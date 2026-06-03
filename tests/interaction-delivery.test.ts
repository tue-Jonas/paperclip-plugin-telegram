import { describe, it, expect, vi } from "vitest";
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import {
  assertInteractionDeliveriesNamespace,
  dispatchInteractionNotification,
} from "../src/worker.js";
import type { IssueLinksOpts } from "../src/formatters.js";
import type { SendMessageOptions } from "../src/telegram-api.js";

type DeliveryRow = {
  sent: boolean;
  telegramMessageId?: string;
};

type DeliveryStore = Map<string, DeliveryRow>;

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function deliveryKey(companyId = "co-1", issueId = "iss-1", interactionId = "int-1"): string {
  return `${companyId}:${issueId}:${interactionId}`;
}

function mockCtx(input: {
  store?: DeliveryStore;
  interactions?: unknown[];
  fetchStatus?: number;
  updateFails?: boolean;
  namespace?: string;
} = {}): PluginContext {
  const store = input.store ?? new Map<string, DeliveryRow>();
  return {
    db: {
      namespace: input.namespace ?? "plugin_telegram_63f79ea5a3",
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
          if (input.updateFails) throw new Error("update failed");
          const key = String(params?.[0] ?? "");
          const row = store.get(key);
          if (!row) return { rowCount: 0 };
          row.sent = true;
          row.telegramMessageId = String(params?.[1] ?? "");
          return { rowCount: 1 };
        }
        return { rowCount: 0 };
      }),
    },
    http: {
      fetch: vi.fn(async () => {
        if (input.fetchStatus && input.fetchStatus >= 400) {
          return jsonRes({ error: "boom" }, input.fetchStatus);
        }
        return jsonRes(input.interactions ?? [
          {
            id: "int-1",
            payload: { prompt: "Ship it?" },
          },
        ]);
      }),
    },
    issues: {
      get: vi.fn(async () => ({
        id: "iss-1",
        identifier: "TWX-136",
        title: "Fix doubled Telegram decision messages",
      })),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as PluginContext;
}

function makeEvent(): PluginEvent {
  return {
    eventId: "evt-1",
    eventType: "issue.interaction.created" as never,
    occurredAt: "2026-06-03T10:00:00.000Z",
    entityId: "iss-1",
    entityType: "issue",
    companyId: "co-1",
    payload: {
      interactionId: "int-1",
      interactionKind: "request_confirmation",
    },
  };
}

function makeNotify(messageId: number | null = 123) {
  return vi.fn(
    async (
      _event: PluginEvent,
      _formatter: (e: PluginEvent, opts?: IssueLinksOpts) => { text: string; options: SendMessageOptions },
      _overrideChatId?: string,
      _mappingOverride?: Record<string, unknown>,
    ) => messageId,
  );
}

async function dispatch(ctx: PluginContext, event = makeEvent(), notify = makeNotify()) {
  const result = await dispatchInteractionNotification(ctx, event, {
    baseUrl: "http://paperclip.local",
    boardApiToken: "pcp_board_test",
    defaultChatId: "default-chat",
    approvalsChatId: "approvals-chat",
    notify,
  });
  return { result, notify };
}

describe("interaction delivery idempotency", () => {
  it("suppresses a duplicate after the first interaction notification is sent", async () => {
    const store: DeliveryStore = new Map();
    const ctx = mockCtx({ store });

    const first = await dispatch(ctx);
    const second = await dispatch(ctx);

    expect(first.result).toBe("sent");
    expect(second.result).toBe("duplicate");
    expect(first.notify).toHaveBeenCalledTimes(1);
    expect(second.notify).not.toHaveBeenCalled();
    expect(store.get(deliveryKey())).toEqual({ sent: true, telegramMessageId: "123" });
  });

  it("releases the claim when the interaction cannot be fetched, allowing a later retry", async () => {
    const store: DeliveryStore = new Map();
    const missingCtx = mockCtx({ store, interactions: [] });

    const missing = await dispatch(missingCtx);

    expect(missing.result).toBe("skipped");
    expect(missing.notify).not.toHaveBeenCalled();
    expect(store.has(deliveryKey())).toBe(false);

    const retryCtx = mockCtx({ store });
    const retry = await dispatch(retryCtx);

    expect(retry.result).toBe("sent");
    expect(retry.notify).toHaveBeenCalledTimes(1);
    expect(store.get(deliveryKey())?.sent).toBe(true);
  });

  it("releases the claim when Telegram send returns null, allowing a later retry", async () => {
    const store: DeliveryStore = new Map();
    const failedNotify = makeNotify(null);

    const first = await dispatch(mockCtx({ store }), makeEvent(), failedNotify);

    expect(first.result).toBe("failed");
    expect(failedNotify).toHaveBeenCalledTimes(1);
    expect(store.has(deliveryKey())).toBe(false);

    const retry = await dispatch(mockCtx({ store }));

    expect(retry.result).toBe("sent");
    expect(retry.notify).toHaveBeenCalledTimes(1);
    expect(store.get(deliveryKey())?.sent).toBe(true);
  });

  it("releases the claim when interaction fetch throws", async () => {
    const store: DeliveryStore = new Map();
    const ctx = mockCtx({ store, fetchStatus: 500 });

    const response = await dispatch(ctx);

    expect(response.result).toBe("failed");
    expect(response.notify).not.toHaveBeenCalled();
    expect(store.has(deliveryKey())).toBe(false);
    expect(ctx.logger.error).toHaveBeenCalledWith(
      "Failed to dispatch interaction notification",
      expect.objectContaining({ issueId: "iss-1", interactionId: "int-1" }),
    );
  });

  it("logs sent-record update failures without releasing a delivered notification", async () => {
    const store: DeliveryStore = new Map();
    const ctx = mockCtx({ store, updateFails: true });

    const response = await dispatch(ctx);

    expect(response.result).toBe("sent");
    expect(response.notify).toHaveBeenCalledTimes(1);
    expect(store.has(deliveryKey())).toBe(true);
    expect(store.get(deliveryKey())?.sent).toBe(false);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      "Could not record Telegram interaction delivery as sent",
      expect.objectContaining({ issueId: "iss-1", interactionId: "int-1" }),
    );
  });
});

describe("interaction delivery migration namespace", () => {
  it("fails fast when runtime namespace does not match the migration schema", () => {
    expect(() => assertInteractionDeliveriesNamespace(mockCtx({ namespace: "plugin_other" }))).toThrow(
      /migration namespace mismatch/,
    );
  });
});
