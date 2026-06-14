import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleInboxWake } from "../src/worker.js";
import { __resetHostApiState, setChatCompany } from "../src/host-api.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";

// Inbox-wake creates a new issue assigned to inboxAgentId so the agent wakes via
// the standard assignment path. ctx.issues is gated in the poll loop ("unknown
// invocation scope"), so the create/assign now go through the board REST API via
// ctx.http.fetch. These tests assert the create-then-assign ordering (load-bearing
// for the issue_assigned wake) and the company resolution.

let sentMessages: Array<{ chatId: string; text: string }> = [];
let metricsWritten: Array<{ name: string; value: number }> = [];
let posted: Array<{ url: string; body: Record<string, unknown> }> = [];
let patched: Array<{ url: string; body: Record<string, unknown> }> = [];
let stateStore: Record<string, unknown> = {};

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function mockCtx(opts?: {
  stateGet?: (stateKey: string) => unknown;
}): PluginContext {
  return {
    http: {
      fetch: vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        const method = init?.method ?? "GET";
        if (/\/api\/companies\/[^/]+\/issues$/.test(url) && method === "POST") {
          const body = JSON.parse(init?.body ?? "{}");
          posted.push({ url, body });
          return jsonRes({ id: "i-new", identifier: "TWX-77", title: body.title, status: "backlog" });
        }
        if (/\/api\/issues\/[^/]+$/.test(url) && method === "PATCH") {
          const body = JSON.parse(init?.body ?? "{}");
          patched.push({ url, body });
          return jsonRes({ id: "i-new", identifier: "TWX-77", status: body.status, assigneeAgentId: body.assigneeAgentId });
        }
        return jsonRes({ error: "not found" }, 404);
      }),
    },
    state: {
      get: vi.fn(async (key: { stateKey: string }) => {
        if (opts?.stateGet) return opts.stateGet(key.stateKey);
        return stateStore[key.stateKey] ?? null;
      }),
      set: vi.fn(async (key: { stateKey: string }, value: unknown) => {
        stateStore[key.stateKey] = value;
      }),
    },
    metrics: { write: vi.fn(async (name: string, value: number) => { metricsWritten.push({ name, value }); }) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    secrets: { resolve: vi.fn(async () => "pcp_board_test") },
  } as unknown as PluginContext;
}

vi.mock("../src/telegram-api.js", async () => {
  const actual = (await vi.importActual("../src/telegram-api.js")) as Record<string, unknown>;
  return {
    ...actual,
    sendMessage: vi.fn(async (_ctx: unknown, _t: string, chatId: string, text: string) => {
      sentMessages.push({ chatId, text });
      return 1;
    }),
  };
});

const CONFIG = {
  inboxAgentId: "ceo-1",
  boardApiToken: "pcp_board_test",
  defaultCompanyId: "co-default",
  paperclipBaseUrl: "http://localhost:3100",
} as Parameters<typeof handleInboxWake>[2];

function makeMsg(text: string) {
  return {
    message_id: 555,
    from: { id: 6870350866, username: "tue_jonas" },
    chat: { id: 6870350866, type: "private" },
    text,
  } as Parameters<typeof handleInboxWake>[3];
}

beforeEach(() => {
  sentMessages = [];
  metricsWritten = [];
  posted = [];
  patched = [];
  stateStore = {};
  __resetHostApiState();
});

describe("handleInboxWake", () => {
  it("creates an issue without assignee, then PATCHes status+assignee to fire the wake", async () => {
    const ctx = mockCtx();
    await handleInboxWake(ctx, "token", CONFIG, makeMsg("ship the release tonight"), "6870350866", "ship the release tonight");

    expect(posted.length).toBe(1);
    expect(posted[0].url).toBe("http://localhost:3100/api/companies/co-default/issues");
    expect(posted[0].body).not.toHaveProperty("assigneeAgentId");
    expect(String(posted[0].body.title)).toContain("[Inbox]");
    expect(String(posted[0].body.description)).toContain("ship the release tonight");

    expect(patched.length).toBe(1);
    expect(patched[0].url).toBe("http://localhost:3100/api/issues/i-new");
    expect(patched[0].body).toEqual({ status: "todo", assigneeAgentId: "ceo-1" });

    expect(metricsWritten.some((m) => m.name === "telegram_inbound_routed")).toBe(true);
    expect(sentMessages[0].text).toContain("Forwarded to agent — TWX-77");
  });

  it("routes to the /connect-linked company over the default", async () => {
    const ctx = mockCtx();
    setChatCompany("6870350866", "co-linked", "Linked Co");
    await handleInboxWake(ctx, "token", CONFIG, makeMsg("hello"), "6870350866", "hello");
    expect(posted[0].url).toBe("http://localhost:3100/api/companies/co-linked/issues");
  });

  it("includes recent chat context bullets when the ring buffer is populated", async () => {
    stateStore["recent_ctx_6870350866"] = [
      {
        messageId: 157,
        issueIdentifier: "TWX-579",
        issueTitle: "Scope Instant Recap MVP",
        eventType: "issue.interaction.created",
        entityType: "interaction",
        at: "2026-06-14T20:18:37.000Z",
      },
      {
        messageId: 156,
        issueIdentifier: "TWX-578",
        issueTitle: "Parent recap scope",
        eventType: "issue.created",
        entityType: "issue",
        at: "2026-06-14T20:17:10.000Z",
      },
    ];

    const ctx = mockCtx();
    await handleInboxWake(ctx, "token", CONFIG, makeMsg("ship the release tonight"), "6870350866", "ship the release tonight");

    const description = String(posted[0].body.description);
    expect(description).toContain("Recent context in this chat:");
    expect(description).toContain('- TWX-579 "Scope Instant Recap MVP" — issue.interaction.created (20:18Z)');
    expect(description).toContain('- TWX-578 "Parent recap scope" — issue.created (20:17Z)');
  });

  it("includes reply quote and linked notification details when a reply falls through to inbox", async () => {
    stateStore["msg_6870350866_157"] = {
      entityType: "interaction",
      entityId: "iss-579",
      companyId: "co-default",
      eventType: "issue.interaction.created",
      issueIdentifier: "TWX-579",
      issueTitle: "Scope Instant Recap MVP",
    };

    const ctx = mockCtx();
    await handleInboxWake(ctx, "token", CONFIG, {
      ...makeMsg("Is it Thomas? If yes send him a WhatsApp what to do"),
      reply_to_message: {
        message_id: 157,
        text: "Decision needed for TWX-579",
        from: { is_bot: true },
      },
    }, "6870350866", "Is it Thomas? If yes send him a WhatsApp what to do");

    const description = String(posted[0].body.description);
    expect(description).toContain("Replying to Telegram message 157:");
    expect(description).toContain("> Decision needed for TWX-579");
    expect(description).toContain('Linked notification: TWX-579 "Scope Instant Recap MVP" — issue.interaction.created');
  });

  it("degrades to the base inbox description when context state reads throw", async () => {
    const ctx = mockCtx({
      stateGet: (stateKey) => {
        if (stateKey === "recent_ctx_6870350866" || stateKey === "msg_6870350866_157") {
          throw new Error("scope missing");
        }
        return null;
      },
    });

    await handleInboxWake(ctx, "token", CONFIG, {
      ...makeMsg("hello"),
      reply_to_message: { message_id: 157, text: "prior bot message", from: { is_bot: true } },
    }, "6870350866", "hello");

    expect(posted.length).toBe(1);
    expect(sentMessages[0].text).toContain("Forwarded to agent — TWX-77");
    expect(String(posted[0].body.description)).toContain("hello");
  });

  it("acks an error to the sender when the board call fails", async () => {
    const ctx = {
      ...mockCtx(),
      http: { fetch: vi.fn(async () => jsonRes({ error: "boom" }, 500)) },
    } as unknown as PluginContext;
    await handleInboxWake(ctx, "token", CONFIG, makeMsg("hi"), "6870350866", "hi");
    expect(posted.length).toBe(0);
    expect(sentMessages[0].text).toContain("Could not forward message");
  });
});
