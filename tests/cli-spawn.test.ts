/**
 * Child-process smoke tests for the built binary (`dist/index.js`).
 *
 * In-process tests drive `runCli()` directly and can't catch issues in the
 * real entry point: the shebang, the `bin` wiring, the argv-based dispatch
 * between CLI and MCP mode, and the EPIPE handler installed on the process's
 * actual stdout. These spawn the compiled binary and assert on its behavior.
 *
 * Build dependency: the tests run against `dist/`. `beforeAll` rebuilds only
 * when `dist/index.js` is older than the relevant sources (so CI — which
 * builds before testing — and a fresh local build both skip the rebuild).
 */

import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { execFile, spawn } from "node:child_process";
import { execSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const distEntry = join(root, "dist", "index.js");

/** Run the built binary and resolve with its exit code + captured output. */
function run(
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [distEntry, ...args],
      { cwd: root, env, timeout: 15000 },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
            ? ((error as unknown as { code: number }).code)
            : error
              ? 1
              : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

/** Env with all OPENL_* keys stripped, so config comes only from args. */
function envWithoutOpenl(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith("OPENL_")) delete env[k];
  }
  return env;
}

describe("built binary (dist/index.js)", () => {
  beforeAll(() => {
    // Rebuild only if dist is missing or older than the entry/dispatch sources.
    const srcs = ["src/index.ts", "src/cli.ts"].map((p) => join(root, p));
    const distMtime = existsSync(distEntry) ? statSync(distEntry).mtimeMs : 0;
    const newestSrc = Math.max(...srcs.map((s) => statSync(s).mtimeMs));
    if (distMtime < newestSrc) {
      execSync("npm run build", { cwd: root, stdio: "ignore" });
    }
  }, 120000);

  describe("CLI-mode dispatch (argv present)", () => {
    it("--version prints version and exits 0", async () => {
      const { code, stdout } = await run(["--version"], envWithoutOpenl());
      expect(code).toBe(0);
      expect(stdout).toMatch(/openl-mcp-server \d+\.\d+\.\d+/);
    });

    it("--help prints usage and exits 0 (no config needed)", async () => {
      const { code, stdout } = await run(["--help"], envWithoutOpenl());
      expect(code).toBe(0);
      expect(stdout).toContain("Usage:");
      expect(stdout).toContain("Available tools");
    });

    it("a typo'd tool with no config exits EX_USAGE (64)", async () => {
      const { code, stderr } = await run(["openl_typo_tool"], envWithoutOpenl());
      expect(code).toBe(64);
      expect(stderr).toContain("Unknown tool");
    });

    it("a valid tool with no config exits EX_CONFIG (78) via the CLI loader", async () => {
      const { code, stderr } = await run(["openl_list_repositories"], envWithoutOpenl());
      expect(code).toBe(78);
      // CLI-mode message (distinct from the MCP-mode message asserted below)
      expect(stderr).toContain("--base-url");
    });
  });

  describe("MCP-mode dispatch (no argv)", () => {
    it("no arguments routes to the stdio MCP path, not CLI", async () => {
      // With no args and no OPENL_BASE_URL, main() takes the MCP branch and
      // loadConfigFromEnv throws its OWN message ("environment variable is
      // required") — distinct from the CLI loader's "--base-url" hint. This
      // proves the dispatch routed to MCP, not CLI.
      const { code, stderr } = await run([], envWithoutOpenl());
      expect(code).toBe(1);
      expect(stderr).toContain("OPENL_BASE_URL environment variable is required");
      expect(stderr).not.toContain("--base-url");
    });
  });

  describe("EPIPE handling", () => {
    it("does not crash when stdout is closed early (e.g. piped to head)", async () => {
      const child = spawn(process.execPath, [distEntry, "--list-tools"], {
        cwd: root,
        env: envWithoutOpenl(),
      });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d.toString()));
      // Close our read end after the first chunk → child's next write to the
      // pipe gets EPIPE, which the handler must swallow (exit 0), not crash.
      child.stdout.on("data", () => child.stdout.destroy());

      const code: number = await new Promise((resolve) => {
        child.on("close", (c) => resolve(c ?? 0));
      });

      expect(stderr).not.toContain("EPIPE");
      expect(code).toBe(0);
    });
  });

  // No persistent processes are spawned (every command terminates), so there's
  // nothing to tear down — present for symmetry / future additions.
  afterAll(() => {});
});
