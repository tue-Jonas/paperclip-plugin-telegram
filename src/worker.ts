import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginEvent,
  type PluginHealthDiagnostics,
  type Agent,
  type Issue,
} from "@paperclipai/plugin-sdk";
import {
  sendMessage,
  editMessage,
  answerCallbackQuery,
  setMyCommands,
  escapeMarkdownV2,
  isForum,
  GENERAL_TOPIC_THREAD_ID,
} from "./telegram-api.js";
import {
  formatIssueCreated,
  formatIssueDone,
  formatApprovalCreated,
  formatInteractionCreated,
  formatAgentError,
  formatAgentRunStarted,
  formatAgentRunFinished,
  formatIssueBlocked,
  formatBoardMention,
  commentMentionsBoard,
  isInboxChatAllowed,
  type IssueLinksOpts,
} from "./formatters.js";
import { handleCommand, getTopicForProject, BOT_COMMANDS } from "./commands.js";
import {
  routeMessageToAgent,
  handleHandoffToolCall,
  handleDiscussToolCall,
  handleHandoffApproval,
  handleHandoffRejection,
  setupAcpOutputListener,
} from "./acp-bridge.js";
import { handleMediaMessage } from "./media-pipeline.js";
import { handleCommandsCommand, tryCustomCommand } from "./command-registry.js";
import { handleRegisterWatch, checkWatches } from "./watch-registry.js";
import { METRIC_NAMES } from "./constants.js";
import { EscalationManager } from "./escalation.js";
import type { EscalationEvent } from "./escalation.js";
import {
  type HostApiConfig,
  resolveCompanyId as resolveCompanyIdFromMap,
  createIssue,
  updateIssue,
} from "./host-api.js";
import { fetchApprovalContext, submitApprovalDecision } from "./approvals-api.js";
import {
  fetchInteraction,
  isAlreadyResolvedInteractionError,
  respondInteraction,
} from "./interactions-api.js";

type TelegramConfig = {
  telegramBotTokenRef: string;
  telegramBotToken?: string;
  boardApiToken?: string;
  boardApiTokenRef?: string;
  defaultCompanyId?: string;
  defaultChatId: string;
  approvalsChatId: string;
  errorsChatId: string;
  paperclipBaseUrl: string;
  paperclipPublicUrl: string;
  notifyOnIssueCreated: boolean;
  notifyOnIssueDone: boolean;
  notifyOnApprovalCreated: boolean;
  notifyOnAgentError: boolean;
  notifyOnAgentRunStarted: boolean;
  notifyOnAgentRunFinished: boolean;
  notifyOnIssueBlocked: boolean;
  notifyOnBoardMention: boolean;
  boardUsernames: string[];
  inboxAgentId: string;
  inboxChatIds: string[];
  enableCommands: boolean;
  enableInbound: boolean;
  digestMode: "off" | "daily" | "bidaily" | "tridaily";
  dailyDigestTime: string;
  bidailySecondTime: string;
  tridailyTimes: string;
  topicRouting: boolean;
  escalationChatId: string;
  escalationTimeoutMs: number;
  escalationDefaultAction: "defer" | "auto_reply" | "close";
  escalationHoldMessage: string;
  // Phase 3: Media Pipeline
  briefAgentId: string;
  briefAgentChatIds: string[];
  transcriptionApiKeyRef: string;
  // Phase 5: Proactive Suggestions
  maxSuggestionsPerHourPerCompany: number;
  watchDeduplicationWindowMs: number;
};

const INTERACTION_DELIVERIES_NAMESPACE = "plugin_telegram_63f79ea5a3";

export type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; username?: string; first_name?: string };
    chat: { id: number; type: string; title?: string };
    text?: string;
    message_thread_id?: number;
    reply_to_message?: {
      message_id: number;
      text?: string;
      from?: { is_bot?: boolean };
    };
    entities?: Array<{ type: string; offset: number; length: number }>;
    // Media fields (Phase 3)
    voice?: { file_id: string; duration: number; mime_type?: string };
    audio?: { file_id: string; duration: number; title?: string; mime_type?: string };
    video_note?: { file_id: string; duration: number };
    document?: { file_id: string; file_name?: string; mime_type?: string };
    photo?: Array<{ file_id: string; width: number; height: number }>;
    caption?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number; username?: string; first_name?: string };
    message?: {
      message_id: number;
      chat: { id: number };
      text?: string;
    };
    data?: string;
  };
};

const TELEGRAM_API = "https://api.telegram.org";

export type StoredMessageMapping = {
  entityId: string;
  entityType: string;
  companyId: string;
  eventType?: string;
  issueId?: string;
  issueIdentifier?: string;
  approvalId?: string;
  interactionId?: string;
  interactionKind?: string;
  interactionQuestions?: Array<{
    id: string;
    selectionMode: "single" | "multi";
    options: Array<{ id: string; label: string }>;
  }>;
};

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function firstNonEmptyString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function formatInboundAuditPrefix(msg: NonNullable<TelegramUpdate["message"]>): string {
  const username = msg.from?.username ? `@${msg.from.username}` : null;
  const display = username ?? msg.from?.first_name ?? (msg.from?.id ? String(msg.from.id) : "unknown");
  const chat = String(msg.chat.id);
  const thread = msg.message_thread_id ? String(msg.message_thread_id) : "main";
  return `[Telegram reply by ${display} | chat:${chat} | thread:${thread} | message:${String(msg.message_id)}]`;
}

function buildInboundAuditComment(
  msg: NonNullable<TelegramUpdate["message"]>,
  body: string,
): string {
  return `${formatInboundAuditPrefix(msg)}\n\n${body}`;
}

type ParsedQuestion = NonNullable<StoredMessageMapping["interactionQuestions"]>[number];

// Hint shown to users on a failed parse — keep it aligned with the Telegram
// formatter contract (formatters.ts:formatInteractionCreated, ask_user_questions).
export const ASK_QUESTIONS_PARSE_HINT =
  'No valid answers parsed. Reply with the option label (e.g. "Approve"). For multiple questions: Q1: <option label>';

// Resolve a single token (an option label OR an option id) to its option id for
// the given question. Label matching is case-insensitive and whitespace-trimmed.
function matchOptionId(question: ParsedQuestion, token: string): string | null {
  const needle = token.trim();
  if (!needle) return null;
  for (const option of question.options) {
    if (option.id === needle) return option.id;
  }
  const lowered = needle.toLowerCase();
  for (const option of question.options) {
    if (option.label.trim().toLowerCase() === lowered) return option.id;
  }
  return null;
}

// Resolve the value part of a reply (e.g. "High priority, Bug") to option ids.
// Comma-separated tokens are matched individually; if none match, the whole value
// is tried as a single option (so labels containing commas still resolve).
function resolveOptionIds(question: ParsedQuestion, valuePart: string): string[] {
  const matched: string[] = [];
  for (const raw of valuePart.split(",")) {
    const id = matchOptionId(question, raw);
    if (id) matched.push(id);
  }
  if (matched.length === 0) {
    const whole = matchOptionId(question, valuePart);
    if (whole) matched.push(whole);
  }
  return matched;
}

/**
 * Parse an inbound Telegram reply to an `ask_user_questions` interaction into the
 * `{ questionId, optionIds }[]` shape the board API expects.
 *
 * Accepted human-visible formats (matching the formatter contract):
 *  - Single question, bare label(s):           `High priority`  /  `Bug, Feature`
 *  - Multiple questions, positional addressing: `Q1: High priority` / `Q2: Bug, Feature`
 *  - Legacy id syntax (backward compatible):    `q-priority=opt-high,opt-low`
 *
 * Option tokens match either an option label (case-insensitive) or an option id.
 * For single-select questions only the first matched option is kept; for
 * multi-select, matches are de-duplicated. Lines that can't be attributed to a
 * question (e.g. a bare label while several questions are pending) are skipped.
 */
export function parseAskQuestionsAnswers(
  text: string,
  questions: StoredMessageMapping["interactionQuestions"],
): Array<{ questionId: string; optionIds: string[] }> {
  const availableQuestions = Array.isArray(questions) ? questions : [];
  if (availableQuestions.length === 0) return [];

  const byId = new Map<string, ParsedQuestion>();
  for (const question of availableQuestions) byId.set(question.id, question);

  // Accumulate per question so repeated/merged lines de-dup cleanly.
  const accumulator = new Map<string, { question: ParsedQuestion; optionIds: string[] }>();
  const record = (question: ParsedQuestion, optionIds: string[]) => {
    if (optionIds.length === 0) return;
    const existing = accumulator.get(question.id) ?? { question, optionIds: [] };
    for (const id of optionIds) {
      if (!existing.optionIds.includes(id)) existing.optionIds.push(id);
    }
    accumulator.set(question.id, existing);
  };

  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  for (const line of lines) {
    // Split on the first ':' or '=' delimiter into head/value.
    const delimiterMatch = line.match(/[:=]/);
    if (delimiterMatch && delimiterMatch.index !== undefined) {
      const head = line.slice(0, delimiterMatch.index).trim();
      const value = line.slice(delimiterMatch.index + 1).trim();
      if (!value) continue;

      // Legacy id syntax: head is an exact question id.
      const byIdQuestion = byId.get(head);
      if (byIdQuestion) {
        record(byIdQuestion, resolveOptionIds(byIdQuestion, value));
        continue;
      }
      // Positional addressing: head is `Q<n>` (1-indexed, as shown in the message).
      const positional = head.match(/^Q(\d+)$/i);
      if (positional) {
        const index = Number.parseInt(positional[1]!, 10) - 1;
        const question = availableQuestions[index];
        if (question) record(question, resolveOptionIds(question, value));
        continue;
      }
      // Unrecognized head: only safe to attribute if there's a single question.
      if (availableQuestions.length === 1) {
        record(availableQuestions[0]!, resolveOptionIds(availableQuestions[0]!, line));
      }
      continue;
    }

    // No delimiter: a bare label only resolves when exactly one question pending.
    if (availableQuestions.length === 1) {
      record(availableQuestions[0]!, resolveOptionIds(availableQuestions[0]!, line));
    }
  }

  const answers: Array<{ questionId: string; optionIds: string[] }> = [];
  for (const question of availableQuestions) {
    const entry = accumulator.get(question.id);
    if (!entry || entry.optionIds.length === 0) continue;
    const optionIds =
      question.selectionMode === "single" ? [entry.optionIds[0]!] : entry.optionIds;
    answers.push({ questionId: question.id, optionIds });
  }

  return answers;
}

async function resolveChat(
  ctx: PluginContext,
  companyId: string,
  fallback: string,
): Promise<string | null> {
  // Per-company routing override is best-effort: some host builds reject
  // gated state reads inside event handlers ("unknown invocation scope").
  // In that case fall back to the configured default chat so notifications
  // still deliver.
  let override: unknown;
  try {
    override = await ctx.state.get({
      scopeKind: "company",
      scopeId: companyId,
      stateKey: "telegram-chat",
    });
  } catch {
    override = undefined;
  }
  return (override as string) ?? fallback ?? null;
}

// Resolve the company for an inbound chat without touching ctx.state (gated in
// the poll loop). Uses the in-process /connect map, then config.defaultCompanyId,
// then the chatId. See host-api.ts.
function resolveCompanyId(config: HostApiConfig, chatId: string): string {
  return resolveCompanyIdFromMap(chatId, config);
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe SQL identifier: ${value}`);
  }
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function pluginTableName(namespace: string, table: string): string {
  return `${quoteIdentifier(namespace)}.${quoteIdentifier(table)}`;
}

export function assertInteractionDeliveriesNamespace(ctx: PluginContext): void {
  if (ctx.db.namespace !== INTERACTION_DELIVERIES_NAMESPACE) {
    throw new Error(
      `Telegram interaction delivery migration namespace mismatch: runtime namespace "${ctx.db.namespace}" does not match migration schema "${INTERACTION_DELIVERIES_NAMESPACE}"`,
    );
  }
}

async function claimInteractionDelivery(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
  interactionId: string,
  interactionKind: string,
): Promise<boolean> {
  const db = ctx.db;
  const deliveryKey = `${companyId}:${issueId}:${interactionId}`;
  const result = await db.execute(
    `INSERT INTO ${pluginTableName(db.namespace, "interaction_deliveries")}
       (delivery_key, company_id, issue_id, interaction_id, interaction_kind)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (delivery_key) DO NOTHING`,
    [deliveryKey, companyId, issueId, interactionId, interactionKind],
  );
  return (result.rowCount ?? 0) > 0;
}

async function releaseInteractionDeliveryClaim(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
  interactionId: string,
): Promise<void> {
  const db = ctx.db;
  const deliveryKey = `${companyId}:${issueId}:${interactionId}`;
  await db.execute(
    `DELETE FROM ${pluginTableName(db.namespace, "interaction_deliveries")}
     WHERE delivery_key = $1 AND sent_at IS NULL`,
    [deliveryKey],
  );
}

async function recordInteractionDeliverySent(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
  interactionId: string,
  telegramMessageId: number,
): Promise<void> {
  const db = ctx.db;
  const deliveryKey = `${companyId}:${issueId}:${interactionId}`;
  await db.execute(
    `UPDATE ${pluginTableName(db.namespace, "interaction_deliveries")}
     SET telegram_message_id = $2, sent_at = now()
     WHERE delivery_key = $1`,
    [deliveryKey, String(telegramMessageId)],
  );
}

// --- Pending-decision tracking (TWX-455) ---------------------------------
// A "Decision needed" interaction delivered to a chat puts that chat into a
// modal state: the board owes a decision. The board user frequently answers by
// typing a free-text message rather than tapping a button or using Telegram's
// swipe-to-reply. Without native-reply context we cannot key off the replied-to
// message, so we track the most recent unresolved decision per chat and treat
// the next top-level text as a response to it (instead of spawning a new inbox
// issue). The record is cleared once the decision is resolved (button, reply,
// or text response), so once nothing is pending top-level text is inbox again.
function pendingDecisionKey(chatId: string): string {
  return `pending_decision_${chatId}`;
}

async function recordPendingDecision(
  ctx: PluginContext,
  chatId: string,
  mapping: StoredMessageMapping,
): Promise<void> {
  if (!mapping.issueId || !mapping.interactionId) return;
  try {
    await ctx.state.set(
      { scopeKind: "instance", stateKey: pendingDecisionKey(chatId) },
      mapping,
    );
  } catch { /* best effort */ }
}

async function getPendingDecision(
  ctx: PluginContext,
  chatId: string,
): Promise<StoredMessageMapping | null> {
  let record: StoredMessageMapping | null = null;
  try {
    record = await ctx.state.get({
      scopeKind: "instance",
      stateKey: pendingDecisionKey(chatId),
    }) as StoredMessageMapping | null;
  } catch {
    return null;
  }
  if (!record || !record.issueId || !record.interactionId) return null;
  return record;
}

async function clearPendingDecision(ctx: PluginContext, chatId: string): Promise<void> {
  try {
    // No state.delete in the SDK; a tombstone with no interactionId reads as
    // "nothing pending" via getPendingDecision().
    await ctx.state.set(
      { scopeKind: "instance", stateKey: pendingDecisionKey(chatId) },
      { entityType: "interaction", companyId: "", resolved: true },
    );
  } catch { /* best effort */ }
}

export type InteractionResponseResult =
  | "routed"
  | "needs-input"
  | "already-resolved"
  | "missing-token"
  | "error"
  | "skipped";

/**
 * Turn a Telegram text reply into a response on the originating decision's
 * interaction. Shared by the native-reply path and the pending-decision path.
 *
 * For request_confirmation: affirmative keywords accept; everything else —
 * explicit "no" OR an arbitrary free-text message — is a reject-with-reason so
 * the agent wakes on the decision's own issue with the board's instructions
 * (TWX-455). Free text is "needs changes", never a bounce.
 */
export async function routeInteractionResponse(
  ctx: PluginContext,
  baseUrl: string,
  boardApiToken: string,
  mapping: StoredMessageMapping,
  text: string,
): Promise<InteractionResponseResult> {
  if (!mapping.issueId || !mapping.interactionId) return "skipped";
  if (!boardApiToken) return "missing-token";

  const issueId = mapping.issueId;
  const interactionId = mapping.interactionId;
  try {
    if (mapping.interactionKind === "request_confirmation") {
      const normalized = text.trim().toLowerCase();
      const affirmatives = [
        "accept", "approve", "approved", "yes", "y", "yep", "yeah", "yup",
        "ok", "okay", "sure", "confirm", "confirmed", "👍", "✅",
      ];
      if (affirmatives.includes(normalized)) {
        await respondInteraction(ctx.http, {
          baseUrl, issueId, interactionId, action: "accept", boardApiToken,
        });
      } else {
        const reason = ["reject", "no", "n"].includes(normalized)
          ? `Telegram reply: ${text}`
          : `Needs changes (Telegram reply): ${text}`;
        await respondInteraction(ctx.http, {
          baseUrl, issueId, interactionId, action: "reject", boardApiToken, reason,
        });
      }
    } else if (mapping.interactionKind === "ask_user_questions") {
      const answers = parseAskQuestionsAnswers(text, mapping.interactionQuestions);
      if (answers.length === 0) return "needs-input";
      await respondInteraction(ctx.http, {
        baseUrl, issueId, interactionId, action: "respond", boardApiToken, answers,
      });
    } else {
      return "skipped";
    }
    await ctx.metrics.write(METRIC_NAMES.inboundRouted, 1);
    return "routed";
  } catch (err) {
    if (isAlreadyResolvedInteractionError(err)) return "already-resolved";
    ctx.logger.error("Failed to route interaction reply", {
      issueId,
      interactionId,
      error: String(err),
    });
    return "error";
  }
}

type InteractionNotify = (
  event: PluginEvent,
  formatter: (e: PluginEvent, opts?: IssueLinksOpts) => { text: string; options: import("./telegram-api.js").SendMessageOptions },
  overrideChatId?: string,
  mappingOverride?: Partial<StoredMessageMapping>,
) => Promise<number | null>;

export async function dispatchInteractionNotification(
  ctx: PluginContext,
  event: PluginEvent,
  input: {
    baseUrl: string;
    boardApiToken: string;
    defaultChatId: string;
    approvalsChatId?: string;
    notify: InteractionNotify;
  },
): Promise<"sent" | "duplicate" | "skipped" | "failed"> {
  const payload = event.payload as Record<string, unknown>;
  const issueId = String(event.entityId ?? "");
  if (!issueId) return "skipped";
  const interactionId = String(payload.interactionId ?? "");
  const interactionKind = String(payload.interactionKind ?? "");
  if (!interactionId) return "skipped";
  if (interactionKind !== "request_confirmation" && interactionKind !== "ask_user_questions") return "skipped";
  if (!input.boardApiToken) {
    ctx.logger.warn("Skipping interaction Telegram notification: board token missing", {
      issueId,
      interactionId,
      interactionKind,
    });
    return "skipped";
  }

  let claimed = false;
  try {
    claimed = await claimInteractionDelivery(ctx, event.companyId, issueId, interactionId, interactionKind);
    if (!claimed) return "duplicate";

    const interaction = await fetchInteraction(ctx.http, {
      baseUrl: input.baseUrl,
      issueId,
      interactionId,
      boardApiToken: input.boardApiToken,
    });
    if (!interaction) {
      await releaseInteractionDeliveryClaim(ctx, event.companyId, issueId, interactionId);
      return "skipped";
    }

    let issue: Issue | null = null;
    try {
      issue = await ctx.issues.get(issueId, event.companyId);
    } catch { /* best effort */ }

    payload.interaction = interaction;
    payload.issueIdentifier = issue?.identifier ?? issueId;
    payload.issueTitle = issue?.title ?? null;
    payload.interactionKind = interactionKind;

    const interactionPayload = toRecord(interaction.payload);
    const questions = Array.isArray(interactionPayload.questions)
      ? interactionPayload.questions
          .map((question) => {
            const q = toRecord(question);
            const id = firstNonEmptyString(q, ["id"]);
            if (!id) return null;
            const selectionMode = q.selectionMode === "multi" ? "multi" : "single";
            const options = Array.isArray(q.options)
              ? q.options
                  .map((option) => {
                    const o = toRecord(option);
                    const optionId = firstNonEmptyString(o, ["id"]);
                    const label = firstNonEmptyString(o, ["label"]);
                    if (!optionId || !label) return null;
                    return { id: optionId, label };
                  })
                  .filter((option): option is { id: string; label: string } => Boolean(option))
              : [];
            return { id, selectionMode, options };
          })
          .filter((entry): entry is { id: string; selectionMode: "single" | "multi"; options: Array<{ id: string; label: string }> } => Boolean(entry))
      : [];

    const messageId = await input.notify(
      event,
      formatInteractionCreated,
      input.approvalsChatId || input.defaultChatId,
      {
        entityType: "interaction",
        issueId,
        issueIdentifier: issue?.identifier ?? issueId,
        interactionId,
        interactionKind,
        interactionQuestions: questions,
      },
    );

    if (!messageId) {
      await releaseInteractionDeliveryClaim(ctx, event.companyId, issueId, interactionId);
      return "failed";
    }

    try {
      await recordInteractionDeliverySent(ctx, event.companyId, issueId, interactionId, messageId);
    } catch (err) {
      ctx.logger.warn("Could not record Telegram interaction delivery as sent", {
        issueId,
        interactionId,
        interactionKind,
        error: String(err),
      });
    }
    return "sent";
  } catch (err) {
    if (claimed) {
      try {
        await releaseInteractionDeliveryClaim(ctx, event.companyId, issueId, interactionId);
      } catch (releaseErr) {
        ctx.logger.error("Failed to release unsent interaction delivery claim", {
          issueId,
          interactionId,
          interactionKind,
          error: String(releaseErr),
        });
      }
    }
    ctx.logger.error("Failed to dispatch interaction notification", {
      issueId,
      interactionId,
      interactionKind,
      error: String(err),
    });
    return "failed";
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    assertInteractionDeliveriesNamespace(ctx);

    const rawConfig = await ctx.config.get();
    ctx.logger.info("Telegram plugin config loaded");
    const config = rawConfig as unknown as TelegramConfig;
    const baseUrl = config.paperclipBaseUrl || "http://localhost:3100";
    const publicUrl = config.paperclipPublicUrl || baseUrl;

    // Resolve the bot token. Prefer the inline value (host builds where plugin
    // secret references are disabled); otherwise resolve the secret reference.
    const token = config.telegramBotToken
      ? config.telegramBotToken
      : config.telegramBotTokenRef
        ? await ctx.secrets.resolve(config.telegramBotTokenRef)
        : "";
    if (!token) {
      ctx.logger.warn(
        "No telegram bot token configured (telegramBotToken or telegramBotTokenRef), plugin disabled",
      );
      return;
    }

    let boardApiToken = config.boardApiToken?.trim() ?? "";
    if (!boardApiToken && config.boardApiTokenRef) {
      try {
        boardApiToken = await ctx.secrets.resolve(config.boardApiTokenRef);
      } catch {
        boardApiToken = "";
      }
    }
    // --- Register bot commands with Telegram ---
    if (config.enableCommands) {
      const allCommands = [
        ...BOT_COMMANDS,
        { command: "commands", description: "Manage custom workflow commands" },
      ];
      // Non-blocking init: don't hold up worker initialize on external API.
      // The host's worker-init RPC timeout is 15s; if api.telegram.org is
      // slow/unreachable, awaiting this call causes the worker to be SIGKILLed
      // before setup() completes. Fire-and-forget matches pollUpdates() below.
      setMyCommands(ctx, token, allCommands)
        .then((registered) => {
          if (registered) {
            ctx.logger.info("Bot commands registered with Telegram");
          }
        })
        .catch((err) => {
          ctx.logger.error("Failed to register bot commands", {
            error: String(err),
          });
        });
    }

    // --- Long polling for inbound messages ---
    let pollingActive = true;
    let lastUpdateId = 0;

    async function pollUpdates(): Promise<void> {
      while (pollingActive) {
        try {
          const res = await ctx.http.fetch(
            `${TELEGRAM_API}/bot${token}/getUpdates?offset=${lastUpdateId + 1}&timeout=10&allowed_updates=["message","callback_query"]`,
            { method: "GET" },
          );
          const data = (await res.json()) as {
            ok: boolean;
            result?: TelegramUpdate[];
          };

          if (data.ok && data.result) {
            for (const update of data.result) {
              lastUpdateId = Math.max(lastUpdateId, update.update_id);
              await handleUpdate(
                ctx,
                token,
                config,
                update,
                baseUrl,
                publicUrl,
                boardApiToken,
              );
            }
          }
        } catch (err) {
          ctx.logger.error("Telegram polling error", { error: String(err) });
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    }

    if (config.enableCommands || config.enableInbound) {
      pollUpdates().catch((err) =>
        ctx.logger.error("Polling loop crashed", { error: String(err) }),
      );
    }

    ctx.events.on("plugin.stopping", async () => {
      pollingActive = false;
    });

    // --- Phase 2: ACP output listener (cross-plugin events) ---
    setupAcpOutputListener(ctx, token);

    // --- Event subscriptions ---

    const issuePrefixCache = new Map<string, string>();

    async function resolveIssueLinksOpts(companyId: string): Promise<IssueLinksOpts> {
      let prefix = issuePrefixCache.get(companyId);
      if (!prefix) {
        // Best-effort: gated company reads can fail inside event handlers on
        // hosts that don't propagate an invocation scope. Degrade to no prefix
        // (links still work via baseUrl) rather than dropping the notification.
        try {
          const company = await ctx.companies.get(companyId);
          prefix = company?.issuePrefix ?? "";
          if (prefix) issuePrefixCache.set(companyId, prefix);
        } catch {
          prefix = "";
        }
      }
      return { baseUrl: publicUrl, issuePrefix: prefix || undefined };
    }

    const notify = async (
      event: PluginEvent,
      formatter: (e: PluginEvent, opts?: IssueLinksOpts) => { text: string; options: import("./telegram-api.js").SendMessageOptions },
      overrideChatId?: string,
      mappingOverride?: Partial<StoredMessageMapping>,
    ): Promise<number | null> => {
      const chatId = await resolveChat(
        ctx,
        event.companyId,
        overrideChatId || config.defaultChatId,
      );
      if (!chatId) return null;
      const linksOpts = await resolveIssueLinksOpts(event.companyId);
      const msg = formatter(event, linksOpts);

      let messageThreadId: number | undefined;
      if (config.topicRouting) {
        const payload = event.payload as Record<string, unknown>;
        const projectName = payload.projectName ? String(payload.projectName) : undefined;
        messageThreadId = await getTopicForProject(ctx, chatId, projectName);
      }
      // For forum groups, fall back to General topic if no specific topic mapping
      if (!messageThreadId && await isForum(ctx, token, chatId)) {
        messageThreadId = GENERAL_TOPIC_THREAD_ID;
      }

      if (messageThreadId) {
        msg.options.messageThreadId = messageThreadId;
      }

      const messageId = await sendMessage(ctx, token, chatId, msg.text, msg.options);

      if (messageId) {
        const mapping: StoredMessageMapping = {
          entityId: String(event.entityId ?? ""),
          entityType: String(event.entityType ?? "unknown"),
          companyId: event.companyId,
          eventType: event.eventType,
          ...(mappingOverride ?? {}),
        };
        // Reply-routing map + activity log are best-effort: gated writes can be
        // rejected on hosts without an invocation scope in event handlers. The
        // notification itself has already been delivered, so never let these
        // throw out of notify().
        try {
          await ctx.state.set(
            {
              scopeKind: "instance",
              stateKey: `msg_${chatId}_${messageId}`,
            },
            mapping,
          );
        } catch { /* best effort */ }

        // TWX-455: remember the pending decision for this chat so a free-text
        // (non-native-reply) response routes back to the decision instead of
        // spawning a new inbox issue. Only request_confirmation is recorded:
        // it is the kind that meaningfully accepts arbitrary free text (as a
        // needs-changes reject-with-reason). ask_user_questions needs a
        // structured answer that can't be inferred from free text, and other
        // kinds (suggest_tasks, …) aren't routable here at all — recording them
        // would trap the chat's inbox (every later free-text message bounces or
        // is skipped) and leave an uncleared pending record. Those kinds still
        // route correctly via the native swipe-reply path; their free text
        // falls through to inbox as before.
        if (
          mapping.entityType === "interaction" &&
          mapping.interactionId &&
          mapping.interactionKind === "request_confirmation"
        ) {
          await recordPendingDecision(ctx, chatId, mapping);
        }

        try {
          await ctx.activity.log({
            companyId: event.companyId,
            message: `Forwarded ${event.eventType} to Telegram`,
            entityType: "plugin",
            entityId: event.entityId,
          });
        } catch { /* best effort */ }
      }

      return messageId;
    };

    if (config.notifyOnIssueCreated) {
      ctx.events.on("issue.created", async (event: PluginEvent) => {
        await notify(event, formatIssueCreated);
      });
    }

    if (config.notifyOnIssueDone) {
      ctx.events.on("issue.updated", async (event: PluginEvent) => {
        const payload = event.payload as Record<string, unknown>;
        if (payload.status !== "done") return;
        // Enrich with title if missing (issue.updated events often omit it)
        if (!payload.title && event.entityId) {
          try {
            const issue = await ctx.issues.get(event.entityId, event.companyId);
            if (issue) payload.title = issue.title;
          } catch { /* best effort */ }
        }
        // Enrich with latest comment (completion summary)
        if (!payload.comment && event.entityId) {
          try {
            const comments = await ctx.issues.listComments(event.entityId, event.companyId);
            if (comments.length > 0) {
              const latest = comments.reduce((a, b) =>
                new Date(a.createdAt) > new Date(b.createdAt) ? a : b,
              );
              payload.comment = latest.body;
            }
          } catch { /* best effort */ }
        }
        await notify(event, formatIssueDone);
      });
    }

    if (config.notifyOnApprovalCreated) {
      ctx.events.on("approval.created", async (event: PluginEvent) => {
        const payload = event.payload as Record<string, unknown>;
        const approvalId = String(payload.approvalId ?? event.entityId);

        if (boardApiToken) {
          try {
            const approvalContext = await fetchApprovalContext(ctx.http, {
              baseUrl,
              approvalId,
              boardApiToken,
            });
            payload.approvalPayload = toRecord(approvalContext.approval.payload);
            payload.type = String(approvalContext.approval.type ?? payload.type ?? "unknown");
            const requestedByAgentId = firstNonEmptyString(approvalContext.approval, ["requestedByAgentId"]);
            if (requestedByAgentId && !payload.agentId) payload.agentId = requestedByAgentId;
            payload.linkedIssues = approvalContext.issues.map((issue) => ({
              id: String(issue.id ?? ""),
              identifier: String(issue.identifier ?? ""),
              title: String(issue.title ?? ""),
              status: String(issue.status ?? ""),
              priority: String(issue.priority ?? ""),
              assignee: firstNonEmptyString(toRecord(issue), ["assigneeName"]),
            }));
          } catch (err) {
            ctx.logger.warn("Could not enrich approval notification from API", {
              approvalId,
              error: String(err),
            });
          }
        }

        // Enrich with linked issue details (event only has issueIds)
        const issueIds = Array.isArray(payload.issueIds) ? payload.issueIds as string[] : [];
        if (issueIds.length > 0 && !payload.linkedIssues) {
          try {
            const issues = await Promise.all(
              issueIds.slice(0, 5).map((id) => ctx.issues.get(id, event.companyId)),
            );
            payload.linkedIssues = issues
              .filter(Boolean)
              .map((i) => ({
                identifier: i!.identifier,
                title: i!.title,
                status: i!.status,
                priority: i!.priority,
              }));
            // Use first issue's title as the approval title if missing
            if (!payload.title && issues[0]) {
              payload.title = issues[0].identifier
                ? `${issues[0].identifier}: ${issues[0].title}`
                : issues[0].title;
            }
          } catch { /* best effort */ }
        }
        // Enrich agent name
        if (payload.agentId && !payload.agentName) {
          try {
            const agent = await ctx.agents.get(String(payload.agentId), event.companyId);
            if (agent) payload.agentName = agent.name;
          } catch { /* best effort */ }
        }
        // Build a meaningful title if still missing
        if (!payload.title || payload.title === "Approval Requested") {
          const approvalType = String(payload.type ?? "unknown").replace(/_/g, " ");
          const agentLabel = payload.agentName ? String(payload.agentName) : null;
          payload.title = agentLabel
            ? `${approvalType} — ${agentLabel}`
            : approvalType;
        }
        const linkedIssues = Array.isArray(payload.linkedIssues)
          ? payload.linkedIssues as Array<Record<string, unknown>>
          : [];
        const firstIssue = linkedIssues[0];
        const firstIssueId = firstIssue && typeof firstIssue.id === "string" ? firstIssue.id : null;
        await notify(
          event,
          formatApprovalCreated,
          config.approvalsChatId,
          {
            entityType: "approval",
            approvalId,
            issueId: firstIssueId ?? undefined,
          },
        );
      });
    }

    ctx.events.on("issue.interaction.created" as never, async (event: PluginEvent) => {
      await dispatchInteractionNotification(ctx, event, {
        baseUrl,
        boardApiToken,
        defaultChatId: config.defaultChatId,
        approvalsChatId: config.approvalsChatId,
        notify,
      });
    });

    if (config.notifyOnAgentError) {
      ctx.events.on("agent.run.failed", async (event: PluginEvent) => {
        await notify(event, formatAgentError, config.errorsChatId);
      });
    }

    if (config.notifyOnAgentRunStarted) {
      ctx.events.on("agent.run.started", async (event: PluginEvent) => {
        await notify(event, formatAgentRunStarted);
      });
    }
    if (config.notifyOnAgentRunFinished) {
      ctx.events.on("agent.run.finished", async (event: PluginEvent) => {
        await notify(event, formatAgentRunFinished);
      });
    }

    if (config.notifyOnIssueBlocked) {
      ctx.events.on("issue.updated", async (event: PluginEvent) => {
        const payload = event.payload as Record<string, unknown>;
        if (payload.status !== "blocked") return;
        // Only forward when the issue is assigned to a board user (human).
        // We enrich from the issue record because the event payload doesn't
        // always carry assignee fields. If we can't confirm a human assignee,
        // skip — we don't want to spam chat for every agent-owned blocker.
        let assigneeUserId: string | null = null;
        let assigneeName: string | null = null;
        let title = payload.title ? String(payload.title) : null;
        if (event.entityId) {
          try {
            const issue = await ctx.issues.get(event.entityId, event.companyId);
            if (issue) {
              const anyIssue = issue as unknown as { assigneeUserId?: string | null; assigneeName?: string | null; title?: string };
              assigneeUserId = anyIssue.assigneeUserId ?? null;
              assigneeName = anyIssue.assigneeName ?? null;
              if (!title && anyIssue.title) title = anyIssue.title;
            }
          } catch { /* best effort */ }
        }
        if (!assigneeUserId) return;
        if (title && !payload.title) payload.title = title;
        if (assigneeName && !payload.assigneeName) payload.assigneeName = assigneeName;
        // Attach latest comment body as context for the blocker
        if (!payload.comment && event.entityId) {
          try {
            const comments = await ctx.issues.listComments(event.entityId, event.companyId);
            if (comments.length > 0) {
              const latest = comments.reduce((a, b) =>
                new Date(a.createdAt) > new Date(b.createdAt) ? a : b,
              );
              payload.comment = latest.body;
            }
          } catch { /* best effort */ }
        }
        await notify(event, formatIssueBlocked);
      });
    }

    if (config.notifyOnBoardMention) {
      ctx.events.on("issue.comment.created", async (event: PluginEvent) => {
        const payload = event.payload as Record<string, unknown>;
        const body = payload.body ? String(payload.body) : "";
        const usernames = Array.isArray(config.boardUsernames) ? config.boardUsernames : [];
        if (!commentMentionsBoard(body, usernames)) return;
        // Enrich issue identifier / title and author username for the formatter
        const issueId = (payload.issueId as string | undefined) ?? event.entityId;
        if (issueId) {
          try {
            const issue = await ctx.issues.get(issueId, event.companyId);
            if (issue) {
              payload.issueIdentifier = issue.identifier;
              payload.issueTitle = issue.title;
            }
          } catch { /* best effort */ }
        }
        await notify(event, formatBoardMention);
      });
    }

    // --- Per-company chat overrides ---

    ctx.data.register("chat-mapping", async (params) => {
      const companyId = String(params.companyId);
      const saved = await ctx.state.get({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: "telegram-chat",
      });
      return { chatId: saved ?? config.defaultChatId };
    });

    ctx.actions.register("set-chat", async (params) => {
      const companyId = String(params.companyId);
      const chatId = String(params.chatId);
      await ctx.state.set(
        { scopeKind: "company", scopeId: companyId, stateKey: "telegram-chat" },
        chatId,
      );
      ctx.logger.info("Updated Telegram chat mapping", { companyId, chatId });
      return { ok: true };
    });

    // --- Daily digest job ---

    // Support legacy dailyDigestEnabled boolean
    const effectiveDigestMode = (config as Record<string, unknown>).dailyDigestEnabled === true && config.digestMode === "off"
      ? "daily"
      : config.digestMode ?? "off";

    ctx.jobs.register("telegram-daily-digest", async () => {
      if (effectiveDigestMode === "off") return;

        // Check if current UTC hour matches a configured digest time
        const nowHour = new Date().getUTCHours();
        const nowMin = new Date().getUTCMinutes();
        if (nowMin >= 5) return; // only fire within first 5 min of the hour

        const parseHour = (t: string) => {
          const [h] = (t || "").split(":");
          return parseInt(h ?? "", 10);
        };
        const firstHour = parseHour(config.dailyDigestTime);
        const secondHour = parseHour(config.bidailySecondTime);
        const tridailyHours = (config.tridailyTimes || "07:00,13:00,19:00")
          .split(",")
          .map((t) => parseHour(t.trim()));

        let shouldSend = false;
        if (effectiveDigestMode === "daily") {
          shouldSend = nowHour === firstHour;
        } else if (effectiveDigestMode === "bidaily") {
          shouldSend = nowHour === firstHour || nowHour === secondHour;
        } else if (effectiveDigestMode === "tridaily") {
          shouldSend = tridailyHours.includes(nowHour);
        }
        if (!shouldSend) return;

        const companies = await ctx.companies.list();
        for (const company of companies) {
          const chatId = await resolveChat(ctx, company.id, config.defaultChatId);
          if (!chatId) continue;

          try {
            const agents = await ctx.agents.list({ companyId: company.id });
            const activeAgents = agents.filter((a: Agent) => a.status === "active");
            const issues = await ctx.issues.list({ companyId: company.id, limit: 50 });

            const now = Date.now();
            const oneDayMs = 24 * 60 * 60 * 1000;
            const completedToday = issues.filter((i: Issue) =>
              i.status === "done" && i.completedAt && (now - new Date(i.completedAt).getTime()) < oneDayMs
            );
            const createdToday = issues.filter((i: Issue) =>
              (now - new Date(i.createdAt).getTime()) < oneDayMs
            );

            const issuePrefix = company.issuePrefix;
            const inProgress = issues.filter((i: Issue) => i.status === "in_progress");
            const inReview = issues.filter((i: Issue) => i.status === "in_review");
            const blocked = issues.filter((i: Issue) => i.status === "blocked");

            const dateStr = new Date().toISOString().split("T")[0];
            const companyLabel = company.name ? ` \\- ${escapeMarkdownV2(company.name)}` : "";
            const digestLabel = effectiveDigestMode === "bidaily" ? "Digest" : "Daily Digest";
            const lines = [
              escapeMarkdownV2("\ud83d\udcca") + ` *${escapeMarkdownV2(digestLabel)}${companyLabel} \\- ${escapeMarkdownV2(dateStr!)}*`,
              "",
              `${escapeMarkdownV2("\u2705")} Tasks completed: *${completedToday.length}*`,
              `${escapeMarkdownV2("\ud83d\udccb")} Tasks created: *${createdToday.length}*`,
              `${escapeMarkdownV2("\ud83e\udd16")} Active agents: *${activeAgents.length}*/${escapeMarkdownV2(String(agents.length))}`,
            ];

            if (activeAgents.length > 0) {
              const topAgent = activeAgents[0]!.name;
              lines.push(`${escapeMarkdownV2("\u2b50")} Top performer: *${escapeMarkdownV2(topAgent)}*`);
            }

            const formatIssueItem = (i: Issue) => {
              const id = i.identifier ?? i.id;
              const idText = issuePrefix
                ? `[${escapeMarkdownV2(id)}](${publicUrl}/${issuePrefix}/issues/${id})`
                : escapeMarkdownV2(id);
              return `  ${idText} \\- ${escapeMarkdownV2(i.title)}`;
            };

            if (inProgress.length > 0) {
              lines.push("", `${escapeMarkdownV2("\ud83d\udd04")} *In Progress \\(${inProgress.length}\\)*`);
              for (const i of inProgress.slice(0, 10)) lines.push(formatIssueItem(i));
            }
            if (inReview.length > 0) {
              lines.push("", `${escapeMarkdownV2("\ud83d\udd0d")} *In Review \\(${inReview.length}\\)*`);
              for (const i of inReview.slice(0, 10)) lines.push(formatIssueItem(i));
            }
            if (blocked.length > 0) {
              lines.push("", `${escapeMarkdownV2("\ud83d\udeab")} *Blocked \\(${blocked.length}\\)*`);
              for (const i of blocked.slice(0, 10)) lines.push(formatIssueItem(i));
            }

            const digestThreadId = await isForum(ctx, token, chatId)
              ? GENERAL_TOPIC_THREAD_ID
              : undefined;

            await sendMessage(ctx, token, chatId, lines.join("\n"), {
              parseMode: "MarkdownV2",
              messageThreadId: digestThreadId,
            });
          } catch (err) {
            ctx.logger.error("Daily digest failed for company", { companyId: company.id, error: String(err) });
            const text = [
              escapeMarkdownV2("\ud83d\udcca") + " *Daily Digest*",
              "",
              escapeMarkdownV2("Could not generate digest. Check plugin logs for details."),
            ].join("\n");

            const errorThreadId = await isForum(ctx, token, chatId)
              ? GENERAL_TOPIC_THREAD_ID
              : undefined;

            await sendMessage(ctx, token, chatId, text, {
              parseMode: "MarkdownV2",
              messageThreadId: errorThreadId,
            });
          }
        }
    });

    // --- Phase 1: Escalation support ---
    const escalationManager = new EscalationManager();

    // Register escalate_to_human tool - 3-arg signature with ToolRunContext
    ctx.tools.register("escalate_to_human", {
      displayName: "Escalate to Human",
      description: "Escalate a conversation to a human when you cannot handle it confidently",
      parametersSchema: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            enum: ["low_confidence", "explicit_request", "policy_violation", "unknown_intent"],
            description: "Why this conversation needs human attention",
          },
          conversationSummary: {
            type: "string",
            description: "Brief summary of the conversation context and what the user needs",
          },
          suggestedActions: {
            type: "array",
            items: { type: "string" },
            description: "Suggested actions the human responder could take",
          },
          suggestedReply: {
            type: "string",
            description: "A draft reply the human can send or modify",
          },
          confidenceScore: {
            type: "number",
            minimum: 0,
            maximum: 1,
            description: "How confident the agent is (0-1). Lower values indicate greater need for human help",
          },
          originChatId: { type: "string" },
          originThreadId: { type: "string" },
          originMessageId: { type: "string" },
          sessionId: { type: "string", description: "Session ID for routing reply back" },
          transport: { type: "string", enum: ["native", "acp"], description: "Transport type for reply routing" },
        },
        required: ["reason", "conversationSummary"],
      },
    }, async (params: unknown, runCtx) => {
      const p = params as Record<string, unknown>;
      const escalationId = crypto.randomUUID();
      const timeoutMs = config.escalationTimeoutMs || 900000;
      const defaultAction = config.escalationDefaultAction || "defer";

      const resolvedEscalationChatId = await resolveChat(
        ctx,
        runCtx.companyId,
        config.escalationChatId,
      );
      if (!resolvedEscalationChatId) {
        ctx.logger.warn("Escalation received but no escalationChatId configured");
        return { error: "No escalation channel configured" };
      }

      const escalationEvent: EscalationEvent = {
        escalationId,
        agentId: runCtx.agentId,
        companyId: runCtx.companyId,
        reason: p.reason as EscalationEvent["reason"],
        context: {
          conversationHistory: [],
          agentReasoning: String(p.conversationSummary ?? ""),
          suggestedActions: (p.suggestedActions as string[]) ?? [],
          suggestedReply: p.suggestedReply ? String(p.suggestedReply) : undefined,
          confidenceScore: typeof p.confidenceScore === "number" ? p.confidenceScore : undefined,
        },
        timeout: {
          durationMs: timeoutMs,
          defaultAction,
        },
        originChatId: p.originChatId ? String(p.originChatId) : undefined,
        originThreadId: p.originThreadId ? String(p.originThreadId) : undefined,
        originMessageId: p.originMessageId ? String(p.originMessageId) : undefined,
        transport: p.transport as "native" | "acp" | undefined,
        sessionId: p.sessionId ? String(p.sessionId) : undefined,
      };

      await escalationManager.create(ctx, token, escalationEvent, resolvedEscalationChatId);

      // Send hold message to the originating chat if configured
      if (config.escalationHoldMessage && escalationEvent.originChatId) {
        const holdText = escapeMarkdownV2(config.escalationHoldMessage);
        await sendMessage(ctx, token, escalationEvent.originChatId, holdText, {
          parseMode: "MarkdownV2",
          messageThreadId: escalationEvent.originThreadId ? Number(escalationEvent.originThreadId) : undefined,
          replyToMessageId: escalationEvent.originMessageId ? Number(escalationEvent.originMessageId) : undefined,
        });
      }

      return { content: JSON.stringify({ status: "escalated", escalationId }) };
    });

    // --- Phase 2: Register handoff_to_agent tool ---
    ctx.tools.register("handoff_to_agent", {
      displayName: "Handoff to Agent",
      description: "Hand off work to another agent in this thread",
      parametersSchema: {
        type: "object",
        properties: {
          targetAgent: { type: "string", description: "Name of agent to hand off to" },
          reason: { type: "string", description: "Why you're handing off" },
          contextSummary: { type: "string", description: "Summary for the target agent" },
          requiresApproval: { type: "boolean", default: true, description: "Wait for human approval before target starts" },
          chatId: { type: "string", description: "Telegram chat ID" },
          threadId: { type: "number", description: "Telegram thread ID" },
        },
        required: ["targetAgent", "reason", "contextSummary"],
      },
    }, async (params: unknown, runCtx) => {
      return handleHandoffToolCall(ctx, token, params as Record<string, unknown>, runCtx.companyId, runCtx.agentId);
    });

    // --- Phase 2: Register discuss_with_agent tool ---
    ctx.tools.register("discuss_with_agent", {
      displayName: "Discuss with Agent",
      description: "Start a back-and-forth conversation with another agent",
      parametersSchema: {
        type: "object",
        properties: {
          targetAgent: { type: "string", description: "Name of agent to discuss with" },
          topic: { type: "string", description: "Discussion topic" },
          initialMessage: { type: "string", description: "First message to send" },
          maxTurns: { type: "number", default: 10, description: "Maximum conversation turns" },
          humanCheckpointAt: { type: "number", description: "Pause for human approval at this turn" },
          chatId: { type: "string", description: "Telegram chat ID" },
          threadId: { type: "number", description: "Telegram thread ID" },
        },
        required: ["targetAgent", "topic", "initialMessage"],
      },
    }, async (params: unknown, runCtx) => {
      return handleDiscussToolCall(ctx, token, params as Record<string, unknown>, runCtx.companyId, runCtx.agentId);
    });

    // --- Phase 5: Register register_watch tool ---
    ctx.tools.register("register_watch", {
      displayName: "Register Watch",
      description: "Register a proactive watch that monitors entities and sends suggestions",
      parametersSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name of the watch" },
          description: { type: "string", description: "What this watch monitors" },
          entityType: { type: "string", enum: ["issue", "agent", "company", "custom"], description: "Type of entity to watch" },
          conditions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                field: { type: "string" },
                operator: { type: "string", enum: ["gt", "lt", "eq", "ne", "contains", "exists"] },
                value: {},
              },
              required: ["field", "operator", "value"],
            },
            description: "Conditions that trigger the watch",
          },
          template: { type: "string", description: "Message template with {{field}} placeholders" },
          builtinTemplate: { type: "string", enum: ["invoice-overdue", "lead-stale"], description: "Use a built-in template instead" },
          chatId: { type: "string", description: "Telegram chat ID for suggestions" },
          threadId: { type: "number", description: "Telegram thread ID for suggestions" },
        },
        required: ["chatId"],
      },
    }, async (params: unknown, runCtx) => {
      return handleRegisterWatch(ctx, params as Record<string, unknown>, runCtx.companyId);
    });

    // --- Phase 1: Escalation timeout checker job ---
    ctx.jobs.register("check-escalation-timeouts", async () => {
      try {
        await escalationManager.checkTimeouts(ctx, token);
      } catch (err) {
        ctx.logger.error("Escalation timeout check failed", { error: String(err) });
      }
    });

    // --- Phase 5: Watch checker job ---
    ctx.jobs.register("check-watches", async () => {
      try {
        await checkWatches(ctx, token, {
          maxSuggestionsPerHourPerCompany: config.maxSuggestionsPerHourPerCompany ?? 10,
          watchDeduplicationWindowMs: config.watchDeduplicationWindowMs ?? 86400000,
        });
      } catch (err) {
        ctx.logger.error("Watch check failed", { error: String(err) });
      }
    });

    ctx.logger.info("Telegram bot plugin started (Chat OS v2 - all 5 phases)");
  },

  async onValidateConfig(config) {
    const hasInline = typeof config.telegramBotToken === "string" && config.telegramBotToken.length > 0;
    const hasRef = typeof config.telegramBotTokenRef === "string" && config.telegramBotTokenRef.length > 0;
    if (!hasInline && !hasRef) {
      return { ok: false, errors: ["Either telegramBotToken (inline) or telegramBotTokenRef (secret) is required"] };
    }
    return { ok: true };
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    return { status: "ok" };
  },
});

export async function handleUpdate(
  ctx: PluginContext,
  token: string,
  config: TelegramConfig,
  update: TelegramUpdate,
  baseUrl: string,
  publicUrl?: string,
  boardApiToken: string = "",
): Promise<void> {
  if (update.callback_query) {
    await handleCallbackQuery(ctx, token, update.callback_query, baseUrl, boardApiToken);
    return;
  }

  const msg = update.message;
  if (!msg) return;

  const chatId = String(msg.chat.id);
  const threadId = msg.message_thread_id;

  // Phase 3: Handle media messages
  const hasMedia = !!(msg.voice || msg.audio || msg.video_note || msg.document || msg.photo);
  if (hasMedia) {
    const companyId = resolveCompanyId(config, chatId);
    const handled = await handleMediaMessage(ctx, token, msg as Parameters<typeof handleMediaMessage>[2], {
      briefAgentId: config.briefAgentId ?? "",
      briefAgentChatIds: config.briefAgentChatIds ?? [],
      transcriptionApiKeyRef: config.transcriptionApiKeyRef ?? "",
      publicUrl,
    }, companyId);
    if (handled) return;
  }

  if (!msg.text) return;

  const text = msg.text;

  // Route thread messages to agent sessions
  if (threadId) {
    const isCommand = text.startsWith("/");
    if (!isCommand) {
      const companyId = resolveCompanyId(config, chatId);
      const replyToId = msg.reply_to_message?.message_id;
      const routed = await routeMessageToAgent(ctx, token, chatId, threadId, text, replyToId, companyId);
      if (routed) return;
    }
  }

  const botCommand = msg.entities?.find((e) => e.type === "bot_command" && e.offset === 0);
  if (botCommand && config.enableCommands) {
    const fullCommand = text.slice(botCommand.offset, botCommand.offset + botCommand.length);
    const command = fullCommand.replace(/^\//, "").replace(/@.*$/, "");
    const args = text.slice(botCommand.offset + botCommand.length).trim();
    const companyId = resolveCompanyId(config, chatId);

    // Phase 4: Check custom commands first
    if (command === "commands") {
      await handleCommandsCommand(ctx, token, chatId, args, threadId, companyId);
      return;
    }

    const handledCustom = await tryCustomCommand(ctx, token, chatId, command, args, threadId, companyId);
    if (handledCustom) return;

    // Built-in commands. Pass config so the handlers reach the board REST API
    // (the gated SDK host RPCs throw "unknown invocation scope" in the poll loop).
    await handleCommand(ctx, token, chatId, command, args, threadId, baseUrl, publicUrl, config);
    return;
  }

  const isReply = !!msg.reply_to_message;

  // --- Pending decision (TWX-455): a top-level free-text message while a
  // decision is pending for this chat is a response to that decision, not a
  // fresh inbox item. Route it to the decision's own issue. Native swipe-replies
  // are handled further down via the msg_<chat>_<reply> mapping. ---
  if (!threadId && !isReply && !text.startsWith("/")) {
    const pending = await getPendingDecision(ctx, chatId);
    if (pending) {
      const result = await routeInteractionResponse(ctx, baseUrl, boardApiToken, pending, text);
      if (result === "routed") {
        await clearPendingDecision(ctx, chatId);
        const label = pending.issueIdentifier ?? pending.issueId ?? "the decision";
        await sendMessage(ctx, token, chatId, `Forwarded to decision — ${label}`, {});
        return;
      }
      if (result === "already-resolved") {
        // The decision was decided elsewhere; drop the stale state and let the
        // message fall through to inbox as a fresh item.
        await clearPendingDecision(ctx, chatId);
      } else if (result === "needs-input") {
        // Only reachable for a stale/legacy ask_user_questions record (those are
        // no longer recorded as pending). Don't trap the inbox — clear the
        // record and let the message fall through as a fresh inbox item.
        await clearPendingDecision(ctx, chatId);
      } else if (result === "missing-token" || result === "error") {
        // Don't silently spawn an inbox issue on a transient failure — tell the
        // user their reply didn't land and to use the buttons.
        await sendMessage(
          ctx,
          token,
          chatId,
          "Could not deliver your reply to the pending decision. Please use the buttons on the decision message.",
          {},
        );
        return;
      }
      // "skipped" falls through to inbox handling below.
    }
  }

  // --- Inbox wake: plain text from the board → new issue for the configured agent ---
  // Fires only for top-level (non-thread, non-reply, non-command) text messages
  // in an allow-listed chat. Creates an issue assigned to inboxAgentId so the
  // agent wakes via the standard assignment path.
  const isInboxEligible =
    !!config.inboxAgentId &&
    !threadId &&
    !isReply &&
    isInboxChatAllowed(chatId, config.defaultChatId ?? "", config.inboxChatIds ?? []);
  if (isInboxEligible) {
    await handleInboxWake(ctx, token, config, msg, chatId, text);
    return;
  }

  if (config.enableInbound && msg.reply_to_message?.from?.is_bot) {
    const replyToId = msg.reply_to_message.message_id;
    const inboundKey = `inbound_${chatId}_${msg.message_id}`;
    // Dedup state reads are best-effort under host-gated runtimes. If this
    // throws, treat it as "not processed yet" so inbound routing still runs.
    let alreadyProcessed: unknown = null;
    try {
      alreadyProcessed = await ctx.state.get({
        scopeKind: "instance",
        stateKey: inboundKey,
      });
    } catch {
      alreadyProcessed = null;
    }
    if (alreadyProcessed) return;

    const markInboundRouted = async () => {
      try {
        await ctx.state.set(
          { scopeKind: "instance", stateKey: inboundKey },
          { routedAt: new Date().toISOString() },
        );
      } catch {
        // best effort
      }
    };

    // The msg→entity map is written by notify() via ctx.state.set, which is
    // gated in event handlers under the invocation-scope bug — so this lookup
    // may throw or be empty. Degrade to "no mapping" instead of crashing the
    // poll loop.
    let mapping: StoredMessageMapping | null = null;
    try {
      mapping = await ctx.state.get({
        scopeKind: "instance",
        stateKey: `msg_${chatId}_${replyToId}`,
      }) as StoredMessageMapping | null;
    } catch {
      mapping = null;
    }

    if (mapping && mapping.entityType === "escalation") {
      const escalationManager = new EscalationManager();
      const responderId = `telegram:${msg.from?.username ?? msg.from?.id ?? chatId}`;
      await escalationManager.respond(ctx, token, mapping.entityId, {
        escalationId: mapping.entityId,
        responderId,
        responseText: text,
        action: "reply_to_customer",
      });
      await ctx.metrics.write(METRIC_NAMES.inboundRouted, 1);
      ctx.logger.info("Routed Telegram reply to escalation", {
        escalationId: mapping.entityId,
        from: msg.from?.username,
      });
      await markInboundRouted();
    } else if (mapping && mapping.entityType === "issue") {
      try {
        await ctx.issues.createComment(
          mapping.entityId,
          buildInboundAuditComment(msg, text),
          mapping.companyId,
        );
        await ctx.metrics.write(METRIC_NAMES.inboundRouted, 1);
        ctx.logger.info("Routed Telegram reply to issue comment", {
          issueId: mapping.entityId,
          from: msg.from?.username,
        });
        await markInboundRouted();
      } catch (err) {
        ctx.logger.error("Failed to route inbound message", {
          issueId: mapping.entityId,
          error: String(err),
        });
      }
    } else if (mapping && mapping.entityType === "approval" && mapping.issueId) {
      try {
        await ctx.issues.createComment(
          mapping.issueId,
          buildInboundAuditComment(msg, text),
          mapping.companyId,
        );
        await ctx.metrics.write(METRIC_NAMES.inboundRouted, 1);
        ctx.logger.info("Routed Telegram reply to approval-linked issue comment", {
          approvalId: mapping.approvalId ?? mapping.entityId,
          issueId: mapping.issueId,
          from: msg.from?.username,
        });
        await markInboundRouted();
      } catch (err) {
        ctx.logger.error("Failed to route approval reply to issue comment", {
          approvalId: mapping.approvalId ?? mapping.entityId,
          issueId: mapping.issueId,
          error: String(err),
        });
      }
    } else if (mapping && mapping.entityType === "interaction" && mapping.issueId && mapping.interactionId) {
      const result = await routeInteractionResponse(ctx, baseUrl, boardApiToken, mapping, text);
      switch (result) {
        case "routed":
          await clearPendingDecision(ctx, chatId);
          await markInboundRouted();
          break;
        case "already-resolved":
          await clearPendingDecision(ctx, chatId);
          await sendMessage(
            ctx,
            token,
            chatId,
            escapeMarkdownV2("This decision was already resolved."),
            { parseMode: "MarkdownV2", replyToMessageId: msg.message_id },
          );
          break;
        case "missing-token":
          await sendMessage(
            ctx,
            token,
            chatId,
            escapeMarkdownV2("Cannot route interaction reply: board token is missing."),
            { parseMode: "MarkdownV2", replyToMessageId: msg.message_id },
          );
          break;
        case "needs-input":
          await sendMessage(
            ctx,
            token,
            chatId,
            escapeMarkdownV2(ASK_QUESTIONS_PARSE_HINT),
            { parseMode: "MarkdownV2", replyToMessageId: msg.message_id },
          );
          break;
        default:
          // "error" already logged inside routeInteractionResponse; "skipped"
          // means nothing to do.
          break;
      }
    }
  }
}

/**
 * Inbox wake: a plain top-level message from an allow-listed chat becomes a new
 * issue assigned to config.inboxAgentId, so the agent wakes via the standard
 * assignment path. Uses the board REST API (host-api) because ctx.issues is
 * gated in the poll loop ("unknown invocation scope"). Exported for testing.
 *
 * The create-then-assign ordering is load-bearing: the issue_assigned wake only
 * fires when the assignee transitions from null to an agent, so we create
 * without an assignee and set it on the follow-up PATCH.
 */
export async function handleInboxWake(
  ctx: PluginContext,
  token: string,
  config: TelegramConfig,
  msg: NonNullable<TelegramUpdate["message"]>,
  chatId: string,
  text: string,
): Promise<void> {
  const companyId = resolveCompanyId(config, chatId);
  const sender = msg.from?.username
    ? `@${msg.from.username}`
    : msg.from?.first_name ?? "Telegram user";
  const shortBody = text.length > 140 ? text.slice(0, 137).trimEnd() + "…" : text;
  const issueTitle = `[Inbox] ${shortBody.replace(/\s+/g, " ")}`;
  const issueDescription = [
    `From ${sender} via Telegram (chat ${chatId}, message ${msg.message_id}).`,
    "",
    text,
  ].join("\n");
  try {
    const created = await createIssue(ctx, config as HostApiConfig, companyId, {
      title: issueTitle.length > 200 ? issueTitle.slice(0, 197) + "…" : issueTitle,
      description: issueDescription,
    });
    const issue = await updateIssue(ctx, config as HostApiConfig, created.id, {
      status: "todo",
      assigneeAgentId: config.inboxAgentId,
    });
    await ctx.metrics.write(METRIC_NAMES.inboundRouted, 1);
    ctx.logger.info("Routed inbox message to agent via new issue", {
      chatId,
      agentId: config.inboxAgentId,
      issueId: issue.id,
    });
    // Brief ack so the sender sees their message landed. Plain text to avoid
    // MarkdownV2 escape pitfalls on arbitrary identifiers.
    const ackLabel = issue.identifier ? String(issue.identifier) : issue.id;
    await sendMessage(ctx, token, chatId, `Forwarded to agent — ${ackLabel}`, {});
  } catch (err) {
    ctx.logger.error("Failed to create inbox issue from Telegram", {
      chatId,
      agentId: config.inboxAgentId,
      error: String(err),
    });
    await sendMessage(ctx, token, chatId, `Could not forward message: ${String(err)}`, {});
  }
}

export async function handleCallbackQuery(
  ctx: PluginContext,
  token: string,
  query: NonNullable<TelegramUpdate["callback_query"]>,
  baseUrl: string,
  boardApiToken: string = "",
): Promise<void> {
  const data = query.data;
  if (!data) return;

  const actor = query.from.username ?? query.from.first_name ?? String(query.from.id);
  const chatId = query.message?.chat.id ? String(query.message.chat.id) : null;
  const messageId = query.message?.message_id;

  if (data.startsWith("approve_")) {
    const approvalId = data.replace("approve_", "");
    ctx.logger.info("Approval button clicked", { approvalId, actor });

    try {
      await submitApprovalDecision(ctx.http, {
        baseUrl,
        approvalId,
        action: "approve",
        actor,
        boardApiToken,
      });

      await answerCallbackQuery(ctx, token, query.id, "Approved");

      if (chatId && messageId) {
        await editMessage(
          ctx,
          token,
          chatId,
          messageId,
          `${escapeMarkdownV2("\u2705")} *Approved* by ${escapeMarkdownV2(actor)}`,
          { parseMode: "MarkdownV2" },
        );
      }
    } catch (err) {
      await answerCallbackQuery(ctx, token, query.id, `Failed: ${String(err)}`);
    }
    return;
  }

  if (data === "interaction_accept" || data === "interaction_reject") {
    const action = data === "interaction_accept" ? "accept" : "reject";
    if (!boardApiToken) {
      await answerCallbackQuery(ctx, token, query.id, "Board token missing");
      return;
    }
    if (!chatId || !messageId) {
      await answerCallbackQuery(ctx, token, query.id, "Missing message context");
      return;
    }

    const mapping = await ctx.state.get({
      scopeKind: "instance",
      stateKey: `msg_${chatId}_${messageId}`,
    }) as StoredMessageMapping | null;
    if (!mapping?.issueId || !mapping.interactionId) {
      await answerCallbackQuery(ctx, token, query.id, "Interaction mapping missing");
      return;
    }

    try {
      await respondInteraction(ctx.http, {
        baseUrl,
        issueId: mapping.issueId,
        interactionId: mapping.interactionId,
        action,
        boardApiToken,
      });
      await clearPendingDecision(ctx, chatId);
      await answerCallbackQuery(ctx, token, query.id, action === "accept" ? "Accepted" : "Rejected");
      await editMessage(
        ctx,
        token,
        chatId,
        messageId,
        `${escapeMarkdownV2(action === "accept" ? "✅ Accepted" : "❌ Rejected")} by ${escapeMarkdownV2(actor)}`,
        { parseMode: "MarkdownV2" },
      );
    } catch (err) {
      if (isAlreadyResolvedInteractionError(err)) {
        await clearPendingDecision(ctx, chatId);
        await answerCallbackQuery(ctx, token, query.id, "Already resolved");
        ctx.logger.info("Ignored stale Telegram interaction callback", {
          issueId: mapping.issueId,
          interactionId: mapping.interactionId,
          action,
          actor,
        });
        await editMessage(
          ctx,
          token,
          chatId,
          messageId,
          escapeMarkdownV2("This interaction was already resolved."),
          { parseMode: "MarkdownV2" },
        );
        return;
      }
      await answerCallbackQuery(ctx, token, query.id, `Failed: ${String(err)}`);
    }
    return;
  }

  if (data.startsWith("esc_")) {
    const parts = data.split("_");
    const action = parts[1] ?? "";
    const escalationId = parts.slice(2).join("_");
    const escalationManager = new EscalationManager();
    await escalationManager.handleCallback(
      ctx,
      token,
      action,
      escalationId,
      actor,
      query.id,
      chatId,
      messageId,
    );
    await answerCallbackQuery(ctx, token, query.id, `Escalation: ${action}`);
    return;
  }

  if (data.startsWith("reject_")) {
    const approvalId = data.replace("reject_", "");
    ctx.logger.info("Rejection button clicked", { approvalId, actor });

    try {
      await submitApprovalDecision(ctx.http, {
        baseUrl,
        approvalId,
        action: "reject",
        actor,
        boardApiToken,
      });

      await answerCallbackQuery(ctx, token, query.id, "Rejected");

      if (chatId && messageId) {
        await editMessage(
          ctx,
          token,
          chatId,
          messageId,
          `${escapeMarkdownV2("\u274c")} *Rejected* by ${escapeMarkdownV2(actor)}`,
          { parseMode: "MarkdownV2" },
        );
      }
    } catch (err) {
      await answerCallbackQuery(ctx, token, query.id, `Failed: ${String(err)}`);
    }
    return;
  }

  if (data.startsWith("handoff_approve_")) {
    const handoffId = data.replace("handoff_approve_", "");
    await handleHandoffApproval(ctx, token, handoffId, actor, query.id, chatId, messageId);
    await answerCallbackQuery(ctx, token, query.id, "Handoff approved");
    return;
  }

  if (data.startsWith("handoff_reject_")) {
    const handoffId = data.replace("handoff_reject_", "");
    await handleHandoffRejection(ctx, token, handoffId, actor, query.id, chatId, messageId);
    await answerCallbackQuery(ctx, token, query.id, "Handoff rejected");
    return;
  }

  await answerCallbackQuery(ctx, token, query.id, "Unknown action");
}

export default plugin;

runWorker(plugin, import.meta.url);
