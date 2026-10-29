-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "chatroom" VARCHAR(80) NOT NULL,
    "display_name" VARCHAR(80) NOT NULL,
    "short_name" VARCHAR(60) NOT NULL,
    "region" VARCHAR(40) NOT NULL,
    "region_scope" VARCHAR(20) NOT NULL,
    "real_name" VARCHAR(60),
    "phone" VARCHAR(30),
    "name_source" VARCHAR(40),
    "primary_nickname" VARCHAR(80),
    "confidence" VARCHAR(10) NOT NULL DEFAULT 'low',
    "review_status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "stage" VARCHAR(20) NOT NULL DEFAULT 'consulting',
    "stage_source" VARCHAR(20) NOT NULL DEFAULT 'ai_stage',
    "group_file" VARCHAR(200),
    "msg_rows" INTEGER NOT NULL DEFAULT 0,
    "first_message_at" TIMESTAMPTZ(3),
    "last_message_at" TIMESTAMPTZ(3),
    "skip_img" INTEGER NOT NULL DEFAULT 0,
    "skip_voice" INTEGER NOT NULL DEFAULT 0,
    "repeat_of_id" UUID,
    "contract_total_fen" INTEGER,
    "legacy_blocks" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_orders" (
    "id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "customer_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 1,
    "is_repeat" BOOLEAN NOT NULL DEFAULT false,
    "stage" VARCHAR(20) NOT NULL DEFAULT 'consulting',
    "stage_source" VARCHAR(20) NOT NULL DEFAULT 'ai_stage',
    "contract_fen" INTEGER,
    "received_fen" INTEGER,
    "unpaid_fen" INTEGER,
    "amount_source" VARCHAR(30),
    "amount_confidence" VARCHAR(10),
    "amount_evidence_date" DATE,
    "amount_evidence_note" VARCHAR(300),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customer_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_order_steps" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "idx" INTEGER NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "reached" BOOLEAN NOT NULL DEFAULT false,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "started_at" DATE,
    "finished_at" DATE,
    "date_imprecise" BOOLEAN NOT NULL DEFAULT false,
    "note" VARCHAR(300),

    CONSTRAINT "customer_order_steps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customers_chatroom_key" ON "customers"("chatroom");

-- CreateIndex
CREATE INDEX "customers_region_idx" ON "customers"("region");

-- CreateIndex
CREATE INDEX "customers_region_scope_idx" ON "customers"("region_scope");

-- CreateIndex
CREATE INDEX "customers_stage_idx" ON "customers"("stage");

-- CreateIndex
CREATE INDEX "customers_review_status_idx" ON "customers"("review_status");

-- CreateIndex
CREATE INDEX "customers_repeat_of_id_idx" ON "customers"("repeat_of_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_orders_code_key" ON "customer_orders"("code");

-- CreateIndex
CREATE INDEX "customer_orders_stage_idx" ON "customer_orders"("stage");

-- CreateIndex
CREATE UNIQUE INDEX "customer_orders_customer_id_seq_key" ON "customer_orders"("customer_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "customer_order_steps_order_id_idx_key" ON "customer_order_steps"("order_id", "idx");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_repeat_of_id_fkey" FOREIGN KEY ("repeat_of_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_orders" ADD CONSTRAINT "customer_orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_order_steps" ADD CONSTRAINT "customer_order_steps_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "customer_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
