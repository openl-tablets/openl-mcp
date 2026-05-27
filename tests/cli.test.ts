/**
 * Tests for the CLI mode (`src/cli.ts`).
 *
 * Drives `runCli` with injected stdin/stdout/stderr and a mock-wrapped
 * OpenLClient. No child processes, no real network — purely in-process
 * so it integrates with the existing axios-mock-adapter setup.
 */

import { afterEach, describe, expect, it } from "@jest/globals";
import MockAdapter from "axios-mock-adapter";
import { Readable, Writable } from "node:stream";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EXIT_CODES, runCli } from "../src/cli.js";
import { OpenLClient } from "../src/client.js";
import type { OpenLConfig } from "../src/types.js";
import { mockRepositories } from "./mocks/openl-api-mocks.js";

/**
 * Build a captured-output harness for one CLI invocation.
 */
function createHarness(stdinText = "") {
  let stdoutBuf = "";
  let stderrBuf = "";
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      stdoutBuf += chunk.toString();
      cb();
    },
  });
  const stderr = new Writable({
    write(chunk, _enc, cb) {
      stderrBuf += chunk.toString();
      cb();
    },
  });
  const stdin = Readable.from(stdinText, { objectMode: false });
  return {
    stdout,
    stderr,
    stdin,
    getStdout: () => stdoutBuf,
    getStderr: () => stderrBuf,
  };
}

/**
 * Build a client + axios mock for tests that need to hit the OpenL API.
 */
function createMockClient(): { client: OpenLClient; mock: MockAdapter } {
  const config: OpenLConfig = {
    baseUrl: "http://localhost:8080",
    username: "admin",
    password: "admin",
  };
  const client = new OpenLClient(config);
  // @ts-ignore Access private axios instance for mocking, mirrors mcp-server.test.ts
  const mock = new MockAdapter(client.axiosInstance);
  return { client, mock };
}

const ENV_OK = {
  OPENL_BASE_URL: "http://localhost:8080",
  OPENL_USERNAME: "admin",
  OPENL_PASSWORD: "admin",
};

describe("CLI", () => {
  let mock: MockAdapter | undefined;

  afterEach(() => {
    if (mock) {
      mock.restore();
      mock = undefined;
    }
  });

  describe("--help", () => {
    it("prints usage and tool list, returns 0", async () => {
      const h = createHarness();
      const code = await runCli({
        argv: ["--help"],
        env: {},
        stdin: h.stdin,
        stdout: h.stdout,
        stderr: h.stderr,
      });
      expect(code).toBe(0);
      expect(h.getStdout()).toContain("Usage:");
      expect(h.getStdout()).toContain("openl_list_repositories");
      expect(h.getStdout()).toContain("--base-url");
    });
  });

  describe("--list-tools", () => {
    it("returns JSON schema dump for all tools", async () => {
      const { client } = createMockClient();
      const h = createHarness();
      const code = await runCli({
        argv: ["--list-tools"],
        env: ENV_OK,
        stdin: h.stdin,
        stdout: h.stdout,
        stderr: h.stderr,
        clientFactory: () => client,
      });
      expect(code).toBe(0);
      const parsed = JSON.parse(h.getStdout());
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed[0]).toHaveProperty("name");
      expect(parsed[0]).toHaveProperty("inputSchema");
    });

    it("works without any config (pure discovery, no auth needed)", async () => {
      const h = createHarness();
      const code = await runCli({
        argv: ["--list-tools"],
        env: {}, // no OPENL_BASE_URL, no auth
        stdin: h.stdin,
        stdout: h.stdout,
        stderr: h.stderr,
      });
      expect(code).toBe(0);
      expect(h.getStderr()).toBe("");
      const parsed = JSON.parse(h.getStdout());
      expect(parsed.length).toBeGreaterThan(0);
    });
  });

  describe("happy path", () => {
    it("invokes openl_list_repositories with inline JSON and writes result to stdout", async () => {
      const { client, mock: m } = createMockClient();
      mock = m;
      m.onGet("/repos").reply(200, mockRepositories);

      const h = createHarness();
      const code = await runCli({
        argv: ["openl_list_repositories", '{"response_format":"json"}'],
        env: ENV_OK,
        stdin: h.stdin,
        stdout: h.stdout,
        stderr: h.stderr,
        clientFactory: () => client,
      });

      expect(code).toBe(0);
      expect(h.getStdout()).toContain("Design Repository");
      expect(h.getStderr()).toBe("");
    });

    it("reads tool args from --stdin", async () => {
      const { client, mock: m } = createMockClient();
      mock = m;
      m.onGet("/repos").reply(200, mockRepositories);

      const h = createHarness('{"response_format":"json"}');
      const code = await runCli({
        argv: ["openl_list_repositories", "--stdin"],
        env: ENV_OK,
        stdin: h.stdin,
        stdout: h.stdout,
        stderr: h.stderr,
        clientFactory: () => client,
      });

      expect(code).toBe(0);
      expect(h.getStdout()).toContain("Design Repository");
    });

    it("reads tool args from @file", async () => {
      const dir = await mkdtemp(join(tmpdir(), "openl-cli-test-"));
      try {
        const file = join(dir, "args.json");
        await writeFile(file, '{"response_format":"json"}');

        const { client, mock: m } = createMockClient();
        mock = m;
        m.onGet("/repos").reply(200, mockRepositories);

        const h = createHarness();
        const code = await runCli({
          argv: ["openl_list_repositories", `@${file}`],
          env: ENV_OK,
          stdin: h.stdin,
          stdout: h.stdout,
          stderr: h.stderr,
          clientFactory: () => client,
        });

        expect(code).toBe(0);
        expect(h.getStdout()).toContain("Design Repository");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("works with no tool args (calls executeTool with undefined)", async () => {
      const { client, mock: m } = createMockClient();
      mock = m;
      m.onGet("/repos").reply(200, mockRepositories);

      const h = createHarness();
      const code = await runCli({
        argv: ["openl_list_repositories"],
        env: ENV_OK,
        stdin: h.stdin,
        stdout: h.stdout,
        stderr: h.stderr,
        clientFactory: () => client,
      });

      expect(code).toBe(0);
      expect(h.getStdout()).toContain("Design Repository");
    });

    it("honors CLI flag overrides for auth", async () => {
      const { client, mock: m } = createMockClient();
      mock = m;
      m.onGet("/repos").reply(200, mockRepositories);

      const h = createHarness();
      const code = await runCli({
        argv: [
          "openl_list_repositories",
          "--base-url",
          "http://localhost:8080",
          "--user",
          "admin",
          "--password",
          "admin",
        ],
        env: {}, // no env config — overrides should fill in
        stdin: h.stdin,
        stdout: h.stdout,
        stderr: h.stderr,
        clientFactory: () => client,
      });

      expect(code).toBe(0);
      expect(h.getStdout()).toContain("Design Repository");
    });

    it("propagates --client-document-id to process.env for the interceptor", async () => {
      const { client, mock: m } = createMockClient();
      mock = m;
      m.onGet("/repos").reply(200, mockRepositories);

      const prev = process.env.OPENL_CLIENT_DOCUMENT_ID;
      delete process.env.OPENL_CLIENT_DOCUMENT_ID;

      // Capture the doc id seen inside the run via a custom factory.
      let seenAtRun: string | undefined;
      try {
        const h = createHarness();
        const code = await runCli({
          argv: ["openl_list_repositories", "--client-document-id", "ticket-42"],
          env: ENV_OK,
          stdin: h.stdin,
          stdout: h.stdout,
          stderr: h.stderr,
          clientFactory: (config) => {
            seenAtRun = process.env.OPENL_CLIENT_DOCUMENT_ID;
            return client;
          },
        });
        expect(code).toBe(0);
        expect(seenAtRun).toBe("ticket-42");
        // Restored after runCli completes
        expect(process.env.OPENL_CLIENT_DOCUMENT_ID).toBeUndefined();
      } finally {
        if (prev !== undefined) process.env.OPENL_CLIENT_DOCUMENT_ID = prev;
      }
    });

    it("defaults to markdown when caller omits response_format (agent-first)", async () => {
      const { client, mock: m } = createMockClient();
      mock = m;
      m.onGet("/repos").reply(200, mockRepositories);

      const h = createHarness();
      const code = await runCli({
        argv: ["openl_list_repositories"], // no args at all
        env: ENV_OK,
        stdin: h.stdin,
        stdout: h.stdout,
        stderr: h.stderr,
        clientFactory: () => client,
      });

      expect(code).toBe(0);
      // Markdown output contains the repo name but is NOT valid JSON
      // (markdown wraps content in headings/sections).
      expect(h.getStdout()).toContain("Design Repository");
      expect(() => JSON.parse(h.getStdout())).toThrow();
    });

    it("honors explicit response_format=json for pipe-friendly output", async () => {
      const { client, mock: m } = createMockClient();
      mock = m;
      m.onGet("/repos").reply(200, mockRepositories);

      const h = createHarness();
      const code = await runCli({
        argv: ["openl_list_repositories", '{"response_format":"json"}'],
        env: ENV_OK,
        stdin: h.stdin,
        stdout: h.stdout,
        stderr: h.stderr,
        clientFactory: () => client,
      });

      expect(code).toBe(0);
      // Explicit json → parseable
      const parsed = JSON.parse(h.getStdout());
      expect(parsed).toBeDefined();
    });

    it("sets OPENL_CLI_QUIET=1 during the run and restores afterwards", async () => {
      const { client, mock: m } = createMockClient();
      mock = m;
      m.onGet("/repos").reply(200, mockRepositories);

      const prev = process.env.OPENL_CLI_QUIET;
      delete process.env.OPENL_CLI_QUIET;

      let seenAtRun: string | undefined;
      try {
        const h = createHarness();
        const code = await runCli({
          argv: ["openl_list_repositories"],
          env: ENV_OK,
          stdin: h.stdin,
          stdout: h.stdout,
          stderr: h.stderr,
          clientFactory: (config) => {
            seenAtRun = process.env.OPENL_CLI_QUIET;
            return client;
          },
        });
        expect(code).toBe(0);
        expect(seenAtRun).toBe("1");
        expect(process.env.OPENL_CLI_QUIET).toBeUndefined();
      } finally {
        if (prev !== undefined) process.env.OPENL_CLI_QUIET = prev;
      }
    });
  });

  describe("--cookie-jar", () => {
    it("writes captured JSESSIONID to the jar after a tool call", async () => {
      const dir = await mkdtemp(join(tmpdir(), "openl-cli-jar-"));
      try {
        const jarPath = join(dir, "session.jar");
        const { client, mock: m } = createMockClient();
        mock = m;
        // Server returns a Set-Cookie header, the client's interceptor
        // should capture it and store on the instance.
        m.onGet("/repos").reply(200, mockRepositories, {
          "set-cookie": "JSESSIONID=abc123session; Path=/; HttpOnly",
        });

        const h = createHarness();
        const code = await runCli({
          argv: ["openl_list_repositories", "--cookie-jar", jarPath],
          env: ENV_OK,
          stdin: h.stdin,
          stdout: h.stdout,
          stderr: h.stderr,
          clientFactory: () => client,
        });
        expect(code).toBe(0);

        const persisted = (await readFile(jarPath, "utf-8")).trim();
        expect(persisted).toBe("abc123session");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("restores JSESSIONID from the jar on the next invocation", async () => {
      const dir = await mkdtemp(join(tmpdir(), "openl-cli-jar-"));
      try {
        const jarPath = join(dir, "session.jar");
        await writeFile(jarPath, "prevsession789\n");

        const { client, mock: m } = createMockClient();
        mock = m;
        // Capture the Cookie header the client sends.
        let sentCookie: string | undefined;
        m.onGet("/repos").reply((config) => {
          sentCookie = (config.headers?.Cookie || config.headers?.cookie) as string | undefined;
          return [200, mockRepositories];
        });

        const h = createHarness();
        const code = await runCli({
          argv: ["openl_list_repositories", "--cookie-jar", jarPath],
          env: ENV_OK,
          stdin: h.stdin,
          stdout: h.stdout,
          stderr: h.stderr,
          clientFactory: () => client,
        });
        expect(code).toBe(0);
        expect(sentCookie).toContain("JSESSIONID=prevsession789");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("treats a missing jar file as a fresh session (no error)", async () => {
      const dir = await mkdtemp(join(tmpdir(), "openl-cli-jar-"));
      try {
        const jarPath = join(dir, "does-not-exist-yet.jar");
        const { client, mock: m } = createMockClient();
        mock = m;
        m.onGet("/repos").reply(200, mockRepositories);

        const h = createHarness();
        const code = await runCli({
          argv: ["openl_list_repositories", "--cookie-jar", jarPath],
          env: ENV_OK,
          stdin: h.stdin,
          stdout: h.stdout,
          stderr: h.stderr,
          clientFactory: () => client,
        });
        expect(code).toBe(0);
        expect(h.getStderr()).toBe("");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("skips writing when no session cookie was established", async () => {
      const dir = await mkdtemp(join(tmpdir(), "openl-cli-jar-"));
      try {
        const jarPath = join(dir, "session.jar");
        const { client, mock: m } = createMockClient();
        mock = m;
        // No Set-Cookie in response — client never captures a session.
        m.onGet("/repos").reply(200, mockRepositories);

        const h = createHarness();
        const code = await runCli({
          argv: ["openl_list_repositories", "--cookie-jar", jarPath],
          env: ENV_OK,
          stdin: h.stdin,
          stdout: h.stdout,
          stderr: h.stderr,
          clientFactory: () => client,
        });
        expect(code).toBe(0);

        // Jar should not exist (or be empty) — nothing to persist.
        let written = "";
        try {
          written = await readFile(jarPath, "utf-8");
        } catch (error) {
          // ENOENT is the expected outcome here (no jar written because
          // the stateless endpoint didn't set a session cookie). Anything
          // else — permissions, I/O — should surface as a test failure.
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        expect(written).toBe("");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("error handling", () => {
    it("returns EX_CONFIG (78) when OPENL_BASE_URL is missing", async () => {
      const h = createHarness();
      const code = await runCli({
        argv: ["openl_list_repositories", "{}"],
        env: {},
        stdin: h.stdin,
        stdout: h.stdout,
        stderr: h.stderr,
      });
      expect(code).toBe(EXIT_CODES.CONFIG);
      expect(h.getStderr()).toContain("OPENL_BASE_URL");
    });

    it("returns EX_CONFIG (78) when no auth method is configured", async () => {
      const h = createHarness();
      const code = await runCli({
        argv: ["openl_list_repositories", "{}"],
        env: { OPENL_BASE_URL: "http://localhost:8080" },
        stdin: h.stdin,
        stdout: h.stdout,
        stderr: h.stderr,
      });
      expect(code).toBe(EXIT_CODES.CONFIG);
      expect(h.getStderr()).toContain("Authentication required");
    });

    it("returns EX_USAGE (64) on unknown flag", async () => {
      const h = createHarness();
      const code = await runCli({
        argv: ["--bogus"],
        env: ENV_OK,
        stdin: h.stdin,
        stdout: h.stdout,
        stderr: h.stderr,
      });
      expect(code).toBe(EXIT_CODES.USAGE);
      expect(h.getStderr()).toContain("Unknown flag");
    });

    it("returns EX_USAGE (64) when tool name is missing", async () => {
      const h = createHarness();
      const code = await runCli({
        argv: ['{"response_format":"json"}'],
        env: ENV_OK,
        stdin: h.stdin,
        stdout: h.stdout,
        stderr: h.stderr,
      });
      expect(code).toBe(EXIT_CODES.USAGE);
      expect(h.getStderr()).toContain("tool name is required");
    });

    it("returns EX_DATAERR (65) on malformed JSON args", async () => {
      const { client } = createMockClient();
      const h = createHarness();
      const code = await runCli({
        argv: ["openl_list_repositories", "{not-json"],
        env: ENV_OK,
        stdin: h.stdin,
        stdout: h.stdout,
        stderr: h.stderr,
        clientFactory: () => client,
      });
      expect(code).toBe(EXIT_CODES.DATAERR);
      expect(h.getStderr()).toContain("Failed to parse tool arguments as JSON");
    });

    it("returns EX_USAGE (64) when more than one args source is provided", async () => {
      const h = createHarness();
      const code = await runCli({
        argv: ["openl_list_repositories", "{}", "--stdin"],
        env: ENV_OK,
        stdin: h.stdin,
        stdout: h.stdout,
        stderr: h.stderr,
      });
      expect(code).toBe(EXIT_CODES.USAGE);
      expect(h.getStderr()).toContain("only one of");
    });

    it("returns EX_USAGE (64) for unknown tool name", async () => {
      const { client } = createMockClient();
      const h = createHarness();
      const code = await runCli({
        argv: ["openl_does_not_exist", "{}"],
        env: ENV_OK,
        stdin: h.stdin,
        stdout: h.stdout,
        stderr: h.stderr,
        clientFactory: () => client,
      });
      // Unknown tool is a "user typed the wrong name" case — same category
      // as a typo'd flag — so the runCli pre-checks the registry before
      // dispatching to executeTool and returns EX_USAGE (consistent with
      // the `<tool> --help` path for the same error).
      expect(code).toBe(EXIT_CODES.USAGE);
      expect(h.getStderr()).toContain("Unknown tool");
    });

    it("returns EX_CONFIG (78) when --base-url is invalid", async () => {
      const h = createHarness();
      const code = await runCli({
        argv: ["openl_list_repositories", "{}", "--base-url", "not-a-url"],
        env: { OPENL_USERNAME: "admin", OPENL_PASSWORD: "admin" },
        stdin: h.stdin,
        stdout: h.stdout,
        stderr: h.stderr,
      });
      expect(code).toBe(EXIT_CODES.CONFIG);
      expect(h.getStderr()).toContain("Invalid base URL");
    });
  });

  describe("--version", () => {
    it("prints version and exits 0 with no config", async () => {
      const h = createHarness();
      const code = await runCli({
        argv: ["--version"],
        env: {},
        stdin: h.stdin,
        stdout: h.stdout,
        stderr: h.stderr,
      });
      expect(code).toBe(EXIT_CODES.OK);
      expect(h.getStdout()).toMatch(/openl-mcp-server \d+\.\d+\.\d+/);
      expect(h.getStderr()).toBe("");
    });

    it("supports the -V short form", async () => {
      const h = createHarness();
      const code = await runCli({
        argv: ["-V"],
        env: {},
        stdin: h.stdin,
        stdout: h.stdout,
        stderr: h.stderr,
      });
      expect(code).toBe(EXIT_CODES.OK);
      expect(h.getStdout()).toMatch(/openl-mcp-server \d+\.\d+\.\d+/);
    });
  });

  describe("tool-specific --help", () => {
    it("renders schema details when a known tool is passed with --help", async () => {
      const h = createHarness();
      const code = await runCli({
        argv: ["openl_list_repositories", "--help"],
        env: {},
        stdin: h.stdin,
        stdout: h.stdout,
        stderr: h.stderr,
      });
      expect(code).toBe(EXIT_CODES.OK);
      const out = h.getStdout();
      expect(out).toContain("openl_list_repositories");
      expect(out).toContain("Arguments:");
      expect(out).toContain("response_format");
    });

    it("returns EX_USAGE (64) for unknown tool with --help", async () => {
      const h = createHarness();
      const code = await runCli({
        argv: ["openl_fake_tool_xyz", "--help"],
        env: {},
        stdin: h.stdin,
        stdout: h.stdout,
        stderr: h.stderr,
      });
      expect(code).toBe(EXIT_CODES.USAGE);
      expect(h.getStderr()).toContain("Unknown tool");
    });
  });

  describe("documentation consistency", () => {
    /**
     * Defends against the class of bug where help text or README examples
     * reference a tool that's been disabled or renamed. Extracts every
     * `openl_*` token from the rendered global help and asserts each is
     * actually registered.
     */
    it("every openl_* tool name in --help refers to a registered tool", async () => {
      const h = createHarness();
      const code = await runCli({
        argv: ["--help"],
        env: {},
        stdin: h.stdin,
        stdout: h.stdout,
        stderr: h.stderr,
      });
      expect(code).toBe(EXIT_CODES.OK);

      const cited = new Set(h.getStdout().match(/openl_[a-z_]+/g) ?? []);
      // --list-tools dump → array of registered tool definitions
      const listH = createHarness();
      const listCode = await runCli({
        argv: ["--list-tools"],
        env: {},
        stdin: listH.stdin,
        stdout: listH.stdout,
        stderr: listH.stderr,
      });
      // Guard against the second invocation silently failing — without this,
      // a broken --list-tools could still leave partial JSON that parses
      // and the regression check would pass for the wrong reason.
      expect(listCode).toBe(EXIT_CODES.OK);
      const registered = new Set(
        (JSON.parse(listH.getStdout()) as Array<{ name: string }>).map((t) => t.name),
      );

      const missing = [...cited].filter((name) => !registered.has(name));
      expect(missing).toEqual([]);
    });
  });

  describe("--help grouping", () => {
    it("groups tools by category in --help output", async () => {
      const h = createHarness();
      const code = await runCli({
        argv: ["--help"],
        env: {},
        stdin: h.stdin,
        stdout: h.stdout,
        stderr: h.stderr,
      });
      expect(code).toBe(EXIT_CODES.OK);
      const out = h.getStdout();
      // Spot-check each category header is rendered
      expect(out).toContain("Repository:");
      expect(out).toContain("Project:");
      expect(out).toContain("Rules & Tables:");
      expect(out).toContain("Trace (BETA):");
      expect(out).toContain("Deployment:");
    });
  });
});
