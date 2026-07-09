/*
  Warnings:

  - The values [OPEN] on the enum `ActivityStatus` will be removed. If these variants are still used in the database, this will fail.
  - A unique constraint covering the columns `[code]` on the table `Category` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "ActivityStatus_new" AS ENUM ('PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');
ALTER TABLE "public"."Activity" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Activity" ALTER COLUMN "status" TYPE "ActivityStatus_new" USING ("status"::text::"ActivityStatus_new");
ALTER TYPE "ActivityStatus" RENAME TO "ActivityStatus_old";
ALTER TYPE "ActivityStatus_new" RENAME TO "ActivityStatus";
DROP TYPE "public"."ActivityStatus_old";
ALTER TABLE "Activity" ALTER COLUMN "status" SET DEFAULT 'PLANNED';
COMMIT;

-- AlterTable
ALTER TABLE "Activity" ALTER COLUMN "status" SET DEFAULT 'PLANNED';

-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "code" TEXT;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'USD';

-- CreateIndex
CREATE UNIQUE INDEX "Category_code_key" ON "Category"("code");
