/**
 * Compare two dotted version strings numerically, segment-by-segment, the
 * way Business Central `.app` versions order (`28.0.46665.50105` etc.).
 *
 * Returns a value < 0 if `a` < `b`, > 0 if `a` > `b`, and `0` if they
 * compare equal. The comparison is stable: padding the shorter version
 * with trailing zeros means `1.0` and `1.0.0` compare equal, and `1.0.1`
 * sorts after `1.0` even though `1.0` has fewer segments.
 *
 * Non-numeric segments (which BC `.app` files don't produce in practice
 * but a corrupted manifest theoretically might) sort lower than any
 * numeric segment, so a malformed version never displaces a real one
 * from "highest" position. Empty strings sort lowest of all.
 */
export function compareVersions(a: string, b: string): number {
  const aParts = parseSegments(a);
  const bParts = parseSegments(b);
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const av = aParts[i] ?? 0;
    const bv = bParts[i] ?? 0;
    if (av < bv) {
      return -1;
    }
    if (av > bv) {
      return 1;
    }
  }
  return 0;
}

function parseSegments(version: string): number[] {
  if (!version) {
    return [-1];
  }
  return version.split('.').map((seg) => {
    const n = parseInt(seg, 10);
    return Number.isNaN(n) ? -1 : n;
  });
}
