import prisma from "../lib/prisma";
import { ValidationError } from "../errors/AppError";

// Phase 2 M2 — canonical product-tag helpers.
//
// Tags are a closed vendor vocabulary (stable string ids like "SPICY"):
// vendors attach/detach existing ACTIVE rows, they never free-type tag
// names and no endpoint here ever creates a Tag row. All associations
// are resolved server-side against the Tag table.

/** Maximum tag ids accepted in one request (write or filter). */
export const MAX_TAG_IDS = 20;

/** Same shape rule as dishType ids: uppercase stable keys only. */
const TAG_ID_SHAPE = /^[A-Z0-9_]+$/;

/**
 * Pure query parser for the `tags` (or legacy singular `tag`) filter:
 * accepts a comma-separated string, an array, or repeated params.
 * Returns undefined when no tag filter was supplied so callers keep
 * their unfiltered behavior. Throws ValidationError on malformed values.
 */
export function parseTagQueryParam(raw: unknown): string[] | undefined {
  if (raw == null) return undefined;
  const parts = (Array.isArray(raw) ? raw : [raw]).flatMap((v) =>
    String(v).split(","),
  );
  const ids: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const normalized = trimmed.toUpperCase();
    if (normalized.length > 40 || !TAG_ID_SHAPE.test(normalized)) {
      throw new ValidationError(
        `Invalid tag filter: "${trimmed.slice(0, 40)}". Use tag ids from GET /product/tags.`,
      );
    }
    ids.push(normalized);
  }
  const unique = [...new Set(ids)];
  if (unique.length > MAX_TAG_IDS) {
    throw new ValidationError(`Too many tags in filter (max ${MAX_TAG_IDS}).`);
  }
  return unique.length > 0 ? unique : undefined;
}

/**
 * Verifies every supplied id exists and is active. Returns the deduped
 * id list. Throws ValidationError naming unknown/inactive ids — the
 * write path and the filter path share this so both reject identically.
 * An empty input resolves to [] (no associations) without a DB call, so
 * update callers can clear all tags with an explicit empty array.
 */
export async function resolveActiveTagIds(tagIds: string[]): Promise<string[]> {
  const unique = [
    ...new Set(tagIds.map((t) => t.trim()).filter((t) => t.length > 0)),
  ];
  if (unique.length === 0) return [];
  const rows = await prisma.tag.findMany({
    where: { id: { in: unique }, isActive: true },
    select: { id: true },
  });
  const found = new Set(rows.map((r) => r.id));
  const invalid = unique.filter((id) => !found.has(id));
  if (invalid.length > 0) {
    throw new ValidationError(
      `Invalid tag(s): ${invalid.join(", ")}. Choose from GET /product/tags.`,
    );
  }
  return unique;
}
