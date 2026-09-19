-- AlterTable
ALTER TABLE "HotItem" ADD COLUMN "domain" TEXT;
ALTER TABLE "HotItem" ADD COLUMN "importance" TEXT;

-- AlterTable
ALTER TABLE "Match" ADD COLUMN "isAbout" BOOLEAN;

-- CreateIndex
CREATE INDEX "HotItem_heatScore_idx" ON "HotItem"("heatScore");

-- CreateIndex
CREATE INDEX "HotItem_importance_idx" ON "HotItem"("importance");

-- CreateIndex
CREATE INDEX "HotItem_publishedAt_idx" ON "HotItem"("publishedAt");
