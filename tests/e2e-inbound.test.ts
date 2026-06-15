import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleUpdate } from "../src/worker.js";
import { escapeMarkdownV2 } from "../src/telegram-api.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";

// TWX-80 — Deterministic inbound E2E harness.
//
// The plugin only receives inbound Telegram events via `getUpdates` long-polling,
// which structurally requires a real authenticated Telegram user account in the
// board chat to generate button taps / replies. Agents have no such session, so
// QA could not exercise the inbound half of the TWX-46 decision interface
// (TWX-50 Phase 0.2 / 1.x / 2.x all FAILed for exactly this reason).
//
// This harness substitutes ONLY the Telegram transport: it constructs the exact
// `TelegramUpdate` payloads Telegram would deliver for a board user's tap/reply
// and feeds them through the REAL exported `handleUpdate` dispatch. Board-facing
// effects (approval decision, interaction accept/reject, issue comment) run
// against an in-memory fake board here; the companion `scripts/e2e-telegram-inbound.mjs`
// points the same dispatch at a live board to produce real board-side evidence.
//
// Outbound delivery is already proven in production (TWX-50 Phase 0.1 PASS), so
// the only untested boundary was inbound — which this closes without a Telegram
// account, a human, or any spend.

// Capture the Telegram-facing calls (best-effort in prod; recorded here).
const tg = {
  answered: [] as Array<{ id: string; text?: string }>,
  edited: [] as Array<{ chatId: string; messageId: number; text: string }>,
  sent: [] as Array<{
    chatId: string;
    text: string;
    options: import("../src/telegram-api.js").SendMessageOptions;
  }>,
};

vi.mock("../src/telegram-api.js", async () => {
  const actual = (await vi.importActual("../src/telegram-api.js")) as Record<string, unknown>;
  return {
    ...actual,
    answerCallbackQuery: vi.fn(async (_ctx: unknown, _token: string, id: string, text?: string) => {
      tg.answered.push({ id, text });
    }),
    editMessage: vi.fn(async (_ctx: unknown, _token: string, chatId: string, messageId: number, text: string) => {
      tg.edited.push({ chatId, messageId, text });
    }),
    sendMessage: vi.fn(
      async (
        _ctx: unknown,
        _token: string,
        chatId: string,
        text: string,
        options: import("../src/telegram-api.js").SendMessageOptions,
      ) => {
        tg.sent.push({ chatId, text, options });
        return 123; // Dummy message ID
      },
    ),
  };
});

const BASE = "http://board.local";
const TOKEN = "test-bot-token";
const BOARD_TOKEN = "pcp_board_test";
const CHAT = "1001";

// Fake board: records every board write the dispatch performs.
type BoardCall = { method: string; url: string; body: unknown };
let board: BoardCall[] = [];
let comments: Array<{ issueId: string; body: string; companyId: string }> = [];
let stateStore: Record<string, unknown> = {};

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let issues: Array<{ id: string; identifier?: string; title: string; assigneeAgentId?: string }> = [];

function mockCtx(): PluginContext {
  return {
    http: {
      fetch: vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(init.body) : undefined;
        board.push({ method, url, body });
        if (/\/api\/approvals\/[^/]+\/(approve|reject)$/.test(url)) return jsonRes({ ok: true });
        if (/\/api\/issues\/[^/]+\/interactions\/[^/]+\/(accept|reject|respond)$/.test(url)) return jsonRes({ ok: true });
        if (/\/api\/companies\/co-1\/issues\?/.test(url) && method === "GET") {
          // This mock is specifically for findIssueByIdentifier.
          const qParam = new URLSearchParams(url.split("?")[1]).get("q");
          if (qParam && qParam === "TWX-608") {
            return jsonRes([{ id: "iss-608", identifier: "TWX-608", title: "Telegram decision", status: "in_progress" }]);
          }
          return jsonRes([]);
        }
        if (/\/api\/issues\/iss-608\/comments$/.test(url) && method === "POST") {
          return jsonRes({ id: "comment-608", body: (body as { body?: string } | undefined)?.body ?? "" });
        }
        return jsonRes({ error: "unexpected board call" }, 404);
      }),
    },
    issues: {
      createComment: vi.fn(async (issueId: string, body: string, companyId: string) => {
        comments.push({ issueId, body, companyId });
        return { id: `c-${comments.length}` };
      }),
    },
    metrics: { write: vi.fn(async () => {}) },
    state: {
      get: vi.fn(async (key: { stateKey: string }) => stateStore[key.stateKey] ?? null),
      set: vi.fn(async (key: { stateKey: string }, value: unknown) => {
        stateStore[key.stateKey] = value;
      }),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as PluginContext;
}

vi.mock("../src/host-api.js", async () => {
  const actual = (await vi.importActual("../src/host-api.js")) as Record<string, unknown>;
  return {
    ...actual,
    createIssue: vi.fn(async (_ctx: unknown, _config: unknown, _companyId: string, issue: { title: string; description: string }) => {
      const newIssue = { id: `iss-${issues.length + 1}`, identifier: `TWX-${issues.length + 1}`, ...issue };
      issues.push(newIssue);
      return { id: newIssue.id, identifier: newIssue.identifier };
    }),
    updateIssue: vi.fn(async (_ctx: unknown, _config: unknown, issueId: string, updates: { status?: string; assigneeAgentId?: string }) => {
      const issue = issues.find(i => i.id === issueId);
      if (issue) {
        if (updates.status) issue.status = updates.status;
        if (updates.assigneeAgentId) issue.assigneeAgentId = updates.assigneeAgentId;
      }
      return issue;
    }),
    // Mock other necessary host-api functions if they are called in the tested path
    resolveCompanyId: vi.fn(() => "co-1"),
    configuredActorMappings: vi.fn(() => ({})),
    configuredUserChatMappings: vi.fn(() => ({})),
    resolveActorUserId: vi.fn(() => "user-777"),
  };
});

const CONFIG = {
  enableInbound: true,
  enableCommands: false,
  defaultChatId: CHAT,
  defaultCompanyId: "co-1",
  boardApiToken: BOARD_TOKEN,
  paperclipBaseUrl: BASE,
  inboxAgentId: "inbox-agent-123", // Added inboxAgentId for testing handleInboxWake
} as unknown as Parameters<typeof handleUpdate>[2];

function callbackUpdate(data: string, messageId = 50): Parameters<typeof handleUpdate>[3] {
  return {
    update_id: messageId,
    callback_query: {
      id: `cbq-${messageId}`,
      from: { id: 777, username: "boarduser", first_name: "Board" },
      message: { message_id: messageId, chat: { id: Number(CHAT) }, text: "decision msg" },
      data,
    },
  };
}

function replyUpdate(messageId: number, replyToId: number, text: string, isBotReply: boolean = true): Parameters<typeof handleUpdate>[3] {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      from: { id: 777, username: "boarduser", first_name: "Board" },
      chat: { id: Number(CHAT), type: "private" },
      text,
      reply_to_message: { message_id: replyToId, text: "decision msg", from: { is_bot: isBotReply } },
    },
  };
}

function inboundMessageUpdate(messageId: number, text: string): Parameters<typeof handleUpdate>[3] {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      from: { id: 777, username: "testuser", first_name: "Test" },
      chat: { id: Number(CHAT), type: "private" },
      text,
    },
  };
}

const run = (u: Parameters<typeof handleUpdate>[3]) =>
  handleUpdate(mockCtx(), TOKEN, CONFIG, u, BASE, undefined, BOARD_TOKEN);

beforeEach(() => {
  board = [];
  comments = [];
  stateStore = {};
  tg.answered = [];
  tg.edited = [];
  tg.sent = [];
  issues = []; // Reset issues for each test
  vi.clearAllMocks();
});

describe("TWX-80 inbound E2E harness (real dispatch, fake board)", () => {
  it("Phase 0: approval Approve tap → POST /api/approvals/:id/approve + ack + edit", async () => {
    await run(callbackUpdate("approve_appr-123"));
    const call = board.find((c) => c.url === `${BASE}/api/approvals/appr-123/approve`);
    expect(call?.method).toBe("POST");
    expect((call?.body as { decidedByUserId: string }).decidedByUserId).toBe("telegram:boarduser");
    expect(tg.answered.at(-1)?.text).toBe("Approved");
    expect(tg.edited.at(-1)?.text).toContain("Approved");
  });

  it("Phase 0: approval Reject tap → POST /api/approvals/:id/reject", async () => {
    await run(callbackUpdate("reject_appr-456"));
    const call = board.find((c) => c.url === `${BASE}/api/approvals/appr-456/reject`);
    expect(call?.method).toBe("POST");
    expect(tg.answered.at(-1)?.text).toBe("Rejected");
  });

  it("Phase 1: request_confirmation accept → POST .../interactions/:id/accept + wakes via board", async () => {
    stateStore[`msg_${CHAT}_60`] = { issueId: "iss-1", interactionId: "int-1", entityType: "issue", companyId: "co-1" };
    await run(callbackUpdate("interaction_accept", 60));
    const call = board.find((c) => c.url === `${BASE}/api/issues/iss-1/interactions/int-1/accept`);
    expect(call?.method).toBe("POST");
    expect(tg.answered.at(-1)?.text).toBe("Accepted");
  });

  it("Phase 1: request_confirmation reject → POST .../interactions/:id/reject", async () => {
    stateStore[`msg_${CHAT}_61`] = { issueId: "iss-1", interactionId: "int-2", entityType: "issue", companyId: "co-1" };
    await run(callbackUpdate("interaction_reject", 61));
    const call = board.find((c) => c.url === `${BASE}/api/issues/iss-1/interactions/int-2/reject`);
    expect(call?.method).toBe("POST");
    expect(tg.answered.at(-1)?.text).toBe("Rejected");
  });

  it("Phase 1: missing interaction mapping → safe ack, no board write", async () => {
    await run(callbackUpdate("interaction_accept", 62)); // no seeded state
    expect(board.some((c) => /\/interactions\//.test(c.url))).toBe(false);
    expect(tg.answered.at(-1)?.text).toBe("Interaction mapping missing");
  });

  it("Phase 0/2: reply to a bot decision message → issue-thread audit comment", async () => {
    stateStore[`msg_${CHAT}_70`] = { entityType: "issue", entityId: "iss-9", companyId: "co-1" };
    await run(replyUpdate(700, 70, "approving this, ship it"));
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ issueId: "iss-9", companyId: "co-1" });
    expect(comments[0].body).toContain("approving this, ship it");
  });

  it("Phase 2: unmapped bot reply with leading issue id → issue-thread audit comment", async () => {
    await run(replyUpdate(702, 72, "TWX-608: approving this, ship it"));
    const search = board.find((c) => c.method === "GET" && c.url.includes("/api/companies/co-1/issues?"));
    expect(search?.url).toContain("q=TWX-608");
    const comment = board.find((c) => c.method === "POST" && c.url === `${BASE}/api/issues/iss-608/comments`);
    expect(comment).toBeDefined();
    expect(String((comment!.body as { body: string }).body)).toContain("approving this, ship it");
    expect(comments).toHaveLength(0);
  });

  it("Phase 2: duplicate reply is suppressed (idempotency on inbound_<chat>_<msg>)", async () => {
    stateStore[`msg_${CHAT}_71`] = { entityType: "issue", entityId: "iss-9", companyId: "co-1" };
    const ctx = mockCtx();
    const dup = replyUpdate(701, 71, "same reply twice");
    await handleUpdate(ctx, TOKEN, CONFIG, dup, BASE, undefined, BOARD_TOKEN);
    await handleUpdate(ctx, TOKEN, CONFIG, dup, BASE, undefined, BOARD_TOKEN);
    expect(comments).toHaveLength(1); // second delivery suppressed
  });

  it("TWX-611 recheck: unmapped reply *to a bot message* with no mapping and no issue identifier → guidance message, no new inbox issue", async () => {
    // Simulate a reply to a bot message (replyToId: 80)
    // but there's no corresponding mapping in stateStore for msg_${CHAT}_80
    // and the message text itself does not contain an issue identifier.
    const replyToMsgId = 80;
    stateStore[`msg_${CHAT}_${replyToMsgId}`] = null; // Ensure no mapping exists
    const text = "This is a reply to a bot message that has no stored mapping.";
    await run(replyUpdate(800, replyToMsgId, text));

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toEqual(escapeMarkdownV2("I could not match that reply to a stored Paperclip message. Reply to the original bot message, or start with an issue id like TWX-123: your answer."));
    expect(issues).toHaveLength(0); // No new issue created
    expect(comments).toHaveLength(0); // No comment created
  });

  it("TWX-611 recheck: top-level message (not a reply/command) → new inbox issue created and assigned", async () => {
    const text = "A new top-level message for the inbox agent.";
    const ctx = mockCtx();
    await handleUpdate(ctx, TOKEN, CONFIG, inboundMessageUpdate(900, text), BASE, undefined, BOARD_TOKEN);

    expect(issues).toHaveLength(1); // One new issue created
    expect(issues[0].title).toContain("[Inbox] A new top-level message for the inbox agent.");
    expect(issues[0].assigneeAgentId).toBe("inbox-agent-123"); // Assigned to inbox agent

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toContain(`Forwarded to agent — ${issues[0].identifier}`);
    expect(tg.sent[0].options.replyToMessageId).toBeUndefined(); // Not a reply to the original message
  });
});