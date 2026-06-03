import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import plugin from "../src/worker.js";

function mockCtx(config: Record<string, unknown>): PluginContext {
  return {
    config: {
      get: vi.fn(async () => config),
    },
    secrets: {
      resolve: vi.fn(),
    },
    http: {
      fetch: vi.fn(),
    },
    db: {
      namespace: "plugin_telegram_63f79ea5a3",
    },
    events: {
      on: vi.fn(),
    },
    jobs: {
      register: vi.fn(),
    },
    tools: {
      register: vi.fn(),
    },
    data: {
      register: vi.fn(),
    },
    actions: {
      register: vi.fn(),
    },
    streams: {
      emit: vi.fn(),
    },
    state: {
      get: vi.fn(),
      set: vi.fn(),
    },
    metrics: {
      write: vi.fn(),
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as PluginContext;
}

describe("worker job registration", () => {
  it("registers the daily digest job even when digest mode is off", async () => {
    const ctx = mockCtx({
      telegramBotToken: "test-token",
      digestMode: "off",
      dailyDigestTime: "09:00",
      bidailySecondTime: "17:00",
      tridailyTimes: "07:00,13:00,19:00",
      enableCommands: false,
      enableInbound: false,
      notifyOnIssueCreated: false,
      notifyOnIssueDone: false,
      notifyOnApprovalCreated: false,
      notifyOnAgentError: false,
      notifyOnAgentRunStarted: false,
      notifyOnAgentRunFinished: false,
      notifyOnIssueBlocked: false,
      notifyOnBoardMention: false,
      topicRouting: false,
      defaultChatId: "",
      paperclipBaseUrl: "http://localhost:3100",
      paperclipPublicUrl: "http://localhost:3100",
    });

    await plugin.definition.setup(ctx);

    expect(ctx.jobs.register).toHaveBeenCalledWith("telegram-daily-digest", expect.any(Function));
  });
});
