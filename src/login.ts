/**
 * `openl-mcp login` / `openl-mcp logout` — browser-based authentication.
 *
 * `login` runs the OAuth 2.0 Authorization Code + PKCE flow (RFC 7636) against
 * the OpenL Studio deployment's identity provider using a loopback redirect
 * (RFC 8252): it opens the system browser, the user clicks "OK", the code comes
 * back to a transient `http://127.0.0.1:<ephemeral>/callback` listener, and the
 * CLI exchanges it for an access token. It then mints an OpenL Personal Access
 * Token by calling `POST /rest/users/personal-access-tokens` with that bearer
 * (no Studio-side change needed — the REST API accepts the IdP bearer in oauth2
 * mode) and caches the returned `openl_pat_…` via {@link setCachedToken}.
 *
 * Afterwards the stdio server / CLI pick up the cached PAT automatically and
 * send it as `Authorization: Token <pat>` — the existing request path is
 * unchanged. `logout` clears the cache.
 *
 * Dependency-free by design (per the repo's "prefer reimplementing small
 * functionality" rule): PKCE via node:crypto, the loopback via node:http, the
 * HTTP calls via the global fetch (Node >= 24).
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { AddressInfo } from "node:net";
import { hostname } from "node:os";

import { setCachedToken, clearCachedToken } from "./token-cache.js";
import { sanitizeError } from "./utils.js";

const DEFAULT_CLIENT_ID = "openl-cli";
const DEFAULT_SCOPE = "openid profile email";
// PAT names are unique per user, so qualify the default with the machine name
// to keep one user's tokens from different machines distinct in the Studio UI.
const DEFAULT_TOKEN_NAME = `Claude Code (openl-mcp) — ${hostname()}`;
const DEFAULT_TOKEN_TTL_SECONDS = 90 * 24 * 3600; // 90 days
const DEFAULT_AUTH_TIMEOUT_MS = 180_000; // 3 minutes to click "OK"
// Per-request bound for the OIDC/Studio HTTP calls (discovery, settings probe,
// token exchange, PAT mint) so an unreachable/slow host can't hang login — the
// auth timeout above only bounds the browser/loopback wait, not these requests.
const HTTP_TIMEOUT_MS = 10_000;

/** Parsed options for `login`. */
interface LoginOptions {
  baseUrl?: string;
  issuer?: string;
  clientId: string;
  scope: string;
  tokenName: string;
  tokenTtlSeconds: number;
  openBrowser: boolean;
  authTimeoutMs: number;
}

/** base64url without padding (PKCE + state). */
function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Open `url` in the system browser; best-effort, non-fatal. */
function openInBrowser(url: string): void {
  try {
    let child;
    if (process.platform === "win32") {
      // The OAuth authorize URL contains `&`, which cmd treats as a command
      // separator. Quote the URL and pass args verbatim so it reaches `start`
      // intact; the empty `""` is start's window-title placeholder.
      child = spawn("cmd", ["/s", "/c", "start", '""', `"${url}"`], {
        stdio: "ignore", detached: true, windowsVerbatimArguments: true,
      });
    } else {
      const cmd = process.platform === "darwin" ? "open" : "xdg-open";
      child = spawn(cmd, [url], { stdio: "ignore", detached: true });
    }
    child.on("error", () => {/* fall back to the printed URL */});
    child.unref();
  } catch {
    /* the URL is also printed, so the user can open it manually */
  }
}

/** Format a Date as the `yyyy-MM-dd'T'HH:mm:ss.SSSZ` (RFC822 offset) shape the
 * Studio PAT API expects (verified against the live API). */
export function formatExpiry(date: Date): string {
  return date.toISOString().replace("Z", "+0000");
}

interface OidcMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
}

/**
 * Normalize an issuer identifier for comparison: lower-case the scheme and
 * host (case-insensitive per URL rules) and strip trailing slashes, keeping
 * the path's case (realm names are case-sensitive). Non-URL values fall back
 * to trailing-slash stripping.
 */
function normalizeIssuer(issuer: string): string {
  try {
    const u = new URL(issuer);
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    return issuer.replace(/\/+$/, "");
  }
}

/**
 * Validate the authorization-response parameters delivered to the loopback
 * callback and return the authorization code.
 *
 * Rejects (by throwing) when the IdP reported an `error`, when the `state`
 * does not match the one this login sent (CSRF), or when an `iss` parameter is
 * present but names a different authorization server than the configured
 * issuer (RFC 9207 — defends against authorization-server mix-up in exactly
 * our shape: one CLI talking to many deployments/IdPs). An absent `iss` is
 * accepted, since IdPs predating RFC 9207 don't send it.
 */
export function validateAuthorizationCallback(
  params: URLSearchParams,
  expected: { state: string; issuer: string },
): string {
  const err = params.get("error");
  if (err) throw new Error(`Authorization denied: ${err}`);
  const returnedState = params.get("state");
  if (!returnedState || returnedState !== expected.state) {
    throw new Error("OAuth state mismatch — aborting");
  }
  const iss = params.get("iss");
  if (iss !== null && normalizeIssuer(iss) !== normalizeIssuer(expected.issuer)) {
    throw new Error(
      `OAuth issuer mismatch: the authorization response names ${iss}, ` +
        `but this login was started against ${expected.issuer} — aborting`,
    );
  }
  const code = params.get("code");
  if (!code) throw new Error("No authorization code in callback");
  return code;
}

/** Fetch OIDC discovery metadata from the issuer. */
export async function discover(issuer: string): Promise<OidcMetadata> {
  const url = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  const res = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`OIDC discovery failed at ${url}: HTTP ${res.status}`);
  }
  const meta = (await res.json()) as Partial<OidcMetadata>;
  if (!meta.authorization_endpoint || !meta.token_endpoint) {
    throw new Error(`OIDC discovery at ${url} is missing authorization/token endpoints`);
  }
  return meta as OidcMetadata;
}

/** Confirm the Studio deployment supports the browser-PAT flow (oauth2 mode).
 * Uses the public, no-auth `/rest/settings` probe. */
export async function assertPatSupported(baseUrl: string): Promise<void> {
  const url = `${baseUrl.replace(/\/+$/, "")}/rest/settings`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  } catch (error) {
    throw new Error(`Could not reach OpenL Studio at ${url}: ${sanitizeError(error)}`);
  }
  if (!res.ok) throw new Error(`Studio settings probe failed at ${url}: HTTP ${res.status}`);
  const body = (await res.json()) as { userMode?: string; supportedFeatures?: { personalAccessToken?: boolean } };
  if (!body.supportedFeatures?.personalAccessToken) {
    throw new Error(
      `This OpenL Studio deployment (mode: ${body.userMode ?? "unknown"}) does not support ` +
        `Personal Access Tokens, so browser login is unavailable. ` +
        `Use a manually issued token via OPENL_PERSONAL_ACCESS_TOKEN / --token instead.`,
    );
  }
}

/**
 * Run the loopback listener: start on an ephemeral 127.0.0.1 port, return the
 * redirect URI and a promise that resolves with the `code` once the browser is
 * redirected back. The authorization response is checked by
 * {@link validateAuthorizationCallback} (CSRF `state`, RFC 9207 `iss`).
 */
function startLoopback(expected: { state: string; issuer: string }, timeoutMs: number): Promise<{ redirectUri: string; code: Promise<string> }> {
  return new Promise((resolveSetup, rejectSetup) => {
    let resolveCode!: (code: string) => void;
    let rejectCode!: (err: Error) => void;
    const code = new Promise<string>((res, rej) => { resolveCode = res; rejectCode = rej; });

    const server = createServer((req, res) => {
      const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      if (reqUrl.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const finish = (ok: boolean, msg: string): void => {
        res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><meta charset=utf-8><title>OpenL MCP</title>` +
          `<body style="font-family:system-ui;padding:3rem;text-align:center">` +
          `<h2>${ok ? "✅ Connected to OpenL Studio" : "❌ Login failed"}</h2>` +
          `<p>${msg}</p><p>You can close this tab and return to your terminal.</p>`);
        setTimeout(() => server.close(), 100);
      };
      let returnedCode: string;
      try {
        returnedCode = validateAuthorizationCallback(reqUrl.searchParams, expected);
      } catch (error) {
        finish(false, (error as Error).message);
        rejectCode(error as Error);
        return;
      }
      finish(true, "Authorization complete.");
      resolveCode(returnedCode);
    });

    const timer = setTimeout(() => {
      rejectCode(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for browser authorization`));
      server.close();
    }, timeoutMs);
    timer.unref();

    server.on("error", (e) => rejectSetup(e));
    // Bind to loopback on an ephemeral port (RFC 8252 §7.3).
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolveSetup({ redirectUri: `http://127.0.0.1:${port}/callback`, code });
    });
  });
}

/** Exchange the authorization code (+ PKCE verifier) for an access token. */
export async function exchangeCode(meta: OidcMetadata, opts: { clientId: string; code: string; redirectUri: string; verifier: string }): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: opts.clientId,
    code: opts.code,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.verifier,
  });
  const res = await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Token exchange failed: HTTP ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("Token endpoint returned no access_token");
  return json.access_token;
}

/** Mint an OpenL PAT using the IdP access token as a bearer. Returns the PAT. */
export async function mintPat(baseUrl: string, accessToken: string, name: string, ttlSeconds: number): Promise<{ token: string; loginName: string; expiresAt: string }> {
  const url = `${baseUrl.replace(/\/+$/, "")}/rest/users/personal-access-tokens`;
  const post = async (tokenName: string): Promise<{ ok: boolean; status: number; text: string }> => {
    const expiresAt = formatExpiry(new Date(Date.now() + ttlSeconds * 1000));
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ name: tokenName, expiresAt }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    return { ok: res.ok, status: res.status, text: await res.text() };
  };

  let res = await post(name);
  // PAT names are unique per user; if one already exists (e.g. re-running login
  // on the same machine), retry once with a timestamp suffix so login never
  // hard-fails on a stale token of the same name.
  if (res.status === 400 && res.text.includes("pat.duplicate.name")) {
    res = await post(`${name} (${new Date().toISOString().replace(/[:.]/g, "-")})`);
  }
  if (!res.ok) {
    throw new Error(`Minting a Personal Access Token failed: HTTP ${res.status} ${res.text}`);
  }
  const json = JSON.parse(res.text) as { token?: string; loginName?: string; expiresAt?: string };
  if (!json.token) throw new Error("PAT mint response contained no token");
  return { token: json.token, loginName: json.loginName ?? "?", expiresAt: json.expiresAt ?? "" };
}

/** Parse `login`/`logout` argv (everything after the subcommand name). */
export function parseLoginArgs(argv: string[]): LoginOptions {
  const opts: LoginOptions = {
    clientId: process.env.OPENL_OAUTH_CLIENT_ID ?? DEFAULT_CLIENT_ID,
    scope: process.env.OPENL_OAUTH_SCOPE ?? DEFAULT_SCOPE,
    tokenName: DEFAULT_TOKEN_NAME,
    tokenTtlSeconds: DEFAULT_TOKEN_TTL_SECONDS,
    openBrowser: true,
    authTimeoutMs: DEFAULT_AUTH_TIMEOUT_MS,
    issuer: process.env.OPENL_OAUTH_ISSUER,
    baseUrl: process.env.OPENL_BASE_URL,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string | undefined => argv[++i];
    switch (a) {
      case "--base-url": opts.baseUrl = next(); break;
      case "--issuer": opts.issuer = next(); break;
      case "--client-id": opts.clientId = next() ?? opts.clientId; break;
      case "--scope": opts.scope = next() ?? opts.scope; break;
      case "--token-name": opts.tokenName = next() ?? opts.tokenName; break;
      case "--token-ttl": { const v = Number(next()); if (Number.isFinite(v) && v > 0) opts.tokenTtlSeconds = v; break; }
      case "--timeout": { const v = Number(next()); if (Number.isFinite(v) && v > 0) opts.authTimeoutMs = v; break; }
      case "--no-browser": opts.openBrowser = false; break;
      default:
        if (!a.startsWith("--") && /^https?:\/\//.test(a)) opts.baseUrl = a; // positional <studio-url>
        break;
    }
  }
  return opts;
}

/**
 * Entry point for `openl-mcp login` / `openl-mcp logout`. Returns a process
 * exit code. `argv` is the full process args after the binary name (the first
 * element is the `login`/`logout` subcommand).
 */
export async function runLoginCli(argv: string[]): Promise<number> {
  const [subcommand, ...rest] = argv;
  const opts = parseLoginArgs(rest);

  if (subcommand === "logout") {
    const removed = await clearCachedToken(opts.baseUrl);
    console.error(opts.baseUrl
      ? (removed ? `Logged out of ${opts.baseUrl} (cached token removed).` : `No cached token for ${opts.baseUrl}.`)
      : `Cleared all cached OpenL tokens.`);
    return 0;
  }

  try {
    if (!opts.baseUrl) throw new Error("OpenL Studio base URL is required: pass it positionally (openl-mcp login <url>), via --base-url, or OPENL_BASE_URL");
    if (!opts.issuer) throw new Error("The OAuth issuer is required: pass --issuer <url> or set OPENL_OAUTH_ISSUER (the deployment's identity-provider realm URL)");

    await assertPatSupported(opts.baseUrl);
    const meta = await discover(opts.issuer);

    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    const state = base64url(randomBytes(16));

    const { redirectUri, code: codePromise } = await startLoopback({ state, issuer: opts.issuer }, opts.authTimeoutMs);

    const authUrl = new URL(meta.authorization_endpoint);
    authUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: opts.clientId,
      redirect_uri: redirectUri,
      scope: opts.scope,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();

    console.error(`Opening your browser to sign in to OpenL Studio…`);
    console.error(`If it doesn't open, visit:\n  ${authUrl.toString()}\n`);
    if (opts.openBrowser) openInBrowser(authUrl.toString());

    const code = await codePromise;
    const accessToken = await exchangeCode(meta, { clientId: opts.clientId, code, redirectUri, verifier });
    const pat = await mintPat(opts.baseUrl, accessToken, opts.tokenName, opts.tokenTtlSeconds);

    await setCachedToken(opts.baseUrl, { token: pat.token, loginName: pat.loginName, expiresAt: pat.expiresAt, issuer: opts.issuer });

    console.error(`\n✅ Signed in as "${pat.loginName}". A Personal Access Token "${opts.tokenName}" was created and cached.`);
    console.error(`   It expires ${pat.expiresAt}. Run "openl-mcp logout" to remove it.`);
    return 0;
  } catch (error) {
    console.error(`\n❌ Login failed: ${sanitizeError(error)}`);
    return 1;
  }
}
