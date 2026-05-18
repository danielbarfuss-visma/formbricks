import { z } from "zod";

/**
 * Minimum and maximum allowed values for the `delayDays` field on the
 * `scheduled` trigger variant. Enforced at the type layer; the form-layer
 * schema (`apps/web/modules/survey/editor/types/survey-follow-up.ts`) mirrors
 * these bounds.
 */
export const SCHEDULED_FOLLOW_UP_MIN_DAYS = 1;
export const SCHEDULED_FOLLOW_UP_MAX_DAYS = 365;
export const SCHEDULED_FOLLOW_UP_DEFAULT_DAYS = 7;

// Trigger types as a const tuple — referenced by the form-layer schema to stay in sync.
export const FOLLOW_UP_TRIGGER_TYPES = ["response", "endings", "scheduled"] as const;
export type TSurveyFollowUpTriggerType = (typeof FOLLOW_UP_TRIGGER_TYPES)[number];

/**
 * Discriminated union over `type`. Each variant carries exactly the
 * properties it needs:
 *   - `response`  → no properties (fires for every response)
 *   - `endings`   → set of endingIds to filter on
 *   - `scheduled` → number of days to delay the send
 */
export const ZSurveyFollowUpTrigger = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("response"),
    properties: z.null(),
  }),
  z.object({
    type: z.literal("endings"),
    properties: z.object({
      // Kept non-empty in the form-layer schema; left permissive here to stay
      // backward-compatible with any pre-existing rows that may have empty arrays.
      endingIds: z.array(z.cuid2()),
    }),
  }),
  z.object({
    type: z.literal("scheduled"),
    properties: z.object({
      delayDays: z.number().int().min(SCHEDULED_FOLLOW_UP_MIN_DAYS).max(SCHEDULED_FOLLOW_UP_MAX_DAYS),
    }),
  }),
]);

export type TSurveyFollowUpTrigger = z.infer<typeof ZSurveyFollowUpTrigger>;

export const ZSurveyFollowUpAction = z.object({
  type: z.literal("send-email"),
  properties: z.object({
    to: z.string(),
    from: z.email(),
    replyTo: z.array(z.email()),
    subject: z.string(),
    body: z.string(),
    attachResponseData: z.boolean(),
    includeVariables: z.boolean().optional(),
    includeHiddenFields: z.boolean().optional(),
  }),
});

export type TSurveyFollowUpAction = z.infer<typeof ZSurveyFollowUpAction>;

export const ZSurveyFollowUp = z.object({
  id: z.cuid2(),
  createdAt: z.date(),
  updatedAt: z.date(),
  name: z.string(),
  trigger: ZSurveyFollowUpTrigger,
  action: ZSurveyFollowUpAction,
  surveyId: z.cuid2(),
});

export type TSurveyFollowUp = z.infer<typeof ZSurveyFollowUp>;
