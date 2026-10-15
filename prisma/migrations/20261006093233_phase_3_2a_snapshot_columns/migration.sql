-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "commissionKobo" BIGINT,
ADD COLUMN     "discountKobo" BIGINT,
ADD COLUMN     "vendorPayoutKobo" BIGINT;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "productName" TEXT;

-- AlterTable
ALTER TABLE "RefundRequest" ADD COLUMN     "orderId" TEXT;

-- AddForeignKey
ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
