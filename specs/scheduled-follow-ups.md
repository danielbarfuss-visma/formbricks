# Scheduled Follow-Ups (Time-Based Triggers)

> **Status:** Draft for implementation
> **Source brief:** [`outputs/handover-scheduled-follow-ups-brief.md`](../../../../../../Claude/Projects/Discovery%20Engine/outputs/handover-scheduled-follow-ups-brief.md)
> **Module reference:** [`outputs/survey-follow-ups-reference.md`](../../../../../../Claude/Projects/Discovery%20Engine/outputs/survey-follow-ups-reference.md)
> **AGENTS.md context:** See `Discovery Context — Scheduled Follow-Ups` block in repo `AGENTS.md`
> **Date:** 2026-05-15

---

## Overview

Add a third trigger variant to the existing `SurveyFollowUp` module — `"scheduled"` — that defers email delivery by a configurable number of days after response submission (1–365 days). Today, every follow-up fires synchronously inside the response-submission HTTP request; this feature introduces a durable queue and a background processor so that scheduled follow-ups can be delivered hours or days later. It is a brownfield extension: the existing email rendering, sanitisation, recall-tag processing, and email transport are reused unchanged.

---

## Requirements

### REQ-1: New `scheduled` trigger type accepted by the type system

`TSurveyFollowUpTrigger` accepts a third variant `{ type: "scheduled", properties: { delayDays: number } }` alongside the existing `"response"` and `"endings"` variants. Both the canonical type (`packages/types/surveys/follow-up.ts`) and the form-layer schema (`apps/web/modules/survey/editor/types/survey-follow-up.ts`) accept this variant; existing variants continue to parse correctly.

**Acceptance criteria:**

- Given a valid `TSurveyFollowUp` payload with `trigger: { type: "scheduled", properties: { delayDays: 7 } }`, when parsed by `ZSurveyFollowUp`, then parsing succeeds and the resulting object has `trigger.type === "scheduled"` and `trigger.properties.delayDays === 7`.
- Given a payload with `trigger: { type: "scheduled", properties: null }`, when parsed, then parsing fails with a validation error stating `properties` must be defined for `scheduled` type.
- Given a payload with `trigger: { type: "scheduled", properties: { delayDays: 0 } }`, when parsed, then parsing fails with a range error.
- Given a payload with `trigger: { type: "scheduled", properties: { delayDays: 366 } }`, when parsed, then parsing fails with a range error.
- Given a payload with `trigger: { type: "scheduled", properties: { delayDays: 7.5 } }`, when parsed, then parsing fails (integer required).
- Given existing `"response"` and `"endings"` payloads with their previous shape, when parsed, then parsing continues to succeed unchanged.

---

### REQ-2: Trigger evaluation correctly routes the new type

When `sendFollowUpsForResponse(responseId)` evaluates a follow-up with `trigger.type === "scheduled"`, the existing endings filter must not engage. The current condition `if (trigger.properties)` (at `apps/web/modules/survey/follow-ups/lib/follow-ups.ts:217`) is type-coupled by accident — it must be changed to check `trigger.type === "endings"` explicitly before the new type is wired in.

**Acceptance criteria:**

- Given a follow-up with `trigger.type === "scheduled"` and `trigger.properties.delayDays === 7`, when the pipeline evaluates it for any submitted response, then the endings filter is not applied and the follow-up is not skipped on grounds of `endingId` mismatch.
- Given a follow-up with `trigger.type === "response"` (properties null), when the pipeline evaluates it, then it continues to fire for every response (current behaviour unchanged).
- Given a follow-up with `trigger.type === "endings"` and `properties.endingIds = ["e1"]`, when a response with `endingId === "e1"` is submitted, then the follow-up fires; when `endingId !== "e1"` or is null, then the follow-up is skipped (current behaviour unchanged).

---

### REQ-3: Submission defers scheduled sends to a durable queue

When a response is submitted and the survey has a follow-up with `trigger.type === "scheduled"`, the system persists a record of the pending send to a `ScheduledFollowUp` table instead of calling `sendFollowUpEmail()` synchronously. The record stores enough information to send the email at the correct time without needing the original HTTP request context.

**Acceptance criteria:**

- Given a survey with one `scheduled` follow-up configured at `delayDays = 7`, when a response is submitted at time `T`, then a `ScheduledFollowUp` row is persisted with `sendAt = T + 7 × 24 hours` (UTC), `status = PENDING`, `followUpId` pointing to the source follow-up, `responseId` pointing to the submitted response, and `surveyId` + `environmentId` denormalised for query efficiency.
- Given the same conditions, when the response submission HTTP request completes, then no follow-up email has been sent (`sendFollowUpEmail()` was not called for this follow-up).
- Given a survey with both a `scheduled` and a `response` follow-up, when a response is submitted, then the `response` follow-up sends immediately and the `scheduled` follow-up is queued — both happen in the same request.
- Given a survey with a `scheduled` follow-up but no `response` or `endings` follow-ups, when a response is submitted, then the pipeline route returns successfully without sending any email.

---

### REQ-4: Background processor sends queued follow-ups when due

A scheduled job runs at a fixed interval. On each tick, it finds all `ScheduledFollowUp` records that are due (`status = PENDING` and `sendAt <= now()`) and dispatches the email using the existing `sendFollowUpEmail()` code path.

**Acceptance criteria:**

- Given a `ScheduledFollowUp` record with `status = PENDING` and `sendAt = now() - 1 minute`, when the processor runs, then the record's email is sent (verified by mock of `sendFollowUpEmail`) and `status` transitions to `SENT` with `sentAt` set to the time of the send.
- Given a `ScheduledFollowUp` record with `status = PENDING` and `sendAt = now() + 1 hour`, when the processor runs, then no email is sent and `status` remains `PENDING`.
- Given a `ScheduledFollowUp` record with `status = SENT`, when the processor runs again, then no email is sent (the record is skipped).
- Given the processor has been offline and 100 records are now overdue, when the processor next runs, then all 100 records are processed in that tick (no per-tick cap in v1 beyond the rate limit in REQ-5).
- Given a `ScheduledFollowUp` record where `sendFollowUpEmail()` throws, when the processor handles it, then `status` is set to `FAILED`, an error is logged with `followUpId` and `responseId` in the log metadata, and no further attempt is made automatically.

---

### REQ-5: Rate limit applies to scheduled sends

The processor enforces the same per-organisation rate limit used today by `sendFollowUpsForResponse()` — `rateLimitConfigs.actions.surveyFollowUp` (50 sends per organisation per hour, namespace `action:followup`). Rate limit denial does not consume the queue record; it remains `PENDING` for retry on the next tick.

**Acceptance criteria:**

- Given an organisation that has already used 50 of 50 follow-up slots in the current hour, when the processor encounters a due `ScheduledFollowUp` for that organisation, then `sendFollowUpEmail()` is not called for that record, the record's `status` remains `PENDING`, and a "rate limit deferred" message is logged.
- Given the same record on the next tick after the rate limit window has reset, when the processor runs, then the record is sent normally (status → `SENT`).
- Given an organisation under the rate limit threshold, when 10 due records for that organisation are processed in a single tick, then all 10 are sent and the rate-limit counter for that organisation is incremented by 10.

---

### REQ-6: Entitlement check applies to scheduled sends

The processor calls `getSurveyFollowUpsPermission(organizationId)` before sending. If the organisation no longer has the follow-ups entitlement (Stripe lookup key `"follow-ups"`), the record is marked `FAILED` and not sent.

**Acceptance criteria:**

- Given an organisation that had the entitlement when the record was queued but has since lost it, when the processor encounters the record, then `sendFollowUpEmail()` is not called, `status` is set to `FAILED`, and a "entitlement denied" message is logged.
- Given an organisation with active entitlement, when the processor encounters a due record, then `getSurveyFollowUpsPermission()` is called and the send proceeds.

---

### REQ-7: Double-send is prevented across overlapping processor runs

If the processor is invoked again while a previous run is still in progress, no `ScheduledFollowUp` record is sent twice. The implementation must use database-level mutual exclusion (e.g. conditional `UPDATE ... WHERE status = 'PENDING'`, or `SELECT ... FOR UPDATE SKIP LOCKED`) so that a record claimed by one processor instance is invisible to another.

**Acceptance criteria:**

- Given a single `ScheduledFollowUp` with `status = PENDING` and two concurrent processor invocations, when both processors attempt to claim it, then exactly one processor sends the email and `sendFollowUpEmail()` is called exactly once in total for that record.
- Given a record that has been transitioned to `SENT` or `FAILED`, when a subsequent processor tick runs, then the record is not claimed and not re-processed.

---

### REQ-8: Deleting a survey or follow-up cancels pending sends

When a `Survey` or a `SurveyFollowUp` is deleted, any `ScheduledFollowUp` records that reference it must not send. This is enforced via cascade delete at the database level — pending and sent records alike are removed when their parent is deleted.

**Acceptance criteria:**

- Given a `SurveyFollowUp` with three `PENDING` `ScheduledFollowUp` records, when the follow-up is deleted via the survey editor's save action, then all three `ScheduledFollowUp` rows are removed from the database.
- Given a `Survey` with multiple follow-ups, each with `PENDING` records, when the survey is deleted, then all related `ScheduledFollowUp` rows are removed.
- Given a `ScheduledFollowUp` that has been removed via cascade, when the next processor tick runs, then no email is sent for that record (because it no longer exists).

---

### REQ-9: Modal UI lets the user configure the scheduled trigger

In `follow-up-modal.tsx`, the trigger Select control offers a third option labelled "After X days" (i18n key: `environments.surveys.edit.follow_ups_modal_trigger_type_scheduled`). When selected, a number input for `delayDays` becomes visible. The input is pre-filled with the default value `7`.

**Acceptance criteria:**

- Given the modal is open in "create" mode, when the user opens the trigger Select control, then three options are visible: "On submission", "After X days", and "Specific ending" (the third only when the survey has at least one ending — same gating rule as today).
- Given the user selects "After X days", when the trigger type changes, then a number input becomes visible immediately, pre-filled with the value `7`, and a contextual info note reads "This email will be sent automatically 7 days after the response is submitted" (or i18n equivalent).
- Given the user types `14` into the input, when the input blurs, then the info note updates to reflect 14 days.
- Given the modal is opened in "edit" mode for an existing follow-up with `trigger.type === "scheduled"` and `delayDays === 30`, when the modal renders, then the Select shows "After X days" as the active option and the number input shows `30`.
- Given the user switches from "After X days" back to "On submission", when the trigger type changes, then the number input disappears and the form's `delayDays` field is cleared (no stale value is persisted).

---

### REQ-10: Modal validates `delayDays` before save

The `delayDays` field is required when `triggerType === "scheduled"`. The form rejects values outside `[1, 365]` and non-integers, and surfaces an inline error message. The Save button is disabled (or save is blocked) while the value is invalid.

**Acceptance criteria:**

- Given the trigger type is "After X days" and the input is empty, when the user clicks Save, then save does not proceed and an inline error indicates that a value is required.
- Given the input contains `0`, when the user clicks Save, then save does not proceed and an inline error indicates the value must be between 1 and 365.
- Given the input contains `366`, when the user clicks Save, then save does not proceed and an inline error indicates the value must be between 1 and 365.
- Given the input contains `7.5`, when the user clicks Save, then save does not proceed and an inline error indicates the value must be a whole number.
- Given the input contains `7`, when the user clicks Save, then save proceeds and the follow-up is persisted with `trigger: { type: "scheduled", properties: { delayDays: 7 } }`.

---

### REQ-11: Follow-up list item shows scheduled badge

In `follow-up-item.tsx`, when `followUp.trigger.type === "scheduled"`, the item displays a badge of type `warning` (existing `Badge` component) with text `"In N days"` (i18n key: `environments.surveys.edit.follow_ups_item_scheduled_tag`, parameterised by `delayDays`). The existing trigger-type badge ("Response" / "Ending") is replaced by this scheduled badge — only one trigger-type badge per item.

**Acceptance criteria:**

- Given a follow-up with `trigger.type === "scheduled"` and `delayDays === 7`, when the item renders, then a warning-type badge with text "In 7 days" is visible in the trigger badge slot.
- Given a follow-up with `trigger.type === "response"`, when the item renders, then a gray-type badge with the existing "Response" label is shown (current behaviour unchanged).
- Given a follow-up with `trigger.type === "endings"`, when the item renders, then a gray-type badge with the existing "Ending" label is shown (current behaviour unchanged).

---

### REQ-12: Scheduled processor uses follow-up and survey state as of send time

The processor loads the `SurveyFollowUp`, `Response`, and `Survey` records fresh on each send. If a survey author edits the follow-up's subject, body, recipient configuration, or recall tags after the scheduled record was queued, the send at delivery time reflects the current configuration — not the configuration that existed at queue time. This mirrors the existing `sendFollowUpsForResponse()` pattern.

The only value frozen at queue time is `sendAt` (derived from the `delayDays` value at queue time and the response's `createdAt`).

**Acceptance criteria:**

- Given a `ScheduledFollowUp` record queued with the follow-up's body set to "Hello!", when the author edits the body to "Greetings!" before `sendAt` arrives, then the email sent at `sendAt` contains "Greetings!".
- Given a `ScheduledFollowUp` record queued with `delayDays = 7`, when the author edits the follow-up to `delayDays = 14` before the record sends, then the existing record's `sendAt` is unchanged (the change only affects future submissions).

---

## Constraints

- **Pipeline write must be fast.** The new `ScheduledFollowUp` insert added to `sendFollowUpsForResponse()` runs synchronously inside the response-submission HTTP request. The total added latency for a request that schedules one follow-up must not exceed 50ms in p95 (single DB insert; no external calls). Source: AGENTS.md §"The pipeline DB write must stay fast".
- **Cron interval is 15 minutes.** Documented granularity; the trade-off (15-minute precision vs. cost) is accepted for v1. Source: PRD F3 and brief Open Assumption #2.
- **`delayDays` range is `[1, 365]` integers.** Hard bounds enforced at Zod, form, and DB layers. Source: brief F1.
- **Cascade delete on `ScheduledFollowUp.followUpId → SurveyFollowUp.id` and `ScheduledFollowUp.responseId → Response.id`.** Source: AGENTS.md §"Cascade delete is required".
- **Same Stripe entitlement key `"follow-ups"`.** Scheduled follow-ups are not a new tier; they reuse the existing `CLOUD_STRIPE_FEATURE_LOOKUP_KEYS.FOLLOW_UPS`. Source: AGENTS.md §"Entitlement check applies".
- **Same per-organisation rate limit `rateLimitConfigs.actions.surveyFollowUp` (50/hour, namespace `action:followup`).** No new rate-limit config introduced. Source: AGENTS.md §"Rate limit must be applied in the cron processor".
- **No changes to `sendFollowUpEmail()`, `renderFollowUpEmail()`, body sanitisation allowlists, or `TSurveyFollowUpAction`.** The scheduled processor must reuse the existing send path unchanged.
- **`trigger` column in Prisma remains `Json`.** No migration is required for the existing `SurveyFollowUp` table; only the new `ScheduledFollowUp` table requires a migration.
- **Time arithmetic is UTC, 24-hour days.** `sendAt = response.createdAt + delayDays × 24 hours` in UTC. No timezone awareness, no end-of-day or business-day adjustment. Source: ambiguity resolution — matches existing time-handling convention in the codebase.

---

## Non-Requirements (Explicit Exclusions)

The following are explicitly **not** part of this work. They may be considered for future iterations but must not be implemented now.

- **Recurring follow-ups.** No "send every N days" or "send daily until X". One queue record per response × follow-up.
- **Time-of-day scheduling.** No "send at 9am Tuesday" or "send during business hours". The send fires whenever the next processor tick after `sendAt` runs.
- **Cancellation when the respondent acts.** If a respondent fills out the survey again, refunds, or unsubscribes between submission and send, the scheduled follow-up still fires (subject to entitlement/rate-limit checks).
- **A/B testing of delay windows.** No experiment framework.
- **Automatic retry of `FAILED` records.** `FAILED` is terminal in v1. No retry queue, no exponential backoff. Source: brief Risk #3 and AGENTS.md §"No retry in v1".
- **Manual retry UI.** No "Resend" button in the editor or anywhere else for `FAILED` records.
- **Per-record status visible to the user.** The survey author sees only that the follow-up is configured as scheduled ("In 7 days" badge). They do not see how many records are `PENDING`, `SENT`, or `FAILED` for that follow-up.
- **Configurable cron interval.** 15-minute interval is hard-coded in v1.
- **Audit history of sent records after deletion.** Cascade delete removes `SENT` records when the parent is removed. No archive table.
- **Cross-environment scheduling.** Each environment's follow-ups process independently using the same cron infrastructure; no cross-env queuing.
- **Backfill of existing responses.** Activating a new scheduled follow-up does not retroactively queue sends for responses submitted before the follow-up was created.

---

## Assumptions

These are believed true based on discovery, but if any turn out to be wrong, the spec must be revisited.

1. **15-minute cron granularity is acceptable.** Customers who say "send 7 days later" do not expect minute-precision; they expect ~7 days. Source: brief Open Assumption #2 — flagged but not validated with users.
2. **The `"follow-ups"` Stripe entitlement covers scheduled sends.** Billing has not been consulted for a new tier; PM has decided this is an existing-feature extension. Source: brief Open Assumption #4.
3. **No retry is acceptable for v1.** PM has decided `FAILED` is terminal and that the operational cost of building a retry queue is not justified for v1. Source: brief Open Assumption #3.
4. **A 50ms DB insert on the response-submission hot path is acceptable.** Pipeline already does multiple DB calls; one more insert is within budget. Not load-tested.
5. **Existing Formbricks job infrastructure (or Vercel Cron / equivalent) is available.** A separate worker process or new cron registration is not required; the implementer can choose between existing infrastructure and a new minimal cron endpoint. Source: brief Risk discussion + Open Question #2.
6. **The current Prisma `Response.id` and `Survey.id` foreign-key cascade behaviour is acceptable for cleanup paths.** If a response is hard-deleted, pending scheduled follow-ups for it are also removed.

---

## Open Questions

These must be resolved before, or during, implementation. They are blockers for specific requirements.

- [ ] **Cron registration mechanism.** Does this repo already have a job framework (BullMQ, node-cron, Vercel Cron route, etc.), or does this feature introduce one? Affects REQ-4. **Owner:** Eng lead. **Until resolved:** the implementer should choose the lowest-friction option and document the choice; a Vercel Cron API route is the most likely default given the Next.js stack.
- [ ] **Retry policy in v2.** If `FAILED` proves problematic in early usage, what is the planned retry strategy? Does not block v1, but informs the data model (do we store enough to retry?). **Owner:** PM. **Recommendation:** the `ScheduledFollowUp` schema should preserve all fields needed to call `sendFollowUpEmail()` even after `FAILED`, so a future retry feature can be added without backfill.
- [ ] **i18n keys.** New strings introduced by this feature (REQ-9, REQ-11) need i18n keys agreed and added to all locale files. **Owner:** Eng + translation pipeline. **Affects:** REQ-9 acceptance criteria (the exact label "After X days" is illustrative; localised key is what ships).

---

## Tasks (Implementation Breakdown)

Ordered by dependency. Each task is independently verifiable and small enough for one work session.

1. **Fix the trigger evaluation condition** (implements REQ-2 prerequisite). Change `if (trigger.properties)` to `if (trigger.type === "endings")` in `follow-ups.ts:217`. Add a unit test covering the new `"scheduled"` type path in `follow-ups.test.ts` — verify it does not skip on endings filter. Ship this first as a pure refactor; it should be safe with existing types because no `"scheduled"` follow-ups exist yet.

2. **Extend the canonical Zod schema** (implements REQ-1). Update `packages/types/surveys/follow-up.ts`:
   - Add `"scheduled"` to the `type` enum
   - Extend the `superRefine` so `"scheduled"` requires `properties.delayDays: integer, 1..365`
   - Update the `TSurveyFollowUpTrigger` type accordingly
   - Add unit tests for valid and invalid `"scheduled"` payloads

3. **Add the Prisma `ScheduledFollowUp` model** (implements REQ-3, REQ-4, REQ-7, REQ-8). New model with `id`, `createdAt`, `sendAt`, `sentAt?`, `status` (enum: `PENDING | SENT | FAILED`), `followUpId` (FK cascade), `responseId` (FK cascade), `surveyId`, `environmentId`. Indexes on `(sendAt, status)` and `(environmentId, status)`. Generate and apply the migration.

4. **Implement `createScheduledFollowUp()` and update the pipeline branch** (implements REQ-3). New file `apps/web/modules/survey/follow-ups/lib/scheduled-follow-ups.ts` exports `createScheduledFollowUp({ followUpId, responseId, surveyId, environmentId, sendAt })`. Update `evaluateFollowUp()` (or its caller in `follow-ups.ts`) to detect `trigger.type === "scheduled"` and call this function instead of `sendFollowUpEmail()`. Add unit tests with all dependencies mocked.

5. **Implement the cron processor** (implements REQ-4, REQ-5, REQ-6, REQ-7). New file `apps/web/modules/survey/follow-ups/lib/process-scheduled-follow-ups.ts` exports `processDueFollowUps()`. The function: (a) selects due records using DB-level locking, (b) for each record loads survey + response + organisation, (c) runs entitlement + rate-limit checks, (d) calls `sendFollowUpEmail()`, (e) transitions status. Add unit tests with mocked dependencies covering: success path, rate-limit denial (stays PENDING), entitlement denial (FAILED), send error (FAILED), concurrent claim attempt (only one wins).

6. **Add the cron entry point** (implements REQ-4). New file `apps/web/app/api/(internal)/cron/scheduled-follow-ups/route.ts` (or equivalent — see Open Question #1). The route is auth-gated to the cron secret and calls `processDueFollowUps()`. Register the route in the project's cron configuration with a 15-minute interval.

7. **Update the form-layer Zod schema and modal UI** (implements REQ-9, REQ-10). Update `apps/web/modules/survey/editor/types/survey-follow-up.ts` to add `"scheduled"` to the `triggerType` enum and add an optional `delayDays` field with conditional validation. Update `follow-up-modal.tsx` to render the new trigger option and the `delayDays` input. Wire the field through `react-hook-form`. Update `handleSubmit` to set `trigger.properties` correctly for the new type.

8. **Update the follow-up list item** (implements REQ-11). Update `follow-up-item.tsx` to render the warning-type "In N days" badge when `trigger.type === "scheduled"`. Replace (not add to) the existing trigger-type badge.

9. **Add E2E coverage** (implements REQ-3, REQ-9, REQ-10, REQ-11 end-to-end). Extend `apps/web/playwright/survey-follow-up.spec.ts` to cover: creating a scheduled follow-up via the modal, seeing the badge on the list, submitting a response, and asserting that a `ScheduledFollowUp` row is created (DB assertion or API check).

10. **Add i18n keys** (implements REQ-9, REQ-11). Add the new translation keys to the default locale and create stub entries for other locales as per the project's i18n workflow.

---

## Verification

The spec is complete when an engineer can implement each task from this document plus the cited references (Engineering Brief, Module Reference, AGENTS.md context block) without asking clarifying questions. Implementation is complete when every requirement's acceptance criteria pass, all three Open Questions are resolved, and no Non-Requirement has slipped into scope.
