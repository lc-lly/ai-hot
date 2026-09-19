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
    "heatScore" REAL,
    "domain" TEXT,
    "importance" TEXT,
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
INSERT INTO "new_HotItem" ("aiFlags", "aiReasoning", "aiScoredAt", "aiState", "authenticity", "author", "clusterId", "contentHash", "domain", "externalId", "fetchedAt", "heatScore", "id", "importance", "lang", "publishedAt", "raw", "sourceId", "summary", "title", "url") SELECT "aiFlags", "aiReasoning", "aiScoredAt", "aiState", "authenticity", "author", "clusterId", "contentHash", "domain", "externalId", "fetchedAt", "heatScore", "id", "importance", "lang", "publishedAt", "raw", "sourceId", "summary", "title", "url" FROM "HotItem";
DROP TABLE "HotItem";
ALTER TABLE "new_HotItem" RENAME TO "HotItem";
CREATE INDEX "HotItem_contentHash_idx" ON "HotItem"("contentHash");
CREATE INDEX "HotItem_fetchedAt_idx" ON "HotItem"("fetchedAt");
CREATE INDEX "HotItem_aiState_idx" ON "HotItem"("aiState");
CREATE INDEX "HotItem_heatScore_idx" ON "HotItem"("heatScore");
CREATE INDEX "HotItem_importance_idx" ON "HotItem"("importance");
CREATE INDEX "HotItem_publishedAt_idx" ON "HotItem"("publishedAt");
CREATE UNIQUE INDEX "HotItem_sourceId_externalId_key" ON "HotItem"("sourceId", "externalId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
