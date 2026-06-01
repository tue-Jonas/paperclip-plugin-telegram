import { describe, it, expect, vi } from "vitest";
import { fetchInteraction, respondInteraction } from "../src/interactions-api.js";

describe("fetchInteraction", () => {
  it("returns the matched interaction from list endpoint", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue(JSON.stringify([
        { id: "int-1", kind: "request_confirmation" },
        { id: "int-2", kind: "ask_user_questions" },
      ])),
    });

    const result = await fetchInteraction(
      { fetch },
      {
        baseUrl: "http://example.com",
        issueId: "iss-1",
        interactionId: "int-2",
        boardApiToken: "pcp_board_test",
      },
    );

    expect(result?.id).toBe("int-2");
    expect(fetch).toHaveBeenCalledWith(
      "http://example.com/api/issues/iss-1/interactions",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer pcp_board_test",
        }),
      }),
    );
  });
});

describe("respondInteraction", () => {
  it("posts accept to the interaction endpoint", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    await respondInteraction(
      { fetch },
      {
        baseUrl: "http://example.com",
        issueId: "iss-1",
        interactionId: "int-1",
        action: "accept",
        boardApiToken: "pcp_board_test",
      },
    );

    expect(fetch).toHaveBeenCalledWith(
      "http://example.com/api/issues/iss-1/interactions/int-1/accept",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });

  it("posts answers for ask_user_questions interactions", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    await respondInteraction(
      { fetch },
      {
        baseUrl: "http://example.com",
        issueId: "iss-1",
        interactionId: "int-2",
        action: "respond",
        boardApiToken: "pcp_board_test",
        answers: [{ questionId: "q1", optionIds: ["a", "b"] }],
      },
    );

    expect(fetch).toHaveBeenCalledWith(
      "http://example.com/api/issues/iss-1/interactions/int-2/respond",
      expect.objectContaining({
        body: JSON.stringify({
          answers: [{ questionId: "q1", optionIds: ["a", "b"] }],
        }),
      }),
    );
  });
});

