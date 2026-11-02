-- CreateTable
CREATE TABLE "quote_datasets" (
    "id" UUID NOT NULL,
    "version" VARCHAR(32) NOT NULL,
    "item_count" INTEGER NOT NULL,
    "image_count" INTEGER NOT NULL,
    "added_count" INTEGER NOT NULL DEFAULT 0,
    "changed_count" INTEGER NOT NULL DEFAULT 0,
    "archived_count" INTEGER NOT NULL DEFAULT 0,
    "source_note" VARCHAR(300) NOT NULL DEFAULT '',
    "imported_by" UUID,
    "imported_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quote_datasets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "quote_datasets_version_key" ON "quote_datasets"("version");

-- CreateIndex
CREATE INDEX "quote_datasets_imported_at_idx" ON "quote_datasets"("imported_at");

-- CreateTable
CREATE TABLE "quote_items" (
    "code" VARCHAR(64) NOT NULL,
    "source" VARCHAR(16) NOT NULL,
    "category" VARCHAR(80) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "model" VARCHAR(120) NOT NULL DEFAULT '',
    "spec" VARCHAR(160) NOT NULL DEFAULT '',
    "unit" VARCHAR(24) NOT NULL DEFAULT '',
    "unit_raw" VARCHAR(24) NOT NULL DEFAULT '',
    "price_kind" VARCHAR(16) NOT NULL,
    "price_fen" INTEGER,
    "price_text" VARCHAR(200) NOT NULL DEFAULT '',
    "note" VARCHAR(400) NOT NULL DEFAULT '',
    "status" VARCHAR(16) NOT NULL DEFAULT 'active',
    "image_key" VARCHAR(64),
    "dataset_version" VARCHAR(32) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "quote_items_pkey" PRIMARY KEY ("code")
);

-- CreateIndex
CREATE INDEX "quote_items_source_category_idx" ON "quote_items"("source", "category");

-- CreateIndex
CREATE INDEX "quote_items_status_source_idx" ON "quote_items"("status", "source");

-- CreateIndex
CREATE INDEX "quote_items_image_key_idx" ON "quote_items"("image_key");

-- CreateTable
CREATE TABLE "quote_item_images" (
    "id" UUID NOT NULL,
    "image_key" VARCHAR(64) NOT NULL,
    "data" BYTEA NOT NULL,
    "thumb" BYTEA NOT NULL,
    "mime" VARCHAR(32) NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "thumb_width" INTEGER NOT NULL,
    "thumb_height" INTEGER NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "bind_type" VARCHAR(16) NOT NULL,
    "source_row" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "replaced_by" UUID,
    "uploaded_by" UUID,
    "uploaded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quote_item_images_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quote_item_images_image_key_is_active_idx" ON "quote_item_images"("image_key", "is_active");

-- CreateTable
CREATE TABLE "quote_access_secrets" (
    "id" UUID NOT NULL,
    "hash" VARCHAR(255) NOT NULL,
    "algo" VARCHAR(16) NOT NULL DEFAULT 'argon2id',
    "version" INTEGER NOT NULL DEFAULT 1,
    "fail_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "quote_access_secrets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_unlock_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "secret_version" INTEGER NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "ip" VARCHAR(45),

    CONSTRAINT "quote_unlock_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "quote_unlock_sessions_token_hash_key" ON "quote_unlock_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "quote_unlock_sessions_user_id_expires_at_idx" ON "quote_unlock_sessions"("user_id", "expires_at");

-- CreateTable
CREATE TABLE "quote_revisions" (
    "id" UUID NOT NULL,
    "item_code" VARCHAR(64) NOT NULL,
    "field" VARCHAR(16) NOT NULL,
    "old_value" VARCHAR(400),
    "new_value" VARCHAR(400),
    "operator_id" UUID NOT NULL,
    "unlock_session_id" UUID,
    "reason" VARCHAR(200),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quote_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quote_revisions_item_code_created_at_idx" ON "quote_revisions"("item_code", "created_at");

-- CreateIndex
CREATE INDEX "quote_revisions_created_at_idx" ON "quote_revisions"("created_at");
