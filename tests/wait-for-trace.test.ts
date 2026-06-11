/**
 * Unit tests for the websocket-based trace wait (EPBDS-16089).
 *
 * The STOMP subscription is injected via the `subscribeImpl` test seam (same
 * pattern as wait-for-compilation.test.ts), so these tests run entirely
 * in-memory — no network, no axios mocks.
 */

import { describe, it, expect, jest } from "@jest/globals";
import { AxiosError, AxiosHeaders } from "axios";

import {
  executeTraceReadWithWait,
  parseTraceStatusFrame,
  TraceExecutionFailedError,
  TraceWaitTimeoutError,
  TraceWaitUnavailableError,
} from "../src/wait-for-trace.js";
import type { OpenLClient } from "../src/client.js";
import type { SubscribeTopicOpts, Subscription } from "../src/stomp-client.js";

function make409(): AxiosError {
  const err = new AxiosError("Request failed with status code 409");
  err.response = {
    status: 409,
    statusText: "Conflict",
    data: { message: "trace.execution.not.completed.message" },
    headers: {},
    config: { headers: new AxiosHeaders() },
  };
  return err;
}

interface FakeStomp {
  subscribe: (opts: SubscribeTopicOpts) => Promise<Subscription>;
  emit(body: string): void;
  closeSpy: jest.Mock<() => Promise<void>>;
  lastOpts(): SubscribeTopicOpts | null;
}

function makeFakeStomp(): FakeStomp {
  let onFrame: ((body: string) => void) | null = null;
  let opts: SubscribeTopicOpts | null = null;
  const closeSpy = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  return {
    subscribe: async (o: SubscribeTopicOpts) => {
      opts = o;
      onFrame = o.onFrame;
      return { close: closeSpy };
    },
    emit(body: string) {
      if (!onFrame) throw new Error("emit called before subscribe");
      onFrame(body);
    },
    closeSpy,
    lastOpts: () => opts,
  };
}

function makeClient(overrides: Partial<{ cookie: string | null; auth: string | undefined }> = {}): OpenLClient {
  return {
    getSessionCookie: () => (overrides.cookie === undefined ? "abc123" : overrides.cookie),
    getAuthorizationHeader: () => (overrides.auth === undefined ? "Basic dXNlcjpwd2Q=" : overrides.auth),
    getBaseUrl: () => "http://localhost:8080/rest",
  } as unknown as OpenLClient;
}

/**
 * Build a `read` that fails with 409 the first `failures` times, then returns
 * `result`.
 */
function makeRead<T>(failures: number, result: T): { read: () => Promise<T>; calls: () => number } {
  let calls = 0;
  return {
    read: async () => {
      calls++;
      if (calls <= failures) throw make409();
      return result;
    },
    calls: () => calls,
  };
}

describe("parseTraceStatusFrame", () => {
  it("parses a plain ExecutionStatus name", () => {
    expect(parseTraceStatusFrame("COMPLETED")).toEqual({ status: "COMPLETED" });
  });

  it("parses a JSON-quoted status string", () => {
    expect(parseTraceStatusFrame('"STARTED"')).toEqual({ status: "STARTED" });
  });

  it("parses the ERROR object with its message", () => {
    expect(parseTraceStatusFrame('{"status":"ERROR","message":"boom"}')).toEqual({
      status: "ERROR",
      message: "boom",
    });
  });

  it("falls back to the raw string for unexpected JSON", () => {
    expect(parseTraceStatusFrame("[1,2]")).toEqual({ status: "[1,2]" });
  });
});

describe("executeTraceReadWithWait", () => {
  it("returns immediately when the first read succeeds (no subscription)", async () => {
    const stomp = makeFakeStomp();
    const { read, calls } = makeRead(0, "nodes");

    const result = await executeTraceReadWithWait(makeClient(), "p1", "t1", read, {}, stomp.subscribe);

    expect(result).toBe("nodes");
    expect(calls()).toBe(1);
    expect(stomp.lastOpts()).toBeNull();
  });

  it("rethrows non-409 read errors untouched", async () => {
    const stomp = makeFakeStomp();
    const boom = new Error("network down");

    await expect(
      executeTraceReadWithWait(makeClient(), "p1", "t1", async () => { throw boom; }, {}, stomp.subscribe)
    ).rejects.toBe(boom);
    expect(stomp.lastOpts()).toBeNull();
  });

  it("closes the race: re-read right after subscribing succeeds without frames", async () => {
    const stomp = makeFakeStomp();
    const { read, calls } = makeRead(1, "nodes");

    const result = await executeTraceReadWithWait(makeClient(), "p1", "t1", read, {}, stomp.subscribe);

    expect(result).toBe("nodes");
    expect(calls()).toBe(2);
    const opts = stomp.lastOpts();
    expect(opts?.destination).toBe("/user/topic/projects/p1/tables/t1/trace/status");
    expect(opts?.cookieHeader).toBe("JSESSIONID=abc123");
    expect(stomp.closeSpy).toHaveBeenCalled();
  });

  it("waits for the COMPLETED frame, reporting progress frames, then reads", async () => {
    const stomp = makeFakeStomp();
    const { read, calls } = makeRead(2, "nodes");
    const progress: string[] = [];

    const promise = executeTraceReadWithWait(
      makeClient(),
      "p1",
      "t1",
      read,
      { onProgress: (s) => progress.push(s) },
      stomp.subscribe,
    );
    // Let the subscribe + race-close re-read settle before emitting frames.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    stomp.emit("PENDING");
    stomp.emit("STARTED");
    stomp.emit("COMPLETED");

    const result = await promise;
    expect(result).toBe("nodes");
    expect(calls()).toBe(3);
    expect(progress).toEqual(["PENDING", "STARTED"]);
    expect(stomp.closeSpy).toHaveBeenCalled();
  });

  it("treats INTERRUPTED as terminal and reads the (partial) result", async () => {
    const stomp = makeFakeStomp();
    const { read } = makeRead(2, "partial");

    const promise = executeTraceReadWithWait(makeClient(), "p1", "t1", read, {}, stomp.subscribe);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    stomp.emit("INTERRUPTED");

    await expect(promise).resolves.toBe("partial");
  });

  it("surfaces the studio's ERROR frame as TraceExecutionFailedError", async () => {
    const stomp = makeFakeStomp();
    const { read } = makeRead(99, "never");

    const promise = executeTraceReadWithWait(makeClient(), "p1", "t1", read, {}, stomp.subscribe);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    stomp.emit('{"status":"ERROR","message":"NPE in rule"}');

    await expect(promise).rejects.toThrow(TraceExecutionFailedError);
    await expect(promise).rejects.toThrow(/NPE in rule/);
    expect(stomp.closeSpy).toHaveBeenCalled();
  });

  it("times out with TraceWaitTimeoutError when no terminal frame arrives", async () => {
    const stomp = makeFakeStomp();
    const { read } = makeRead(99, "never");

    await expect(
      executeTraceReadWithWait(makeClient(), "p1", "t1", read, { timeoutMs: 25 }, stomp.subscribe)
    ).rejects.toThrow(TraceWaitTimeoutError);
    expect(stomp.closeSpy).toHaveBeenCalled();
  });

  it("throws TraceWaitUnavailableError when the studio issued no session cookie", async () => {
    const stomp = makeFakeStomp();
    const { read } = makeRead(99, "never");

    await expect(
      executeTraceReadWithWait(makeClient({ cookie: null }), "p1", "t1", read, {}, stomp.subscribe)
    ).rejects.toThrow(TraceWaitUnavailableError);
    expect(stomp.lastOpts()).toBeNull();
  });

  it("rejects with AbortError when the signal aborts mid-wait", async () => {
    const stomp = makeFakeStomp();
    const { read } = makeRead(99, "never");
    const controller = new AbortController();

    const promise = executeTraceReadWithWait(
      makeClient(),
      "p1",
      "t1",
      read,
      { signal: controller.signal },
      stomp.subscribe,
    );
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    controller.abort();

    await expect(promise).rejects.toThrow(/aborted/);
    expect(stomp.closeSpy).toHaveBeenCalled();
  });

  it("URL-encodes project and table ids in the destination", async () => {
    const stomp = makeFakeStomp();
    const { read } = makeRead(1, "nodes");

    await executeTraceReadWithWait(makeClient(), "design:My Project:hash/1", "id with space", read, {}, stomp.subscribe);

    expect(stomp.lastOpts()?.destination).toBe(
      "/user/topic/projects/design%3AMy%20Project%3Ahash%2F1/tables/id%20with%20space/trace/status",
    );
  });
});
