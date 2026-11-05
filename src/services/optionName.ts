/**
 * Canonical option-name normalization for structured add-ons.
 *
 * The live option-group write path (`optionGroup.service.ts` → `assertUniqueItemName`)
 * compares names with `trim()` + `toLowerCase()`. Phase 2B.2 item matching must
 * use identical semantics, otherwise a rerun could create a duplicate item purely
 * because a name was re-cased or re-spaced between runs.
 *
 * Keeping the rule in one exported function makes the comparison auditable and
 * stops the two paths from drifting apart.
 */
export function normalizeOptionName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * True when two option names refer to the same add-on under
 * `normalizeOptionName`. Used for item identity matching, never for merging.
 */
export function optionNamesMatch(a: string, b: string): boolean {
  return normalizeOptionName(a) === normalizeOptionName(b);
}