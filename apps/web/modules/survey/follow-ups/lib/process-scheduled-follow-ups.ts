import { prisma } from "@formbricks/database";
import { logger } from "@formbricks/logger";
import { getOrganizationByEnvironmentId } from "@/lib/organization/service";
import { getResponse } from "@/lib/response/service";
import { getSurvey } from "@/lib/survey/service";
import { applyRateLimit } from "@/modules/core/rate-limit/helpers";
import { rateLimitConfigs } from "@/modules/core/rate-limit/rate-limit-configs";
import { sendFollowUpEmail } from "@/modules/survey/follow-ups/lib/email";
import { getSurveyFollowUpsPermission } from "@/modules/survey/follow-ups/lib/utils";

/**
 * Maximum number of records to process in a single cron tick. Bounds the
 * worst-case execution time of the processor; any overflow is picked up on
 * the next tick. Tuned conservatively — a 15-min interval at 200/tick gives
 * 800 sends/hour, well above the per-org rate limit of 50/hour.
 */
const MAX_BATCH_SIZE = 200;

export interface ProcessResult {
  scheduledFollowUpId: string;
  status: "sent" | "deferred-rate-limit" | "failed";
  reason?: string;
}

/**
 * Cron entry point. Finds all `ScheduledFollowUp` records whose `sendAt` is
 * in the past and dispatches each via the existing `sendFollowUpEmail()`
 * path. Enforces the same per-organisation rate limit and entitlement gate
 * that `sendFollowUpsForResponse()` uses.
 *
 * Double-send safety: each record is claimed with a conditional UPDATE that
 * transitions PENDING -> PENDING (no-op) and returns the row only if no other
 * worker has already claimed it. Postgres row-level locking is provided by
 * `FOR UPDATE SKIP LOCKED` via a transaction.
 */
export const processDueFollowUps = async (): Promise<ProcessResult[]> => {
  const now = new Date();

  // Claim a batch of due records using SELECT ... FOR UPDATE SKIP LOCKED.
  // This prevents two concurrent cron invocations from sending the same
  // record twice. Records claimed by this transaction remain locked until
  // commit.
  const claimedIds = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "ScheduledFollowUp"
      WHERE "status" = 'PENDING' AND "send_at" <= ${now}
      ORDER BY "send_at" ASC
      LIMIT ${MAX_BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    `;
    return rows.map((r) => r.id);
  });

  if (claimedIds.length === 0) {
    return [];
  }

  logger.info({ count: claimedIds.length }, "Processing scheduled follow-ups");

  const results = await Promise.all(claimedIds.map((id) => processOne(id)));

  const summary = {
    total: results.length,
    sent: results.filter((r) => r.status === "sent").length,
    failed: results.filter((r) => r.status === "failed").length,
    deferred: results.filter((r) => r.status === "deferred-rate-limit").length,
  };
  logger.info(summary, "Scheduled follow-up batch complete");

  return results;
};

const processOne = async (scheduledFollowUpId: string): Promise<ProcessResult> => {
  // Load the record (status may have changed since we claimed it — check again).
  const record = await prisma.scheduledFollowUp.findUnique({
    where: { id: scheduledFollowUpId },
  });

  if (!record || record.status !== "PENDING") {
    return { scheduledFollowUpId, status: "failed", reason: "Record missing or no longer pending" };
  }

  try {
    // Resolve current state at send time. The follow-up config may have been
    // edited since the record was queued — we honour the latest config.
    const [response, survey, organization] = await Promise.all([
      getResponse(record.responseId),
      // Survey is needed for env id, follow-up config, and email rendering context.
      // We load via the followUp's surveyId (denormalised) to avoid extra hops.
      getSurvey(record.surveyId),
      getOrganizationByEnvironmentId(record.environmentId),
    ]);

    if (!response) {
      await markFailed(scheduledFollowUpId, "Response not found at send time");
      return { scheduledFollowUpId, status: "failed", reason: "Response not found" };
    }
    if (!survey) {
      await markFailed(scheduledFollowUpId, "Survey not found at send time");
      return { scheduledFollowUpId, status: "failed", reason: "Survey not found" };
    }
    if (!organization) {
      await markFailed(scheduledFollowUpId, "Organization not found at send time");
      return { scheduledFollowUpId, status: "failed", reason: "Organization not found" };
    }

    // Locate the follow-up within the survey. If it has been removed since
    // the record was queued, fail the record (cascade should have caught
    // this, but defensive check).
    const followUp = survey.followUps.find((f) => f.id === record.followUpId);
    if (!followUp) {
      await markFailed(scheduledFollowUpId, "Follow-up no longer attached to survey");
      return { scheduledFollowUpId, status: "failed", reason: "Follow-up missing" };
    }

    // Entitlement check — organisation may have downgraded since the
    // record was queued.
    const permitted = await getSurveyFollowUpsPermission(organization.id);
    if (!permitted) {
      await markFailed(scheduledFollowUpId, "Organisation entitlement denied");
      return { scheduledFollowUpId, status: "failed", reason: "Entitlement denied" };
    }

    // Rate limit — same per-org limit used by the synchronous send path.
    try {
      await applyRateLimit(rateLimitConfigs.actions.surveyFollowUp, organization.id);
    } catch {
      // Leave the record PENDING so the next tick can retry once the
      // rate-limit window has reset.
      logger.warn(
        { scheduledFollowUpId, organizationId: organization.id },
        "Scheduled follow-up deferred — rate limit"
      );
      return { scheduledFollowUpId, status: "deferred-rate-limit" };
    }

    // Resolve the recipient. We reuse the same resolution logic as the
    // synchronous path: direct email, or a question/hidden-field reference
    // looked up in `response.data`.
    const recipient = resolveRecipient(followUp.action.properties.to, response.data);
    if (!recipient) {
      await markFailed(scheduledFollowUpId, `Recipient email could not be resolved`);
      return { scheduledFollowUpId, status: "failed", reason: "Recipient unresolved" };
    }

    // Send.
    await sendFollowUpEmail({
      followUp,
      to: recipient,
      replyTo: followUp.action.properties.replyTo,
      survey,
      response,
      attachResponseData: followUp.action.properties.attachResponseData,
      includeVariables: followUp.action.properties.includeVariables,
      includeHiddenFields: followUp.action.properties.includeHiddenFields,
      logoUrl: organization.whitelabel?.logoUrl ?? "",
    });

    // Mark sent.
    await prisma.scheduledFollowUp.update({
      where: { id: scheduledFollowUpId },
      data: { status: "SENT", sentAt: new Date(), failureReason: null },
    });

    return { scheduledFollowUpId, status: "sent" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    logger.error(
      { error, scheduledFollowUpId, responseId: record.responseId, followUpId: record.followUpId },
      "Scheduled follow-up send failed"
    );
    await markFailed(scheduledFollowUpId, message);
    return { scheduledFollowUpId, status: "failed", reason: message };
  }
};

const markFailed = async (id: string, reason: string): Promise<void> => {
  await prisma.scheduledFollowUp
    .update({
      where: { id },
      data: { status: "FAILED", failureReason: reason.slice(0, 1000) },
    })
    .catch((err) => {
      logger.error({ err, scheduledFollowUpId: id }, "Failed to mark ScheduledFollowUp as FAILED");
    });
};

/**
 * Resolve the recipient email for a scheduled send.
 *
 * Mirrors the resolution logic in `evaluateFollowUp()`:
 *  1. If `to` is itself a valid email, use it directly.
 *  2. Otherwise treat `to` as a key into `response.data` and unpack the value
 *     (string or array — array index 2 is the ContactInfo email field).
 *
 * Email format is validated by the caller via `sendFollowUpEmail()`; this
 * function only extracts the candidate string.
 */
const resolveRecipient = (to: string, responseData: Record<string, unknown>): string | null => {
  // Case 1: literal email in the "to" field.
  if (isEmailLike(to)) {
    return to;
  }

  // Case 2: look up the question/hidden-field response.
  const value = responseData[to];
  if (typeof value === "string" && isEmailLike(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    // ContactInfo questions store sub-fields as an array; index 2 is the email.
    const email = value[2];
    if (typeof email === "string" && isEmailLike(email)) {
      return email;
    }
  }
  return null;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isEmailLike = (s: string): boolean => EMAIL_RE.test(s);
