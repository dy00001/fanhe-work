-- 客户双角色归属与公共池归类结果。
--
-- 两条改动都是**只加不删**：既有 58 行客户的 designer_id / sales_id 全部为 NULL，
-- 也就是全部落在公共池。这一步本身不改变任何人的可见范围 —— 行级过滤在代码里
-- 由 `customer.scope.read` 决定，未持有时才收窄。上线顺序见
-- docs/CUSTOMER-DUAL-ROLE-POOL-2026-11-02.md 第五节。

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "designer_id" UUID,
ADD COLUMN     "sales_id" UUID;

-- CreateTable
CREATE TABLE "customer_pool_suggestions" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "role" VARCHAR(20) NOT NULL,
    "suggested_user_id" UUID,
    "confidence" INTEGER NOT NULL DEFAULT 0,
    "sales_score" INTEGER NOT NULL DEFAULT 0,
    "designer_score" INTEGER NOT NULL DEFAULT 0,
    "reasons" JSONB NOT NULL,
    "signals" JSONB,
    "engine" VARCHAR(20) NOT NULL DEFAULT 'rules-v1',
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "review_note" VARCHAR(300),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customer_pool_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_pool_suggestions_customer_id_key" ON "customer_pool_suggestions"("customer_id");

-- CreateIndex
CREATE INDEX "customer_pool_suggestions_status_idx" ON "customer_pool_suggestions"("status");

-- CreateIndex
CREATE INDEX "customer_pool_suggestions_role_idx" ON "customer_pool_suggestions"("role");

-- CreateIndex
CREATE INDEX "customers_designer_id_last_message_at_idx" ON "customers"("designer_id", "last_message_at");

-- CreateIndex
CREATE INDEX "customers_sales_id_last_message_at_idx" ON "customers"("sales_id", "last_message_at");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_designer_id_fkey" FOREIGN KEY ("designer_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_sales_id_fkey" FOREIGN KEY ("sales_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_pool_suggestions" ADD CONSTRAINT "customer_pool_suggestions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_pool_suggestions" ADD CONSTRAINT "customer_pool_suggestions_suggested_user_id_fkey" FOREIGN KEY ("suggested_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_pool_suggestions" ADD CONSTRAINT "customer_pool_suggestions_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
