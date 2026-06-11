import { describe, expect, it, vi, beforeEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { handleCallbackQuery } from "../src/worker.js";
import { answerCallbackQuery, editMessage } from "../src/telegram-api.js";

const telegramMocks = vi.hoisted(() => ({
  answerCallbackQuery: vi.fn(async () => undefined),
  editMessage: vi.fn(async () => true),
}));

vi.mock("../src/telegram-api.js", async () => {
  const actual = (await vi.importActual("../src/telegram-api.js")) as Record<string, unknown>;
  return {
    ...actual,
    answerCallbackQuery: telegramMocks.answerCallbackQuery,
    editMessage: telegramMocks.editMessage,
  };
});

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockCtx(response: Response): PluginContext {
  return {
    http: {
      fetch: vi.fn(async () => response),
    },
    state: {
      get: vi.fn(async () => ({
        entityType: "interaction",
        issueId: "iss-1",
        interactionId: "int-1",
        companyId: "co-1",
      })),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as PluginContext;
}

function callbackQuery(data = "interaction_accept"): Parameters<typeof handleCallbackQuery>[2] {
  return {
    id: "callback-1",
    data,
    from: { id: 101, first_name: "Thomas", username: "thomas" },
    message: {
      message_id: 202,
      chat: { id: 303, type: "private" },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handleCallbackQuery", () => {
  it("acknowledges already-resolved interaction conflicts without surfacing a raw 409", async () => {
    const ctx = mockCtx(jsonRes({ error: "Interaction has already been resolved" }, 409));

    await handleCallbackQuery(
      ctx,
      "telegram-token",
      callbackQuery(),
      "http://paperclip.local",
      "pcp_board_test",
    );

    expect(answerCallbackQuery).toHaveBeenCalledWith(
      ctx,
      "telegram-token",
      "callback-1",
      "Already resolved",
    );
    expect(editMessage).toHaveBeenCalledWith(
      ctx,
      "telegram-token",
      "303",
      202,
      "This interaction was already resolved\\.",
      { parseMode: "MarkdownV2" },
    );
    expect(ctx.logger.info).toHaveBeenCalledWith(
      "Ignored stale Telegram interaction callback",
      expect.objectContaining({ issueId: "iss-1", interactionId: "int-1" }),
    );
  });

  it("continues to surface non-idempotent interaction conflicts as failures", async () => {
    const ctx = mockCtx(jsonRes({
      error: "Cannot accept interaction: the issue's most recent run has not completed workspace_finalize.",
    }, 409));

    await handleCallbackQuery(
      ctx,
      "telegram-token",
      callbackQuery(),
      "http://paperclip.local",
      "pcp_board_test",
    );

    expect(answerCallbackQuery).toHaveBeenCalledWith(
      ctx,
      "telegram-token",
      "callback-1",
      expect.stringContaining("Failed:"),
    );
    expect(editMessage).not.toHaveBeenCalled();
  });
});
