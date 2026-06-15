import { describe, it, expect } from "vitest";
import {
  formatIssueCreated,
  formatIssueDone,
  formatApprovalCreated,
  formatInteractionCreated,
  formatAgentError,
  formatAgentRunStarted,
  formatAgentRunFinished,
} from "../src/formatters.js";
import type { PluginEvent } from "@paperclipai/plugin-sdk";

function mockEvent(overrides: Record<string, unknown> = {}): PluginEvent {
  return {
    eventType: "issue.created",
    entityId: "iss-123",
    entityType: "issue",
    companyId: "co-1",
    occurredAt: new Date().toISOString(),
    payload: { identifier: "PROJ-42", title: "Test issue", ...overrides },
  } as PluginEvent;
}

describe("formatIssueCreated", () => {
  it("includes identifier and title", () => {
    const msg = formatIssueCreated(mockEvent());
    expect(msg.text).toContain("PROJ\\-42");
    expect(msg.text).toContain("Test issue");
  });

  it("falls back to entityId when no identifier", () => {
    const msg = formatIssueCreated(mockEvent({ identifier: undefined }));
    expect(msg.text).toContain("iss\\-123");
  });

  it("uses MarkdownV2 parse mode", () => {
    const msg = formatIssueCreated(mockEvent());
    expect(msg.options.parseMode).toBe("MarkdownV2");
  });

  it("includes the org name when provided", () => {
    const msg = formatIssueCreated(mockEvent(), { companyName: "TWB Digital" });
    expect(msg.text).toContain("Org");
    expect(msg.text).toContain("TWB Digital");
  });

  it("includes metadata fields when available", () => {
    const msg = formatIssueCreated(mockEvent({
      status: "open",
      priority: "high",
      assigneeName: "Alice",
      projectName: "Backend",
    }));
    expect(msg.text).toContain("open");
    expect(msg.text).toContain("high");
    expect(msg.text).toContain("Alice");
    expect(msg.text).toContain("Backend");
  });

  it("includes description snippet", () => {
    const msg = formatIssueCreated(mockEvent({ description: "A long description about this issue" }));
    expect(msg.text).toContain("A long description");
  });

  it("truncates long descriptions at word boundary", () => {
    const words = Array(50).fill("word").join(" ");
    const msg = formatIssueCreated(mockEvent({ description: words }));
    expect(msg.text).toContain("\\.\\.\\.");
    expect(msg.text.length).toBeLessThan(words.length * 2);
  });

  it("omits metadata line when no metadata", () => {
    const msg = formatIssueCreated(mockEvent({
      status: undefined,
      priority: undefined,
      assigneeName: undefined,
      projectName: undefined,
    }));
    expect(msg.text).not.toContain("\\|");
  });
});

describe("formatIssueDone", () => {
  it("includes identifier and done text", () => {
    const msg = formatIssueDone(mockEvent());
    expect(msg.text).toContain("PROJ\\-42");
    expect(msg.text).toContain("done");
  });

  it("falls back to entityId", () => {
    const msg = formatIssueDone(mockEvent({ identifier: undefined }));
    expect(msg.text).toContain("iss\\-123");
  });

  it("includes comment when provided", () => {
    const msg = formatIssueDone(mockEvent({ comment: "Board prep package completed for Q3" }));
    expect(msg.text).toContain("Board prep package completed for Q3");
  });

  it("truncates long comments", () => {
    const longComment = Array(80).fill("word").join(" ");
    const msg = formatIssueDone(mockEvent({ comment: longComment }));
    expect(msg.text).toContain("\\.\\.\\.");
  });

  it("omits comment section when no comment", () => {
    const msg = formatIssueDone(mockEvent());
    // Should only have the title and done line, no blockquote
    const lines = msg.text.split("\n").filter((l: string) => l.trim());
    expect(lines.length).toBe(2);
  });
});

describe("formatApprovalCreated", () => {
  it("includes approve and reject buttons", () => {
    const msg = formatApprovalCreated(mockEvent({
      type: "deploy",
      approvalId: "apr-1",
      title: "Deploy to prod",
    }));
    expect(msg.options.inlineKeyboard).toBeDefined();
    const buttons = msg.options.inlineKeyboard![0];
    expect(buttons.length).toBe(2);
    expect(buttons[0].text).toBe("Approve");
    expect(buttons[0].callback_data).toBe("approve_apr-1");
    expect(buttons[1].text).toBe("Reject");
    expect(buttons[1].callback_data).toBe("reject_apr-1");
  });

  it("shows org context and native-reply guidance", () => {
    const msg = formatApprovalCreated(mockEvent({
      approvalId: "apr-1",
      linkedIssues: [{ identifier: "TWX-611", title: "Telegram decisions" }],
    }), { companyName: "TWB Digital" });
    expect(msg.text).toContain("TWB Digital");
    expect(msg.text).toContain("Reply to this message");
  });

  it("falls back to entityId for approvalId", () => {
    const msg = formatApprovalCreated(mockEvent({ approvalId: undefined }));
    const buttons = msg.options.inlineKeyboard![0];
    expect(buttons[0].callback_data).toBe("approve_iss-123");
  });

  it("includes agent name when provided", () => {
    const msg = formatApprovalCreated(mockEvent({
      agentName: "Builder",
      type: "deploy",
    }));
    expect(msg.text).toContain("Builder");
  });

  it("uses approval payload labels and includes decision context blocks", () => {
    const msg = formatApprovalCreated(mockEvent({
      approvalId: "apr-ctx",
      approvalPayload: {
        prompt: "Ship to production now?",
        summary: "All checks passed on staging.",
        options: ["Ship now", "Wait for QA"],
        recommendedDefault: "Ship now",
        risks: ["Small chance of rollback"],
        acceptLabel: "Ship now",
        rejectLabel: "Hold",
      },
    }));
    const buttons = msg.options.inlineKeyboard![0];
    expect(buttons[0].text).toBe("Ship now");
    expect(buttons[1].text).toBe("Hold");
    expect(msg.text).toContain("Recommended Default");
    expect(msg.text).toContain("Risks");
  });

  it("includes linked issues", () => {
    const msg = formatApprovalCreated(mockEvent({
      linkedIssues: [
        { identifier: "ISS-1", title: "First", status: "open" },
        { identifier: "ISS-2", title: "Second", status: "done" },
      ],
    }));
    expect(msg.text).toContain("ISS\\-1");
    expect(msg.text).toContain("ISS\\-2");
    expect(msg.text).toContain("Issue Context");
  });

  it("truncates description at word boundary", () => {
    const longDesc = Array(80).fill("word").join(" ");
    const msg = formatApprovalCreated(mockEvent({ description: longDesc }));
    expect(msg.text).toContain("word");
  });
});

describe("formatInteractionCreated", () => {
  it("renders request_confirmation interactions with accept/reject buttons", () => {
    const msg = formatInteractionCreated(mockEvent({
      interactionId: "int-1",
      interactionKind: "request_confirmation",
      issueIdentifier: "TWX-46",
      issueTitle: "Ship Telegram interface",
      interaction: {
        payload: {
          prompt: "Approve this rollout?",
          acceptLabel: "Yes, ship",
          rejectLabel: "No, wait",
        },
      },
    }));
    expect(msg.text).toContain("Approve this rollout");
    expect(msg.text).toContain("Decision needed");
    expect(msg.text).toContain("Reply to this message");
    expect(msg.text).not.toContain("Kind:");
    expect(msg.text).not.toContain("Interaction ID");
    const buttons = msg.options.inlineKeyboard![0];
    expect(buttons[0].callback_data).toBe("interaction_accept");
    expect(buttons[1].callback_data).toBe("interaction_reject");
  });

  it("renders ask_user_questions without exposing raw IDs", () => {
    const msg = formatInteractionCreated(mockEvent({
      interactionId: "int-2",
      interactionKind: "ask_user_questions",
      interaction: {
        payload: {
          title: "Pick scope",
          questions: [
            {
              id: "scope",
              prompt: "Which scope?",
              selectionMode: "single",
              options: [
                { id: "p0", label: "Phase 0 only" },
                { id: "all", label: "All phases" },
              ],
            },
          ],
        },
      },
    }));
    expect(msg.text).toContain("Q1");
    expect(msg.text).toContain("Phase 0 only");
    expect(msg.text).toContain("All phases");
    expect(msg.text).not.toContain("scope =");
    expect(msg.text).not.toContain("p0");
    expect(msg.text).not.toContain("• all =");
    expect(msg.text).not.toContain("Reply format");
    expect(msg.text).toContain("Reply to this message with option labels");
  });

  it("renders details in a dedicated block with paragraph breaks", () => {
    const msg = formatInteractionCreated(mockEvent({
      interactionId: "int-3",
      interactionKind: "request_confirmation",
      issueIdentifier: "TWX-138",
      issueTitle: "Domain deploy check",
      interaction: {
        payload: {
          prompt: "Approve Fix A?",
          detailsMarkdown: "B1 ships regardless.\n\nFix A lowers TTL blast radius.",
        },
      },
    }));
    expect(msg.text).toContain("Details");
    expect(msg.text).toContain("B1 ships regardless");
    expect(msg.text).toContain("\n\nFix A lowers TTL blast radius");
  });

  it("renders issue references in details as friendly labels", () => {
    const msg = formatInteractionCreated(mockEvent({
      interactionId: "int-4",
      interactionKind: "request_confirmation",
      interaction: {
        payload: {
          prompt: "Approve Fix A?",
          detailsMarkdown: "Context: /issues/TWX-91 and TWB-138 are related.",
        },
      },
    }));
    expect(msg.text).toContain("*TWX\\-91*");
    expect(msg.text).toContain("*TWB\\-138*");
    expect(msg.text).not.toContain("/issues/TWX\\-91");
  });
});

describe("formatAgentError", () => {
  it("includes agent name and error", () => {
    const msg = formatAgentError(mockEvent({
      agentName: "Builder",
      error: "Connection refused",
    }));
    expect(msg.text).toContain("Builder");
    expect(msg.text).toContain("Connection refused");
  });

  it("truncates long error messages", () => {
    const longError = "x".repeat(600);
    const msg = formatAgentError(mockEvent({ error: longError }));
    expect(msg.text).toContain("\\.\\.\\.");
    expect(msg.text).not.toContain("x".repeat(501));
  });

  it("falls back to entityId for agent name", () => {
    const msg = formatAgentError(mockEvent({ agentName: undefined, name: undefined }));
    expect(msg.text).toContain("iss\\-123");
  });
});

describe("formatAgentRunStarted", () => {
  it("includes agent name", () => {
    const msg = formatAgentRunStarted(mockEvent({ agentName: "Deployer" }));
    expect(msg.text).toContain("Deployer");
    expect(msg.text).toContain("started");
  });

  it("disables notification", () => {
    const msg = formatAgentRunStarted(mockEvent());
    expect(msg.options.disableNotification).toBe(true);
  });
});

describe("formatAgentRunFinished", () => {
  it("includes agent name and completion text", () => {
    const msg = formatAgentRunFinished(mockEvent({ agentName: "Deployer" }));
    expect(msg.text).toContain("Deployer");
    expect(msg.text).toContain("completed");
  });

  it("disables notification", () => {
    const msg = formatAgentRunFinished(mockEvent());
    expect(msg.options.disableNotification).toBe(true);
  });
});
