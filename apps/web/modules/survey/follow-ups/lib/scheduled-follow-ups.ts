import { prisma } from "@formbricks/database";
import { logger } from "@formbricks/logger";

/**
 * Number of milliseconds in one day. Used to compute `sendAt` from
 * `delayDays`. Time is treated as a simple 24-hour offset from
 * `response.createdAt` in UTC — no timezone or business-day handling.
 */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export interface CreateScheduledFollowUpInput {
  followUpId: string;
  responseId: string;
  surveyId: string;
  environmentId: string;
  /** The submission time of the response — used as the base for `sendAt`. */
  responseCreatedAt: Date;
  /** Integer days in [1, 365]. Validated upstream by the Zod schema. */
  delayDays: number;
}

/**
 * Persist a pending scheduled follow-up. Called by `sendFollowUpsForResponse()`
 * when a follow-up has `trigger.type === "scheduled"`. The cron processor will
 * later pick up the record and dispatch the email via `sendFollowUpEmail()`.
 *
 * This function is intentionally minimal — it must remain fast because it
 * runs synchronously inside the response-submission HTTP request.
 */
export const createScheduledFollowUp = async ({
  followUpId,
  responseId,
  surveyId,
  environmentId,
  responseCreatedAt,
  delayDays,
}: CreateScheduledFollowUpInput): Promise<{ id: string; sendAt: Date }> => {
  const sendAt = new Date(responseCreatedAt.getTime() + delayDays * ONE_DAY_MS);

  const record = await prisma.scheduledFollowUp.create({
    data: {
      followUpId,
      responseId,
      surveyId,
      environmentId,
      sendAt,
      status: "PENDING",
    },
    select: { id: true, sendAt: true },
  });

  logger.info(
    { followUpId, responseId, surveyId, scheduledFollowUpId: record.id, sendAt: record.sendAt },
    "Scheduled follow-up queued"
  );

  return record;
};
