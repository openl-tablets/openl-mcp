/**
 * Unit tests for src/token-cache.ts — the on-disk credential cache that backs
 * the `openl-mcp login` flow.
 *
 * Exercises the real behavior: per-base-URL keying and normalization, expiry
 * handling, merge/clear semantics, and the 0600 file mode. Every test points
 * `OPENL_CONFIG_DIR` at a throwaway temp directory so a real user's cache is
 * never touched.
 */

import { mkdtempSync, rmSync, statSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { getCachedToken, setCachedToken, clearCachedToken, cacheKey } from "../src/token-cache.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openl-cache-"));
  process.env.OPENL_CONFIG_DIR = dir;
});

afterEach(() => {
  delete process.env.OPENL_CONFIG_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("cacheKey normalization", () => {
  it("strips a trailing slash and lower-cases so equivalent URLs collide", () => {
    expect(cacheKey("http://Studio:8080/")).toBe(cacheKey("http://studio:8080"));
    expect(cacheKey("HTTP://Studio:8080///")).toBe("http://studio:8080");
  });

  it("keeps distinct hosts/ports/paths apart", () => {
    expect(cacheKey("http://a:8080")).not.toBe(cacheKey("http://a:8081"));
    expect(cacheKey("http://a:8080/x")).not.toBe(cacheKey("http://a:8080/y"));
  });
});

describe("get/set round-trip", () => {
  it("returns undefined when no cache file exists", async () => {
    expect(await getCachedToken("http://studio:8080")).toBeUndefined();
  });

  it("returns a stored token, matching on the normalized key", async () => {
    const credential = { token: "openl_pat_abc", loginName: "admin", issuer: "https://idp.example.com/realms/openl" };
    await setCachedToken("http://studio:8080", credential);
    expect(await getCachedToken("http://studio:8080/")).toBe("openl_pat_abc");
    // The full credential — including the issuer provenance the login flow
    // records (SEP-2352) — survives the round-trip to disk, not just the token.
    const persisted = JSON.parse(readFileSync(join(dir, "credentials.json"), "utf-8"));
    expect(persisted[cacheKey("http://studio:8080")]).toEqual(credential);
  });

  it("keeps tokens for different servers independent", async () => {
    await setCachedToken("http://a:8080", { token: "openl_pat_a" });
    await setCachedToken("http://b:8080", { token: "openl_pat_b" });
    expect(await getCachedToken("http://a:8080")).toBe("openl_pat_a");
    expect(await getCachedToken("http://b:8080")).toBe("openl_pat_b");
  });

  it("overwrites the entry for the same server on re-login", async () => {
    await setCachedToken("http://a:8080", { token: "openl_pat_old" });
    await setCachedToken("http://a:8080", { token: "openl_pat_new" });
    expect(await getCachedToken("http://a:8080")).toBe("openl_pat_new");
  });
});

describe("expiry handling", () => {
  it("ignores an expired credential", async () => {
    await setCachedToken("http://a:8080", { token: "openl_pat_x", expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(await getCachedToken("http://a:8080")).toBeUndefined();
  });

  it("returns a credential whose expiry is in the future", async () => {
    await setCachedToken("http://a:8080", { token: "openl_pat_x", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect(await getCachedToken("http://a:8080")).toBe("openl_pat_x");
  });

  it("returns a credential with no expiry set", async () => {
    await setCachedToken("http://a:8080", { token: "openl_pat_x" });
    expect(await getCachedToken("http://a:8080")).toBe("openl_pat_x");
  });
});

describe("clearCachedToken", () => {
  it("removes a single server's entry and reports whether one was present", async () => {
    await setCachedToken("http://a:8080", { token: "openl_pat_a" });
    await setCachedToken("http://b:8080", { token: "openl_pat_b" });
    expect(await clearCachedToken("http://a:8080")).toBe(true);
    expect(await getCachedToken("http://a:8080")).toBeUndefined();
    expect(await getCachedToken("http://b:8080")).toBe("openl_pat_b"); // untouched
    expect(await clearCachedToken("http://a:8080")).toBe(false); // already gone
  });

  it("clears the whole cache when no base URL is given", async () => {
    await setCachedToken("http://a:8080", { token: "openl_pat_a" });
    await setCachedToken("http://b:8080", { token: "openl_pat_b" });
    await clearCachedToken();
    expect(await getCachedToken("http://a:8080")).toBeUndefined();
    expect(await getCachedToken("http://b:8080")).toBeUndefined();
  });
});

describe("on-disk safety", () => {
  it("writes the credentials file with owner-only 0600 permissions", async () => {
    await setCachedToken("http://a:8080", { token: "openl_pat_secret" });
    const file = join(dir, "credentials.json");
    expect(existsSync(file)).toBe(true);
    // Skip the permission assertion on Windows, where POSIX mode bits don't apply.
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("treats a corrupt cache file as empty rather than throwing", async () => {
    await setCachedToken("http://a:8080", { token: "openl_pat_a" });
    const file = join(dir, "credentials.json");
    // Corrupt the file, then a read must not throw — it falls back to anonymous.
    writeFileSync(file, "{ not json");
    expect(await getCachedToken("http://a:8080")).toBeUndefined();
    expect(readFileSync(file, "utf-8")).toContain("not json"); // unchanged by the failed read
  });
});
