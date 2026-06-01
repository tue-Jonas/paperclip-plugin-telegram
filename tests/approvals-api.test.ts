import { describe, it, expect, vi } from "vitest";
import { fetchApprovalContext, submitApprovalDecision } from "../src/approvals-api.js";

describe("submitApprovalDecision", () => {
  it("sends authorization header and actor payload", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    await submitApprovalDecision(
      { fetch },
      {
        baseUrl: "http://example.com",
        approvalId: "apr-1",
        action: "approve",
        actor: "jonas",
        boardApiToken: "pcp_board_test",
      },
    );

    expect(fetch).toHaveBeenCalledWith(
      "http://example.com/api/approvals/apr-1/approve",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Authorization: "Bearer pcp_board_test",
        }),
        body: JSON.stringify({ decidedByUserId: "telegram:jonas" }),
      }),
    );
  });

  it("fails fast when no board token is configured", async () => {
    const fetch = vi.fn();

    await expect(
      submitApprovalDecision(
        { fetch },
        {
          baseUrl: "http://example.com",
          approvalId: "apr-1",
          action: "reject",
          actor: "jonas",
          boardApiToken: "",
        },
      ),
    ).rejects.toThrow("Board API token missing");

    expect(fetch).not.toHaveBeenCalled();
  });

  it("throws on non-2xx responses with status/body detail", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: vi.fn().mockResolvedValue("Board access required"),
    });

    await expect(
      submitApprovalDecision(
        { fetch },
        {
          baseUrl: "http://example.com",
          approvalId: "apr-1",
          action: "approve",
          actor: "jonas",
          boardApiToken: "pcp_board_test",
        },
      ),
    ).rejects.toThrow("Approval approve failed (403): Board access required");
  });
});

describe("fetchApprovalContext", () => {
  it("loads approval details and linked issues", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue(JSON.stringify({
          id: "apr-1",
          type: "request_board_approval",
          payload: { prompt: "Ship?" },
        })),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue(JSON.stringify([
          { id: "iss-1", identifier: "TWX-46", title: "Ship all phases" },
        ])),
      });

    const result = await fetchApprovalContext(
      { fetch },
      {
        baseUrl: "http://example.com",
        approvalId: "apr-1",
        boardApiToken: "pcp_board_test",
      },
    );

    expect(result.approval.id).toBe("apr-1");
    expect(result.issues[0]?.identifier).toBe("TWX-46");
  });
});
