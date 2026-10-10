-- CreateEnum
CREATE TYPE "login_outcome" AS ENUM ('success', 'unknown_user', 'wrong_password', 'account_unavailable', 'account_locked');

-- CreateTable
CREATE TABLE "login_attempts" (
    "id" UUID NOT NULL,
    "ip" VARCHAR(64) NOT NULL,
    "username" VARCHAR(64) NOT NULL,
    "outcome" "login_outcome" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "login_attempts_ip_created_at_idx" ON "login_attempts"("ip", "created_at");

-- CreateIndex
CREATE INDEX "login_attempts_created_at_idx" ON "login_attempts"("created_at");
