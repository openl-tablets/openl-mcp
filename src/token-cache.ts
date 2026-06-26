/**
 * On-disk cache for credentials obtained via the browser `login` flow.
 *
 * The `login` command (src/login.ts) mints an OpenL Personal Access Token and
 * stores it here so subsequent server/CLI launches authenticate without any
 * further interaction. The cache is keyed by the OpenL Studio base URL, so one
 * machine can hold tokens for several Studio instances side by side.
 *
 * Resolution precedence elsewhere (stdio-server, cli) is:
 *   OPENL_PERSONAL_ACCESS_TOKEN / --token  >  cached token  >  anonymous
 * i.e. an explicit token always wins; the cache is only consulted as a fallback.
 *
 * The file is written with `0600` (owner read/write only) since it holds a live
 * credential, mirroring the cookie-jar handling already in src/cli.ts.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";

/** One cached credential for a single Studio instance. */
export interface CachedCredential {
  /** The OpenL Personal Access Token (`openl_pat_…`). */
  token: string;
  /** Login name the PAT belongs to (for display / sanity only). */
  loginName?: string;
  /** ISO-8601 expiry, when known. A past value means "treat as absent". */
  expiresAt?: string;
}

/** File shape: a map of normalized base URL → credential. */
type CacheFile = Record<string, CachedCredential>;

/**
 * Directory holding the credentials file. Respects `XDG_CONFIG_HOME`, else
 * `~/.config/openl-mcp`. Overridable via `OPENL_CONFIG_DIR` (used by tests so
 * they never touch a real user's cache).
 */
function configDir(): string {
  if (process.env.OPENL_CONFIG_DIR) return process.env.OPENL_CONFIG_DIR;
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, "openl-mcp") : join(homedir(), ".config", "openl-mcp");
}

function cacheFilePath(): string {
  return join(configDir(), "credentials.json");
}

/**
 * Normalize a base URL into a stable cache key: lower-cased origin + path with
 * any trailing slash removed, so `http://x:8080` and `http://x:8080/` collide
 * (they are the same server) while different hosts/ports do not.
 */
export function cacheKey(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.protocol}//${u.host}${path}`.toLowerCase();
  } catch {
    return baseUrl.replace(/\/+$/, "").toLowerCase();
  }
}

async function readCacheFile(): Promise<CacheFile> {
  let raw: string;
  try {
    raw = await readFile(cacheFilePath(), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as CacheFile) : {};
  } catch {
    // A corrupt cache must not break startup — treat it as empty.
    return {};
  }
}

/**
 * Return the cached token for `baseUrl`, or `undefined` when there is none or
 * the stored credential has expired. Best-effort: any read/parse failure
 * resolves to `undefined` so a broken cache never blocks the server.
 */
export async function getCachedToken(baseUrl: string): Promise<string | undefined> {
  let cache: CacheFile;
  try {
    cache = await readCacheFile();
  } catch {
    return undefined;
  }
  const entry = cache[cacheKey(baseUrl)];
  if (!entry?.token) return undefined;
  if (entry.expiresAt && Date.parse(entry.expiresAt) <= Date.now()) {
    return undefined; // expired — caller falls through to anonymous / re-login
  }
  return entry.token;
}

/**
 * Persist a credential for `baseUrl`, creating the config dir if needed and
 * writing the file `0600`. Merges into any existing entries for other servers.
 */
export async function setCachedToken(baseUrl: string, credential: CachedCredential): Promise<void> {
  const dir = configDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const cache = await readCacheFile();
  cache[cacheKey(baseUrl)] = credential;
  await writeFile(cacheFilePath(), `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Remove the cached credential for `baseUrl` (used by `logout`). Returns true
 * if an entry was removed. When `baseUrl` is omitted, clears the whole cache
 * file. Best-effort and idempotent.
 */
export async function clearCachedToken(baseUrl?: string): Promise<boolean> {
  if (baseUrl === undefined) {
    try {
      await rm(cacheFilePath(), { force: true });
    } catch {
      /* ignore */
    }
    return true;
  }
  const cache = await readCacheFile();
  const key = cacheKey(baseUrl);
  if (!(key in cache)) return false;
  delete cache[key];
  await writeFile(cacheFilePath(), `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
  return true;
}
