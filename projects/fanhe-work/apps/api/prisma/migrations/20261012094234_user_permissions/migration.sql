-- 账号与权限管理：部门字段 + 账号级权限覆盖表

-- AlterTable：所属部门。纯展示用途，不参与授权判断，允许为空。
ALTER TABLE "users" ADD COLUMN "department" VARCHAR(64);

-- CreateTable：账号级权限覆盖。
-- granted 是布尔而非「存在即授予」，因为必须能写下行表达显式拒绝：
-- 只做额外授予的话，收回某个权限就只能改角色，而改角色会影响所有同角色的人。
CREATE TABLE "user_permissions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,
    "granted" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_permissions_permission_id_idx" ON "user_permissions"("permission_id");

-- CreateIndex：复合唯一。缺了它，「勾上再取消」会插出第二行，
-- 而哪一行生效取决于查询顺序，表现为取消勾选后有时还生效、有时不生效。
CREATE UNIQUE INDEX "user_permissions_user_id_permission_id_key" ON "user_permissions"("user_id", "permission_id");

-- AddForeignKey
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;