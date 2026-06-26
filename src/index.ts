#!/usr/bin/env node

/**
 * OpenL MCP Server — binary entry point
 *
 * Model Context Protocol server for OpenL Studio Rules Management System.
 *
 * This file is only the dispatcher: it inspects how the binary was invoked and
 * routes to one of three modes, each implemented in a sibling module that is
 * lazy-imported so a launch loads only the code it needs:
 * - stdio transport — `src/stdio-server.ts`
 * - Streamable HTTP transport — `src/http-server.ts`
 * - CLI / direct tool invocation — `src/cli.ts`
 *
 * @see https://github.com/openl-tablets/openl-mcp
 * @see https://modelcontextprotocol.io/
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { sanitizeError } from "./utils.js";

/**
 * Main entry point.
 *
 * Dispatches based on how the binary was invoked:
 * - `--http` flag → start the Express Streamable HTTP transport (Docker /
 *   `npm run start:http`). The base URL comes from the positional `<url>` /
 *   `--base-url`, falling back to `OPENL_BASE_URL`; the port comes from `PORT`;
 *   auth is per-session via the Authorization header. See `src/http-server.ts`.
 * - A tool name or discovery flag → CLI mode (direct API invocation via
 *   `executeTool`). See `src/cli.ts`.
 * - Otherwise (no args, or just a positional `<url>` / server flags) → start
 *   the MCP server on stdio (Claude Desktop / Cursor / other MCP clients).
 *   See `src/stdio-server.ts`.
 */
async function main(): Promise<void> {
  try {
    const cliArgs = process.argv.slice(2);

    // Browser-auth subcommands. `login` / `logout` are handled before tool/CLI
    // routing (otherwise `login` would be misread as a tool name). Lazy-imported
    // so a normal server/CLI launch never loads the OAuth/loopback code.
    if (cliArgs[0] === "login" || cliArgs[0] === "logout") {
      const { runLoginCli } = await import("./login.js");
      process.exit(await runLoginCli(cliArgs));
    }

    const { parseArgs, isCliInvocation, runCli } = await import("./cli.js");

    // HTTP transport. `--http` is not a tool flag, so strip it before parsing,
    // then forward the resolved base URL (positional `<url>` / `--base-url`) so
    // `openl-mcp <url> --http` works — matching stdio and the documented
    // precedence (positional `<url>` > `--base-url` > `OPENL_BASE_URL`).
    // Lazy-import so a stdio/CLI launch never loads Express.
    if (cliArgs.includes("--http")) {
      const httpArgs = parseArgs(cliArgs.filter((arg) => arg !== "--http"));
      const { startHttpServer } = await import("./http-server.js");
      await startHttpServer({
        baseUrl: httpArgs.baseUrlPositional ?? httpArgs.overrides.baseUrl,
      });
      return;
    }

    const parsed = parseArgs(cliArgs);

    if (isCliInvocation(parsed)) {
      // CLI/tool mode: a tool name, a discovery flag (--help/--list-tools/
      // --version), a tool-argument source, or a parse error.
      //
      // EPIPE handling: when our stdout is piped into something that exits
      // early (`npx … | head -1`), the next write would throw EPIPE and crash
      // the process. Treat it as a successful early termination — exit 0.
      // See https://github.com/nodejs/node-v0.x-archive/issues/3211
      process.stdout.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EPIPE") process.exit(0);
        throw err;
      });

      const code = await runCli({ argv: cliArgs });
      process.exit(code);
    }

    // Default: launch the MCP server on the stdio transport.
    const { startStdioServer } = await import("./stdio-server.js");
    await startStdioServer(parsed);
  } catch (error: unknown) {
    const sanitizedMessage = sanitizeError(error);
    console.error("Failed to start OpenL MCP server:", sanitizedMessage);
    process.exit(1);
  }
}

/**
 * True when this module is the process entry point (run directly), false when
 * it's merely imported (e.g. by the test suite, which must not start a server).
 *
 * Compares the realpath of `process.argv[1]` to this module's own path. Using
 * realpaths is essential: when the binary is launched through a `bin` symlink
 * — which is how a global install (`npm i -g`) and npm's `.bin/` shims invoke
 * it — `process.argv[1]` is the UNRESOLVED symlink path (e.g. `.../bin/openl-
 * mcp-server`), so the previous `=== file://argv[1]` / `endsWith('index.js')`
 * check missed it and `main()` never ran. realpath resolves the symlink to the
 * real `dist/index.js`, and also smooths over platform path quirks (e.g. macOS
 * `/tmp` → `/private/tmp`). Falls back to `false` if the path can't be resolved.
 */
function isMainEntryPoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainEntryPoint()) {
  main();
}
