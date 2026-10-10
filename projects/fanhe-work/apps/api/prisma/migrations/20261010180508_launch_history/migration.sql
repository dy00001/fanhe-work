-- CreateTable
CREATE TABLE "launch_history" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "profile_name" VARCHAR(64) NOT NULL,
    "executable_path" VARCHAR(1024) NOT NULL,
    "outcome" VARCHAR(32) NOT NULL,
    "pid" INTEGER,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "launch_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "launch_history_user_id_started_at_idx" ON "launch_history"("user_id", "started_at");

-- CreateIndex
CREATE INDEX "launch_history_user_id_profile_id_started_at_idx" ON "launch_history"("user_id", "profile_id", "started_at");

-- AddForeignKey
ALTER TABLE "launch_history" ADD CONSTRAINT "launch_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "launch_history" ADD CONSTRAINT "launch_history_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "launch_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
