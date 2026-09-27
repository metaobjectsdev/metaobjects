CREATE TABLE "subscribers" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  "email" VARCHAR(320) NOT NULL,
  "name" TEXT,
  "status" TEXT NOT NULL,
  "created_at" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT "subscribers_status_chk" CHECK ("status" IN ('active', 'paused', 'cancelled'))
);
