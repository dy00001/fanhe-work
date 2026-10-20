-- CreateEnum
CREATE TYPE "ecom_platform" AS ENUM ('taobao', 'tmall');

-- CreateEnum
CREATE TYPE "ecom_collect_source" AS ENUM ('report', 'api');

-- CreateEnum
CREATE TYPE "ecom_collect_status" AS ENUM ('running', 'succeeded', 'partial', 'failed');

-- CreateEnum
CREATE TYPE "ecom_dimension_type" AS ENUM ('item', 'channel', 'area', 'keyword', 'content', 'summary');

-- CreateTable
CREATE TABLE "ecom_shops" (
    "id" UUID NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "platform" "ecom_platform" NOT NULL DEFAULT 'taobao',
    "seller_nick" VARCHAR(80),
    "timezone" VARCHAR(40) NOT NULL DEFAULT 'Asia/Shanghai',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_collected_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ecom_shops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ecom_daily_metrics" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "stat_date" DATE NOT NULL,
    "pay_amount_fen" INTEGER,
    "visitors" INTEGER,
    "pay_buyers" INTEGER,
    "item_visitors" INTEGER,
    "source" "ecom_collect_source" NOT NULL DEFAULT 'report',
    "revised" BOOLEAN NOT NULL DEFAULT false,
    "collected_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ecom_daily_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ecom_dimension_snapshots" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "dim_type" "ecom_dimension_type" NOT NULL,
    "stat_from" DATE NOT NULL,
    "stat_to" DATE NOT NULL,
    "dim_key" VARCHAR(120) NOT NULL,
    "dim_label" VARCHAR(300) NOT NULL,
    "metrics" JSONB NOT NULL,
    "collected_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ecom_dimension_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ecom_collect_runs" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "stat_from" DATE NOT NULL,
    "stat_to" DATE NOT NULL,
    "trigger" VARCHAR(20) NOT NULL,
    "source" "ecom_collect_source" NOT NULL,
    "status" "ecom_collect_status" NOT NULL DEFAULT 'running',
    "daily_rows" INTEGER NOT NULL DEFAULT 0,
    "dimension_rows" INTEGER NOT NULL DEFAULT 0,
    "raw_path" VARCHAR(300),
    "error_message" TEXT,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),
    "duration_ms" INTEGER,

    CONSTRAINT "ecom_collect_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ecom_shops_code_key" ON "ecom_shops"("code");

-- CreateIndex
CREATE INDEX "ecom_daily_metrics_shop_id_stat_date_idx" ON "ecom_daily_metrics"("shop_id", "stat_date");

-- CreateIndex
CREATE UNIQUE INDEX "ecom_daily_metrics_shop_id_stat_date_key" ON "ecom_daily_metrics"("shop_id", "stat_date");

-- CreateIndex
CREATE INDEX "ecom_dimension_snapshots_shop_id_dim_type_stat_from_stat_to_idx" ON "ecom_dimension_snapshots"("shop_id", "dim_type", "stat_from", "stat_to");

-- CreateIndex
CREATE UNIQUE INDEX "ecom_dimension_snapshots_shop_id_dim_type_stat_from_stat_to_key" ON "ecom_dimension_snapshots"("shop_id", "dim_type", "stat_from", "stat_to", "dim_key");

-- CreateIndex
CREATE INDEX "ecom_collect_runs_shop_id_started_at_idx" ON "ecom_collect_runs"("shop_id", "started_at");

-- CreateIndex
CREATE INDEX "ecom_collect_runs_shop_id_stat_to_idx" ON "ecom_collect_runs"("shop_id", "stat_to");

-- AddForeignKey
ALTER TABLE "ecom_daily_metrics" ADD CONSTRAINT "ecom_daily_metrics_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "ecom_shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ecom_dimension_snapshots" ADD CONSTRAINT "ecom_dimension_snapshots_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "ecom_shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ecom_collect_runs" ADD CONSTRAINT "ecom_collect_runs_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "ecom_shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
