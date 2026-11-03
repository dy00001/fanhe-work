-- 分类表：存「顺序」与「空分类」，不复制条目上的分类值。
--
-- 建表之后**不需要回填**：读路径（`listCategories`）会把 `quote_items` 里出现过的
-- 分类自动补进结果，顺序按「表里有记录的按 sort_order，没记录的按名称」。第一次
-- 打开维护台、动一次排序，就会把这些分类落成显式行。

-- CreateTable
CREATE TABLE "quote_categories" (
    "id" UUID NOT NULL,
    "source" VARCHAR(16) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "quote_categories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "quote_categories_source_name_key" ON "quote_categories"("source", "name");

-- CreateIndex
CREATE INDEX "quote_categories_source_sort_order_idx" ON "quote_categories"("source", "sort_order");
