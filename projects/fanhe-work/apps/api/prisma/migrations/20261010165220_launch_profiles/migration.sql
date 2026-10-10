-- CreateTable
CREATE TABLE "launch_profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "software" VARCHAR(32) NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "executable_path" VARCHAR(1024) NOT NULL,
    "args" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "icon" VARCHAR(64),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "launch_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "launch_profiles_user_id_deleted_at_sort_order_idx" ON "launch_profiles"("user_id", "deleted_at", "sort_order");

-- AddForeignKey
ALTER TABLE "launch_profiles" ADD CONSTRAINT "launch_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
