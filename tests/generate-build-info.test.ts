/**
 * Unit tests for the build-time metadata collection in
 * src/generate-build-info.ts: which git facts are recorded, how a tagged
 * release, a plain branch, and a detached checkout are named, and how each
 * unavailable fact degrades. Git is injected, so no test needs a repository;
 * the file writing around it is exercised by the real build.
 */

import { describe, it, expect } from "@jest/globals";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectBuildMetadata, toUtcIso, type GitRunner } from "../src/generate-build-info.js";
import { BUILD_METADATA_SCHEMA_VERSION } from "../src/build-info.js";

const BUILT_AT = "2026-08-19T07:30:00.000Z";
const COMMIT = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

/**
 * The directory the package is "built from". A real path, because the collector
 * canonicalizes it to compare with git's work tree.
 */
const packageRoot = mkdtempSync(join(tmpdir(), "openl-pkg-root-"));

/** One git query, identified by intent rather than by raw argv. */
type GitQuery = "toplevel" | "head" | "branch" | "log" | "describe" | "status";

/** Classify the argv the collector passes to git. */
function queryOf(args: string[]): GitQuery {
  if (args[0] === "rev-parse") {
    if (args.includes("--show-toplevel")) return "toplevel";
    return args.includes("--abbrev-ref") ? "branch" : "head";
  }
  if (args[0] === "describe") return "describe";
  return args[0] as GitQuery;
}

/**
 * Git runner answering from `answers`, keyed by query intent. A missing key
 * throws, standing in for a query git cannot answer (no tags, not a repository,
 * git absent).
 */
function fakeGit(answers: Partial<Record<GitQuery, string>>): GitRunner {
  return (args) => {
    const answer = answers[queryOf(args)];
    if (answer === undefined) throw new Error(`fatal: cannot answer 'git ${args.join(" ")}'`);
    return answer;
  };
}

const cleanRelease: Partial<Record<GitQuery, string>> = {
  toplevel: packageRoot,
  head: COMMIT,
  log: "2026-08-18T11:04:51+03:00",
  describe: "1.2.0",
  status: "",
};

describe("collectBuildMetadata", () => {
  it("records the commit, its date, the exact release tag, a clean tree, and the build time", () => {
    expect(collectBuildMetadata(fakeGit(cleanRelease), BUILT_AT, packageRoot)).toEqual({
      schemaVersion: BUILD_METADATA_SCHEMA_VERSION,
      commit: COMMIT,
      // git reported +03:00; both recorded timestamps are UTC.
      commitDate: "2026-08-18T08:04:51Z",
      ref: "1.2.0",
      dirty: false,
      builtAt: BUILT_AT,
    });
  });

  it("omits an unparseable committer date rather than recording a non-UTC value", () => {
    const git = fakeGit({ ...cleanRelease, log: "not a date" });
    expect(collectBuildMetadata(git, BUILT_AT, packageRoot).commitDate).toBeUndefined();
  });

  it("names the branch when HEAD carries no exact tag", () => {
    // `git describe --tags --exact-match` fails on an untagged commit; the
    // branch name comes from the same rev-parse the commit did.
    const git = fakeGit({ ...cleanRelease, describe: undefined, branch: "main" });
    expect(collectBuildMetadata(git, BUILT_AT, packageRoot).ref).toBe("main");
  });

  it("omits the ref for a detached, untagged checkout instead of recording the literal 'HEAD'", () => {
    const git = fakeGit({ ...cleanRelease, describe: undefined, branch: "HEAD" });
    expect(collectBuildMetadata(git, BUILT_AT, packageRoot).ref).toBeUndefined();
  });

  it("flags a build made from a modified working tree", () => {
    const git = fakeGit({ ...cleanRelease, status: " M src/client.ts\n?? notes.txt" });
    expect(collectBuildMetadata(git, BUILT_AT, packageRoot).dirty).toBe(true);
  });

  it("leaves dirty unset when git cannot report status, so 'unknown' stays distinct from 'clean'", () => {
    const git = fakeGit({ ...cleanRelease, status: undefined });
    const metadata = collectBuildMetadata(git, BUILT_AT, packageRoot);
    expect(metadata.dirty).toBeUndefined();
    expect(metadata.commit).toBe(COMMIT);
  });

  it("still records the build time when git is unavailable, never failing the build", () => {
    const unavailable: GitRunner = () => {
      throw new Error("spawn git ENOENT");
    };
    expect(collectBuildMetadata(unavailable, BUILT_AT, packageRoot)).toEqual({
      schemaVersion: BUILD_METADATA_SCHEMA_VERSION,
      builtAt: BUILT_AT,
    });
  });

  it("asks git nothing else once the work tree is not this package", () => {
    const calls: string[] = [];
    const git: GitRunner = (args) => {
      calls.push(args.join(" "));
      throw new Error("fatal: not a git repository");
    };
    collectBuildMetadata(git, BUILT_AT, packageRoot);
    expect(calls).toEqual(["rev-parse --show-toplevel"]);
  });

  it("ignores the coordinates of an enclosing, unrelated repository", () => {
    // A source export unpacked inside another project: git answers from THAT
    // repository, whose commit and branch are not this build's identity.
    const enclosing = mkdtempSync(join(tmpdir(), "openl-enclosing-repo-"));
    const git = fakeGit({
      ...cleanRelease,
      toplevel: enclosing,
      head: "0000000000000000000000000000000000000000",
      describe: "customer-acme-incident-4471",
      status: " M README.md",
    });

    expect(collectBuildMetadata(git, BUILT_AT, packageRoot)).toEqual({
      schemaVersion: BUILD_METADATA_SCHEMA_VERSION,
      builtAt: BUILT_AT,
    });
  });


  it("records an empty-output commit date as absent rather than blank", () => {
    const git = fakeGit({ ...cleanRelease, log: "" });
    expect(collectBuildMetadata(git, BUILT_AT, packageRoot).commitDate).toBeUndefined();
  });
});

describe("toUtcIso", () => {
  it("shifts a committer offset to UTC", () => {
    expect(toUtcIso("2026-08-18T11:04:51+03:00")).toBe("2026-08-18T08:04:51Z");
    expect(toUtcIso("2026-08-18T11:04:51-05:00")).toBe("2026-08-18T16:04:51Z");
  });

  it("rolls the date over when the offset crosses midnight", () => {
    expect(toUtcIso("2026-08-18T01:30:00+03:00")).toBe("2026-08-17T22:30:00Z");
  });

  it("leaves a timestamp that is already UTC unchanged", () => {
    expect(toUtcIso("2026-08-18T08:04:51Z")).toBe("2026-08-18T08:04:51Z");
  });

  it("drops the milliseconds git never reports", () => {
    expect(toUtcIso("2026-08-18T08:04:51.123Z")).toBe("2026-08-18T08:04:51Z");
  });

  it("returns undefined for input that is not a timestamp", () => {
    expect(toUtcIso("HEAD")).toBeUndefined();
    expect(toUtcIso("")).toBeUndefined();
  });
});
