import { headers } from "next/headers";
import { logger } from "@formbricks/logger";
import { responses } from "@/app/lib/api/response";
import { CRON_SECRET } from "@/lib/constants";
import { processDueFollowUps } from "@/modules/survey/follow-ups/lib/process-scheduled-follow-ups";

/**
 * Cron entry point for the scheduled-follow-ups processor. Invoked every
 * 15 minutes (Vercel Cron configured in `vercel.json`, or via any external
 * scheduler that hits this endpoint with the `x-api-key: CRON_SECRET` header).
 *
 * Idempotent: the underlying `processDueFollowUps()` uses
 * `FOR UPDATE SKIP LOCKED` so overlapping invocations cannot double-send.
 */
export const POST = async () => {
  const requestHeaders = await headers();

  // Accept either the Formbricks convention (`x-api-key`) used by internal
  // callers, or the Vercel Cron convention (`Authorization: Bearer ...`)
  // used when this route is invoked by the platform scheduler.
  const apiKey = requestHeaders.get("x-api-key");
  const bearer = requestHeaders.get("authorization")?.replace(/^Bearer\s+/i, "");
  const isAuthorized = !!CRON_SECRET && (apiKey === CRON_SECRET || bearer === CRON_SECRET);

  if (!isAuthorized) {
    return responses.notAuthenticatedResponse();
  }

  try {
    const results = await processDueFollowUps();
    const summary = {
      total: results.length,
      sent: results.filter((r) => r.status === "sent").length,
      failed: results.filter((r) => r.status === "failed").length,
      deferred: results.filter((r) => r.status === "deferred-rate-limit").length,
    };
    return responses.successResponse(summary);
  } catch (error) {
    logger.error({ error }, "Scheduled follow-up cron run failed");
    return responses.internalServerErrorResponse(error instanceof Error ? error.message : "Unexpected error");
  }
};

// Allow GET as well, so that Vercel Cron (which calls with GET by default)
// or simple curl checks succeed without configuration tweaks.
export const GET = POST;
