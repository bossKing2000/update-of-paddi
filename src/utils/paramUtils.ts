// Utility to normalize Express params/query values to a single string
export function ensureString(v: any): string {
  if (v === undefined || v === null) return "";
  return Array.isArray(v) ? v[0] : String(v);
}

export function ensureNumber(v: any): number {
  const s = ensureString(v);
  const n = Number(s);
  return Number.isNaN(n) ? 0 : n;
}
