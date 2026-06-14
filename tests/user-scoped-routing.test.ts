import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import {
  dispatchInteractionNotification,
  handleCallbackQuery,
  handleUpdate,
  resolveActorUserId,
} from "../src/worker.js";
import { __resetHostApiState, setUserChatMapping } from "../src/host-api.js";

// TWX-525: User-scoped decision routing.
// - Jonas-owned interaction cards are routed to Jonas's chat only.
// - Thomas-owned interaction cards are routed to Thomas's chat only.
// - When the owner has no Telegram chat mapping, a non-actionable notice is
//   sent to the admin/default chat and the decision is left unresolved.
// - Cross-user callback (wrong actor presses the button) is rejected locally
//   before any API call is made.
// - Cross-user native reply is rejected locally.

const JONAS_USER_ID = "U1v5HFLADePyPLXPTX17rsUiCWkG40zl";
const THOMAS_USER_ID = "oiUyZpjYThWdccgNbKnHQjd7Zy1hl9Xw";
const JONAS_CHAT_ID = "6870350866";
const THOMAS_CHAT_ID = "6784294797";

const USER_CHAT_MAPPINGS: Record<string, string> = {
  [JONAS_USER_ID]: JONAS_CHAT_ID,
  [THOMAS_USER_ID]: THOMAS_CHAT_ID,
};

const TELEGRAM_ACTOR_MAPPINGS: Record<string, string> = {
  tue_jonas: JONAS_USER_ID,
  [JONAS_CHAT_ID]: JONAS_USER_ID,
  thomopa: THOMAS_USER_ID,
  [THOMAS_CHAT_ID]: THOMAS_USER_ID,
};

const telegramMocks = vi.hoisted(() => ({
  sendMessage: vi.fn(async () => 101),
  editMessage: vi.fn(async () => true),
  answerCallbackQuery: vi.fn(async () => undefined),
  isForum: vi.fn(async () => false),
}));

vi.mock("../src/telegram-api.js", async () => {
  const actual = (await vi.importActual("../src/telegram-api.js")) as Record<string, unknown>;
  return {
    ...actual,
    sendMessage: telegramMocks.sendMessage,
    editMessage: telegramMocks.editMessage,
    answerCallbackQuery: telegramMocks.answerCallbackQuery,
    isForum: telegramMocks.isForum,
  };
});

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeDeliveryStore() {
  const store = new Map<string, { sent: boolean; telegramMessageId?: string }>();
  return {
    store,
    execute: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("INSERT INTO")) {
        const key = String(params?.[0] ?? "");
        if (store.has(key)) return { rowCount: 0 };
        store.set(key, { sent: false });
        return { rowCount: 1 };
      }
      if (sql.includes("DELETE FROM")) {
        const key = String(params?.[0] ?? "");
        const row = store.get(key);
        if (!row || row.sent) return { rowCount: 0 };
        store.delete(key);
        return { rowCount: 1 };
      }
      if (sql.includes("UPDATE")) {
        const key = String(params?.[0] ?? "");
        const row = store.get(key);
        if (row) { row.sent = true; row.telegramMessageId = String(params?.[1] ?? ""); }
        return { rowCount: 1 };
      }
      return { rowCount: 0 };
    }),
  };
}

function makeDispatchCtx(opts: {
  stateStore?: Map<string, unknown>;
  deliveryExecute?: ReturnType<typeof makeDeliveryStore>["execute"];
}): PluginContext {
  const stateStore = opts.stateStore ?? new Map<string, unknown>();
  return {
    db: {
      namespace: "plugin_telegram_63f79ea5a3",
      execute: opts.deliveryExecute ?? vi.fn(async () => ({ rowCount: 1 })),
    },
    http: {
      fetch: vi.fn(async () =>
        jsonRes([{ id: "int-jonas-1", payload: { prompt: "Ship it?" } }]),
      ),
    },
    issues: {
      get: vi.fn(async () => ({
        id: "iss-1",
        identifier: "TWX-525",
        title: "User-scoped routing test",
      })),
    },
    state: {
      get: vi.fn(async (key: { stateKey: string }) => stateStore.get(key.stateKey) ?? null),
      set: vi.fn(async (key: { stateKey: string }, value: unknown) => stateStore.set(key.stateKey, value)),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as PluginContext;
}

function makeInteractionEvent(targetUserId: string | null = JONAS_USER_ID): PluginEvent {
  return {
    eventId: "evt-1",
    eventType: "issue.interaction.created" as never,
    occurredAt: "2026-06-12T10:00:00.000Z",
    entityId: "iss-1",
    entityType: "issue",
    companyId: "co-twx",
    payload: {
      interactionId: "int-jonas-1",
      interactionKind: "request_confirmation",
      ...(targetUserId ? { targetUserId } : {}),
    },
  };
}

function makeNotify(notifiedChats: string[]) {
  return vi.fn(
    async (
      _event: PluginEvent,
      _formatter: unknown,
      overrideChatId?: string,
      _mappingOverride?: Record<string, unknown>,
    ) => {
      if (overrideChatId) notifiedChats.push(overrideChatId);
      return 101;
    },
  );
}

// ────────────────────────────────────────────────────────────────────────────
// resolveActorUserId helper
// ────────────────────────────────────────────────────────────────────────────

describe("resolveActorUserId", () => {
  it("resolves by Telegram username", () => {
    expect(resolveActorUserId(TELEGRAM_ACTOR_MAPPINGS, "tue_jonas", 0)).toBe(JONAS_USER_ID);
  });

  it("resolves by numeric Telegram user ID when username is absent", () => {
    expect(resolveActorUserId(TELEGRAM_ACTOR_MAPPINGS, undefined, Number(THOMAS_CHAT_ID))).toBe(THOMAS_USER_ID);
  });

  it("prefers username over numeric ID when both are present", () => {
    // thomas username resolves correctly even if numeric would also work
    expect(resolveActorUserId(TELEGRAM_ACTOR_MAPPINGS, "thomopa", Number(JONAS_CHAT_ID))).toBe(THOMAS_USER_ID);
  });

  it("returns null when mappings is undefined", () => {
    expect(resolveActorUserId(undefined, "tue_jonas", 0)).toBeNull();
  });

  it("returns null when actor is not in mappings", () => {
    expect(resolveActorUserId(TELEGRAM_ACTOR_MAPPINGS, "unknown_user", 999)).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// dispatchInteractionNotification — user-scoped chat routing
// ────────────────────────────────────────────────────────────────────────────

describe("dispatchInteractionNotification — user-scoped chat routing", () => {
  let ds: ReturnType<typeof makeDeliveryStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    ds = makeDeliveryStore();
    __resetHostApiState();
  });

  it("routes Jonas-owned interaction to Jonas's chat, not the default/approvals chat", async () => {
    const notifiedChats: string[] = [];
    const ctx = makeDispatchCtx({ deliveryExecute: ds.execute });

    const result = await dispatchInteractionNotification(ctx, makeInteractionEvent(JONAS_USER_ID), {
      baseUrl: "http://paperclip.local",
      boardApiToken: "pcp_board_test",
      defaultChatId: "default-chat",
      approvalsChatId: "approvals-chat",
      userChatMappings: USER_CHAT_MAPPINGS,
      notify: makeNotify(notifiedChats),
    });

    expect(result).toBe("sent");
    expect(notifiedChats).toContain(JONAS_CHAT_ID);
    expect(notifiedChats).not.toContain("approvals-chat");
    expect(notifiedChats).not.toContain("default-chat");
  });

  it("routes Jonas-owned interaction through a dynamic /connect mapping when static config is empty", async () => {
    const notifiedChats: string[] = [];
    const ctx = makeDispatchCtx({ deliveryExecute: ds.execute });
    setUserChatMapping("co-twx", JONAS_USER_ID, JONAS_CHAT_ID);

    const result = await dispatchInteractionNotification(ctx, makeInteractionEvent(JONAS_USER_ID), {
      baseUrl: "http://paperclip.local",
      boardApiToken: "pcp_board_test",
      defaultChatId: "default-chat",
      approvalsChatId: "approvals-chat",
      notify: makeNotify(notifiedChats),
    });

    expect(result).toBe("sent");
    expect(notifiedChats).toContain(JONAS_CHAT_ID);
    expect(notifiedChats).not.toContain("approvals-chat");
    expect(notifiedChats).not.toContain("default-chat");
  });

  it("routes Thomas-owned interaction to Thomas's chat, not Jonas's or default", async () => {
    const notifiedChats: string[] = [];
    const ctx = makeDispatchCtx({ deliveryExecute: ds.execute });

    const result = await dispatchInteractionNotification(ctx, makeInteractionEvent(THOMAS_USER_ID), {
      baseUrl: "http://paperclip.local",
      boardApiToken: "pcp_board_test",
      defaultChatId: "default-chat",
      approvalsChatId: "approvals-chat",
      userChatMappings: USER_CHAT_MAPPINGS,
      notify: makeNotify(notifiedChats),
    });

    expect(result).toBe("sent");
    expect(notifiedChats).toContain(THOMAS_CHAT_ID);
    expect(notifiedChats).not.toContain(JONAS_CHAT_ID);
    expect(notifiedChats).not.toContain("approvals-chat");
  });

  it("falls back to approvalsChatId when targetUserId is absent (legacy event)", async () => {
    const notifiedChats: string[] = [];
    const ctx = makeDispatchCtx({ deliveryExecute: ds.execute });

    const result = await dispatchInteractionNotification(ctx, makeInteractionEvent(null), {
      baseUrl: "http://paperclip.local",
      boardApiToken: "pcp_board_test",
      defaultChatId: "default-chat",
      approvalsChatId: "approvals-chat",
      userChatMappings: USER_CHAT_MAPPINGS,
      notify: makeNotify(notifiedChats),
    });

    expect(result).toBe("sent");
    expect(notifiedChats).toContain("approvals-chat");
    expect(notifiedChats).not.toContain(JONAS_CHAT_ID);
  });

  it("sends non-actionable notice to admin chat when owner has no Telegram mapping", async () => {
    const notifiedChats: string[] = [];
    const notifyFn = vi.fn(
      async (_event: PluginEvent, _formatter: unknown, overrideChatId?: string) => {
        if (overrideChatId) notifiedChats.push(overrideChatId);
        return 102;
      },
    );
    const ctx = makeDispatchCtx({ deliveryExecute: ds.execute });

    const unmappedUserId = "some-unmapped-user-id";
    const result = await dispatchInteractionNotification(
      ctx,
      makeInteractionEvent(unmappedUserId),
      {
        baseUrl: "http://paperclip.local",
        boardApiToken: "pcp_board_test",
        defaultChatId: "default-chat",
        approvalsChatId: "approvals-chat",
        userChatMappings: USER_CHAT_MAPPINGS,
        notify: notifyFn,
      },
    );

    // Sent (the notice counts for idempotency), but to the admin chat only.
    expect(result).toBe("sent");
    expect(notifiedChats).toContain("approvals-chat");
    expect(notifiedChats).not.toContain(JONAS_CHAT_ID);
    expect(notifiedChats).not.toContain(THOMAS_CHAT_ID);
    // The logger warned about the missing mapping.
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      "Interaction owner has no Telegram chat mapping; sending setup notice",
      expect.objectContaining({ targetUserId: unmappedUserId }),
    );
  });

  it("passes ownerUserId in the mappingOverride so callbacks can validate actor", async () => {
    let capturedMappingOverride: Record<string, unknown> | undefined;
    const notifyFn = vi.fn(
      async (_event: PluginEvent, _formatter: unknown, _chatId?: string, mappingOverride?: Record<string, unknown>) => {
        capturedMappingOverride = mappingOverride;
        return 103;
      },
    );
    const ctx = makeDispatchCtx({ deliveryExecute: ds.execute });

    await dispatchInteractionNotification(ctx, makeInteractionEvent(JONAS_USER_ID), {
      baseUrl: "http://paperclip.local",
      boardApiToken: "pcp_board_test",
      defaultChatId: "default-chat",
      userChatMappings: USER_CHAT_MAPPINGS,
      notify: notifyFn,
    });

    expect(capturedMappingOverride?.ownerUserId).toBe(JONAS_USER_ID);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// handleCallbackQuery — cross-user callback rejected locally
// ────────────────────────────────────────────────────────────────────────────

describe("handleCallbackQuery — ownership guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeCallbackCtx(ownerUserId: string | undefined): PluginContext {
    const mapping = {
      entityType: "interaction",
      issueId: "iss-1",
      interactionId: "int-1",
      companyId: "co-twx",
      ownerUserId,
    };
    return {
      http: { fetch: vi.fn(async () => jsonRes({ ok: true })) },
      state: {
        get: vi.fn(async () => mapping),
        set: vi.fn(async () => undefined),
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as PluginContext;
  }

  function callbackQuery(username: string, numericId: number, data = "interaction_accept") {
    return {
      id: "cb-1",
      data,
      from: { id: numericId, username },
      message: { message_id: 99, chat: { id: Number(JONAS_CHAT_ID) } },
    };
  }

  it("accepts Jonas's callback on Jonas's decision", async () => {
    const ctx = makeCallbackCtx(JONAS_USER_ID);

    await handleCallbackQuery(
      ctx,
      "tg-token",
      callbackQuery("tue_jonas", Number(JONAS_CHAT_ID)),
      "http://paperclip.local",
      "pcp_board_test",
      TELEGRAM_ACTOR_MAPPINGS,
    );

    expect(telegramMocks.answerCallbackQuery).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), "Not your decision",
    );
    // The interaction was submitted (HTTP POST to /accept).
    expect(ctx.http.fetch).toHaveBeenCalled();
  });

  it("rejects Thomas's callback on Jonas's decision locally (before any API call)", async () => {
    const ctx = makeCallbackCtx(JONAS_USER_ID);

    await handleCallbackQuery(
      ctx,
      "tg-token",
      callbackQuery("thomopa", Number(THOMAS_CHAT_ID)),
      "http://paperclip.local",
      "pcp_board_test",
      TELEGRAM_ACTOR_MAPPINGS,
    );

    expect(telegramMocks.answerCallbackQuery).toHaveBeenCalledWith(
      ctx, "tg-token", "cb-1", "Not your decision",
    );
    // No API call was made — rejected before the round-trip.
    expect(ctx.http.fetch).not.toHaveBeenCalled();
    expect(ctx.logger.info).toHaveBeenCalledWith(
      "Rejected cross-user interaction callback",
      expect.objectContaining({ ownerUserId: JONAS_USER_ID }),
    );
  });

  it("rejects an unmapped actor on an owned decision", async () => {
    const ctx = makeCallbackCtx(JONAS_USER_ID);

    await handleCallbackQuery(
      ctx,
      "tg-token",
      callbackQuery("unknown_user", 999),
      "http://paperclip.local",
      "pcp_board_test",
      TELEGRAM_ACTOR_MAPPINGS,
    );

    expect(telegramMocks.answerCallbackQuery).toHaveBeenCalledWith(
      ctx, "tg-token", "cb-1", "Not your decision",
    );
    expect(ctx.http.fetch).not.toHaveBeenCalled();
  });

  it("does not enforce ownership when ownerUserId is absent (legacy mapping)", async () => {
    const ctx = makeCallbackCtx(undefined);

    await handleCallbackQuery(
      ctx,
      "tg-token",
      callbackQuery("thomopa", Number(THOMAS_CHAT_ID)),
      "http://paperclip.local",
      "pcp_board_test",
      TELEGRAM_ACTOR_MAPPINGS,
    );

    // No rejection — legacy mapping without owner, anyone can act.
    expect(telegramMocks.answerCallbackQuery).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), "Not your decision",
    );
    expect(ctx.http.fetch).toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// handleUpdate — native-reply cross-user rejection
// ────────────────────────────────────────────────────────────────────────────

describe("handleUpdate — native-reply ownership guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetHostApiState();
  });

  const CONFIG = {
    inboxAgentId: "ceo-1",
    boardApiToken: "pcp_board_test",
    defaultCompanyId: "co-twx",
    defaultChatId: JONAS_CHAT_ID,
    inboxChatIds: [],
    paperclipBaseUrl: "http://paperclip.local",
    enableInbound: true,
    enableCommands: false,
    telegramActorMappings: TELEGRAM_ACTOR_MAPPINGS,
  } as unknown as Parameters<typeof handleUpdate>[2];

  function replyUpdate(from: { id: number; username: string }, text: string) {
    return {
      update_id: 1,
      message: {
        message_id: 200,
        from,
        chat: { id: Number(JONAS_CHAT_ID), type: "private" },
        text,
        reply_to_message: { message_id: 99, from: { is_bot: true } },
      },
    } as unknown as Parameters<typeof handleUpdate>[3];
  }

  function makeReplyCtx(ownerUserId: string | undefined): PluginContext {
    const stateStore = new Map<string, unknown>([
      [`msg_${JONAS_CHAT_ID}_99`, {
        entityType: "interaction",
        issueId: "iss-1",
        interactionId: "int-1",
        interactionKind: "request_confirmation",
        companyId: "co-twx",
        ownerUserId,
      }],
      [`inbound_${JONAS_CHAT_ID}_200`, null],
    ]);
    return {
      http: {
        fetch: vi.fn(async (url: string) => {
          if (url.includes("/accept") || url.includes("/reject")) return jsonRes({ ok: true });
          return jsonRes({ error: "not found" }, 404);
        }),
      },
      state: {
        get: vi.fn(async (key: { stateKey: string }) => stateStore.get(key.stateKey) ?? null),
        set: vi.fn(async (key: { stateKey: string }, value: unknown) => stateStore.set(key.stateKey, value)),
      },
      metrics: { write: vi.fn() },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as PluginContext;
  }

  it("allows Jonas to reply to his own decision", async () => {
    const ctx = makeReplyCtx(JONAS_USER_ID);
    await handleUpdate(
      ctx, "tg-token", CONFIG,
      replyUpdate({ id: Number(JONAS_CHAT_ID), username: "tue_jonas" }, "yes"),
      "http://paperclip.local",
      undefined,
      "pcp_board_test",
    );

    expect(ctx.http.fetch).toHaveBeenCalled();
    const urls = (ctx.http.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0]);
    expect(urls.some((u: unknown) => typeof u === "string" && u.includes("/accept"))).toBe(true);
  });

  it("rejects Thomas replying to Jonas's decision before any API call", async () => {
    const ctx = makeReplyCtx(JONAS_USER_ID);
    await handleUpdate(
      ctx, "tg-token", CONFIG,
      replyUpdate({ id: Number(THOMAS_CHAT_ID), username: "thomopa" }, "yes"),
      "http://paperclip.local",
      undefined,
      "pcp_board_test",
    );

    // sendMessage called with "not yours" notice.
    expect(telegramMocks.sendMessage).toHaveBeenCalled();
    const sentTexts = telegramMocks.sendMessage.mock.calls.map((c: unknown[]) => c[3]);
    expect(sentTexts.some((t: unknown) => typeof t === "string" && t.includes("not yours"))).toBe(true);
    // No interaction API call.
    expect(ctx.http.fetch).not.toHaveBeenCalled();
    expect(ctx.logger.info).toHaveBeenCalledWith(
      "Rejected cross-user interaction reply",
      expect.objectContaining({ ownerUserId: JONAS_USER_ID }),
    );
  });
});
