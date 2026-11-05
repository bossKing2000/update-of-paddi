/**
 * Phase 2B.2 — receipt PDF artifact isolation.
 *
 * DATABASE-INDEPENDENT: `src/lib/prisma` is mocked, so no database is
 * contacted and no receipt row is written.
 *
 * These cover the contract that the `receipts/` refactor had to preserve:
 *   - the DEFAULT on-disk location is unchanged (`process.cwd()/receipts`);
 *   - the on-disk location is redirectable, so a test run cannot litter the
 *     repository working tree;
 *   - the PUBLIC URL and the stored `Receipt` row are NOT affected by where
 *     the file lives;
 *   - the writer and the reader resolve the same path.
 */
jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: { findUnique: jest.fn() },
    receipt: { create: jest.fn() },
  },
}));

import fs from "fs";
import os from "os";
import path from "path";

import prisma from "../../src/lib/prisma";
import { generateReceipt } from "../../src/utils/generate Receipt/generateReceipt";
import {
  RECEIPTS_DIR_ENV,
  ensureReceiptsDir,
  getReceiptFileName,
  getReceiptFilePath,
  getReceiptsDir,
} from "../../src/utils/receiptsPath";

const db = prisma as unknown as {
  payment: { findUnique: jest.Mock };
  receipt: { create: jest.Mock };
};

const ORIGINAL_CWD = process.cwd();
let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "foodpaddi-receipts-"));
  delete process.env[RECEIPTS_DIR_ENV];
  db.payment.findUnique.mockReset();
  db.receipt.create.mockReset();
});

afterEach(() => {
  delete process.env[RECEIPTS_DIR_ENV];
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** A minimal Payment row shaped like the one `generateReceipt` reads. */
function paymentRow(reference: string) {
  return {
    id: `pay_${reference}`,
    reference,
    amount: 5500,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    orderId: "ord_1",
    order: { items: [], vendor: { name: "Vendor" } },
    user: { email: "customer@example.com" },
  };
}

describe("receiptsPath — default location is unchanged", () => {
  it("defaults to process.cwd()/receipts when no override is set", () => {
    expect(getReceiptsDir()).toBe(path.resolve(ORIGINAL_CWD, "receipts"));
  });

  it("resolves to the same absolute path the old relative './receipts' resolved to", () => {
    // The historical code wrote to "./receipts" relative to cwd. The new
    // resolver must land on exactly that absolute location.
    expect(getReceiptsDir()).toBe(path.resolve(ORIGINAL_CWD, "./receipts"));
  });

  it("ignores an empty or whitespace override", () => {
    process.env[RECEIPTS_DIR_ENV] = "   ";
    expect(getReceiptsDir()).toBe(path.resolve(ORIGINAL_CWD, "receipts"));
  });

  it("derives the file name from the payment reference", () => {
    expect(getReceiptFileName("REF-1")).toBe("receipt_REF-1.pdf");
  });

  it("joins the file name onto the resolved directory", () => {
    expect(getReceiptFilePath("REF-1")).toBe(
      path.join(path.resolve(ORIGINAL_CWD, "receipts"), "receipt_REF-1.pdf"),
    );
  });
});

describe("receiptsPath — explicit override", () => {
  it("honours RECEIPTS_DIR", () => {
    const dir = path.join(tmpRoot, "artifacts");
    process.env[RECEIPTS_DIR_ENV] = dir;
    expect(getReceiptsDir()).toBe(path.resolve(dir));
    expect(getReceiptFilePath("REF-1")).toBe(path.join(path.resolve(dir), "receipt_REF-1.pdf"));
  });

  it("ensureReceiptsDir creates the directory when missing", () => {
    const dir = path.join(tmpRoot, "created-on-demand");
    process.env[RECEIPTS_DIR_ENV] = dir;
    expect(fs.existsSync(dir)).toBe(false);
    expect(ensureReceiptsDir()).toBe(path.resolve(dir));
    expect(fs.existsSync(dir)).toBe(true);
  });
});

describe("generateReceipt — writes into the configured directory", () => {
  it("writes the PDF into RECEIPTS_DIR, not into the repository", async () => {
    const dir = path.join(tmpRoot, "artifacts");
    process.env[RECEIPTS_DIR_ENV] = dir;
    db.payment.findUnique.mockResolvedValue(paymentRow("REDIR-1"));
    db.receipt.create.mockImplementation(async ({ data }: never) => ({ id: "r1", ...(data as object) }));

    await generateReceipt("pay_REDIR-1");

    const written = path.join(dir, "receipt_REDIR-1.pdf");
    expect(fs.existsSync(written)).toBe(true);
    // Nothing was written into the repository's ./receipts directory.
    const repoCopy = path.resolve(ORIGINAL_CWD, "receipts", "receipt_REDIR-1.pdf");
    expect(fs.existsSync(repoCopy)).toBe(false);
  });

  it("produces a non-empty PDF file", async () => {
    const dir = path.join(tmpRoot, "artifacts");
    process.env[RECEIPTS_DIR_ENV] = dir;
    db.payment.findUnique.mockResolvedValue(paymentRow("VALID-1"));
    db.receipt.create.mockImplementation(async ({ data }: never) => ({ id: "r1", ...(data as object) }));

    await generateReceipt("pay_VALID-1");

    const written = path.join(dir, "receipt_VALID-1.pdf");
    const bytes = fs.readFileSync(written);
    expect(bytes.length).toBeGreaterThan(0);
    // A real PDF starts with the %PDF- magic header.
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("keeps the public URL and the stored Receipt row unchanged by the location", async () => {
    const dir = path.join(tmpRoot, "artifacts");
    process.env[RECEIPTS_DIR_ENV] = dir;
    const baseUrl = process.env.BASE_URL;
    process.env.BASE_URL = "https://example.test";
    db.payment.findUnique.mockResolvedValue(paymentRow("URL-1"));
    db.receipt.create.mockImplementation(async ({ data }: never) => ({ id: "r1", ...(data as object) }));

    try {
      await generateReceipt("pay_URL-1");
    } finally {
      if (baseUrl === undefined) delete process.env.BASE_URL;
      else process.env.BASE_URL = baseUrl;
    }

    // The URL contract is untouched: still BASE_URL + /receipts/<fileName>,
    // and the row still stores that URL (never a filesystem path).
    expect(db.receipt.create).toHaveBeenCalledWith({
      data: { paymentId: "pay_URL-1", pdfUrl: "https://example.test/receipts/receipt_URL-1.pdf" },
    });
  });

  it("leaves no file behind when the payment does not exist", async () => {
    const dir = path.join(tmpRoot, "artifacts");
    process.env[RECEIPTS_DIR_ENV] = dir;
    db.payment.findUnique.mockResolvedValue(null);

    await expect(generateReceipt("pay_missing")).rejects.toThrow("Payment not found");
    // The failure happens before anything is written: the directory is not
    // even created, and in particular no PDF is left behind.
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
  });

  it("with NO override, still writes to <cwd>/receipts — the historical location", async () => {
    // `process.cwd()` is mocked to a temp directory so this proves the
    // default resolution end-to-end without writing into the repository.
    // The font is also resolved from `process.cwd()`, so a copy is placed
    // there for the duration of this test.
    const fontsDir = path.join(tmpRoot, "fonts");
    fs.mkdirSync(fontsDir, { recursive: true });
    fs.copyFileSync(
      path.resolve(ORIGINAL_CWD, "fonts", "DejaVuSans.ttf"),
      path.join(fontsDir, "DejaVuSans.ttf"),
    );

    const cwdSpy = jest.spyOn(process, "cwd").mockReturnValue(tmpRoot);
    try {
      delete process.env[RECEIPTS_DIR_ENV];
      db.payment.findUnique.mockResolvedValue(paymentRow("DEFAULT-1"));
      db.receipt.create.mockImplementation(async ({ data }: never) => ({ id: "r1", ...(data as object) }));

      await generateReceipt("pay_DEFAULT-1");

      expect(fs.existsSync(path.join(tmpRoot, "receipts", "receipt_DEFAULT-1.pdf"))).toBe(true);
      // And the resolver agrees with the writer.
      expect(getReceiptFilePath("DEFAULT-1")).toBe(
        path.join(tmpRoot, "receipts", "receipt_DEFAULT-1.pdf"),
      );
    } finally {
      cwdSpy.mockRestore();
    }
  });
});

describe("artifact isolation between references", () => {
  it("removing one reference's file leaves another reference's file intact", async () => {
    const dir = path.join(tmpRoot, "artifacts");
    process.env[RECEIPTS_DIR_ENV] = dir;
    db.payment.findUnique.mockImplementation(async ({ where }: never) => {
      const id = (where as { id: string }).id;
      return paymentRow(id.replace("pay_", ""));
    });
    db.receipt.create.mockImplementation(async ({ data }: never) => ({ id: "r1", ...(data as object) }));

    await generateReceipt("pay_OWN-A");
    await generateReceipt("pay_OWN-B");

    const a = getReceiptFilePath("OWN-A");
    const b = getReceiptFilePath("OWN-B");
    expect(fs.existsSync(a)).toBe(true);
    expect(fs.existsSync(b)).toBe(true);

    // Cleanup scoped to A only.
    fs.unlinkSync(a);
    expect(fs.existsSync(a)).toBe(false);
    expect(fs.existsSync(b)).toBe(true);
  });

  it("two suites using different directories cannot remove each other's files", () => {
    const dirOne = path.join(tmpRoot, "suite-one");
    const dirTwo = path.join(tmpRoot, "suite-two");

    process.env[RECEIPTS_DIR_ENV] = dirOne;
    ensureReceiptsDir();
    fs.writeFileSync(getReceiptFilePath("S1"), "one");
    const fileOne = getReceiptFilePath("S1");

    process.env[RECEIPTS_DIR_ENV] = dirTwo;
    ensureReceiptsDir();
    fs.writeFileSync(getReceiptFilePath("S2"), "two");
    const fileTwo = getReceiptFilePath("S2");

    // Suite one cleans up its own file only.
    fs.unlinkSync(fileOne);
    expect(fs.existsSync(fileOne)).toBe(false);
    expect(fs.existsSync(fileTwo)).toBe(true);
  });
});
