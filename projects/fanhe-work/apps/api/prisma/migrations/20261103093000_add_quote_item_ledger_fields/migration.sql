-- 报价条目补三列：条目号、计价方式、可选花色。
--
-- 这三样在台账里本来就有，只是早期导入时被揉成了两样东西：计价方式拼进 note
-- 前缀（`计价：投影面积｜`），花色被当成 remark 一并拼进 note。结果是详情页该
-- 显示「计价方式」与「可选花色」的两栏是空的，而备注里躺着一串花色。
--
-- 全部带 DEFAULT ''，既有 1225 行不需要回填停机；重跑一次 `pnpm db:quote-import`
-- 就会按台账把值写进来。

-- AlterTable
ALTER TABLE "quote_items"
  ADD COLUMN "ledger_no" VARCHAR(12) NOT NULL DEFAULT '',
  ADD COLUMN "pricing_mode" VARCHAR(40) NOT NULL DEFAULT '',
  ADD COLUMN "materials" VARCHAR(300) NOT NULL DEFAULT '';

-- 列表按条目号排（台账顺序），这条索引覆盖「同一来源按号取一段」。
CREATE INDEX "quote_items_source_ledger_no_idx" ON "quote_items"("source", "ledger_no");
