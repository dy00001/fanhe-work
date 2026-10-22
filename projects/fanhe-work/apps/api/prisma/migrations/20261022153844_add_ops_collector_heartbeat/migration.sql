-- CreateTable
CREATE TABLE "ops_collector_heartbeats" (
    "id" VARCHAR(32) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL,
    "source" VARCHAR(20),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ops_collector_heartbeats_pkey" PRIMARY KEY ("id")
);
