import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { escapeMarkdownV2, truncateAtWord } from "./telegram-api.js";
import type { SendMessageOptions } from "./telegram-api.js";
import { buildInteractionCallbackData } from "./interaction-callback-data.js";

type Payload = Record<string, unknown>;

type FormattedMessage = {
  text: string;
  options: SendMessageOptions;
};

function esc(s: string): string {
  return escapeMarkdownV2(s);
}

function bold(s: string): string {
  return `*${esc(s)}*`;
}

function code(s: string): string {
  return `\`${esc(s)}\``;
}

export type IssueLinksOpts = { baseUrl?: string; issuePrefix?: string };

type InteractionOption = {
  id: string;
  label: string;
  description?: string | null;
};

type InteractionQuestion = {
  id: string;
  prompt: string;
  selectionMode: "single" | "multi";
  options: InteractionOption[];
  required?: boolean;
};

function isExternalUrl(url?: string): boolean {
  return !!url && url.startsWith("https://");
}

function issueLink(identifier: string, opts?: IssueLinksOpts): string {
  if (opts?.baseUrl && opts?.issuePrefix) {
    const url = `${opts.baseUrl}/${opts.issuePrefix}/issues/${identifier}`;
    return `[${esc(identifier)}](${url})`;
  }
  return bold(identifier);
}

function issueButton(identifier: string, opts?: IssueLinksOpts): { text: string; url: string } | null {
  if (opts?.baseUrl && opts?.issuePrefix && isExternalUrl(opts.baseUrl)) {
    return { text: `Open ${identifier} ↗`, url: `${opts.baseUrl}/${opts.issuePrefix}/issues/${identifier}` };
  }
  return null;
}

function asPayload(value: unknown): Payload {
  return value && typeof value === "object" ? (value as Payload) : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function firstNonEmptyString(source: Payload, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === "string") return entry.trim();
        if (entry && typeof entry === "object") {
          const payload = entry as Payload;
          return firstNonEmptyString(payload, ["label", "title", "text", "value"]) ?? "";
        }
        return "";
      })
      .filter((entry) => entry.length > 0);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value.split("\n").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  }
  return [];
}

function formatOptionList(options: string[]): string | null {
  if (options.length === 0) return null;
  const preview = options.slice(0, 6).map((option) => `• ${esc(option)}`);
  if (options.length > 6) preview.push(`• ${esc(`+${String(options.length - 6)} more`)}`);
  return preview.join("\n");
}

function parseInteractionQuestions(value: unknown): InteractionQuestion[] {
  if (!Array.isArray(value)) return [];
  const questions: InteractionQuestion[] = [];
  for (const rawQuestion of value) {
    const q = asPayload(rawQuestion);
    const id = firstNonEmptyString(q, ["id"]) ?? "";
    const prompt = firstNonEmptyString(q, ["prompt"]) ?? "";
    if (!id || !prompt) continue;
    const selectionMode =
      q.selectionMode === "multi" ? "multi" : "single";
    const optionsRaw = Array.isArray(q.options) ? q.options : [];
    const options: InteractionOption[] = [];
    for (const rawOption of optionsRaw) {
      const option = asPayload(rawOption);
      const optionId = firstNonEmptyString(option, ["id"]) ?? "";
      const label = firstNonEmptyString(option, ["label"]) ?? "";
      if (!optionId || !label) continue;
      options.push({
        id: optionId,
        label,
        description: stringOrNull(option.description),
      });
    }
    if (options.length === 0) continue;
    questions.push({
      id,
      prompt,
      selectionMode,
      options,
      required: q.required === true,
    });
  }
  return questions;
}

function agentButton(agentId: string, label: string, publicUrl?: string): { text: string; url: string } | null {
  if (publicUrl && isExternalUrl(publicUrl)) {
    return { text: label, url: `${publicUrl}/agents/${agentId}` };
  }
  return null;
}

export function formatIssueCreated(event: PluginEvent, opts?: IssueLinksOpts): FormattedMessage {
  const p = event.payload as Payload;
  const identifier = String(p.identifier ?? event.entityId);
  const title = String(p.title ?? "Untitled");
  const status = p.status ? String(p.status) : null;
  const priority = p.priority ? String(p.priority) : null;
  const assigneeName = p.assigneeName ? String(p.assigneeName) : null;
  const projectName = p.projectName ? String(p.projectName) : null;

  const lines: string[] = [
    `${esc("📋")} ${bold("Issue Created")}: ${issueLink(identifier, opts)}`,
    bold(title),
  ];

  const meta: string[] = [];
  if (status) meta.push(`Status: ${code(status)}`);
  if (priority) meta.push(`Priority: ${code(priority)}`);
  if (assigneeName) meta.push(`Assignee: ${esc(assigneeName)}`);
  if (projectName) meta.push(`Project: ${esc(projectName)}`);
  if (meta.length > 0) lines.push(meta.join(" \\| "));

  if (p.description) {
    const desc = truncateAtWord(String(p.description), 200);
    lines.push(`\n${esc(">")} ${esc(desc)}`);
  }

  const button = issueButton(identifier, opts);
  return {
    text: lines.join("\n"),
    options: {
      parseMode: "MarkdownV2",
      ...(button ? { inlineKeyboard: [[button]] } : {}),
    },
  };
}

export function formatIssueDone(event: PluginEvent, opts?: IssueLinksOpts): FormattedMessage {
  const p = event.payload as Payload;
  const identifier = String(p.identifier ?? event.entityId);
  const title = String(p.title ?? "");
  const comment = p.comment ? String(p.comment) : null;

  const lines: string[] = [
    `${esc("✅")} ${bold("Issue Completed")}: ${issueLink(identifier, opts)}`,
    `${bold(title)} ${esc("is now done.")}`,
  ];

  if (comment) {
    const truncated = truncateAtWord(comment, 300);
    lines.push(`\n${esc(">")} ${esc(truncated)}`);
  }

  const button = issueButton(identifier, opts);
  return {
    text: lines.join("\n"),
    options: {
      parseMode: "MarkdownV2",
      ...(button ? { inlineKeyboard: [[button]] } : {}),
    },
  };
}

export function formatApprovalCreated(event: PluginEvent, opts?: IssueLinksOpts): FormattedMessage {
  const p = event.payload as Payload;
  const approvalType = String(p.type ?? "unknown");
  const approvalId = String(p.approvalId ?? event.entityId);
  const title = String(p.title ?? "Approval Requested");
  const detailPayload = asPayload(p.approvalPayload);
  const prompt = firstNonEmptyString(detailPayload, ["prompt", "title", "question", "whatIsBeingAsked"])
    ?? stringOrNull(p.description)
    ?? title;
  const summary = firstNonEmptyString(detailPayload, ["summary", "why", "reason", "rationale"]);
  const detailsMarkdown = firstNonEmptyString(detailPayload, ["detailsMarkdown", "details"]);
  const recommendedDefault = firstNonEmptyString(detailPayload, [
    "recommendedDefault",
    "recommendedAction",
    "recommendedOption",
    "recommended",
  ]);
  const risks = normalizeStringList(detailPayload.risks);
  const options = normalizeStringList(detailPayload.options);
  const acceptLabel = firstNonEmptyString(detailPayload, ["acceptLabel", "approveLabel"]) ?? "Approve";
  const rejectLabel = firstNonEmptyString(detailPayload, ["rejectLabel", "declineLabel"]) ?? "Reject";
  const agentName = p.agentName ? String(p.agentName) : null;

  const lines: string[] = [
    `${esc("🔔")} ${bold("Approval Requested")}`,
    `${bold("Request")}: ${esc(prompt)}`,
  ];

  lines.push(`${bold("Type")}: ${code(approvalType)}`);
  if (agentName) lines.push(`${bold("Requested By")}: ${esc(agentName)}`);
  if (summary) lines.push(`${bold("Summary / Why")}: ${esc(truncateAtWord(summary, 500))}`);
  if (detailsMarkdown) lines.push(`${bold("Details")}: ${esc(truncateAtWord(detailsMarkdown, 500))}`);
  const optionsBlock = formatOptionList(options);
  if (optionsBlock) lines.push(`${bold("Options")}:\n${optionsBlock}`);
  if (recommendedDefault) lines.push(`${bold("Recommended Default")}: ${esc(recommendedDefault)}`);
  const risksBlock = formatOptionList(risks);
  if (risksBlock) lines.push(`${bold("Risks")}:\n${risksBlock}`);

  // Add linked issues if present
  const linkedIssues = Array.isArray(p.linkedIssues) ? p.linkedIssues as Array<Payload> : [];
  if (linkedIssues.length > 0) {
    lines.push(`\n${bold("Issue Context")}`);
    for (const issue of linkedIssues.slice(0, 5)) {
      const issueId = String(issue.identifier ?? "?");
      const issueParts = [`${issueLink(issueId, opts)} ${esc(String(issue.title ?? ""))}`];
      const issueMeta: string[] = [];
      if (issue.status) issueMeta.push(String(issue.status));
      if (issue.priority) issueMeta.push(String(issue.priority));
      if (issue.assignee) issueMeta.push(`-> ${String(issue.assignee)}`);
      if (issueMeta.length > 0) issueParts.push(`\\(${esc(issueMeta.join(" | "))}\\)`);
      lines.push(issueParts.join(" "));
    }
  }

  const keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>> = [
    [
      { text: acceptLabel, callback_data: `approve_${approvalId}` },
      { text: rejectLabel, callback_data: `reject_${approvalId}` },
    ],
  ];

  // Add deep link to the first linked issue if available
  if (linkedIssues.length > 0) {
    const firstIssueId = String(linkedIssues[0]!.identifier ?? "");
    if (firstIssueId) {
      const btn = issueButton(firstIssueId, opts);
      if (btn) keyboard.push([btn]);
    }
  }

  return {
    text: lines.join("\n"),
    options: {
      parseMode: "MarkdownV2",
      inlineKeyboard: keyboard,
    },
  };
}

export function formatInteractionCreated(event: PluginEvent, opts?: IssueLinksOpts): FormattedMessage {
  const p = event.payload as Payload;
  const interactionId = String(p.interactionId ?? "interaction");
  const kind = String(p.interactionKind ?? "unknown");
  const issueId = String(event.entityId ?? "");
  const issueIdentifier = String(p.issueIdentifier ?? event.entityId);
  const issueTitle = stringOrNull(p.issueTitle);
  const interaction = asPayload(p.interaction);
  const interactionPayload = asPayload(interaction.payload);

  const lines: string[] = [
    `${esc("💬")} ${bold("Decision Interaction")}`,
    `${bold("Issue")}: ${issueLink(issueIdentifier, opts)}${issueTitle ? ` ${esc(issueTitle)}` : ""}`,
    `${bold("Kind")}: ${code(kind)}`,
  ];

  const keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>> = [];

  if (kind === "request_confirmation") {
    const prompt = firstNonEmptyString(interactionPayload, ["prompt"]) ?? "Please confirm this action.";
    const details = firstNonEmptyString(interactionPayload, ["detailsMarkdown"]);
    const acceptLabel = firstNonEmptyString(interactionPayload, ["acceptLabel"]) ?? "Accept";
    const rejectLabel = firstNonEmptyString(interactionPayload, ["rejectLabel"]) ?? "Reject";
    lines.push(`${bold("Prompt")}: ${esc(prompt)}`);
    if (details) lines.push(`${bold("Details")}: ${esc(truncateAtWord(details, 600))}`);
    const acceptData = buildInteractionCallbackData("accept", issueId, interactionId) ?? "interaction_accept";
    const rejectData = buildInteractionCallbackData("reject", issueId, interactionId) ?? "interaction_reject";
    keyboard.push([
      { text: acceptLabel, callback_data: acceptData },
      { text: rejectLabel, callback_data: rejectData },
    ]);
  } else if (kind === "ask_user_questions") {
    const title = firstNonEmptyString(interactionPayload, ["title"]) ?? "Please answer the questions below.";
    const questions = parseInteractionQuestions(interactionPayload.questions);
    lines.push(`${bold("Prompt")}: ${esc(title)}`);
    for (const question of questions.slice(0, 4)) {
      lines.push(`\n${bold(question.id)}: ${esc(question.prompt)}`);
      for (const option of question.options.slice(0, 6)) {
        lines.push(`• ${esc(option.id)} = ${esc(option.label)}`);
      }
      if (question.options.length > 6) lines.push(`• ${esc(`+${String(question.options.length - 6)} more`)}`);
    }
    lines.push(
      `\n${esc("Reply format")}: ${code("question_id=option_id[,option_id]")}`,
    );
    lines.push(
      `${esc("Example")}:\n${code("scope=all")}\n${code("region=eu,us")}`,
    );
  } else {
    lines.push(`${bold("Interaction ID")}: ${code(interactionId)}`);
  }

  const issueLinkButton = issueButton(issueIdentifier, opts);
  if (issueLinkButton) keyboard.push([issueLinkButton]);

  return {
    text: lines.join("\n"),
    options: {
      parseMode: "MarkdownV2",
      ...(keyboard.length > 0 ? { inlineKeyboard: keyboard } : {}),
    },
  };
}

export function formatAgentError(event: PluginEvent, opts?: IssueLinksOpts): FormattedMessage {
  const p = event.payload as Payload;
  const agentId = String(p.agentId ?? event.entityId);
  const agentName = String(p.agentName ?? p.name ?? agentId);
  const errorMessage = String(p.error ?? p.message ?? "Unknown error");

  const btn = agentButton(agentId, "View Agent ↗", opts?.baseUrl);
  return {
    text: [
      `${esc("❌")} ${bold("Agent Error")}`,
      `${bold(agentName)} ${esc("encountered an error")}`,
      `\n${code(truncateAtWord(errorMessage, 500))}`,
    ].join("\n"),
    options: {
      parseMode: "MarkdownV2",
      ...(btn ? { inlineKeyboard: [[btn]] } : {}),
    },
  };
}

export function formatAgentRunStarted(event: PluginEvent, opts?: IssueLinksOpts): FormattedMessage {
  const p = event.payload as Payload;
  const agentId = String(p.agentId ?? event.entityId);
  const agentName = String(p.agentName ?? agentId);
  const runId = p.runId ? String(p.runId) : null;

  const buttons: Array<{ text: string; url: string }> = [];
  if (opts?.baseUrl && isExternalUrl(opts.baseUrl)) {
    const url = runId
      ? `${opts.baseUrl}/agents/${agentId}/runs/${runId}`
      : `${opts.baseUrl}/agents/${agentId}`;
    buttons.push({ text: "View Run ↗", url });
  }

  return {
    text: `${esc("▶️")} ${bold(agentName)} ${esc("started a new run")}`,
    options: {
      parseMode: "MarkdownV2",
      disableNotification: true,
      ...(buttons.length > 0 ? { inlineKeyboard: [buttons] } : {}),
    },
  };
}

export function formatAgentRunFinished(event: PluginEvent, opts?: IssueLinksOpts): FormattedMessage {
  const p = event.payload as Payload;
  const agentId = String(p.agentId ?? event.entityId);
  const agentName = String(p.agentName ?? agentId);
  const runId = p.runId ? String(p.runId) : null;

  const buttons: Array<{ text: string; url: string }> = [];
  if (opts?.baseUrl && isExternalUrl(opts.baseUrl)) {
    const url = runId
      ? `${opts.baseUrl}/agents/${agentId}/runs/${runId}`
      : `${opts.baseUrl}/agents/${agentId}`;
    buttons.push({ text: "View Run ↗", url });
  }

  return {
    text: `${esc("⏹️")} ${bold(agentName)} ${esc("completed successfully")}`,
    options: {
      parseMode: "MarkdownV2",
      disableNotification: true,
      ...(buttons.length > 0 ? { inlineKeyboard: [buttons] } : {}),
    },
  };
}
