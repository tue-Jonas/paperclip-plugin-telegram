#!/usr/bin/env node
// TWX-80 — Live inbound E2E harness for the Telegram decision interface.
//
// Drives the REAL exported `handleUpdate` dispatch with synthetic Telegram
// updates against a LIVE board, with NO authenticated Telegram user session.
// Telegram transport calls (answerCallbackQuery/editMessage) are short-circuited;
// board writes (approval decision / interaction accept-reject / issue comment)
// hit the live REST API and produce real, inspectable evidence + log snippets.
//
// This is the deterministic, no-human, no-spend equivalent of "a board user
// tapping a button / replying" called for in TWX-50 / TWX-80.
//
// Build first:  npm run build
// Usage:
//   BOARD_BASE_URL=http://tj-lt:3100 BOARD_API_TOKEN=pcp_board_... \
//   node scripts/e2e-telegram-inbound.mjs <scenario> [k=v ...]
//
// Scenarios (ids identify the entities created on the board beforehand):
//   approve        APPROVAL_ID=...                              -> POST /api/approvals/:id/approve
//   reject         APPROVAL_ID=...                              -> POST /api/approvals/:id/reject
//   accept         ISSUE_ID=... INTERACTION_ID=...              -> POST /api/issues/:id/interactions/:iid/accept
//   reject-int     ISSUE_ID=... INTERACTION_ID=...              -> POST /api/issues/:id/interactions/:iid/reject
//   reply          ISSUE_ID=... TEXT="..."                      -> ctx.issues.createComment (audit comment)
//   reply-dup      ISSUE_ID=... TEXT="..."                      -> two identical replies; second must be suppressed
//
// Run against a DEDICATED TEST board/company — it performs real board writes.

import { handleUpdate } from "../dist/worker.js";

const TELEGRAM_API = "https://api.telegram.org";
const argv = process.argv.slice(2);
const scenario = argv[0];
const kv = Object.fromEntries(
  argv.slice(1).map((a) => {
    const i = a.indexOf("=");
    return i === -1 ? [a, "true"] : [a.slice(0, i), a.slice(i + 1)];
  }),
);

const BASE = process.env.BOARD_BASE_URL;
const BOARD_TOKEN = process.env.BOARD_API_TOKEN;
const CHAT = process.env.CHAT_ID ?? "1001";
const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "harness-token";

if (!scenario || !BASE || !BOARD_TOKEN) {
  console.error("Missing required input. Set BOARD_BASE_URL + BOARD_API_TOKEN and pass a scenario.");
  console.error("See header of this file for usage.");
  process.exit(2);
}

const evidence = { scenario, boardCalls: [], telegramCalls: [], comments: [], logs: [] };
const stateStore = {};

function mkLog(level) {
  return (message, meta) => evidence.logs.push({ level, message, meta });
}

const ctx = {
  http: {
    fetch: async (url, init = {}) => {
      if (url.startsWith(TELEGRAM_API)) {
        // Substitute Telegram transport: record, do not call the real API.
        evidence.telegramCalls.push({ url: url.replace(/bot[^/]+/, "bot***"), method: init.method ?? "GET" });
        return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
      }
      const res = await fetch(url, init);
      let body;
      try { body = await res.clone().json(); } catch { body = await res.clone().text(); }
      evidence.boardCalls.push({ method: init.method ?? "GET", url, status: res.status, response: body });
      return res;
    },
  },
  issues: {
    createComment: async (issueId, body, companyId) => {
      const res = await fetch(`${BASE}/api/issues/${issueId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${BOARD_TOKEN}` },
        body: JSON.stringify({ body }),
      });
      let json; try { json = await res.json(); } catch { json = null; }
      evidence.comments.push({ issueId, companyId, status: res.status, commentId: json?.id ?? null });
      return json ?? { id: null };
    },
  },
  metrics: { write: async () => {} },
  state: {
    get: async (k) => stateStore[k.stateKey] ?? null,
    set: async (k, v) => { stateStore[k.stateKey] = v; },
  },
  logger: { info: mkLog("info"), warn: mkLog("warn"), error: mkLog("error"), debug: mkLog("debug") },
};

const CONFIG = {
  enableInbound: true,
  enableCommands: false,
  defaultChatId: CHAT,
  defaultCompanyId: kv.COMPANY_ID ?? "",
  boardApiToken: BOARD_TOKEN,
  paperclipBaseUrl: BASE,
};

const from = { id: 777, username: kv.ACTOR ?? "qaharness", first_name: "QA" };

function cb(data, messageId = 50) {
  return {
    update_id: messageId,
    callback_query: { id: `cbq-${messageId}`, from, message: { message_id: messageId, chat: { id: Number(CHAT) } }, data },
  };
}
function reply(messageId, replyToId, text) {
  return {
    update_id: messageId,
    message: {
      message_id: messageId, from, chat: { id: Number(CHAT), type: "private" }, text,
      reply_to_message: { message_id: replyToId, from: { is_bot: true } },
    },
  };
}

const run = (u) => handleUpdate(ctx, TOKEN, CONFIG, u, BASE, undefined, BOARD_TOKEN);

async function main() {
  switch (scenario) {
    case "approve": await run(cb(`approve_${kv.APPROVAL_ID}`)); break;
    case "reject": await run(cb(`reject_${kv.APPROVAL_ID}`)); break;
    case "accept":
      stateStore[`msg_${CHAT}_60`] = { issueId: kv.ISSUE_ID, interactionId: kv.INTERACTION_ID, entityType: "issue", companyId: CONFIG.defaultCompanyId };
      await run(cb("interaction_accept", 60));
      break;
    case "reject-int":
      stateStore[`msg_${CHAT}_61`] = { issueId: kv.ISSUE_ID, interactionId: kv.INTERACTION_ID, entityType: "issue", companyId: CONFIG.defaultCompanyId };
      await run(cb("interaction_reject", 61));
      break;
    case "reply":
      stateStore[`msg_${CHAT}_70`] = { entityType: "issue", entityId: kv.ISSUE_ID, companyId: CONFIG.defaultCompanyId };
      await run(reply(700, 70, kv.TEXT ?? "inbound reply from harness"));
      break;
    case "reply-dup": {
      stateStore[`msg_${CHAT}_71`] = { entityType: "issue", entityId: kv.ISSUE_ID, companyId: CONFIG.defaultCompanyId };
      const dup = reply(701, 71, kv.TEXT ?? "duplicate reply");
      await run(dup); await run(dup);
      break;
    }
    default:
      console.error(`Unknown scenario: ${scenario}`);
      process.exit(2);
  }
  console.log(JSON.stringify(evidence, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
