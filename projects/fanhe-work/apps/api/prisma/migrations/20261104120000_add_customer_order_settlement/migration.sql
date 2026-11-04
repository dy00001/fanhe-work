-- 订单结算：把「合同额 / 已收 / 未收」三个笼统数字拆成可对账的五项。
--
-- 背景：原来的 `received_fen` 与 `unpaid_fen` 是同一个人随手填的两个数字，二者与
-- `contract_fen` 之间没有任何约束。实际使用中它们经常互相对不上（收了定金却没改
-- 未收），而界面上看不出该信哪一个。现在改为：
--
--   手填：contract_fen（合同总金额）、deposit_fen（定金）、prepay_fen（预付款）、
--         final_received_fen（已收尾款）、fee_fen（手续费）
--   派生：received_fen（实收 = 定金 + 预付款 + 已收尾款 − 手续费）
--         unpaid_fen  （未收尾款 = 合同 − 定金 − 预付款 − 已收尾款）
--
-- **不回填存量数据。** 迁移前的那一单（ORD-037）按新公式重算结果与库里一致
-- （3780000 − 0 − 0 − 0 = 3780000，实收 0），因此没有需要纠正的偏差；而对无法
-- 拆分的历史数字做推断，只会在库里制造出看起来像事实的猜测。
--
-- 两列派生值仍然落库而不是只在响应里计算：客户级合同额汇总、导出的表格与将来的
-- 财务报表都读列。

-- AlterTable
ALTER TABLE "customer_orders"
    ADD COLUMN "deposit_fen" INTEGER,
    ADD COLUMN "prepay_fen" INTEGER,
    ADD COLUMN "final_received_fen" INTEGER,
    ADD COLUMN "fee_fen" INTEGER;
