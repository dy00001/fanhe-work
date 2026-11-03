-- 内置案例图的「已移除」记录。
--
-- 背景：内置图（`apps/web/src/lib/case-catalog.ts` 里随前端分发的 webp）没有可删的行，
-- 删除接口按 `isCaseUploadItemId` 判定，遇到 `cabinet-1` 一律 404。界面上表现为
-- 「选中内置图时删除按钮是灰的、新上传的图却能删」。
--
-- 形状与 `case_item_placements` 对称：主键 (user_id, item_id)，一行 = 这张图从图集里
-- 消失。**不设 deleted_at**：这个状态没有「暂时」的语义，加一列软删时间只会让每个
-- 读路径都多一个判断；要恢复某张图，删掉这一行即可。
--
-- 这张表只影响展示，不动任何字节：内置图的字节在构建产物里，服务端从来没见过它们。

-- CreateTable
CREATE TABLE "case_item_deletions" (
    "user_id" UUID NOT NULL,
    "item_id" VARCHAR(64) NOT NULL,
    "category_id" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "case_item_deletions_pkey" PRIMARY KEY ("user_id","item_id")
);

-- CreateIndex
CREATE INDEX "case_item_deletions_user_id_category_id_idx" ON "case_item_deletions"("user_id", "category_id");

-- AddForeignKey
ALTER TABLE "case_item_deletions" ADD CONSTRAINT "case_item_deletions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
