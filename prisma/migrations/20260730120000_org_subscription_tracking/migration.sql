-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('NONE', 'ACTIVE', 'DISABLED');

-- AlterTable
ALTER TABLE "Organisation"
  ADD COLUMN "paystackSubscriptionCode" TEXT,
  ADD COLUMN "paystackCustomerCode" TEXT,
  ADD COLUMN "subscriptionStatus" "SubscriptionStatus" NOT NULL DEFAULT 'NONE';

-- CreateIndex
CREATE UNIQUE INDEX "Organisation_paystackSubscriptionCode_key" ON "Organisation"("paystackSubscriptionCode");
