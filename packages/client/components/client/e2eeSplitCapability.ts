/**
 * Whether the server accepts a split publication ("make this a separate
 * device", multi-device plan D5). An old server would treat the split's
 * first publication as a fresh device and sweep the shared one, so the
 * client offers the split only when the root config says
 * `features.e2ee.split_from === true`. Anything else, malformed included,
 * is false.
 */
export function parseSplitCapability(body: unknown): boolean {
  const features = field(body, "features");
  const e2ee = field(features, "e2ee");
  return field(e2ee, "split_from") === true;
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return Object.prototype.hasOwnProperty.call(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}
