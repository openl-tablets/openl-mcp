/**
 * Unit tests for the config loaders exported from src/index.ts.
 *
 * `loadConfigFromQuery` (HTTP SSE transport) and `loadConfigFromEnv` (stdio
 * MCP transport) are pure-ish validators with several branches (missing base
 * URL, invalid URL, invalid timeout, missing auth). They were previously
 * untested (index.ts at 0%); these cover the validation logic directly,
 * in-process, without spawning the binary.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { loadConfigFromQuery, loadConfigFromEnv } from "../src/index.js";

describe("loadConfigFromQuery (HTTP SSE transport)", () => {
  it("returns null when OPENL_BASE_URL is absent (not enough params)", () => {
    expect(loadConfigFromQuery({})).toBeNull();
  });

  it("throws on an invalid base URL", () => {
    expect(() =>
      loadConfigFromQuery({ OPENL_BASE_URL: "not-a-url", OPENL_PERSONAL_ACCESS_TOKEN: "t" }),
    ).toThrow(/Invalid OPENL_BASE_URL/);
  });

  it("throws on an invalid timeout", () => {
    expect(() =>
      loadConfigFromQuery({
        OPENL_BASE_URL: "http://localhost:8080",
        OPENL_PERSONAL_ACCESS_TOKEN: "t",
        OPENL_TIMEOUT: "-5",
      }),
    ).toThrow(/Invalid OPENL_TIMEOUT/);
  });

  it("returns an unauthenticated config when no auth method is provided (single-user mode)", () => {
    const cfg = loadConfigFromQuery({ OPENL_BASE_URL: "http://localhost:8080" });
    expect(cfg).toMatchObject({ baseUrl: "http://localhost:8080" });
    expect(cfg?.username).toBeUndefined();
    expect(cfg?.password).toBeUndefined();
    expect(cfg?.personalAccessToken).toBeUndefined();
  });

  it("returns a config and warns when only one half of Basic Auth is set", () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const cfg = loadConfigFromQuery({ OPENL_BASE_URL: "http://localhost:8080", OPENL_USERNAME: "u" });
      expect(cfg).toMatchObject({ baseUrl: "http://localhost:8080", username: "u" });
      expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/Incomplete Basic Auth/i));
    } finally {
      errSpy.mockRestore();
    }
  });

  it("accepts a Personal Access Token", () => {
    const cfg = loadConfigFromQuery({
      OPENL_BASE_URL: "http://localhost:8080",
      OPENL_PERSONAL_ACCESS_TOKEN: "openl_pat_x",
    });
    expect(cfg).toMatchObject({
      baseUrl: "http://localhost:8080",
      personalAccessToken: "openl_pat_x",
    });
  });

  it("accepts Basic Auth and parses a valid timeout", () => {
    const cfg = loadConfigFromQuery({
      OPENL_BASE_URL: "http://localhost:8080",
      OPENL_USERNAME: "u",
      OPENL_PASSWORD: "p",
      OPENL_TIMEOUT: "60000",
    });
    expect(cfg).toMatchObject({
      baseUrl: "http://localhost:8080",
      username: "u",
      password: "p",
      timeout: 60000,
    });
  });
});

describe("loadConfigFromEnv (stdio MCP transport)", () => {
  const OPENL_KEYS = [
    "OPENL_BASE_URL",
    "OPENL_USERNAME",
    "OPENL_PASSWORD",
    "OPENL_PERSONAL_ACCESS_TOKEN",
    "OPENL_TIMEOUT",
  ] as const;

  let saved: Record<string, string | undefined>;
  let errSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    // Snapshot and clear the OPENL_* env so each test starts from a clean slate.
    saved = {};
    for (const k of OPENL_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    // loadConfigFromEnv emits diagnostic [Config] lines to stderr — silence them.
    errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    for (const k of OPENL_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    errSpy.mockRestore();
  });

  it("throws when no base URL is provided, naming both the positional and the env var", async () => {
    // The message must mention both ways to supply the URL so the binary's
    // usage hint (printed by main()) and `--help` stay consistent.
    await expect(loadConfigFromEnv()).rejects.toThrow(/OPENL_BASE_URL/);
    await expect(loadConfigFromEnv()).rejects.toThrow(/positional argument/i);
  });

  it("throws on an invalid base URL", async () => {
    process.env.OPENL_BASE_URL = "bad";
    await expect(loadConfigFromEnv()).rejects.toThrow(/Invalid OpenL base URL/);
  });

  it("prefers an explicit base URL override (positional <url>) over OPENL_BASE_URL", async () => {
    process.env.OPENL_BASE_URL = "http://env-host:9999";
    const cfg = await loadConfigFromEnv({ baseUrl: "http://positional:8080" });
    expect(cfg.baseUrl).toBe("http://positional:8080");
  });

  it("validates an invalid base URL override the same way", async () => {
    await expect(loadConfigFromEnv({ baseUrl: "not-a-url" })).rejects.toThrow(/Invalid OpenL base URL/);
  });

  it("applies cred/timeout overrides (server-launch flags) over the environment", async () => {
    process.env.OPENL_BASE_URL = "http://env-host:9999";
    process.env.OPENL_USERNAME = "envuser";
    const cfg = await loadConfigFromEnv({
      baseUrl: "http://localhost:8080",
      username: "flaguser",
      password: "flagpass",
      timeout: 12345,
    });
    expect(cfg).toMatchObject({
      baseUrl: "http://localhost:8080",
      username: "flaguser",
      password: "flagpass",
      timeout: 12345,
    });
  });

  it("throws on an invalid timeout", async () => {
    process.env.OPENL_BASE_URL = "http://localhost:8080";
    process.env.OPENL_PERSONAL_ACCESS_TOKEN = "t";
    process.env.OPENL_TIMEOUT = "0";
    await expect(loadConfigFromEnv()).rejects.toThrow(/Invalid OPENL_TIMEOUT/);
  });

  it("resolves with no auth (single-user mode)", async () => {
    process.env.OPENL_BASE_URL = "http://localhost:8080";
    const cfg = await loadConfigFromEnv();
    expect(cfg).toMatchObject({ baseUrl: "http://localhost:8080" });
    expect(cfg.username).toBeUndefined();
    expect(cfg.password).toBeUndefined();
    expect(cfg.personalAccessToken).toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/No authentication configured/i));
  });

  it("resolves and warns when only one half of Basic Auth is set", async () => {
    process.env.OPENL_BASE_URL = "http://localhost:8080";
    process.env.OPENL_USERNAME = "u";
    const cfg = await loadConfigFromEnv();
    expect(cfg).toMatchObject({ baseUrl: "http://localhost:8080", username: "u" });
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/Incomplete Basic Auth/i));
  });

  it("resolves with a PAT", async () => {
    process.env.OPENL_BASE_URL = "http://localhost:8080";
    process.env.OPENL_PERSONAL_ACCESS_TOKEN = "openl_pat_x";
    await expect(loadConfigFromEnv()).resolves.toMatchObject({
      baseUrl: "http://localhost:8080",
      personalAccessToken: "openl_pat_x",
    });
  });

  it("resolves with Basic Auth and a parsed timeout", async () => {
    process.env.OPENL_BASE_URL = "http://localhost:8080";
    process.env.OPENL_USERNAME = "admin";
    process.env.OPENL_PASSWORD = "admin";
    process.env.OPENL_TIMEOUT = "45000";
    await expect(loadConfigFromEnv()).resolves.toMatchObject({
      baseUrl: "http://localhost:8080",
      username: "admin",
      password: "admin",
      timeout: 45000,
    });
  });
});
