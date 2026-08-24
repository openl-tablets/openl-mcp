/**
 * Release gate: prove the packaged tarball actually carries this build's
 * identity.
 *
 * The runtime is deliberately tolerant — a missing or unreadable
 * `build-info.json` degrades to `source: "unavailable"` and the bare version
 * (see {@link file://./build-info.ts}) — and the test suite must accept that
 * state, because CI runs the tests BEFORE the build. The cost of that tolerance
 * is that every way of losing the artifact is silent: dropping it from
 * `package.json` `files`, a generator step that never ran, a failed write, a
 * malformed artifact. Each would publish a package that cannot identify itself
 * and no check would notice.
 *
 * So this runs AFTER the build, in the workflows that publish: it packs the
 * package the way npm will, reads `build-info.json` back OUT of the tarball, and
 * fails the job when it is absent, malformed, or describes a different revision
 * than the one being built.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { BUILD_METADATA_FILENAME, type BuildMetadata } from "./build-info.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, "..");

/** Path of the metadata artifact inside the tarball (npm roots every entry at `package/`). */
const TARBALL_ENTRY = `package/${BUILD_METADATA_FILENAME}`;

/**
 * Validate the metadata a tarball carries.
 *
 * @param packedPaths - Package-relative paths npm reported for the tarball.
 * @param rawMetadata - Raw `build-info.json` read from the tarball, or undefined
 *   when the entry is missing.
 * @param headCommit - Commit being built, when git can name it; the artifact
 *   must agree with it.
 * @returns The problems found; empty means the package can identify itself.
 */
export function findPackagingProblems(
  packedPaths: readonly string[],
  rawMetadata: string | undefined,
  headCommit: string | undefined,
): string[] {
  const problems: string[] = [];

  if (!packedPaths.includes(BUILD_METADATA_FILENAME)) {
    problems.push(
      `${BUILD_METADATA_FILENAME} is not in the tarball — check the "files" list in package.json.`,
    );
  }
  if (rawMetadata === undefined) {
    problems.push(
      `${TARBALL_ENTRY} could not be read from the tarball — did 'npm run build' run the generator?`,
    );
    return problems;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMetadata);
  } catch (error) {
    problems.push(`${TARBALL_ENTRY} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return problems;
  }
  // `null`, an array or a scalar all parse successfully; reading fields off them
  // would throw or produce a misleading list of "missing field" problems.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    problems.push(`${TARBALL_ENTRY} is not a JSON object.`);
    return problems;
  }
  const metadata = parsed as BuildMetadata;

  if (typeof metadata.schemaVersion !== "number") {
    problems.push(`${TARBALL_ENTRY} has no numeric schemaVersion.`);
  }
  if (typeof metadata.builtAt !== "string" || metadata.builtAt === "") {
    problems.push(`${TARBALL_ENTRY} has no builtAt timestamp.`);
  }
  // A published package must name its revision: "unknown" is the honest answer
  // for a source tree without git, never for a release built from a checkout.
  if (typeof metadata.commit !== "string" || metadata.commit === "") {
    problems.push(`${TARBALL_ENTRY} records no commit, so the published build cannot be identified.`);
  } else if (headCommit !== undefined && metadata.commit !== headCommit) {
    problems.push(
      `${TARBALL_ENTRY} records commit ${metadata.commit} but the tree being packed is at ${headCommit} — stale metadata.`,
    );
  }

  return problems;
}

/** Run one command in the package root, returning trimmed stdout. */
function run(command: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync(command, args, {
    cwd: PACKAGE_ROOT,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "inherit"],
    ...(env && { env }),
  }).trim();
}

/** Build-script progress output (this never runs inside the MCP server). */
function print(message: string): void {
  process.stdout.write(`${message}\n`);
}

function main(): void {
  const outDir = mkdtempSync(join(tmpdir(), "openl-verify-package-"));
  try {
    // `--ignore-scripts` keeps the pack from re-running the build being checked.
    // `npm_config_dry_run` is cleared because this also runs from
    // `prepublishOnly`: under `npm publish --dry-run` the nested pack would
    // inherit that flag, print a file list and write no tarball at all.
    const packed = JSON.parse(
      run(
        "npm",
        ["pack", "--json", "--ignore-scripts", "--pack-destination", outDir],
        { ...process.env, npm_config_dry_run: "false" },
      ),
    ) as Array<{ filename: string; files: Array<{ path: string }> }>;
    const tarball = join(outDir, packed[0].filename);
    const paths = packed[0].files.map((entry) => entry.path);

    if (!existsSync(tarball)) {
      console.error(`verify-package: npm pack wrote no tarball at ${tarball}; cannot verify the package.`);
      process.exitCode = 1;
      return;
    }

    let rawMetadata: string | undefined;
    try {
      // stderr silenced: "not found in archive" is a case this reports itself.
      rawMetadata = execFileSync("tar", ["-xzOf", tarball, TARBALL_ENTRY], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      rawMetadata = undefined;
    }

    const headCommit = (() => {
      try {
        return run("git", ["rev-parse", "HEAD"]);
      } catch {
        return undefined;
      }
    })();

    const problems = findPackagingProblems(paths, rawMetadata, headCommit);
    if (problems.length > 0) {
      for (const problem of problems) console.error(`verify-package: ${problem}`);
      process.exitCode = 1;
      return;
    }

    const metadata = JSON.parse(rawMetadata as string) as BuildMetadata;
    print(
      `${packed[0].filename} carries build ${metadata.commit?.slice(0, 7)}` +
        `${metadata.dirty ? " (modified working tree)" : ""} built at ${metadata.builtAt}.`,
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

// Run only when invoked directly (node dist/verify-package.js); importing the
// module for its pure function (tests) must stay side-effect free.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
