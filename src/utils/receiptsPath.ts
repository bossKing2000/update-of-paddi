/**
 * Single source of truth for WHERE generated receipt PDFs live on disk.
 *
 * WHY THIS EXISTS
 * ---------------
 * `generateReceipt` wrote to `./receipts` (relative to `process.cwd()`) and
 * `getReceipt` read from `process.cwd()/receipts`. Both hardcoded the same
 * cwd-relative segment, so the directory was an implicit writer<->reader
 * contract that nothing declared and nothing could verify.
 *
 * Two consequences:
 *   1. An integration test that finalises a payment writes a real PDF into
 *      the repository working tree. `receipts/` was not git-ignored, so those
 *      runtime artifacts could be staged by accident.
 *   2. Redirecting only the writer would have silently broken the streaming
 *      download, because the reader still looked in the old place.
 *
 * This module makes the location explicit and keeps BOTH sides in agreement.
 *
 * CONTRACT — UNCHANGED
 * --------------------
 *   - The DEFAULT location is exactly what it always was:
 *     `process.cwd()/receipts`. Production behaviour and the on-disk layout
 *     the deployed service already has are untouched. `path.resolve` is used
 *     so the absolute form is identical to what the old relative path
 *     resolved to.
 *   - The PDF MUST outlive the process. `getReceipt` streams it from disk on
 *     demand, arbitrarily long after it was generated, so an OS temporary
 *     directory is NOT a safe default and is not used here. An override is
 *     only ever pointed at a directory the operator controls.
 *   - The PUBLIC URL is unchanged: `${BASE_URL}/receipts/receipt_<ref>.pdf`.
 *     Only the on-disk location is configurable, and only through an explicit
 *     `RECEIPTS_DIR` override, which integration tests set.
 *
 * The `Receipt` row still stores the URL, never a filesystem path, so moving
 * the on-disk directory never invalidates an already-stored receipt.
 */
import fs from "fs";
import path from "path";

/**
 * Environment variable that overrides the on-disk receipts directory.
 * Intended for test runs, which set it to a throwaway directory.
 */
export const RECEIPTS_DIR_ENV = "RECEIPTS_DIR";

/**
 * The directory holding generated receipt PDFs.
 *
 * Defaults to `process.cwd()/receipts` — the historical location — and is
 * only redirected when `RECEIPTS_DIR` is explicitly set.
 */
export function getReceiptsDir(): string {
  const override = process.env[RECEIPTS_DIR_ENV];
  if (override && override.trim()) return path.resolve(override.trim());
  return path.resolve(process.cwd(), "receipts");
}

/**
 * The file name for a payment reference.
 *
 * Shared by the writer and the reader so the two can never drift apart: the
 * reader reconstructs this name from the payment reference, not from the
 * stored `pdfUrl`.
 */
export function getReceiptFileName(reference: string): string {
  return `receipt_${reference}.pdf`;
}

/** Full on-disk path for a payment reference. */
export function getReceiptFilePath(reference: string): string {
  return path.join(getReceiptsDir(), getReceiptFileName(reference));
}

/**
 * Creates the receipts directory when it does not exist and returns it.
 * Called by the writer before streaming the PDF.
 */
export function ensureReceiptsDir(): string {
  const dir = getReceiptsDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
