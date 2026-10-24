-- AlterTable
ALTER TABLE "ecom_shops" ADD COLUMN     "owner_id" UUID;

-- CreateIndex
CREATE INDEX "ecom_shops_owner_id_idx" ON "ecom_shops"("owner_id");

-- AddForeignKey
ALTER TABLE "ecom_shops" ADD CONSTRAINT "ecom_shops_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
