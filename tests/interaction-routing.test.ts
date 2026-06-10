import { describe, it, expect, vi, beforeEach } from "vitest";
import { routeInteractionResponse, handleUpdate } from "../src/worker.js";
import { __resetHostApiState } from "../src/host-api.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";

// TWX-455: a custom free-text response to a Telegram "Decision needed" must land
// on the originating decision's issue — never spawn a brand-new inbox issue.
//
// Two routing surfaces are covered:
//   1. routeInteractionResponse() — turns a text reply into accept / reject /
//      respond against the decision's interaction. Free-text on a
//      request_confirmation is a "needs changes" reject-with-reason, NOT a bounce.
//   2. handleUpdate() — a top-level (non-native-reply) message while a decision
//      is pending for the chat routes to that decision, not handleInboxWake.

const BASE_URL = "http://localhost:3100";

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type FetchCall = { url: string; method: string; body: Record<string, unknown> };

function makeCtx(opts: {
  fetchImpl?: (url: string, method: string, body: Record<string, unknown>) => Response;
  pendingDecision?: Record<string, unknown> | null;
  calls: FetchCall[];
  sent: Array<{ chatId: string; text: string }>;
  metrics: Array<{ name: string; value: number }>;
  stateSets?: Array<{ stateKey: string; value: unknown }>;
}): PluginContext {
  const stateStore = new Map<string, unknown>();
  return {
    http: {
      fetch: vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(init.body) : {};
        opts.calls.push({ url, method, body });
        if (opts.fetchImpl) return opts.fetchImpl(url, method, body);
        // Default: issue create + patch (inbox path), interaction respond.
        if (/\/api\/companies\/[^/]+\/issues$/.test(url) && method === "POST") {
          return jsonRes({ id: "i-new", identifier: "TWX-77", title: body.title, status: "backlog" });
        }
        if (/\/api\/issues\/[^/]+$/.test(url) && method === "PATCH") {
          return jsonRes({ id: "i-new", identifier: "TWX-77", status: body.status, assigneeAgentId: body.assigneeAgentId });
        }
        if (/\/api\/issues\/[^/]+\/interactions\/[^/]+\/(accept|reject|respond)$/.test(url)) {
          return jsonRes({ ok: true });
        }
        return jsonRes({ error: "not found" }, 404);
      }),
    },
    state: {
      get: vi.fn(async (key: { stateKey: string }) => {
        if (key.stateKey.startsWith("pending_decision_")) {
          return opts.pendingDecision ?? null;
        }
        return stateStore.get(key.stateKey) ?? null;
      }),
      set: vi.fn(async (key: { stateKey: string }, value: unknown) => {
        stateStore.set(key.stateKey, value);
        opts.stateSets?.push({ stateKey: key.stateKey, value });
      }),
    },
    metrics: { write: vi.fn(async (name: string, value: number) => { opts.metrics.push({ name, value }); }) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as PluginContext;
}

vi.mock("../src/telegram-api.js", async () => {
  const actual = (await vi.importActual("../src/telegram-api.js")) as Record<string, unknown>;
  return {
    ...actual,
    sendMessage: vi.fn(),
    isForum: vi.fn(async () => false),
  };
});

import { sendMessage } from "../src/telegram-api.js";

const CONFIG = {
  inboxAgentId: "ceo-1",
  boardApiToken: "pcp_board_test",
  defaultCompanyId: "co-default",
  defaultChatId: "6870350866",
  inboxChatIds: [],
  paperclipBaseUrl: BASE_URL,
  enableInbound: true,
  enableCommands: true,
} as unknown as Parameters<typeof handleUpdate>[2];

const DECISION_MAPPING = {
  entityType: "interaction",
  companyId: "co-default",
  issueId: "iss-605",
  issueIdentifier: "WAA-565",
  interactionId: "int-1",
  interactionKind: "request_confirmation",
};

let calls: FetchCall[];
let sent: Array<{ chatId: string; text: string }>;
let metrics: Array<{ name: string; value: number }>;

beforeEach(() => {
  calls = [];
  sent = [];
  metrics = [];
  vi.clearAllMocks();
  __resetHostApiState();
  (sendMessage as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    async (_ctx: unknown, _t: string, chatId: string, text: string) => {
      sent.push({ chatId, text });
      return 1;
    },
  );
});

describe("routeInteractionResponse", () => {
  it("accepts a request_confirmation on an affirmative keyword", async () => {
    const ctx = makeCtx({ calls, sent, metrics });
    const result = await routeInteractionResponse(ctx, BASE_URL, "pcp_board_test", DECISION_MAPPING, "yes");
    expect(result).toBe("routed");
    const accept = calls.find((c) => c.url.endsWith("/accept"));
    expect(accept).toBeDefined();
    expect(calls.some((c) => c.url.endsWith("/reject"))).toBe(false);
  });

  it("rejects-with-reason on an explicit negative keyword", async () => {
    const ctx = makeCtx({ calls, sent, metrics });
    const result = await routeInteractionResponse(ctx, BASE_URL, "pcp_board_test", DECISION_MAPPING, "no");
    expect(result).toBe("routed");
    const reject = calls.find((c) => c.url.endsWith("/reject"));
    expect(reject).toBeDefined();
  });

  it("routes a free-text response as a needs-changes reject-with-reason, not a bounce", async () => {
    const ctx = makeCtx({ calls, sent, metrics });
    const text = "Wait for deployment, ship it to staging and comment to the Jira Ticket";
    const result = await routeInteractionResponse(ctx, BASE_URL, "pcp_board_test", DECISION_MAPPING, text);
    expect(result).toBe("routed");
    const reject = calls.find((c) => c.url.endsWith("/reject"));
    expect(reject).toBeDefined();
    expect(String(reject!.body.reason)).toContain(text);
  });

  it("reports already-resolved when the decision was decided elsewhere", async () => {
    const ctx = makeCtx({
      calls, sent, metrics,
      fetchImpl: () => jsonRes({ error: "Interaction has already been resolved" }, 409),
    });
    const result = await routeInteractionResponse(ctx, BASE_URL, "pcp_board_test", DECISION_MAPPING, "do the thing");
    expect(result).toBe("already-resolved");
  });

  it("reports missing-token when no board token is configured", async () => {
    const ctx = makeCtx({ calls, sent, metrics });
    const result = await routeInteractionResponse(ctx, BASE_URL, "", DECISION_MAPPING, "yes");
    expect(result).toBe("missing-token");
    expect(calls.length).toBe(0);
  });

  it("asks for structured input when ask_user_questions answer can't be parsed", async () => {
    const ctx = makeCtx({ calls, sent, metrics });
    const mapping = { ...DECISION_MAPPING, interactionKind: "ask_user_questions", interactionQuestions: [] };
    const result = await routeInteractionResponse(ctx, BASE_URL, "pcp_board_test", mapping, "free text");
    expect(result).toBe("needs-input");
    expect(calls.length).toBe(0);
  });
});

describe("handleUpdate decision association", () => {
  function textUpdate(text: string) {
    return {
      update_id: 1,
      message: {
        message_id: 999,
        from: { id: 6870350866, username: "tue_jonas" },
        chat: { id: 6870350866, type: "private" },
        text,
      },
    } as unknown as Parameters<typeof handleUpdate>[3];
  }

  it("routes a top-level free-text reply to the pending decision, not a new inbox issue", async () => {
    const ctx = makeCtx({ calls, sent, metrics, pendingDecision: DECISION_MAPPING });
    await handleUpdate(
      ctx, "tg-token", CONFIG,
      textUpdate("Wait for deployment, ship it to staging"),
      BASE_URL, undefined, "pcp_board_test",
    );

    // The decision's interaction got the response...
    expect(calls.some((c) => c.url.includes("/interactions/int-1/reject"))).toBe(true);
    // ...and NO new inbox issue was created.
    expect(calls.some((c) => /\/api\/companies\/[^/]+\/issues$/.test(c.url) && c.method === "POST")).toBe(false);
    expect(sent.some((m) => m.text.includes("WAA-565"))).toBe(true);
  });

  it("still creates an inbox issue for a fresh top-level message when no decision is pending", async () => {
    const ctx = makeCtx({ calls, sent, metrics, pendingDecision: null });
    await handleUpdate(
      ctx, "tg-token", CONFIG,
      textUpdate("ship the release tonight"),
      BASE_URL, undefined, "pcp_board_test",
    );

    expect(calls.some((c) => /\/api\/companies\/[^/]+\/issues$/.test(c.url) && c.method === "POST")).toBe(true);
    expect(calls.some((c) => c.url.includes("/interactions/"))).toBe(false);
    expect(sent.some((m) => m.text.includes("Forwarded to agent"))).toBe(true);
  });

  it("falls through to inbox when the pending decision was already resolved", async () => {
    const ctx = makeCtx({
      calls, sent, metrics, pendingDecision: DECISION_MAPPING,
      fetchImpl: (url, method, body) => {
        if (/\/interactions\/[^/]+\/(accept|reject|respond)$/.test(url)) {
          return jsonRes({ error: "Interaction has already been resolved" }, 409);
        }
        if (/\/api\/companies\/[^/]+\/issues$/.test(url) && method === "POST") {
          return jsonRes({ id: "i-new", identifier: "TWX-77", title: body.title, status: "backlog" });
        }
        if (/\/api\/issues\/[^/]+$/.test(url) && method === "PATCH") {
          return jsonRes({ id: "i-new", identifier: "TWX-77", status: body.status });
        }
        return jsonRes({ error: "not found" }, 404);
      },
    });
    await handleUpdate(
      ctx, "tg-token", CONFIG,
      textUpdate("a brand new unrelated task"),
      BASE_URL, undefined, "pcp_board_test",
    );

    // Tried the decision first, got already-resolved, then created the inbox issue.
    expect(calls.some((c) => c.url.includes("/interactions/int-1/"))).toBe(true);
    expect(calls.some((c) => /\/api\/companies\/[^/]+\/issues$/.test(c.url) && c.method === "POST")).toBe(true);
  });
});
