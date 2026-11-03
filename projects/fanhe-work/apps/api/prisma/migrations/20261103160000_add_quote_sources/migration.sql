-- 主类表：让「销售查价系统 / 板式工艺收费 / 诺米百隆五金」从代码常量变成一行数据。
--
-- 三条内置行在这里初始化，而不是靠应用启动时 seed：这张表一旦为空，维护台顶部就会
-- 一个 tab 都不剩，而现有 1225 条产品还挂在这三个 source 上 —— 界面看起来像整库丢了。
-- 应用侧仍有 `ensureSources` 兜底（只在表完全为空时执行），两处冗余是有意的。
--
-- 内置三条的 `builtin = true`。它不影响权限，只影响提示措辞：删除被拒时要能说
-- 「这是内置主类，把产品移走也删不掉」还是「下面还有 N 条产品」。
--
-- **不需要回填别的东西**：`quote_items.source` 早就存着这三个值，`quote_categories`
-- 也是；这张表只是给它们补上显示名、短名与条目号前缀。

-- CreateTable
CREATE TABLE "quote_sources" (
    "id" UUID NOT NULL,
    "code" VARCHAR(16) NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "short" VARCHAR(8) NOT NULL,
    "ledger_prefix" VARCHAR(2) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "builtin" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "quote_sources_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "quote_sources_code_key" ON "quote_sources"("code");

-- CreateIndex
CREATE INDEX "quote_sources_sort_order_idx" ON "quote_sources"("sort_order");

-- Seed：内置三类。名字与 `packages/shared/src/quote.ts` 的 QUOTE_SOURCE_NAMES 逐字一致，
-- 前缀与条目号 `A001 / B001 / C001` 对应。
INSERT INTO "quote_sources" ("id", "code", "name", "short", "ledger_prefix", "sort_order", "builtin", "updated_at")
VALUES
    (gen_random_uuid(), 'sale',     '销售查价系统',   '柜体', 'A', 0, true, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'craft',    '板式工艺收费',   '工艺', 'B', 1, true, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'hardware', '诺米/百隆五金', '五金', 'C', 2, true, CURRENT_TIMESTAMP);
