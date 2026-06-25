/**
 * Unit tests for `resolveHttpBaseUrl` (the Streamable HTTP transport's base-URL
 * resolver) exported from src/http-server.ts.
 *
 * It mirrors the stdio transport's precedence — an explicit override (the
 * positional `<url>` / `--base-url` forwarded by the dispatcher) wins over the
 * `OPENL_BASE_URL` environment variable — and tolerates a missing/invalid value
 * by returning `undefined` so the server can still start. These cover that
 * resolution logic directly, in-process, without binding a port.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { resolveHttpBaseUrl } from "../src/http-server.js";

describe("resolveHttpBaseUrl (HTTP MCP transport)", () => {
  let savedBaseUrl: string | undefined;
  let errSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    savedBaseUrl = process.env.OPENL_BASE_URL;
    delete process.env.OPENL_BASE_URL;
    // The resolver warns to stderr on an invalid URL — silence it.
    errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    if (savedBaseUrl === undefined) delete process.env.OPENL_BASE_URL;
    else process.env.OPENL_BASE_URL = savedBaseUrl;
    errSpy.mockRestore();
  });

  it("returns the override (positional <url> / --base-url) when set", () => {
    expect(resolveHttpBaseUrl("http://positional:8080")).toBe("http://positional:8080");
  });

  it("prefers the override over OPENL_BASE_URL (documented precedence)", () => {
    process.env.OPENL_BASE_URL = "http://env-host:9999";
    expect(resolveHttpBaseUrl("http://positional:8080")).toBe("http://positional:8080");
  });

  it("falls back to OPENL_BASE_URL when no override is given", () => {
    process.env.OPENL_BASE_URL = "http://env-host:9999";
    expect(resolveHttpBaseUrl()).toBe("http://env-host:9999");
  });

  it("returns undefined when neither override nor OPENL_BASE_URL is set", () => {
    expect(resolveHttpBaseUrl()).toBeUndefined();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("returns undefined and warns on an invalid override", () => {
    expect(resolveHttpBaseUrl("not-a-url")).toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/Invalid OpenL base URL/i));
  });

  it("returns undefined and warns on an invalid OPENL_BASE_URL", () => {
    process.env.OPENL_BASE_URL = "not-a-url";
    expect(resolveHttpBaseUrl()).toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/Invalid OpenL base URL/i));
  });
});
