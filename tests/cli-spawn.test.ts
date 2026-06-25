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
import { existsSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
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
      // Keep this below Jest's default per-test timeout (10s) so a stalled
      // child is killed here — yielding the deterministic exit code mapped
      // below — instead of Jest aborting first with an opaque timeout.
      { cwd: root, env, timeout: 8000 },
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

/** Reserve an ephemeral TCP port, then release it for the child to bind. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        srv.close(() => resolve(addr.port));
      } else {
        srv.close(() => reject(new Error("could not determine a free port")));
      }
    });
  });
}

/** Poll the HTTP server's /health endpoint until it accepts connections. */
async function waitForHealth(port: number, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`HTTP server on port ${port} never became healthy: ${String(lastErr)}`);
}

describe("built binary (dist/index.js)", () => {
  beforeAll(() => {
    // Rebuild only if dist is missing or older than the entry/dispatch sources.
    const srcs = ["src/index.ts", "src/cli.ts", "src/stdio-server.ts", "src/http-server.ts"].map((p) => join(root, p));
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
      expect(stdout).toMatch(/openl-mcp \d+\.\d+\.\d+/);
    });

    it("--help prints usage and exits 0 (no config needed)", async () => {
      const { code, stdout } = await run(["--help"], envWithoutOpenl());
      expect(code).toBe(0);
      expect(stdout).toContain("Usage:");
      expect(stdout).toContain("Available tools");
      // The positional <url> form and the env-var fallback must be documented.
      expect(stdout).toContain("openl-mcp <url>");
      expect(stdout).toContain("OPENL_BASE_URL");
    });

    it("a typo'd tool with no config exits EX_USAGE (64)", async () => {
      const { code, stderr } = await run(["typo_tool"], envWithoutOpenl());
      expect(code).toBe(64);
      expect(stderr).toContain("Unknown tool");
    });

    it("a valid tool with no config exits EX_CONFIG (78) via the CLI loader", async () => {
      const { code, stderr } = await run(["list_repositories"], envWithoutOpenl());
      expect(code).toBe(78);
      // CLI-mode message (distinct from the MCP-mode message asserted below)
      expect(stderr).toContain("--base-url");
    });
  });

  describe("MCP-mode dispatch (no argv)", () => {
    it("no arguments routes to the stdio MCP path, not CLI", async () => {
      // With no args and no OPENL_BASE_URL, main() takes the MCP branch and
      // emits the server-launch usage hint (exit 1) — which names BOTH the
      // positional argument and OPENL_BASE_URL, and crucially does NOT mention
      // the CLI loader's "--base-url" flag. That absence proves the dispatch
      // routed to MCP, not CLI.
      const { code, stderr } = await run([], envWithoutOpenl());
      expect(code).toBe(1);
      expect(stderr).toContain("OPENL_BASE_URL");
      expect(stderr).toMatch(/positional argument|openl-mcp <url>/);
      expect(stderr).not.toContain("--base-url");
    });

    it("an invalid base URL fails early with a readable error, not a stack trace", async () => {
      // Server-launch URL validation (new URL()) must surface a readable
      // message and exit 1 — not leak a stack trace or escape to the outer
      // "Failed to start" catch.
      const { code, stderr } = await run([], { ...envWithoutOpenl(), OPENL_BASE_URL: "not-a-url" });
      expect(code).toBe(1);
      expect(stderr).toMatch(/Invalid OpenL base URL/i);
      expect(stderr).not.toMatch(/^\s*at\s/m); // no stack frames
      expect(stderr).not.toContain("Failed to start OpenL MCP server");
    });

    it("warns that --cookie-jar is ignored on the server path", async () => {
      // --cookie-jar only applies to single CLI tool calls. With no tool name
      // it routes to the server launch; the binary warns, then still reports
      // the missing URL and exits 1 (no hang, no silent no-op).
      const { code, stderr } = await run(["--cookie-jar", "/tmp/jar.json"], envWithoutOpenl());
      expect(code).toBe(1);
      expect(stderr).toContain("--cookie-jar is ignored");
    });
  });

  describe("positional <url> argument", () => {
    it("accepts a positional URL as the base URL in tool mode (no env needed)", async () => {
      // `<url> <tool>` with the URL pointing at a closed port: the positional
      // URL is accepted as the base URL (no usage/config error), and the call
      // then fails to connect. This proves the URL flowed through to the client
      // rather than being mistaken for a tool name. No token is configured, so
      // the request is made unauthenticated.
      const { code, stderr } = await run(
        ["http://127.0.0.1:59999", "list_repositories"],
        envWithoutOpenl(),
      );
      // ECONNREFUSED on the closed port maps to EX_UNAVAILABLE (69). Pinning
      // the exact code proves the positional URL flowed through as the base URL
      // (a USAGE/CONFIG/unknown-tool path would not reach the network) AND that
      // the prefix-less tool name (`list_repositories`) resolved end-to-end in
      // the built binary, not just in-process.
      expect(code).toBe(69);
      expect(stderr).not.toContain("Unknown tool"); // URL wasn't treated as a tool name
      expect(stderr).not.toMatch(/base URL is required|Invalid OpenL base URL/i);
    });

    it("a malformed positional in tool position is treated as a tool name (USAGE)", async () => {
      // `mailto:x` is a URL but not http(s), so it is NOT taken as a base URL;
      // it falls through to the tool-name slot and is rejected as unknown.
      const { code, stderr } = await run(["mailto:nobody@example.com"], envWithoutOpenl());
      expect(code).toBe(64);
      expect(stderr).toContain("Unknown tool");
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

  describe("bin-symlink launch (global install / npm .bin shim)", () => {
    it("runs main() when invoked through a symlink whose name is not index.js", async () => {
      // npm exposes the binary as a symlink named `openl-mcp`
      // (e.g. node_modules/.bin or the global bin dir). When launched that way,
      // process.argv[1] is the unresolved symlink path — NOT ".../index.js" —
      // so the entry-point check must resolve realpaths or main() never runs.
      const dir = mkdtempSync(join(tmpdir(), "openl-binlink-"));
      try {
        const link = join(dir, "openl-mcp"); // name deliberately != index.js
        symlinkSync(distEntry, link);
        // Invoke `node <symlink> --version`: argv[1] is the symlink path.
        const { code, stdout } = await new Promise<{ code: number; stdout: string }>((resolve) => {
          execFile(process.execPath, [link, "--version"], { cwd: root, env: envWithoutOpenl(), timeout: 15000 }, (err, out) => {
            resolve({ code: err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? (err as unknown as { code: number }).code : err ? 1 : 0, stdout: out });
          });
        });
        expect(code).toBe(0);
        expect(stdout).toMatch(/openl-mcp \d+\.\d+\.\d+/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("MCP protocol boundary (stdio)", () => {
    it("tools/list advertises openl_-prefixed names (prefix added on the wire, not the registry)", async () => {
      // A positional URL starts the stdio MCP server. We speak newline-delimited
      // JSON-RPC: initialize → initialized → tools/list, and assert the advertised
      // names carry the openl_ prefix — even though the registry and CLI are bare.
      const child = spawn(process.execPath, [distEntry, "http://localhost:8080"], {
        cwd: root,
        env: envWithoutOpenl(),
      });
      try {
        let buf = "";
        const response = await new Promise<{ result: { tools: Array<{ name: string }> } }>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`timed out waiting for tools/list; got: ${buf.slice(0, 400)}`)),
            8000,
          );
          child.stdout.on("data", (d) => {
            buf += d.toString();
            for (const line of buf.split("\n")) {
              const t = line.trim();
              if (!t.startsWith("{")) continue;
              try {
                const msg = JSON.parse(t);
                if (msg.id === 2) {
                  clearTimeout(timer);
                  resolve(msg);
                }
              } catch {
                /* partial/!json line — keep accumulating */
              }
            }
          });
          child.on("error", reject);
          const send = (o: unknown) => child.stdin.write(JSON.stringify(o) + "\n");
          send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        });

        const names = response.result.tools.map((t) => t.name);
        expect(names.length).toBeGreaterThan(0);
        expect(names.every((n) => n.startsWith("openl_"))).toBe(true);
        expect(names).toContain("openl_list_repositories");
      } finally {
        child.stdin.end();
        child.kill();
      }
    }, 20000);
  });

  describe("HTTP-mode dispatch (--http)", () => {
    it("wires the positional <url> into the HTTP server (no OPENL_BASE_URL needed)", async () => {
      // Regression for the compose.yaml form `openl-mcp <url> --http`: the
      // dispatcher must forward the positional URL to the HTTP transport.
      // Before the fix it dropped it and the server only read OPENL_BASE_URL,
      // so every request failed with "No OpenL client available". `initialize`
      // makes no upstream call, so an unreachable host still proves the URL
      // flowed through and the default client was created.
      const port = await getFreePort();
      const child = spawn(
        process.execPath,
        [distEntry, "http://studio.invalid:8080", "--http"],
        { cwd: root, env: { ...envWithoutOpenl(), PORT: String(port) } },
      );
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d.toString()));
      try {
        await waitForHealth(port);
        const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
          }),
        });
        const body = await res.text();
        expect(res.status).toBe(200);
        expect(body).toContain('"serverInfo"'); // a real initialize result
        expect(body).not.toContain("No OpenL client available");
        expect(stderr).not.toContain("No OpenL client available");
      } finally {
        child.kill();
      }
    }, 20000);
  });

  // Every command terminates on its own except the `--http` server above, which
  // is killed in that test's own `finally` — so there's nothing left to tear
  // down here; present for symmetry / future additions.
  afterAll(() => {});
});
