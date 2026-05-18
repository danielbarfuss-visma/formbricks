import { z } from "zod";
import {
  SCHEDULED_FOLLOW_UP_MAX_DAYS,
  SCHEDULED_FOLLOW_UP_MIN_DAYS,
} from "@formbricks/types/surveys/follow-up";

/**
 * Form-layer schema for create/edit of a follow-up. The trigger is flattened
 * (`triggerType` + `endingIds` + `delayDays`) so it maps cleanly to
 * `react-hook-form` state. The submit handler converts this flat shape into
 * the discriminated union expected by the canonical `TSurveyFollowUpTrigger`.
 */
export const ZCreateSurveyFollowUpFormSchema = z
  .object({
    followUpName: z.string().trim().min(1, "Name is required"),
    triggerType: z.enum(["response", "endings", "scheduled"]),
    endingIds: z.array(z.cuid2()).nullable(),
    delayDays: z
      .number()
      .int()
      .min(SCHEDULED_FOLLOW_UP_MIN_DAYS, `Must be at least ${SCHEDULED_FOLLOW_UP_MIN_DAYS}`)
      .max(SCHEDULED_FOLLOW_UP_MAX_DAYS, `Must be at most ${SCHEDULED_FOLLOW_UP_MAX_DAYS}`)
      .nullable(),
    emailTo: z.string().trim().min(1, "To is required"),
    replyTo: z.array(z.email()).min(1, "Replies must have at least one email"),
    subject: z.string().trim().min(1, "Subject is required"),
    body: z.string().trim().min(1, "Body is required"),
    attachResponseData: z.boolean(),
    includeVariables: z.boolean(),
    includeHiddenFields: z.boolean(),
  })
  .superRefine((data, ctx) => {
    if (data.triggerType === "endings") {
      if (!data.endingIds || data.endingIds.length === 0) {
        ctx.addIssue({
          code: "custom",
          message: "Please select at least one ending",
          path: ["endingIds"],
        });
      }
    }
    if (data.triggerType === "scheduled") {
      if (data.delayDays === null || data.delayDays === undefined) {
        ctx.addIssue({
          code: "custom",
          message: "Delay (in days) is required",
          path: ["delayDays"],
        });
      }
    }
  });

export type TCreateSurveyFollowUpForm = z.infer<typeof ZCreateSurveyFollowUpFormSchema>;

export type TFollowUpEmailToUser = {
  name: string;
  email: string;
};
