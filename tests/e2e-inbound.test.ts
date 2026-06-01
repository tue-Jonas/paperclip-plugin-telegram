import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleUpdate } from "../src/worker.js";
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
    sendMessage: vi.fn(async () => ({ ok: true })),
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

function mockCtx(): PluginContext {
  return {
    http: {
      fetch: vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(init.body) : undefined;
        board.push({ method, url, body });
        if (/\/api\/approvals\/[^/]+\/(approve|reject)$/.test(url)) return jsonRes({ ok: true });
        if (/\/api\/issues\/[^/]+\/interactions\/[^/]+\/(accept|reject|respond)$/.test(url)) return jsonRes({ ok: true });
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

const CONFIG = {
  enableInbound: true,
  enableCommands: false,
  defaultChatId: CHAT,
  defaultCompanyId: "co-1",
  boardApiToken: BOARD_TOKEN,
  paperclipBaseUrl: BASE,
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

function replyUpdate(messageId: number, replyToId: number, text: string): Parameters<typeof handleUpdate>[3] {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      from: { id: 777, username: "boarduser", first_name: "Board" },
      chat: { id: Number(CHAT), type: "private" },
      text,
      reply_to_message: { message_id: replyToId, text: "decision msg", from: { is_bot: true } },
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

  it("Phase 2: duplicate reply is suppressed (idempotency on inbound_<chat>_<msg>)", async () => {
    stateStore[`msg_${CHAT}_71`] = { entityType: "issue", entityId: "iss-9", companyId: "co-1" };
    const ctx = mockCtx();
    const dup = replyUpdate(701, 71, "same reply twice");
    await handleUpdate(ctx, TOKEN, CONFIG, dup, BASE, undefined, BOARD_TOKEN);
    await handleUpdate(ctx, TOKEN, CONFIG, dup, BASE, undefined, BOARD_TOKEN);
    expect(comments).toHaveLength(1); // second delivery suppressed
  });
});
