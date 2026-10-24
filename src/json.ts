// JSON has no 64-bit integer type, and JSON.stringify throws on a bigint.
// We send every bigint (paise amounts, ids) as a string: "50000", never 50000.0.
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v));
}
