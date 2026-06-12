# Inbound E2E harness (TWX-80)

## Why this exists

The plugin receives inbound Telegram events **only** via `getUpdates` long-polling
(`worker.ts`, hardcoded `https://api.telegram.org`). To generate a button tap or a
reply, a **real, authenticated Telegram user account** must exist in the board chat.
Paperclip agents have no such session, so the inbound half of the TWX-46 decision
interface was unverifiable by agents — TWX-50 Phase 0.2 / 1.x / 2.x all FAILed with
"missing authenticated Telegram user session". Outbound delivery is already proven in
prod (TWX-50 Phase 0.1 PASS).

This harness substitutes **only the Telegram transport**. It builds the exact
`TelegramUpdate` payload Telegram would deliver for a board user's tap/reply and feeds
it through the **real exported `handleUpdate` dispatch**. Every board-side effect
(approval decision, interaction accept/reject, audit comment) runs unchanged. No
Telegram account, no human, no spend.

## What it covers (maps to TWX-50)

| TWX-50 scenario | Harness scenario | Board effect asserted |
|---|---|---|
| Phase 0 approve tap | `approve` | `POST /api/approvals/:id/approve` |
| Phase 0 reject tap | `reject` | `POST /api/approvals/:id/reject` |
| Phase 1 request_confirmation accept | `accept` | `POST /api/issues/:id/interactions/:iid/accept` |
| Phase 1 request_confirmation reject | `reject-int` | `POST /api/issues/:id/interactions/:iid/reject` |
| Phase 0/2 reply routes to issue comment | `reply` | `ctx.issues.createComment` audit comment |
| Phase 2 duplicate-reply suppression | `reply-dup` | second identical reply suppressed |

## CI-level proof (no board needed)

`tests/e2e-inbound.test.ts` drives all six scenarios through the real dispatch against
an in-memory fake board. Runs in `npm test`:

```bash
npm test                         # full suite
npx vitest run tests/e2e-inbound.test.ts
```

## Live-board evidence (for QA sign-off)

`scripts/e2e-telegram-inbound.mjs` points the same dispatch at a live board and prints a
JSON evidence report (board calls + statuses + created comment ids + log snippets) — the
"screenshots/log snippets" TWX-50 asks for.

> Run against a **dedicated TEST board/company**: it performs real board writes
> (accepts approvals/interactions, posts comments). Do **not** target the prod TWX board.

```bash
npm run build
# 1. create the entities on the test board first (approval / interaction / issue)
#    via the normal board API, capture their ids.
# 2. drive the inbound action:
BOARD_BASE_URL=http://tj-lt:3100 BOARD_API_TOKEN=pcp_board_<test> COMPANY_ID=<test-co> \
  node scripts/e2e-telegram-inbound.mjs accept ISSUE_ID=<iss> INTERACTION_ID=<int>
# 3. verify on the board the interaction is accepted and the assignee was woken.
```

Scenarios + args are documented in the script header.

## Source change

The only production change is **exports** at the bottom of `worker.ts`
(`handleUpdate`, `handleCallbackQuery`, `TelegramUpdate`, `StoredMessageMapping`).
`runWorker` already self-guards on being the process entry module, so importing these
from a test/harness does **not** start the long-poll worker. No runtime behavior change.

## What this does NOT cover

Pixel-accurate Telegram-client UI screenshots. Those require a real authenticated
Telegram account (one-time login + a phone number = spend) and are a separate board
decision. The functional inbound path — the part that was actually broken/untestable —
is fully covered here.
