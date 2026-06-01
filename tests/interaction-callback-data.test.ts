import { describe, expect, it } from "vitest";
import {
  buildInteractionCallbackData,
  parseInteractionCallbackData,
} from "../src/interaction-callback-data.js";

describe("interaction callback data helpers", () => {
  it("encodes and decodes interaction callback payloads", () => {
    const issueId = "11111111-1111-4111-8111-111111111111";
    const interactionId = "22222222-2222-4222-8222-222222222222";

    const encoded = buildInteractionCallbackData("accept", issueId, interactionId);
    expect(encoded).toMatch(/^ia:a:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
    expect(encoded!.length).toBeLessThanOrEqual(64);

    const parsed = parseInteractionCallbackData(encoded!);
    expect(parsed).toEqual({ action: "accept", issueId, interactionId });
  });

  it("rejects invalid callback payloads", () => {
    expect(buildInteractionCallbackData("reject", "not-a-uuid", "22222222-2222-4222-8222-222222222222")).toBeNull();
    expect(parseInteractionCallbackData("interaction_accept")).toBeNull();
    expect(parseInteractionCallbackData("ia:x:foo:bar")).toBeNull();
  });
});
