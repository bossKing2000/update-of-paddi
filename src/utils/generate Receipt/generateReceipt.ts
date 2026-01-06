import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import prisma from "../../lib/prisma";

/**
 * 🧾 generateReceipt(paymentId)
 * -------------------------------------------------------------
 * Generates a premium, orange-white hybrid business-class receipt
 * for Food Paddi payments. Supports full Unicode (₦ symbol, etc.)
 * using the DejaVu Sans font.
 * -------------------------------------------------------------
 */
export async function generateReceipt(paymentId: string) {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: {
      order: {
        include: {
          items: { include: { product: true } },
          vendor: true,
        },
      }, 
      user: true,
    },
  });

  if (!payment) throw new Error("Payment not found");

  const receiptsDir = "./receipts";
  if (!fs.existsSync(receiptsDir)) fs.mkdirSync(receiptsDir, { recursive: true });

  const fileName = `receipt_${payment.reference}.pdf`;
  const filePath = path.join(receiptsDir, fileName);
  const baseUrl = process.env.BASE_URL || "https://food-paddi-backend.onrender.com";
  const pdfUrl = `${baseUrl}/receipts/${fileName}`;

  const doc = new PDFDocument({ margin: 50 });
  const writeStream = fs.createWriteStream(filePath);
  doc.pipe(writeStream);

  const fontPath = path.join(process.cwd(), "fonts", "DejaVuSans.ttf");
  if (!fs.existsSync(fontPath)) {
    throw new Error(
      "Missing font file: fonts/DejaVuSans.ttf — please add it for ₦ symbol support."
    );
  }

  doc.registerFont("DejaVu", fontPath);
  doc.font("DejaVu");

  const ORANGE = "#FF7A00";
  const LIGHT_GRAY = "#F9F9F9";
  const DARK_GRAY = "#333333";
  const MUTED = "#777777";

  // ============================================================
  // 🧠 HEADER
  // ============================================================
  doc.rect(0, 0, doc.page.width, 100).fill(ORANGE);
  doc
    .fillColor("white")
    .fontSize(28)
    .text("Food Paddi", 50, 35, { lineBreak: false })
    .fontSize(13)
    .text("Official Invoice Receipt", 50, 70);

  // ============================================================
  // 📄 CONTENT CARD
  // ============================================================
  const cardY = 120;
  const cardMargin = 30;
  const cardWidth = doc.page.width - cardMargin * 2;

  doc
    .save()
    .fillColor("#EAEAEA")
    .rect(cardMargin + 5, cardY + 5, cardWidth - 10, doc.page.height - 180)
    .fill()
    .restore();

  doc.rect(cardMargin, cardY, cardWidth, doc.page.height - 180).fill("white");
  doc.translate(0, 20);

  // ============================================================
  // 💳 PAYMENT INFO TABLE
  // ============================================================
  doc.fillColor(DARK_GRAY).fontSize(16).text("Payment Details", 50, cardY + 20);
  doc.moveDown(1);

  const infoPairs: [string, string | number | null | undefined][] = [
    ["Payment Reference", payment.reference],
    ["Order ID", payment.orderId],
    ["Customer", payment.user?.email || "Unknown"],
    ["Vendor", payment.order?.vendor?.name || "Vendor"],
    ["Amount Paid", `₦${payment.amount.toLocaleString()}`],
    ["Date", new Date(payment.createdAt).toLocaleString()],
  ];

  const tableTop = doc.y + 10;
  const startX = 50;
  const labelWidth = 150;
  const valueWidth = 350;
  const rowHeight = 25;
  const extraSpace = 10; // space between rows

  // Table Header Line
  doc
    .strokeColor(ORANGE)
    .moveTo(startX, tableTop - 5)
    .lineTo(startX + labelWidth + valueWidth, tableTop - 5)
    .stroke();

  infoPairs.forEach(([label, value], i) => {
    const y = tableTop + i * (rowHeight + extraSpace);

    // Background alternate rows
    if (i % 2 === 0) {
      doc.save().fillColor(LIGHT_GRAY).rect(startX, y - 3, labelWidth + valueWidth, rowHeight).fill();
      doc.restore();
    }

    // Label
    doc
      .fontSize(11)
      .fillColor(DARK_GRAY)
      .text(`${label}:`, startX + 10, y, {
        width: labelWidth - 20,
        align: "left",
      });

    // Value
    doc
      .fontSize(11)
      .fillColor("#444")
      .text(String(value ?? ""), startX + labelWidth + 10, y, {
        width: valueWidth - 20,
        align: "left",
      });

    // Divider line
    doc
      .strokeColor("#EAEAEA")
      .moveTo(startX, y + rowHeight)
      .lineTo(startX + labelWidth + valueWidth, y + rowHeight)
      .stroke();
  });

  doc.moveDown(4);

  // ============================================================
  // 🛍️ ORDER SUMMARY
  // ============================================================
  const summaryHeaderY = doc.y;
  doc
    .rect(45, summaryHeaderY, doc.page.width - 90, 25)
    .fill(LIGHT_GRAY)
    .strokeColor("#EAEAEA")
    .stroke();

  doc.fillColor(DARK_GRAY).fontSize(13).text("Order Summary", 55, summaryHeaderY + 7);
  doc.moveDown(2);

  if (payment.order?.items?.length) {
    payment.order.items.forEach((item, i) => {
      const productName = item.product?.name || "Unnamed Product";
      const subtotal = item.unitPrice * item.quantity;

      doc.fillColor(DARK_GRAY).fontSize(11);
      doc.text(`${i + 1}. ${productName}`, 50);
      doc.text(`x${item.quantity}`, 300, doc.y - 14);
      doc.text(`₦${subtotal.toLocaleString()}`, 480, doc.y - 14, { align: "right" });

      // if (item.specialRequest) {
      //   doc.fillColor(MUTED).fontSize(10).text(`• ${item.specialRequest}`, 70);
      // }

      doc.strokeColor("#EAEAEA").moveTo(50, doc.y + 2).lineTo(550, doc.y + 2).stroke();
      doc.moveDown(0.8);
    });
  } else {
    doc.fillColor("#555").text("No items in this order.");
  }

  // ============================================================
  // 💰 TOTAL
  // ============================================================
  doc.moveDown(1.5);
  doc.strokeColor(ORANGE).moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown(0.8);

  doc.fontSize(13).fillColor(ORANGE).text("Total Paid:", 50);
  doc.fillColor(DARK_GRAY).fontSize(13).text(`₦${payment.amount.toLocaleString()}`, { align: "right" });

  // ============================================================
  // 🧡 FOOTER
  // ============================================================
  doc.moveDown(3);
  doc.fontSize(11).fillColor("#555").text("Thank you for your purchase!", { align: "center" });
  doc.fillColor(ORANGE).text("— Food Paddi Team —", { align: "center" });
  doc.fillColor("#999").fontSize(10).text("support@foodpaddi.com | www.foodpaddi.com", { align: "center" });

  // ============================================================
  // ✅ FINALIZE
  // ============================================================
  doc.end();

  await new Promise<void>((resolve, reject) => {
    writeStream.on("finish", resolve);
    writeStream.on("error", reject);
  });

  const receipt = await prisma.receipt.create({
    data: { paymentId, pdfUrl },
  });

  return receipt;
}
