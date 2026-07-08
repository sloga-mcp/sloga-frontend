/**
 * Camera virtual-background catalogue.
 *
 * Two kinds of background:
 *  - **presets** (`preset:<name>`) — generated at runtime as gradient/solid
 *    images and returned as stable `data:` URLs (no object-URL lifecycle).
 *  - **uploads** (`upload:<uuid>`) — user-provided images stored as Blobs in a
 *    dedicated localforage instance, surfaced as `blob:` object URLs that the
 *    caller MUST revoke (see {@link resolveBackgroundUrl}).
 *
 * Consumed by the settings preview, the in-call camera modal, and the RTC
 * `Voice` state when applying `@livekit/track-processors` virtual backgrounds.
 */
import localforage from "localforage";

export type CameraBackgroundKind = "preset" | "upload";

export interface CameraBackgroundItem {
  /** Stable id: `preset:<name>` or `upload:<uuid>`. Persisted in the Voice store. */
  id: string;
  /** Human label for the gallery (already localized-neutral). */
  name: string;
  kind: CameraBackgroundKind;
}

/** A resolved background source plus a revoke handle for its URL. */
export interface ResolvedBackground {
  url: string;
  /** Releases the URL. No-op for presets (data URLs); revokes object URLs for uploads. */
  revoke: () => void;
}

const UPLOAD_PREFIX = "upload:";
const PRESET_PREFIX = "preset:";
const INDEX_KEY = "__index__";

/** Dedicated store so blobs never collide with the session/auth keys. */
const store = localforage.createInstance({
  name: "sloga",
  storeName: "camera_backgrounds",
});

/** Preset definitions — rendered to gradient/solid data URLs on demand. */
interface PresetDef {
  name: string;
  /** CSS-ish gradient stops; single entry ⇒ solid colour. */
  stops: string[];
  angleDeg?: number;
}

const PRESET_DEFS: Record<string, PresetDef> = {
  slate: { name: "Slate", stops: ["#1b2733", "#0d141c"], angleDeg: 135 },
  ocean: { name: "Ocean", stops: ["#1f6feb", "#0a2540"], angleDeg: 160 },
  sunset: { name: "Sunset", stops: ["#ff8a3d", "#d7385e"], angleDeg: 120 },
  forest: { name: "Forest", stops: ["#2f9e5f", "#0f3d2e"], angleDeg: 145 },
  studio: { name: "Studio", stops: ["#5a5f66", "#2a2d31"], angleDeg: 180 },
};

const presetDataUrlCache = new Map<string, string>();

/**
 * Render a preset to a 1280x720 data URL (cached). Returns null if a 2D
 * context is unavailable (never expected in a browser/webview).
 */
function renderPreset(name: string): string | null {
  const cached = presetDataUrlCache.get(name);
  if (cached) return cached;

  const def = PRESET_DEFS[name];
  if (!def) return null;

  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  if (def.stops.length === 1) {
    ctx.fillStyle = def.stops[0];
  } else {
    const angle = ((def.angleDeg ?? 135) * Math.PI) / 180;
    const x = Math.cos(angle);
    const y = Math.sin(angle);
    const grad = ctx.createLinearGradient(
      canvas.width / 2 - (x * canvas.width) / 2,
      canvas.height / 2 - (y * canvas.height) / 2,
      canvas.width / 2 + (x * canvas.width) / 2,
      canvas.height / 2 + (y * canvas.height) / 2,
    );
    const step = 1 / (def.stops.length - 1);
    def.stops.forEach((c, i) => grad.addColorStop(i * step, c));
    ctx.fillStyle = grad;
  }
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const url = canvas.toDataURL("image/jpeg", 0.9);
  presetDataUrlCache.set(name, url);
  return url;
}

/** All built-in preset items. */
export function listPresets(): CameraBackgroundItem[] {
  return Object.entries(PRESET_DEFS).map(([key, def]) => ({
    id: `${PRESET_PREFIX}${key}`,
    name: def.name,
    kind: "preset" as const,
  }));
}

async function readIndex(): Promise<CameraBackgroundItem[]> {
  const idx = await store.getItem<CameraBackgroundItem[]>(INDEX_KEY);
  return Array.isArray(idx) ? idx : [];
}

async function writeIndex(items: CameraBackgroundItem[]): Promise<void> {
  await store.setItem(INDEX_KEY, items);
}

/** Uploaded (user) background items. */
export async function listUploads(): Promise<CameraBackgroundItem[]> {
  return readIndex();
}

/** Presets + uploads, presets first. */
export async function listBackgrounds(): Promise<CameraBackgroundItem[]> {
  const uploads = await listUploads();
  return [...listPresets(), ...uploads];
}

/**
 * Store a user image as a new upload background.
 * @param blob image data (any browser-decodable image type)
 * @param name optional label
 */
export async function addUpload(
  blob: Blob,
  name?: string,
): Promise<CameraBackgroundItem> {
  const id = `${UPLOAD_PREFIX}${crypto.randomUUID()}`;
  const item: CameraBackgroundItem = {
    id,
    name: name?.trim() || "Custom",
    kind: "upload",
  };
  await store.setItem(id, blob);
  const idx = await readIndex();
  await writeIndex([...idx, item]);
  return item;
}

/** Delete an uploaded background (no-op for presets / unknown ids). */
export async function removeUpload(id: string): Promise<void> {
  if (!id.startsWith(UPLOAD_PREFIX)) return;
  await store.removeItem(id);
  const idx = await readIndex();
  await writeIndex(idx.filter((i) => i.id !== id));
}

/** Whether an id currently resolves to a real background. */
export async function backgroundExists(id: string): Promise<boolean> {
  if (id.startsWith(PRESET_PREFIX)) {
    return PRESET_DEFS[id.slice(PRESET_PREFIX.length)] !== undefined;
  }
  if (id.startsWith(UPLOAD_PREFIX)) {
    return (await store.getItem(id)) != null;
  }
  return false;
}

/**
 * Resolve an id to a usable image URL for `imagePath`, plus a `revoke` handle.
 * Returns null when the id no longer resolves (deleted upload / bad preset) so
 * callers can fall back to "none". ALWAYS call `revoke()` when done / on change.
 */
export async function resolveBackgroundUrl(
  id: string,
): Promise<ResolvedBackground | null> {
  if (id.startsWith(PRESET_PREFIX)) {
    const url = renderPreset(id.slice(PRESET_PREFIX.length));
    return url ? { url, revoke: () => {} } : null;
  }
  if (id.startsWith(UPLOAD_PREFIX)) {
    const blob = await store.getItem<Blob>(id);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    return { url, revoke: () => URL.revokeObjectURL(url) };
  }
  return null;
}
