-- CreateTable
CREATE TABLE "case_uploads" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "item_id" VARCHAR(64) NOT NULL,
    "category_id" VARCHAR(64) NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "thumb_byte_size" INTEGER NOT NULL,
    "mime" VARCHAR(32) NOT NULL,
    "data" BYTEA NOT NULL,
    "thumb" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "case_uploads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "case_uploads_user_id_category_id_deleted_at_created_at_idx" ON "case_uploads"("user_id", "category_id", "deleted_at", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "case_uploads_user_id_item_id_key" ON "case_uploads"("user_id", "item_id");

-- AddForeignKey
ALTER TABLE "case_uploads" ADD CONSTRAINT "case_uploads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
