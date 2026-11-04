-- 给 quote_items.source 与 quote_categories.source 补外键，指向 quote_sources.code。
--
-- ## 为什么现在补
--
-- 这两个 source 列此前只是字符串，删主类与写条目各走各的路径，于是能留下「主类
-- 已经删掉、条目还在」的孤儿。查价左栏直接从 quote_items 聚合分类，不校验主类，
-- 所以那些分类照常出现在筛选栏；维护台顶部页签只渲染 quote_sources 里的主类，
-- 页签永远匹配不上，改名 / 合并 / 删除三个按钮全部够不到。界面上看起来就是
-- 「这一项改不了、也找不到」，而库里、日志里都没有任何报错。
--
-- 2026-11-04 现场清查出 41 条这种残留（39 条已下架、2 条在售），全部来自集成
-- 测试：产品主键由服务端算成 `<source>-<digest>`，不带 zz_test_ 前缀，旧的 after()
-- 按前缀清不掉；主类行却按名字前缀删掉了。
--
-- ## 为什么先删再建约束
--
-- 外键建在已有孤儿上会直接失败，`migrate deploy` 中止，容器起不来。清理放在同一次
-- 迁移里，顺序就是「先清残留，后落约束」。
--
-- 判定标准只有一条：source 不在主类表里。真实台账的 source 永远在表里，所以这条
-- 不会碰到业务数据。审计记录跟着条目一起清，否则会留下指向已不存在条目的孤儿。

-- 1) 清审计残留（先于条目，避免留下指向已删条目的行）
DELETE FROM "quote_revisions"
WHERE "item_code" IN (
  SELECT i."code"
  FROM "quote_items" i
  LEFT JOIN "quote_sources" s ON s."code" = i."source"
  WHERE s."code" IS NULL
);

-- 2) 清孤儿条目
DELETE FROM "quote_items" i
WHERE NOT EXISTS (
  SELECT 1 FROM "quote_sources" s WHERE s."code" = i."source"
);

-- 3) 清孤儿分类行
DELETE FROM "quote_categories" c
WHERE NOT EXISTS (
  SELECT 1 FROM "quote_sources" s WHERE s."code" = c."source"
);

-- 4) 落约束。
--    ON DELETE RESTRICT：主类下面还有条目 / 分类时，数据库直接拒绝删除。服务层
--    已经先查计数并给 409，这里是第二道；测试与脚本绕过 API 直接删库时就只剩它。
--    ON UPDATE RESTRICT：code 创建后不可改（它拼在每条产品的主键与纸质台账编号
--    里），所以这里也不需要级联改名。
ALTER TABLE "quote_items"
  ADD CONSTRAINT "quote_items_source_fkey"
  FOREIGN KEY ("source") REFERENCES "quote_sources" ("code")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "quote_categories"
  ADD CONSTRAINT "quote_categories_source_fkey"
  FOREIGN KEY ("source") REFERENCES "quote_sources" ("code")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
