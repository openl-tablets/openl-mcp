/**
 * Unit tests for ResourceSubscriptionManager.
 *
 * Mocks `subscribeProjectStatus` (the STOMP subscribe seam) and the
 * per-session `sendResourceUpdated` doorbell so tests run in-memory with no
 * network. Verifies the spec-blessed flow: subscribe → STOMP frame arrives →
 * notifications/resources/updated fires with the *original* URI.
 */

import { describe, it, expect, beforeEach, jest } from "@jest/globals";

import {
  ResourceSubscriptionManager,
  parseStatusUri,
} from "../src/resource-subscriptions.js";
import type { OpenLClient } from "../src/client.js";
import type {
  SubscribeProjectStatusOpts,
  Subscription,
} from "../src/stomp-client.js";
import type * as Types from "../src/types.js";

interface FakeStomp {
  subscribe: jest.Mock<(opts: SubscribeProjectStatusOpts) => Promise<Subscription>>;
  /** Emit a STOMP frame to every active subscription created so far. */
  emit(status: Types.ProjectStatusView): void;
  /** Open subscriptions still alive (not closed). */
  liveCount(): number;
  /** Inspect the args passed to the Nth subscribe call. */
  callArgs(n: number): SubscribeProjectStatusOpts;
}

function makeFakeStomp(): FakeStomp {
  const handlers: Array<(s: Types.ProjectStatusView) => void> = [];
  const live = new Set<number>();
  const closeSpies = new Map<number, jest.Mock<() => Promise<void>>>();
  let nextId = 0;
  const calls: SubscribeProjectStatusOpts[] = [];

  const subscribe = jest.fn(async (opts: SubscribeProjectStatusOpts) => {
    const id = nextId++;
    handlers[id] = opts.onMessage;
    live.add(id);
    const close = jest.fn<() => Promise<void>>().mockImplementation(async () => {
      live.delete(id);
    });
    closeSpies.set(id, close);
    calls.push(opts);
    return { close } as Subscription;
  });
  return {
    subscribe: subscribe as unknown as FakeStomp["subscribe"],
    emit(status: Types.ProjectStatusView) {
      for (const id of live) handlers[id]?.(status);
    },
    liveCount: () => live.size,
    callArgs: (n: number) => calls[n],
  };
}

function makeStatus(overrides: Partial<Types.ProjectStatusView> = {}): Types.ProjectStatusView {
  return {
    projectId: "proj",
    compileState: "ok",
    ...overrides,
  } as Types.ProjectStatusView;
}

function makeClient(
  scriptedFetches: Types.ProjectStatusView[],
  cookie: string | null = "abc123",
): OpenLClient {
  let i = 0;
  return {
    getProjectStatus: jest.fn(async () => {
      if (i >= scriptedFetches.length) {
        throw new Error("getProjectStatus called too many times");
      }
      return scriptedFetches[i++];
    }),
    getBaseUrl: () => "http://localhost:8080/rest",
    getSessionCookie: () => cookie,
    getAuthorizationHeader: () => "Token openl_pat_test",
  } as unknown as OpenLClient;
}

describe("parseStatusUri", () => {
  it("parses URI with branch", () => {
    expect(parseStatusUri("openl://status/proj1/main")).toEqual({
      projectId: "proj1",
      branch: "main",
    });
  });
  it("parses URI without branch", () => {
    expect(parseStatusUri("openl://status/proj1")).toEqual({ projectId: "proj1" });
  });
  it("URL-decodes projectId and branch", () => {
    expect(parseStatusUri("openl://status/design%3Aabc/feat%2Fx")).toEqual({
      projectId: "design:abc",
      branch: "feat/x",
    });
  });
  it("returns null for non-status URIs", () => {
    expect(parseStatusUri("openl://projects/proj1")).toBeNull();
    expect(parseStatusUri("file:///etc/passwd")).toBeNull();
  });
  it("returns null when projectId is empty", () => {
    expect(parseStatusUri("openl://status/")).toBeNull();
  });
});

describe("ResourceSubscriptionManager.subscribe", () => {
  let stomp: FakeStomp;
  let sendUpdated: jest.Mock<(uri: string) => Promise<void>>;

  beforeEach(() => {
    stomp = makeFakeStomp();
    sendUpdated = jest.fn<(uri: string) => Promise<void>>().mockResolvedValue(undefined);
  });

  it("subscribes and fires the doorbell on the next STOMP frame", async () => {
    const client = makeClient([makeStatus({ branch: "main" })]);
    const m = new ResourceSubscriptionManager(client, sendUpdated, stomp.subscribe);

    await m.subscribe("openl://status/proj/main");
    expect(stomp.subscribe).toHaveBeenCalledTimes(1);

    stomp.emit(makeStatus({ branch: "main", compileState: "errors" }));
    expect(sendUpdated).toHaveBeenCalledTimes(1);
    expect(sendUpdated).toHaveBeenCalledWith("openl://status/proj/main");
  });

  it("uses the project's actual branch for STOMP when URI omits it", async () => {
    // Branch-supporting project: getProjectStatus returns branch=master.
    const client = makeClient([makeStatus({ branch: "master" })]);
    const m = new ResourceSubscriptionManager(client, sendUpdated, stomp.subscribe);

    await m.subscribe("openl://status/proj");
    expect(stomp.callArgs(0).branch).toBe("master");
  });

  it("uses the URI branch verbatim when present, even if project differs", async () => {
    const client = makeClient([makeStatus({ branch: "master" })]);
    const m = new ResourceSubscriptionManager(client, sendUpdated, stomp.subscribe);

    await m.subscribe("openl://status/proj/develop");
    expect(stomp.callArgs(0).branch).toBe("develop");
  });

  it("subscribes with branch=undefined when project doesn't support branches", async () => {
    // Backend omits `branch` on the status response for non-branch repos.
    const client = makeClient([makeStatus({})]);
    const m = new ResourceSubscriptionManager(client, sendUpdated, stomp.subscribe);

    await m.subscribe("openl://status/proj");
    expect(stomp.callArgs(0).branch).toBeUndefined();
  });

  it("is idempotent — duplicate subscribe on same URI doesn't open a second STOMP", async () => {
    const client = makeClient([makeStatus({ branch: "main" })]);
    const m = new ResourceSubscriptionManager(client, sendUpdated, stomp.subscribe);

    await m.subscribe("openl://status/proj/main");
    await m.subscribe("openl://status/proj/main");
    expect(stomp.subscribe).toHaveBeenCalledTimes(1);
    expect(m.size).toBe(1);
  });

  it("closes the race-loser STOMP when two subscribes for the same URI run concurrently", async () => {
    // Both calls share scripted fetches; the await-chain interleaves before
    // either inserts into the tracking map. Without the post-await re-check,
    // the second `set()` would overwrite the first and leak its STOMP.
    const client = makeClient([
      makeStatus({ branch: "main" }),
      makeStatus({ branch: "main" }),
    ]);
    const m = new ResourceSubscriptionManager(client, sendUpdated, stomp.subscribe);

    const [a, b] = await Promise.all([
      m.subscribe("openl://status/proj/main"),
      m.subscribe("openl://status/proj/main"),
    ]);
    expect(a).toBeUndefined();
    expect(b).toBeUndefined();

    // Both subscribeImpl invocations ran (no early-exit caught them), but only
    // one survived in the map; the loser was closed inline.
    expect(stomp.subscribe).toHaveBeenCalledTimes(2);
    expect(m.size).toBe(1);
    expect(stomp.liveCount()).toBe(1);
  });

  it("supports multiple distinct subscriptions on the same session", async () => {
    const client = makeClient([
      makeStatus({ branch: "main" }),
      makeStatus({ branch: "main" }),
    ]);
    const m = new ResourceSubscriptionManager(client, sendUpdated, stomp.subscribe);

    await m.subscribe("openl://status/proj1/main");
    await m.subscribe("openl://status/proj2/main");
    expect(m.size).toBe(2);
    expect(stomp.subscribe).toHaveBeenCalledTimes(2);

    stomp.emit(makeStatus({ branch: "main" }));
    // Both subscriptions receive the frame; doorbell fires for each URI.
    expect(sendUpdated).toHaveBeenCalledTimes(2);
    expect(sendUpdated.mock.calls.map((c) => c[0]).sort()).toEqual([
      "openl://status/proj1/main",
      "openl://status/proj2/main",
    ]);
  });

  it("skips STOMP gracefully when no session cookie is available", async () => {
    const client = makeClient([makeStatus({ branch: "main" })], null);
    const m = new ResourceSubscriptionManager(client, sendUpdated, stomp.subscribe);

    await m.subscribe("openl://status/proj/main");
    expect(stomp.subscribe).not.toHaveBeenCalled();
    expect(m.size).toBe(0); // not tracked — STOMP never opened
  });

  it("rejects URIs outside the openl://status schema", async () => {
    const client = makeClient([]);
    const m = new ResourceSubscriptionManager(client, sendUpdated, stomp.subscribe);

    await expect(m.subscribe("openl://projects/proj1")).rejects.toThrow(
      /Unsupported subscribe URI/,
    );
    expect(stomp.subscribe).not.toHaveBeenCalled();
  });

  it("does not crash when sendUpdated throws (logs and stays subscribed)", async () => {
    sendUpdated.mockImplementationOnce(() => {
      throw new Error("transport gone");
    });
    const client = makeClient([makeStatus({ branch: "main" })]);
    const m = new ResourceSubscriptionManager(client, sendUpdated, stomp.subscribe);

    await m.subscribe("openl://status/proj/main");

    // Frame 1 → sendUpdated throws; manager should swallow it.
    expect(() => stomp.emit(makeStatus({ branch: "main" }))).not.toThrow();
    // Frame 2 still tries to fire; subscription is still alive.
    expect(() => stomp.emit(makeStatus({ branch: "main" }))).not.toThrow();
    expect(sendUpdated).toHaveBeenCalledTimes(2);
    expect(stomp.liveCount()).toBe(1);
  });

  it("passes a positive reconnectDelay so resource subs auto-reconnect", async () => {
    const client = makeClient([makeStatus({ branch: "main" })]);
    const m = new ResourceSubscriptionManager(client, sendUpdated, stomp.subscribe);
    await m.subscribe("openl://status/proj/main");
    expect(stomp.callArgs(0).reconnectDelay).toBeGreaterThan(0);
  });
});

describe("ResourceSubscriptionManager.unsubscribe", () => {
  it("closes the STOMP sub for that URI and removes tracking", async () => {
    const stomp = makeFakeStomp();
    const sendUpdated = jest.fn<(uri: string) => Promise<void>>().mockResolvedValue(undefined);
    const client = makeClient([makeStatus({ branch: "main" })]);
    const m = new ResourceSubscriptionManager(client, sendUpdated, stomp.subscribe);

    await m.subscribe("openl://status/proj/main");
    expect(stomp.liveCount()).toBe(1);

    await m.unsubscribe("openl://status/proj/main");
    expect(stomp.liveCount()).toBe(0);
    expect(m.size).toBe(0);
  });

  it("is a no-op for unknown URI (idempotent)", async () => {
    const stomp = makeFakeStomp();
    const sendUpdated = jest.fn<(uri: string) => Promise<void>>().mockResolvedValue(undefined);
    const m = new ResourceSubscriptionManager(
      makeClient([]),
      sendUpdated,
      stomp.subscribe,
    );
    await expect(m.unsubscribe("openl://status/never-subscribed")).resolves.toBeUndefined();
  });
});

describe("ResourceSubscriptionManager.closeAll", () => {
  it("tears down every active subscription", async () => {
    const stomp = makeFakeStomp();
    const sendUpdated = jest.fn<(uri: string) => Promise<void>>().mockResolvedValue(undefined);
    const client = makeClient([
      makeStatus({ branch: "main" }),
      makeStatus({ branch: "main" }),
      makeStatus({ branch: "main" }),
    ]);
    const m = new ResourceSubscriptionManager(client, sendUpdated, stomp.subscribe);

    await m.subscribe("openl://status/a/main");
    await m.subscribe("openl://status/b/main");
    await m.subscribe("openl://status/c/main");
    expect(stomp.liveCount()).toBe(3);

    await m.closeAll();
    expect(stomp.liveCount()).toBe(0);
    expect(m.size).toBe(0);
  });
});
