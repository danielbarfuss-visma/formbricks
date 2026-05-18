-- CreateEnum
CREATE TYPE "ScheduledFollowUpStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "ScheduledFollowUp" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "send_at" TIMESTAMP(3) NOT NULL,
    "sent_at" TIMESTAMP(3),
    "status" "ScheduledFollowUpStatus" NOT NULL DEFAULT 'PENDING',
    "followUpId" TEXT NOT NULL,
    "responseId" TEXT NOT NULL,
    "surveyId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "failureReason" TEXT,

    CONSTRAINT "ScheduledFollowUp_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduledFollowUp_status_send_at_idx" ON "ScheduledFollowUp"("status", "send_at");

-- CreateIndex
CREATE INDEX "ScheduledFollowUp_environmentId_status_idx" ON "ScheduledFollowUp"("environmentId", "status");

-- CreateIndex
CREATE INDEX "ScheduledFollowUp_followUpId_idx" ON "ScheduledFollowUp"("followUpId");

-- CreateIndex
CREATE INDEX "ScheduledFollowUp_responseId_idx" ON "ScheduledFollowUp"("responseId");

-- AddForeignKey
ALTER TABLE "ScheduledFollowUp" ADD CONSTRAINT "ScheduledFollowUp_followUpId_fkey" FOREIGN KEY ("followUpId") REFERENCES "SurveyFollowUp"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledFollowUp" ADD CONSTRAINT "ScheduledFollowUp_responseId_fkey" FOREIGN KEY ("responseId") REFERENCES "Response"("id") ON DELETE CASCADE ON UPDATE CASCADE;
