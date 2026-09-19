-- AlterTable
ALTER TABLE "HotItem" ADD COLUMN "importanceRank" INTEGER;

-- CreateIndex
CREATE INDEX "HotItem_importanceRank_idx" ON "HotItem"("importanceRank");
