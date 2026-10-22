-- CreateEnum
CREATE TYPE "ops_login_state" AS ENUM ('unknown', 'authenticated', 'needs_login');

-- AlterTable
ALTER TABLE "ecom_shops" ADD COLUMN     "bound_at" TIMESTAMPTZ(3),
ADD COLUMN     "collect_port" INTEGER,
ADD COLUMN     "last_sync_error" VARCHAR(500),
ADD COLUMN     "login_checked_at" TIMESTAMPTZ(3),
ADD COLUMN     "login_state" "ops_login_state" NOT NULL DEFAULT 'unknown',
ADD COLUMN     "sync_requested_at" TIMESTAMPTZ(3);
