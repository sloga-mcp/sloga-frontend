/**
 * Synced theme fields that clients from before they existed do not know about
 *
 * Such a client drops them in `clean()` and, on its next edit of any theme
 * field (even light/dark), uploads the whole key without them. And a device
 * that updates after adopting such a copy has only the defaults for them.
 * So each device tracks which of these it actually has a value for
 * (`TypeTheme.knownFields`): set here, or carried by a copy it adopted. It
 * uploads only those, and keeps its own value for any a copy lacks
 * (`Sync.merge`). A default it never had therefore cannot overwrite a choice
 * made on another device.
 *
 * Its own module, without imports, so `Sync.ts` and `Theme.ts` can share it
 * and the Node specs can load it.
 */
export const NEWER_THEME_FIELDS = [
  "style",
  "slogaSurfaceDark",
  "slogaSurfaceLight",
] as const;

export type NewerThemeField = (typeof NEWER_THEME_FIELDS)[number];
