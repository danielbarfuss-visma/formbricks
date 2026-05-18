import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TOrganization } from "@formbricks/types/organizations";
import { TResponse } from "@formbricks/types/responses";
import { TSurvey } from "@formbricks/types/surveys/types";
import { getOrganizationByEnvironmentId } from "@/lib/organization/service";
import { getResponse } from "@/lib/response/service";
import { getSurvey } from "@/lib/survey/service";
import { applyRateLimit } from "@/modules/core/rate-limit/helpers";
import { FollowUpSendError } from "@/modules/survey/follow-ups/types/follow-up";
import { sendFollowUpEmail } from "./email";
import { sendFollowUpsForResponse } from "./follow-ups";
import { createScheduledFollowUp } from "./scheduled-follow-ups";
import { getSurveyFollowUpsPermission } from "./utils";

// Mock all dependencies
vi.mock("@/lib/organization/service", () => ({
  getOrganizationByEnvironmentId: vi.fn(),
}));

vi.mock("@/lib/response/service", () => ({
  getResponse: vi.fn(),
}));

vi.mock("@/lib/survey/service", () => ({
  getSurvey: vi.fn(),
}));

vi.mock("./email", () => ({
  sendFollowUpEmail: vi.fn(),
}));

vi.mock("./scheduled-follow-ups", () => ({
  createScheduledFollowUp: vi.fn(),
}));

vi.mock("./utils", () => ({
  getSurveyFollowUpsPermission: vi.fn(),
}));

vi.mock("@/modules/core/rate-limit/helpers", () => ({
  applyRateLimit: vi.fn(),
}));

describe("Follow-ups", () => {
  const mockResponse = {
    id: "response1",
    surveyId: "survey1",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    data: {
      email: "test@example.com",
      question1: "answer1",
    },
    endingId: "ending1",
  } as unknown as TResponse;

  // Endings trigger fixture — matches the test case for ending-ID matching.
  const mockSurvey = {
    id: "survey1",
    environmentId: "env1",
    followUps: [
      {
        id: "followup1",
        action: {
          type: "email",
          properties: {
            to: "email",
            replyTo: "noreply@example.com",
            attachResponseData: true,
          },
        },
        trigger: {
          type: "endings",
          properties: {
            endingIds: ["ending1"],
          },
        },
      },
    ],
  } as unknown as TSurvey;

  const mockOrganization = {
    id: "org1",
    billing: {
      limits: {
        monthly: { responses: 1000 },
        projects: 3,
      },
      usageCycleAnchor: new Date(),
      stripeCustomerId: "cus123",
    },
    whitelabel: {
      logoUrl: "https://example.com/logo.png",
    },
  } as unknown as TOrganization;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getResponse).mockResolvedValue(mockResponse);
    vi.mocked(getSurvey).mockResolvedValue(mockSurvey);
    vi.mocked(getOrganizationByEnvironmentId).mockResolvedValue(mockOrganization);
    vi.mocked(getSurveyFollowUpsPermission).mockResolvedValue(true);
    vi.mocked(sendFollowUpEmail).mockResolvedValue(undefined);
    vi.mocked(applyRateLimit).mockResolvedValue({ allowed: true });
    vi.mocked(createScheduledFollowUp).mockResolvedValue({
      id: "scheduled1",
      sendAt: new Date("2026-01-08T00:00:00Z"),
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("sendFollowUpsForResponse", () => {
    test("should successfully send follow-up emails", async () => {
      const result = await sendFollowUpsForResponse("response1");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0]).toEqual({
          followUpId: "followup1",
          status: "success",
        });
        expect(sendFollowUpEmail).toHaveBeenCalledWith({
          followUp: mockSurvey.followUps[0],
          to: "test@example.com",
          replyTo: "noreply@example.com",
          survey: mockSurvey,
          response: mockResponse,
          attachResponseData: true,
          logoUrl: "https://example.com/logo.png",
        });
      }
    });

    test("should return error when response is not found", async () => {
      vi.mocked(getResponse).mockResolvedValue(null);

      const result = await sendFollowUpsForResponse("nonexistentresponse");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({
          code: FollowUpSendError.RESPONSE_NOT_FOUND,
          message: "Response not found",
          meta: { responseId: "nonexistentresponse" },
        });
      }
    });

    test("should return error when survey is not found", async () => {
      vi.mocked(getSurvey).mockResolvedValue(null);

      const result = await sendFollowUpsForResponse("response1");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({
          code: FollowUpSendError.SURVEY_NOT_FOUND,
          message: "Survey not found",
          meta: { responseId: "response1", surveyId: "survey1" },
        });
      }
    });

    test("should return error when organization is not found", async () => {
      vi.mocked(getOrganizationByEnvironmentId).mockResolvedValue(null);

      const result = await sendFollowUpsForResponse("response1");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({
          code: FollowUpSendError.ORG_NOT_FOUND,
          message: "Organization not found",
          meta: { responseId: "response1", surveyId: "survey1", environmentId: "env1" },
        });
      }
    });

    test("should return error when follow-ups are not allowed", async () => {
      vi.mocked(getSurveyFollowUpsPermission).mockResolvedValue(false);

      const result = await sendFollowUpsForResponse("response1");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({
          code: FollowUpSendError.FOLLOW_UP_NOT_ALLOWED,
          message: "Survey follow-ups are not allowed for this organization",
          meta: { responseId: "response1", surveyId: "survey1", organizationId: "org1" },
        });
      }
    });

    test("should skip follow-up when ending ID doesn't match", async () => {
      const modifiedResponse = {
        ...mockResponse,
        endingId: "different-ending",
      };

      vi.mocked(getResponse).mockResolvedValue(modifiedResponse);

      const result = await sendFollowUpsForResponse("response1");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0]).toEqual({
          followUpId: "followup1",
          status: "skipped",
        });

        expect(sendFollowUpEmail).not.toHaveBeenCalled();
      }
    });

    test("should handle direct email address in follow-up", async () => {
      const modifiedSurvey = {
        ...mockSurvey,
        followUps: [
          {
            ...mockSurvey.followUps[0],
            action: {
              ...mockSurvey.followUps[0].action,
              properties: {
                ...mockSurvey.followUps[0].action.properties,
                to: "direct@example.com",
              },
            },
          },
        ],
      };

      vi.mocked(getSurvey).mockResolvedValue(modifiedSurvey);

      const result = await sendFollowUpsForResponse("response1");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0]).toEqual({
          followUpId: "followup1",
          status: "success",
        });

        expect(sendFollowUpEmail).toHaveBeenCalledWith({
          followUp: modifiedSurvey.followUps[0],
          to: "direct@example.com",
          replyTo: "noreply@example.com",
          survey: modifiedSurvey,
          response: mockResponse,
          attachResponseData: true,
          logoUrl: "https://example.com/logo.png",
        });
      }
    });

    test("should handle invalid email address in response data", async () => {
      const modifiedResponse = {
        ...mockResponse,
        data: {
          email: "invalid-email",
        },
      };

      vi.mocked(getResponse).mockResolvedValue(modifiedResponse);

      const result = await sendFollowUpsForResponse("response1");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0]).toEqual({
          followUpId: "followup1",
          status: "error",
          error: "Email address is not valid for followup: followup1",
        });
        expect(sendFollowUpEmail).not.toHaveBeenCalled();
      }
    });

    test("should handle missing email value in response data", async () => {
      const modifiedResponse = {
        ...mockResponse,
        data: {},
      };

      vi.mocked(getSurvey).mockResolvedValue({
        ...mockSurvey,
        followUps: [
          {
            id: "followup1",
            action: {
              type: "email",
              properties: {
                to: "email",
                replyTo: "noreply@example.com",
                attachResponseData: true,
              },
            },
            trigger: {
              type: "response",
              properties: {
                endingIds: ["ending1"],
              },
            },
          },
        ],
      } as unknown as TSurvey);

      vi.mocked(getResponse).mockResolvedValue(modifiedResponse as unknown as any);

      const result = await sendFollowUpsForResponse("response1");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0]).toEqual({
          followUpId: "followup1",
          status: "error",
          error: "To value not found in response data for followup: followup1",
        });
        expect(sendFollowUpEmail).not.toHaveBeenCalled();
      }
    });

    test("should handle email sending error", async () => {
      vi.mocked(getSurvey).mockResolvedValue({
        ...mockSurvey,
        followUps: [
          {
            id: "followup1",
            action: {
              type: "email",
              properties: {
                to: "hello@example.com",
                replyTo: "noreply@example.com",
                attachResponseData: true,
              },
            },
            trigger: {
              type: "response",
              properties: {
                endingIds: ["ending1"],
              },
            },
          },
        ],
      } as unknown as TSurvey);

      vi.mocked(sendFollowUpEmail).mockRejectedValue(new Error("Failed to send email"));

      const result = await sendFollowUpsForResponse("response1");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0]).toEqual({
          followUpId: "followup1",
          status: "error",
          error: "Failed to send email",
        });
      }
    });

    test("should return empty array when no follow-ups are configured", async () => {
      const modifiedSurvey = {
        ...mockSurvey,
        followUps: [],
      } as unknown as TSurvey;

      vi.mocked(getSurvey).mockResolvedValue(modifiedSurvey);

      const result = await sendFollowUpsForResponse("response1");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toEqual([]);
        expect(sendFollowUpEmail).not.toHaveBeenCalled();
      }
    });

    // ----------------------------------------------------------------
    // Scheduled follow-up coverage
    // ----------------------------------------------------------------

    test("should queue a scheduled follow-up and NOT send immediately", async () => {
      const scheduledSurvey = {
        ...mockSurvey,
        followUps: [
          {
            id: "scheduledFollowup1",
            action: {
              type: "send-email",
              properties: {
                to: "test@example.com",
                from: "noreply@example.com",
                replyTo: ["noreply@example.com"],
                subject: "Check in",
                body: "Body",
                attachResponseData: false,
              },
            },
            trigger: {
              type: "scheduled",
              properties: { delayDays: 7 },
            },
          },
        ],
      } as unknown as TSurvey;

      vi.mocked(getSurvey).mockResolvedValue(scheduledSurvey);

      const result = await sendFollowUpsForResponse("response1");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0]).toEqual({
          followUpId: "scheduledFollowup1",
          status: "success",
        });
      }
      expect(createScheduledFollowUp).toHaveBeenCalledTimes(1);
      expect(createScheduledFollowUp).toHaveBeenCalledWith(
        expect.objectContaining({
          followUpId: "scheduledFollowup1",
          responseId: "response1",
          surveyId: "survey1",
          environmentId: "env1",
          delayDays: 7,
          responseCreatedAt: mockResponse.createdAt,
        })
      );
      // The synchronous send path must NOT be used for scheduled follow-ups.
      expect(sendFollowUpEmail).not.toHaveBeenCalled();
    });

    test("should NOT engage the endings filter for a scheduled follow-up (regression: trigger.properties truthiness)", async () => {
      // Response has no endingId → the buggy condition `if (trigger.properties)`
      // would skip a scheduled follow-up because its properties are non-null.
      // The fixed condition must check `trigger.type === "endings"` explicitly.
      const responseWithoutEnding = {
        ...mockResponse,
        endingId: undefined,
      } as unknown as TResponse;

      const scheduledSurvey = {
        ...mockSurvey,
        followUps: [
          {
            id: "scheduledFollowup1",
            action: {
              type: "send-email",
              properties: {
                to: "test@example.com",
                from: "noreply@example.com",
                replyTo: ["noreply@example.com"],
                subject: "Check in",
                body: "Body",
                attachResponseData: false,
              },
            },
            trigger: {
              type: "scheduled",
              properties: { delayDays: 30 },
            },
          },
        ],
      } as unknown as TSurvey;

      vi.mocked(getResponse).mockResolvedValue(responseWithoutEnding);
      vi.mocked(getSurvey).mockResolvedValue(scheduledSurvey);

      const result = await sendFollowUpsForResponse("response1");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0].status).toBe("success"); // queued, not skipped
      }
      expect(createScheduledFollowUp).toHaveBeenCalledTimes(1);
    });

    test("should record an error if scheduling throws", async () => {
      const scheduledSurvey = {
        ...mockSurvey,
        followUps: [
          {
            id: "scheduledFollowup1",
            action: {
              type: "send-email",
              properties: {
                to: "test@example.com",
                from: "noreply@example.com",
                replyTo: ["noreply@example.com"],
                subject: "Check in",
                body: "Body",
                attachResponseData: false,
              },
            },
            trigger: {
              type: "scheduled",
              properties: { delayDays: 7 },
            },
          },
        ],
      } as unknown as TSurvey;

      vi.mocked(getSurvey).mockResolvedValue(scheduledSurvey);
      vi.mocked(createScheduledFollowUp).mockRejectedValue(new Error("DB write failed"));

      const result = await sendFollowUpsForResponse("response1");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0]).toEqual({
          followUpId: "scheduledFollowup1",
          status: "error",
          error: "Failed to schedule follow-up: DB write failed",
        });
      }
    });
  });
});
