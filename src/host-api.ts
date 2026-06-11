import type { PluginContext } from "@paperclipai/plugin-sdk";

/**
 * Board-API REST client for the INBOUND command / poll-loop / inbox-wake paths.
 *
 * Why this exists: the Paperclip host build running on this instance does NOT
 * propagate an invocation scope into (a) the bot long-poll command loop or
 * (b) plugin event handlers. Every *gated* host RPC (ctx.companies / ctx.agents
 * / ctx.issues / ctx.state / ctx.activity) therefore throws
 * "... not allowed to perform <x>: the worker referenced a missing, expired, or
 * unknown invocation scope". ctx.http.fetch and ctx.secrets.resolve are NOT
 * gated — which is why the Approve/Reject buttons, getUpdates and outbound
 * notifications already work. This module reaches the same data the gated SDK
 * would, over the authenticated board REST API via ctx.http.fetch.
 *
 * SSRF note (load-bearing): the host's outbound-fetch filter is hostname-based.
 * It allows the "localhost" form (the buttons hit http://localhost:3100 and
 * work) while blocking the literal "127.0.0.1". ALWAYS go through
 * config.paperclipBaseUrl (the localhost form) — never hardcode 127.0.0.1.
 */

export type HostApiConfig = {
  paperclipBaseUrl?: string;
  /** Inline board token (pcp_board_…). Preferred on hosts where plugin secret refs are disabled. */
  boardApiToken?: string;
  /** Secret-ref fallback for the board token (resolved via the un-gated ctx.secrets.resolve). */
  boardApiTokenRef?: string;
  /** Company used for chats with no /connect mapping (host state is unavailable under the scope bug). */
  defaultCompanyId?: string;
};

export type HostCompany = { id: string; name?: string; issuePrefix?: string };
export type HostAgent = {
  id: string;
  name: string;
  role?: string;
  status: string;
};
export type HostIssue = {
  id: string;
  identifier?: string;
  title: string;
  status: string;
  priority?: string;
  projectId?: string | null;
  completedAt?: string | null;
  createdAt?: string;
};

// --- Chat → company routing (in-process) ---------------------------------
// ctx.state is gated, so the persisted chat→company mapping is unreadable from
// the poll loop. The worker is a single long-lived process, so an in-memory map
// keeps /connect links alive for the worker's lifetime; on restart we fall back
// to defaultCompanyId (routing still works — see resolveChat() in worker.ts).
const chatCompanyMap = new Map<string, { companyId: string; companyName?: string }>();

export function setChatCompany(chatId: string, companyId: string, companyName?: string): void {
  chatCompanyMap.set(chatId, { companyId, companyName });
}

/** Test seam: clear in-process chat→company links + the cached board token. */
export function __resetHostApiState(): void {
  chatCompanyMap.clear();
  cachedBoardToken = null;
}

export function getChatCompanyName(chatId: string): string | undefined {
  return chatCompanyMap.get(chatId)?.companyName;
}

/** Resolve the company for a chat: explicit /connect link → defaultCompanyId → chatId. */
export function resolveCompanyId(chatId: string, config: HostApiConfig): string {
  const mapped = chatCompanyMap.get(chatId)?.companyId;
  if (mapped) return mapped;
  if (config.defaultCompanyId) return config.defaultCompanyId;
  return chatId;
}

// --- Board token + fetch --------------------------------------------------
let cachedBoardToken: string | null = null;

export async function resolveBoardToken(
  ctx: PluginContext,
  config: HostApiConfig,
): Promise<string> {
  if (cachedBoardToken !== null) return cachedBoardToken;
  if (config.boardApiToken) {
    cachedBoardToken = config.boardApiToken;
  } else if (config.boardApiTokenRef) {
    try {
      cachedBoardToken = await ctx.secrets.resolve(config.boardApiTokenRef);
    } catch {
      cachedBoardToken = "";
    }
  } else {
    cachedBoardToken = "";
  }
  return cachedBoardToken;
}

function apiBase(config: HostApiConfig): string {
  return (config.paperclipBaseUrl || "http://localhost:3100").replace(/\/+$/, "");
}

async function hostFetch(
  ctx: PluginContext,
  config: HostApiConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const token = await resolveBoardToken(ctx, config);
  if (!token) {
    throw new Error(
      "No board API token configured (boardApiToken / boardApiTokenRef); inbound host calls require one on this server build",
    );
  }
  const res = await ctx.http.fetch(`${apiBase(config)}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      /* ignore */
    }
    throw new Error(`board API ${method} ${path} -> ${res.status} ${detail}`.trim());
  }
  if (res.status === 204) return null;
  return res.json();
}

// --- Typed wrappers (mirror the gated SDK surface we replaced) ------------

export async function listCompanies(ctx: PluginContext, config: HostApiConfig): Promise<HostCompany[]> {
  const data = await hostFetch(ctx, config, "GET", "/api/companies");
  return Array.isArray(data) ? (data as HostCompany[]) : [];
}

export async function getCompany(
  ctx: PluginContext,
  config: HostApiConfig,
  companyId: string,
): Promise<HostCompany | null> {
  const all = await listCompanies(ctx, config);
  return all.find((c) => c.id === companyId) ?? null;
}

export async function listAgents(
  ctx: PluginContext,
  config: HostApiConfig,
  companyId: string,
): Promise<HostAgent[]> {
  const data = await hostFetch(ctx, config, "GET", `/api/companies/${companyId}/agents`);
  return Array.isArray(data) ? (data as HostAgent[]) : [];
}

export async function listIssues(
  ctx: PluginContext,
  config: HostApiConfig,
  companyId: string,
  opts?: { limit?: number; status?: string },
): Promise<HostIssue[]> {
  const params = new URLSearchParams({ limit: String(opts?.limit ?? 10) });
  if (opts?.status) params.set("status", opts.status);
  const data = await hostFetch(
    ctx,
    config,
    "GET",
    `/api/companies/${companyId}/issues?${params.toString()}`,
  );
  return Array.isArray(data) ? (data as HostIssue[]) : [];
}

export async function createIssue(
  ctx: PluginContext,
  config: HostApiConfig,
  companyId: string,
  input: { title: string; description?: string; status?: string; assigneeAgentId?: string },
): Promise<HostIssue> {
  return (await hostFetch(
    ctx,
    config,
    "POST",
    `/api/companies/${companyId}/issues`,
    input,
  )) as HostIssue;
}

export async function updateIssue(
  ctx: PluginContext,
  config: HostApiConfig,
  issueId: string,
  patch: { status?: string; assigneeAgentId?: string },
): Promise<HostIssue> {
  return (await hostFetch(ctx, config, "PATCH", `/api/issues/${issueId}`, patch)) as HostIssue;
}
