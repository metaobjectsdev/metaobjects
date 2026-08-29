CREATE TABLE "subscribers" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  "email" VARCHAR(320) NOT NULL,
  "name" TEXT,
  "status" TEXT NOT NULL,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "subscribers_status_chk" CHECK ("status" IN ('active', 'paused', 'cancelled'))
);
