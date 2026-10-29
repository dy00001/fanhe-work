-- CreateTable
CREATE TABLE "case_folders" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "category_id" VARCHAR(64) NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "case_folders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "case_folders_user_id_category_id_deleted_at_created_at_idx" ON "case_folders"("user_id", "category_id", "deleted_at", "created_at");

-- CreateTable
CREATE TABLE "case_item_placements" (
    "user_id" UUID NOT NULL,
    "item_id" VARCHAR(64) NOT NULL,
    "category_id" VARCHAR(64) NOT NULL,
    "folder_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "case_item_placements_pkey" PRIMARY KEY ("user_id","item_id")
);

-- CreateIndex
CREATE INDEX "case_item_placements_user_id_category_id_idx" ON "case_item_placements"("user_id", "category_id");

-- CreateIndex
CREATE INDEX "case_item_placements_folder_id_idx" ON "case_item_placements"("folder_id");

-- CreateTable
CREATE TABLE "case_library_states" (
    "user_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "case_library_states_pkey" PRIMARY KEY ("user_id")
);

-- AddForeignKey
ALTER TABLE "case_folders" ADD CONSTRAINT "case_folders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_item_placements" ADD CONSTRAINT "case_item_placements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_item_placements" ADD CONSTRAINT "case_item_placements_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "case_folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_library_states" ADD CONSTRAINT "case_library_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
