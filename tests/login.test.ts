/**
 * Unit tests for src/login.ts — the browser `login` flow's testable units.
 *
 * The interactive parts (loopback listener, real browser, real Keycloak) are
 * covered by the end-to-end stack; here we pin the deterministic logic:
 * argument parsing/precedence, the PAT-API expiry format, the Studio capability
 * probe, OIDC discovery, the token exchange request, and the PAT mint request.
 * The global `fetch` is replaced with a stub so no network is touched.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import {
  parseLoginArgs,
  formatExpiry,
  assertPatSupported,
  discover,
  exchangeCode,
  mintPat,
  runLoginCli,
} from "../src/login.js";

/** Build a minimal Response-like object for the fetch stub. */
function fakeResponse(opts: { ok?: boolean; status?: number; json?: unknown; text?: string }): Response {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => opts.json,
    text: async () => opts.text ?? (opts.json !== undefined ? JSON.stringify(opts.json) : ""),
  } as unknown as Response;
}

const realFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof jest.fn>;

beforeEach(() => {
  fetchMock = jest.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  // Isolate from any OPENL_OAUTH_* / OPENL_BASE_URL set in the runner's env.
  for (const k of ["OPENL_OAUTH_ISSUER", "OPENL_OAUTH_CLIENT_ID", "OPENL_OAUTH_SCOPE", "OPENL_BASE_URL"]) {
    delete process.env[k];
  }
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("parseLoginArgs", () => {
  it("applies sensible defaults", () => {
    const o = parseLoginArgs([]);
    expect(o.clientId).toBe("openl-cli");
    expect(o.scope).toBe("openid profile email");
    expect(o.openBrowser).toBe(true);
    expect(o.baseUrl).toBeUndefined();
  });

  it("treats a bareword http(s) URL as the Studio base URL", () => {
    expect(parseLoginArgs(["http://studio:8080"]).baseUrl).toBe("http://studio:8080");
  });

  it("honors flags and --no-browser, and parses numeric ttl", () => {
    const o = parseLoginArgs(["--base-url", "http://s", "--issuer", "http://i", "--client-id", "c", "--token-ttl", "60", "--no-browser"]);
    expect(o).toMatchObject({ baseUrl: "http://s", issuer: "http://i", clientId: "c", tokenTtlSeconds: 60, openBrowser: false });
  });

  it("reads issuer/client-id from the environment, but an explicit flag wins", () => {
    process.env.OPENL_OAUTH_ISSUER = "http://env-issuer";
    process.env.OPENL_OAUTH_CLIENT_ID = "env-client";
    expect(parseLoginArgs([]).issuer).toBe("http://env-issuer");
    expect(parseLoginArgs([]).clientId).toBe("env-client");
    expect(parseLoginArgs(["--client-id", "flag-client"]).clientId).toBe("flag-client");
  });
});

describe("formatExpiry", () => {
  it("renders the RFC822-offset shape the Studio PAT API expects (no trailing Z)", () => {
    expect(formatExpiry(new Date("2026-01-02T03:04:05.678Z"))).toBe("2026-01-02T03:04:05.678+0000");
  });
});

describe("assertPatSupported", () => {
  it("resolves when the deployment reports personalAccessToken support", async () => {
    fetchMock.mockResolvedValue(fakeResponse({ json: { userMode: "EXTERNAL", supportedFeatures: { personalAccessToken: true } } }) as never);
    await expect(assertPatSupported("http://studio:8080/")).resolves.toBeUndefined();
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://studio:8080/rest/settings");
  });

  it("rejects with a helpful message when PAT is unsupported", async () => {
    fetchMock.mockResolvedValue(fakeResponse({ json: { userMode: "single", supportedFeatures: { personalAccessToken: false } } }) as never);
    await expect(assertPatSupported("http://studio:8080")).rejects.toThrow(/single.*does not support|does not support.*Personal Access Tokens/s);
  });

  it("rejects when the probe returns a non-OK status", async () => {
    fetchMock.mockResolvedValue(fakeResponse({ ok: false, status: 503 }) as never);
    await expect(assertPatSupported("http://studio:8080")).rejects.toThrow(/HTTP 503/);
  });
});

describe("discover", () => {
  it("returns the authorization/token endpoints and strips a trailing slash on the issuer", async () => {
    fetchMock.mockResolvedValue(fakeResponse({ json: { authorization_endpoint: "http://i/auth", token_endpoint: "http://i/token" } }) as never);
    const meta = await discover("http://i/realms/r/");
    expect(meta).toEqual({ authorization_endpoint: "http://i/auth", token_endpoint: "http://i/token" });
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://i/realms/r/.well-known/openid-configuration");
  });

  it("rejects when discovery is missing endpoints", async () => {
    fetchMock.mockResolvedValue(fakeResponse({ json: {} }) as never);
    await expect(discover("http://i")).rejects.toThrow(/missing authorization\/token/);
  });

  it("rejects on a non-OK discovery response", async () => {
    fetchMock.mockResolvedValue(fakeResponse({ ok: false, status: 404 }) as never);
    await expect(discover("http://i")).rejects.toThrow(/discovery failed.*HTTP 404/s);
  });
});

describe("exchangeCode", () => {
  const meta = { authorization_endpoint: "http://i/auth", token_endpoint: "http://i/token" };

  it("POSTs the PKCE code-exchange params and returns the access token", async () => {
    fetchMock.mockResolvedValue(fakeResponse({ json: { access_token: "AT123" } }) as never);
    const at = await exchangeCode(meta, { clientId: "openl-cli", code: "CODE", redirectUri: "http://127.0.0.1:5/callback", verifier: "VER" });
    expect(at).toBe("AT123");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://i/token");
    expect(init.method).toBe("POST");
    const body = String(init.body);
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("code_verifier=VER");
    expect(body).toContain("code=CODE");
    expect(body).toContain("client_id=openl-cli");
  });

  it("rejects when the token endpoint returns no access_token", async () => {
    fetchMock.mockResolvedValue(fakeResponse({ json: {} }) as never);
    await expect(exchangeCode(meta, { clientId: "c", code: "x", redirectUri: "y", verifier: "z" })).rejects.toThrow(/no access_token/);
  });

  it("rejects on a non-OK token response", async () => {
    fetchMock.mockResolvedValue(fakeResponse({ ok: false, status: 400, text: "bad" }) as never);
    await expect(exchangeCode(meta, { clientId: "c", code: "x", redirectUri: "y", verifier: "z" })).rejects.toThrow(/Token exchange failed.*HTTP 400/s);
  });
});

describe("mintPat", () => {
  it("POSTs to the PAT endpoint with a Bearer token and a name+expiry body", async () => {
    fetchMock.mockResolvedValue(fakeResponse({ json: { token: "openl_pat_xyz", loginName: "admin", expiresAt: "2026-09-24T00:00:00Z" } }) as never);
    const res = await mintPat("http://studio:8080/", "AT123", "My Token", 3600);
    expect(res).toMatchObject({ token: "openl_pat_xyz", loginName: "admin" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://studio:8080/rest/users/personal-access-tokens");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer AT123");
    const body = JSON.parse(String(init.body)) as { name: string; expiresAt: string };
    expect(body.name).toBe("My Token");
    expect(body.expiresAt).toMatch(/\+0000$/);
  });

  it("retries with a disambiguated name when the name already exists", async () => {
    fetchMock
      .mockResolvedValueOnce(fakeResponse({ ok: false, status: 400, text: JSON.stringify({ code: "openl.error.400.pat.duplicate.name.message" }) }) as never)
      .mockResolvedValueOnce(fakeResponse({ json: { token: "openl_pat_2", loginName: "admin" } }) as never);
    const res = await mintPat("http://s", "AT", "My Token", 60);
    expect(res.token).toBe("openl_pat_2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body)) as { name: string };
    expect(secondBody.name).toMatch(/^My Token \(/); // disambiguating suffix appended
  });

  it("rejects when the mint response has no token", async () => {
    fetchMock.mockResolvedValue(fakeResponse({ json: { loginName: "admin" } }) as never);
    await expect(mintPat("http://s", "AT", "n", 60)).rejects.toThrow(/no token/);
  });

  it("rejects on a non-OK mint response", async () => {
    fetchMock.mockResolvedValue(fakeResponse({ ok: false, status: 403, text: "forbidden" }) as never);
    await expect(mintPat("http://s", "AT", "n", 60)).rejects.toThrow(/Minting.*HTTP 403/s);
  });
});

describe("runLoginCli", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openl-login-"));
    process.env.OPENL_CONFIG_DIR = dir;
  });
  afterEach(() => {
    delete process.env.OPENL_CONFIG_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails (exit 1) when no base URL is given to login", async () => {
    expect(await runLoginCli(["login"])).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled(); // bails before any network
  });

  it("fails (exit 1) when no issuer is given to login", async () => {
    expect(await runLoginCli(["login", "http://studio:8080"])).toBe(1);
  });

  it("logout returns 0 even when nothing is cached", async () => {
    expect(await runLoginCli(["logout", "http://studio:8080"])).toBe(0);
  });
});
