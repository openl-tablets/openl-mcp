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

  it("throws when no authentication method is provided", () => {
    expect(() => loadConfigFromQuery({ OPENL_BASE_URL: "http://localhost:8080" })).toThrow(
      /authentication method/i,
    );
  });

  it("throws when username is given without password (incomplete Basic Auth)", () => {
    expect(() =>
      loadConfigFromQuery({ OPENL_BASE_URL: "http://localhost:8080", OPENL_USERNAME: "u" }),
    ).toThrow(/authentication method/i);
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

  it("throws when OPENL_BASE_URL is missing", async () => {
    await expect(loadConfigFromEnv()).rejects.toThrow(/OPENL_BASE_URL/);
  });

  it("throws on an invalid base URL", async () => {
    process.env.OPENL_BASE_URL = "bad";
    await expect(loadConfigFromEnv()).rejects.toThrow(/Invalid OPENL_BASE_URL/);
  });

  it("throws on an invalid timeout", async () => {
    process.env.OPENL_BASE_URL = "http://localhost:8080";
    process.env.OPENL_PERSONAL_ACCESS_TOKEN = "t";
    process.env.OPENL_TIMEOUT = "0";
    await expect(loadConfigFromEnv()).rejects.toThrow(/Invalid OPENL_TIMEOUT/);
  });

  it("throws when no authentication method is configured", async () => {
    process.env.OPENL_BASE_URL = "http://localhost:8080";
    await expect(loadConfigFromEnv()).rejects.toThrow(/authentication method/i);
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
