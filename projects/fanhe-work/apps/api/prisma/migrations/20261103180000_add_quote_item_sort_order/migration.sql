-- 产品的人工顺序。维护台里拖动产品排出来的先后。
--
-- **默认 0 + 不回调数据**：加这一列之前，列表是按条目号排的；全部老行都是 0 时，
-- 排序键退化成 `(sort_order, ledger_no, code)`，第二键仍然是条目号 —— 也就是说
-- 顺序与加列之前逐行一致。只有真被拖过的行才会拿到 1、2、3…，所以这个功能对没动过
-- 的库没有任何可见影响。
--
-- **不拿 `ledger_no` 当顺序**：条目号印在报价单上，也被拿去跟纸质台账对号。拖动一次
-- 就重编一遍编号，等于每次调顺序都改一遍全部条目的对外编号。

-- AlterTable
ALTER TABLE "quote_items" ADD COLUMN "sort_order" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "quote_items_source_sort_order_idx" ON "quote_items"("source", "sort_order");
