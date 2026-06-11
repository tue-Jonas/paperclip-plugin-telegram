import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleCommand, handleConnectTopic, getTopicForProject } from "../src/commands.js";
import {
  __resetHostApiState,
  resolveCompanyId,
  getChatCompanyName,
} from "../src/host-api.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";

// Inbound commands no longer use the gated SDK host RPCs (ctx.companies / agents
// / issues / state) — those throw "unknown invocation scope" in the poll loop.
// They now go through the board REST API via the un-gated ctx.http.fetch with a
// board token. These tests exercise that path: the http.fetch mock serves the
// board API, and assertions check the resulting messages + POST/PATCH bodies.

const CONFIG = {
  boardApiToken: "pcp_board_test",
  defaultCompanyId: "co-1",
  paperclipBaseUrl: "http://localhost:3100",
};

let sentMessages: Array<{ chatId: string; text: string; options?: Record<string, unknown> }> = [];
let metricsWritten: Array<{ name: string; value: number }> = [];
let stateStore: Record<string, unknown> = {};
let postedIssues: Array<{ url: string; body: Record<string, unknown> }> = [];
let patchedIssues: Array<{ url: string; body: Record<string, unknown> }> = [];

type Fixtures = {
  companies: Array<Record<string, unknown>>;
  agents: Array<Record<string, unknown>>;
  issues: Array<Record<string, unknown>>;
};

const DEFAULT_FIXTURES: Fixtures = {
  companies: [{ id: "co-1", name: "MyCompany", issuePrefix: "MC" }],
  agents: [
    { id: "a1", name: "Builder", status: "active", role: "engineer" },
    { id: "a2", name: "Tester", status: "paused", role: "engineer" },
  ],
  issues: [
    { id: "i1", identifier: "PROJ-1", title: "Fix bug", status: "todo", projectId: null },
    { id: "i2", identifier: "PROJ-2", title: "Add feature", status: "done", projectId: "proj-backend" },
  ],
};

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockCtx(fx: Fixtures = DEFAULT_FIXTURES): PluginContext {
  return {
    http: {
      fetch: vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        const method = init?.method ?? "GET";
        if (url.endsWith("/api/companies") && method === "GET") return jsonRes(fx.companies);
        if (/\/api\/companies\/[^/]+\/agents$/.test(url)) return jsonRes(fx.agents);
        if (/\/api\/companies\/[^/]+\/issues(\?|$)/.test(url) && method === "GET") {
          return jsonRes(fx.issues);
        }
        if (/\/api\/companies\/[^/]+\/issues$/.test(url) && method === "POST") {
          const body = JSON.parse(init?.body ?? "{}");
          postedIssues.push({ url, body });
          return jsonRes({ id: "i-new", identifier: "MC-99", title: body.title, status: "backlog" });
        }
        if (/\/api\/issues\/[^/]+$/.test(url) && method === "PATCH") {
          const body = JSON.parse(init?.body ?? "{}");
          patchedIssues.push({ url, body });
          return jsonRes({
            id: "i-new",
            identifier: "MC-99",
            title: "x",
            status: body.status ?? "backlog",
            assigneeAgentId: body.assigneeAgentId,
          });
        }
        if (/\/api\/approvals\/.+\/(approve|reject)$/.test(url)) return jsonRes({ ok: true });
        return jsonRes({ error: "not found" }, 404);
      }),
    },
    metrics: {
      write: vi.fn(async (name: string, value: number) => {
        metricsWritten.push({ name, value });
      }),
    },
    state: {
      get: vi.fn(async (key: { stateKey: string }) => stateStore[key.stateKey] ?? null),
      set: vi.fn(async (key: { stateKey: string }, value: unknown) => {
        stateStore[key.stateKey] = value;
      }),
    },
    secrets: { resolve: vi.fn(async () => "pcp_board_test") },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as PluginContext;
}

vi.mock("../src/telegram-api.js", async () => {
  const actual = (await vi.importActual("../src/telegram-api.js")) as Record<string, unknown>;
  return {
    ...actual,
    sendMessage: vi.fn(
      async (
        _ctx: unknown,
        _token: string,
        chatId: string,
        text: string,
        options?: Record<string, unknown>,
      ) => {
        sentMessages.push({ chatId, text, options });
        return 1;
      },
    ),
    sendChatAction: vi.fn(),
  };
});

beforeEach(() => {
  sentMessages = [];
  metricsWritten = [];
  stateStore = {};
  postedIssues = [];
  patchedIssues = [];
  __resetHostApiState();
});

describe("handleCommand (board REST path)", () => {
  it("routes /help command", async () => {
    const ctx = mockCtx();
    await handleCommand(ctx, "token", "123", "help", "", undefined, undefined, undefined, CONFIG);
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].text).toContain("Paperclip Bot Commands");
  });

  it("routes /status and shows agent/issue counts via board API", async () => {
    const ctx = mockCtx();
    await handleCommand(ctx, "token", "123", "status", "", undefined, undefined, undefined, CONFIG);
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].text).toContain("Paperclip Status");
    // resolved against defaultCompanyId → board agents/issues endpoints hit
    expect(ctx.http.fetch).toHaveBeenCalledWith(
      "http://localhost:3100/api/companies/co-1/agents",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer pcp_board_test" }) }),
    );
  });

  it("routes /issues command", async () => {
    const ctx = mockCtx();
    await handleCommand(ctx, "token", "123", "issues", "", undefined, undefined, undefined, CONFIG);
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].text).toContain("Issues");
  });

  it("/issues filters by projectId", async () => {
    const ctx = mockCtx();
    await handleCommand(ctx, "token", "123", "issues", "proj-backend", undefined, undefined, undefined, CONFIG);
    expect(sentMessages[0].text).toContain("PROJ\\-2");
    expect(sentMessages[0].text).not.toContain("PROJ\\-1");
  });

  it("routes /agents and shows names + status", async () => {
    const ctx = mockCtx();
    await handleCommand(ctx, "token", "123", "agents", "", undefined, undefined, undefined, CONFIG);
    expect(sentMessages[0].text).toContain("Agents");
    expect(sentMessages[0].text).toContain("Builder");
    expect(sentMessages[0].text).toContain("Tester");
  });

  it("/approve without args shows usage", async () => {
    const ctx = mockCtx();
    await handleCommand(ctx, "token", "123", "approve", "", undefined, undefined, undefined, CONFIG);
    expect(sentMessages[0].text).toContain("Usage");
  });

  it("/approve with id calls approvals API with configurable base URL", async () => {
    const ctx = mockCtx();
    await handleCommand(ctx, "token", "123", "approve", "apr-1", undefined, "http://example.com", undefined, CONFIG);
    expect(ctx.http.fetch).toHaveBeenCalledWith(
      "http://example.com/api/approvals/apr-1/approve",
      expect.any(Object),
    );
  });

  it("handles unknown command", async () => {
    const ctx = mockCtx();
    await handleCommand(ctx, "token", "123", "foobar", "", undefined, undefined, undefined, CONFIG);
    expect(sentMessages[0].text).toContain("Unknown command");
  });

  it("increments commands metric", async () => {
    const ctx = mockCtx();
    await handleCommand(ctx, "token", "123", "help", "", undefined, undefined, undefined, CONFIG);
    expect(metricsWritten.some((m) => m.name === "telegram_commands_handled")).toBe(true);
  });

  it("/connect links the chat to a company (in-process map)", async () => {
    const ctx = mockCtx();
    await handleCommand(ctx, "token", "456", "connect", "MyCompany", undefined, undefined, undefined, CONFIG);
    expect(getChatCompanyName("456")).toBe("MyCompany");
    expect(resolveCompanyId("456", CONFIG)).toBe("co-1");
    expect(sentMessages[0].text).toContain("Linked");
  });

  it("/connect without args shows usage and lists companies", async () => {
    const ctx = mockCtx();
    await handleCommand(ctx, "token", "123", "connect", "", undefined, undefined, undefined, CONFIG);
    expect(sentMessages[0].text).toContain("Usage");
    expect(sentMessages[0].text).toContain("MyCompany");
  });

  it("/create posts without assignee then PATCHes status+assignee (wake trigger)", async () => {
    const ctx = mockCtx({
      companies: [{ id: "co-1", name: "MyCompany", issuePrefix: "MC" }],
      agents: [
        { id: "a1", name: "Builder", status: "active", role: "engineer" },
        { id: "ceo-1", name: "Zhu Li", status: "idle", role: "ceo" },
      ],
      issues: [],
    });
    await handleCommand(ctx, "token", "123", "create", "Board prep for Q1", undefined, undefined, undefined, CONFIG);
    // POST creates WITHOUT an assignee (so the assignee transition can fire the wake)
    expect(postedIssues.length).toBe(1);
    expect(postedIssues[0].body).not.toHaveProperty("assigneeAgentId");
    expect(postedIssues[0].body.title).toBe("Board prep for Q1");
    // PATCH sets BOTH status and assignee → triggers issue_assigned wake
    expect(patchedIssues.length).toBe(1);
    expect(patchedIssues[0].body).toEqual({ status: "todo", assigneeAgentId: "ceo-1" });
    expect(sentMessages[0].text).toContain("Task created");
    expect(sentMessages[0].text).toContain("Zhu Li");
  });

  it("/create works without a CEO agent", async () => {
    const ctx = mockCtx({
      companies: [{ id: "co-1", name: "MyCompany", issuePrefix: null }],
      agents: [{ id: "a1", name: "Builder", status: "active", role: "engineer" }],
      issues: [],
    });
    await handleCommand(ctx, "token", "123", "create", "Some task", undefined, undefined, undefined, CONFIG);
    expect(postedIssues[0].body).not.toHaveProperty("assigneeAgentId");
    expect(patchedIssues[0].body).toEqual({ status: "todo" });
    expect(sentMessages[0].text).toContain("Task created");
  });

  it("commands degrade gracefully when no board token is configured", async () => {
    const ctx = mockCtx();
    await handleCommand(ctx, "token", "123", "status", "", undefined, undefined, undefined, {
      defaultCompanyId: "co-1",
      paperclipBaseUrl: "http://localhost:3100",
    });
    // no token → host call throws → user-facing fallback, not a crash
    expect(sentMessages[0].text).toContain("Could not fetch status");
  });
});

describe("handleConnectTopic", () => {
  it("stores topic mapping for a project", async () => {
    const ctx = mockCtx();
    await handleConnectTopic(ctx, "token", "123", "Backend 42");
    expect(stateStore["topic-map-123"]).toEqual({ Backend: "42" });
  });

  it("shows usage when args are insufficient", async () => {
    const ctx = mockCtx();
    await handleConnectTopic(ctx, "token", "123", "Backend");
    expect(sentMessages[0].text).toContain("Usage");
  });

  it("getTopicForProject returns mapped topic id", async () => {
    const ctx = mockCtx();
    stateStore["topic-map-123"] = { Backend: "42" };
    const topic = await getTopicForProject(ctx, "123", "Backend");
    expect(topic).toBe(42);
  });
});
