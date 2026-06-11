-- The schema name is the host-derived plugin namespace for
-- paperclip-plugin-telegram-twb. worker.ts fails fast if ctx.db.namespace ever
-- diverges from this migration namespace.
CREATE TABLE IF NOT EXISTS plugin_telegram_63f79ea5a3.interaction_deliveries (
  delivery_key text PRIMARY KEY,
  company_id text NOT NULL,
  issue_id text NOT NULL,
  interaction_id text NOT NULL,
  interaction_kind text NOT NULL,
  telegram_message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
