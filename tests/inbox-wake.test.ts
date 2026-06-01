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

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function mockCtx(): PluginContext {
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
