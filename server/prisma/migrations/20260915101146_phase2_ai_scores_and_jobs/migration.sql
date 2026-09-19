/*
  Warnings:

  - You are about to drop the column `channel` on the `Notification` table. All the data in the column will be lost.

*/
-- CreateTable
CREATE TABLE "JobRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "result" TEXT NOT NULL DEFAULT '{}',
    "error" TEXT
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_HotItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "author" TEXT,
    "lang" TEXT,
    "publishedAt" DATETIME,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "contentHash" TEXT NOT NULL,
    "heatScore" REAL NOT NULL DEFAULT 0,
    "aiState" TEXT NOT NULL DEFAULT 'pending',
    "authenticity" REAL,
    "aiFlags" TEXT NOT NULL DEFAULT '[]',
    "aiReasoning" TEXT,
    "aiScoredAt" DATETIME,
    "clusterId" TEXT,
    "raw" TEXT,
    CONSTRAINT "HotItem_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "HotItem_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "Cluster" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_HotItem" ("aiState", "author", "clusterId", "contentHash", "externalId", "fetchedAt", "heatScore", "id", "lang", "publishedAt", "raw", "sourceId", "summary", "title", "url") SELECT "aiState", "author", "clusterId", "contentHash", "externalId", "fetchedAt", "heatScore", "id", "lang", "publishedAt", "raw", "sourceId", "summary", "title", "url" FROM "HotItem";
DROP TABLE "HotItem";
ALTER TABLE "new_HotItem" RENAME TO "HotItem";
CREATE INDEX "HotItem_contentHash_idx" ON "HotItem"("contentHash");
CREATE INDEX "HotItem_fetchedAt_idx" ON "HotItem"("fetchedAt");
CREATE INDEX "HotItem_aiState_idx" ON "HotItem"("aiState");
CREATE UNIQUE INDEX "HotItem_sourceId_externalId_key" ON "HotItem"("sourceId", "externalId");
CREATE TABLE "new_Notification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "level" TEXT NOT NULL DEFAULT 'pending',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "channels" TEXT NOT NULL DEFAULT '[]',
    "itemId" TEXT,
    "topicId" TEXT,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "sentAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "error" TEXT
);
INSERT INTO "new_Notification" ("body", "error", "id", "level", "payload", "read", "sentAt", "title") SELECT "body", "error", "id", "level", "payload", "read", "sentAt", "title" FROM "Notification";
DROP TABLE "Notification";
ALTER TABLE "new_Notification" RENAME TO "Notification";
CREATE INDEX "Notification_sentAt_idx" ON "Notification"("sentAt");
CREATE INDEX "Notification_read_idx" ON "Notification"("read");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "JobRun_name_startedAt_idx" ON "JobRun"("name", "startedAt");
