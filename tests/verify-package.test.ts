/**
 * Unit tests for the release gate in src/verify-package.ts: which packaging
 * failures it reports. Every way of losing the build metadata is silent at
 * runtime by design, so this check is the only thing standing between a broken
 * build step and a published package that cannot identify itself — each failure
 * mode is asserted here. The packing/tar plumbing around it is exercised by the
 * real `npm run verify:package`.
 */

import { describe, it, expect } from "@jest/globals";

import { findPackagingProblems } from "../src/verify-package.js";
import { BUILD_METADATA_FILENAME } from "../src/build-info.js";

const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const packedWithMetadata = ["dist/index.js", BUILD_METADATA_FILENAME, "README.md"];
const goodMetadata = JSON.stringify({
  schemaVersion: 1,
  commit: HEAD,
  commitDate: "2026-08-18T08:04:51Z",
  ref: "1.2.0",
  dirty: false,
  builtAt: "2026-08-19T07:30:00Z",
});

describe("findPackagingProblems", () => {
  it("passes a tarball whose metadata describes the packed revision", () => {
    expect(findPackagingProblems(packedWithMetadata, goodMetadata, HEAD)).toEqual([]);
  });

  it("reports metadata dropped from the package file list", () => {
    const problems = findPackagingProblems(["dist/index.js"], goodMetadata, HEAD);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"files"');
  });

  it("reports an entry that could not be read, naming the generator step", () => {
    const problems = findPackagingProblems(packedWithMetadata, undefined, HEAD);
    expect(problems.join(" ")).toContain("npm run build");
  });

  it("reports malformed metadata instead of throwing", () => {
    const problems = findPackagingProblems(packedWithMetadata, "{nope", HEAD);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("not valid JSON");
  });

  it.each([
    ["null", "null"],
    ["an array", "[]"],
    ["a scalar", '"1.1.0"'],
  ])("reports metadata that is %s rather than an object", (_label, raw) => {
    expect(findPackagingProblems(packedWithMetadata, raw, HEAD)).toEqual([
      expect.stringContaining("not a JSON object"),
    ]);
  });

  it("rejects a published build that names no commit", () => {
    const raw = JSON.stringify({ schemaVersion: 1, builtAt: "2026-08-19T07:30:00Z" });
    expect(findPackagingProblems(packedWithMetadata, raw, HEAD)).toEqual([
      expect.stringContaining("records no commit"),
    ]);
  });

  it("rejects metadata left over from an earlier revision", () => {
    const stale = JSON.stringify({ schemaVersion: 1, commit: "0".repeat(40), builtAt: "2026-08-19T07:30:00Z" });
    expect(findPackagingProblems(packedWithMetadata, stale, HEAD)).toEqual([
      expect.stringContaining("stale metadata"),
    ]);
  });

  it("accepts any commit when git cannot name the packed revision", () => {
    const raw = JSON.stringify({ schemaVersion: 1, commit: "0".repeat(40), builtAt: "2026-08-19T07:30:00Z" });
    expect(findPackagingProblems(packedWithMetadata, raw, undefined)).toEqual([]);
  });

  it("reports a missing schema version and build timestamp", () => {
    const raw = JSON.stringify({ commit: HEAD });
    const problems = findPackagingProblems(packedWithMetadata, raw, HEAD);
    expect(problems).toEqual([
      expect.stringContaining("schemaVersion"),
      expect.stringContaining("builtAt"),
    ]);
  });
});
