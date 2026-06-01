type HttpResponseLike = {
  ok?: boolean;
  status?: number;
  text?: () => Promise<string>;
};

type HttpClientLike = {
  fetch: (
    url: string,
    init: {
      method: string;
      headers: Record<string, string>;
      body?: string;
    },
  ) => Promise<HttpResponseLike>;
};

type ApprovalAction = "approve" | "reject";

type SubmitApprovalDecisionInput = {
  baseUrl: string;
  approvalId: string;
  action: ApprovalAction;
  actor: string;
  boardApiToken: string;
};

type FetchApprovalContextInput = {
  baseUrl: string;
  approvalId: string;
  boardApiToken: string;
};

export type ApprovalContext = {
  approval: Record<string, unknown>;
  issues: Array<Record<string, unknown>>;
};

function requireBoardToken(boardApiToken: string): void {
  if (!boardApiToken) {
    throw new Error("Board API token missing (set boardApiToken or boardApiTokenRef)");
  }
}

function boardHeaders(boardApiToken: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${boardApiToken}`,
  };
}

async function readErrorDetail(response: HttpResponseLike): Promise<string> {
  try {
    return ((await response.text?.()) ?? "").slice(0, 200);
  } catch {
    return "";
  }
}

async function readJson(response: HttpResponseLike): Promise<unknown> {
  const raw = await response.text?.();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function submitApprovalDecision(
  http: HttpClientLike,
  input: SubmitApprovalDecisionInput,
): Promise<void> {
  const { baseUrl, approvalId, action, actor, boardApiToken } = input;
  requireBoardToken(boardApiToken);

  const response = await http.fetch(
    `${baseUrl}/api/approvals/${approvalId}/${action}`,
    {
      method: "POST",
      headers: boardHeaders(boardApiToken),
      body: JSON.stringify({ decidedByUserId: `telegram:${actor}` }),
    },
  );

  if (response.ok) return;

  const detail = await readErrorDetail(response);
  const status = response.status ?? 0;
  const suffix = detail ? `: ${detail}` : "";
  throw new Error(`Approval ${action} failed (${status})${suffix}`);
}

export async function fetchApprovalContext(
  http: HttpClientLike,
  input: FetchApprovalContextInput,
): Promise<ApprovalContext> {
  const { baseUrl, approvalId, boardApiToken } = input;
  requireBoardToken(boardApiToken);

  const [approvalRes, issuesRes] = await Promise.all([
    http.fetch(`${baseUrl}/api/approvals/${approvalId}`, {
      method: "GET",
      headers: boardHeaders(boardApiToken),
    }),
    http.fetch(`${baseUrl}/api/approvals/${approvalId}/issues`, {
      method: "GET",
      headers: boardHeaders(boardApiToken),
    }),
  ]);

  if (!approvalRes.ok) {
    const detail = await readErrorDetail(approvalRes);
    const status = approvalRes.status ?? 0;
    throw new Error(`Approval fetch failed (${status})${detail ? `: ${detail}` : ""}`);
  }

  if (!issuesRes.ok) {
    const detail = await readErrorDetail(issuesRes);
    const status = issuesRes.status ?? 0;
    throw new Error(`Approval issues fetch failed (${status})${detail ? `: ${detail}` : ""}`);
  }

  const approvalRaw = await readJson(approvalRes);
  const issuesRaw = await readJson(issuesRes);
  const approval = approvalRaw && typeof approvalRaw === "object"
    ? (approvalRaw as Record<string, unknown>)
    : {};
  const issues = Array.isArray(issuesRaw)
    ? issuesRaw.filter((entry) => entry && typeof entry === "object") as Array<Record<string, unknown>>
    : [];

  return { approval, issues };
}
