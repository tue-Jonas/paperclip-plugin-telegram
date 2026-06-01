const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type InteractionCallbackAction = "accept" | "reject";

export type ParsedInteractionCallbackData = {
  action: InteractionCallbackAction;
  issueId: string;
  interactionId: string;
};

function isUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

function encodeUuid(uuid: string): string {
  const hex = uuid.replace(/-/g, "");
  return Buffer.from(hex, "hex").toString("base64url");
}

function decodeUuid(encoded: string): string | null {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(encoded, "base64url");
  } catch {
    return null;
  }
  if (bytes.length !== 16) return null;
  const hex = bytes.toString("hex");
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  return isUuid(uuid) ? uuid : null;
}

export function buildInteractionCallbackData(
  action: InteractionCallbackAction,
  issueId: string,
  interactionId: string,
): string | null {
  if (!isUuid(issueId) || !isUuid(interactionId)) return null;
  const actionToken = action === "accept" ? "a" : "r";
  return `ia:${actionToken}:${encodeUuid(issueId)}:${encodeUuid(interactionId)}`;
}

export function parseInteractionCallbackData(data: string): ParsedInteractionCallbackData | null {
  if (!data.startsWith("ia:")) return null;
  const parts = data.split(":");
  if (parts.length !== 4) return null;
  const actionToken = parts[1];
  const action: InteractionCallbackAction | null =
    actionToken === "a" ? "accept" : actionToken === "r" ? "reject" : null;
  if (!action) return null;
  const issueId = decodeUuid(parts[2] ?? "");
  const interactionId = decodeUuid(parts[3] ?? "");
  if (!issueId || !interactionId) return null;
  return { action, issueId, interactionId };
}
