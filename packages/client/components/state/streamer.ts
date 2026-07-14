import { createSignal } from "solid-js";

import type { Settings } from "./stores/Settings";

/**
 * Name of the streaming application currently detected by the desktop app
 * (e.g. "OBS Studio"), or null when none is running. Only ever set on
 * desktop — web and mobile cannot observe running processes.
 */
export const [detectedStreamingApp, setDetectedStreamingApp] = createSignal<
  string | null
>(null);

/**
 * Whether Streamer Mode is currently active, either because the user turned
 * it on manually or because a streaming app was detected while auto-detect
 * is enabled.
 * @param settings Settings store
 */
export function streamerModeActive(settings: Settings): boolean {
  if (settings.getValue("streamer:enabled")) return true;

  return Boolean(
    settings.getValue("streamer:auto_detect") && detectedStreamingApp(),
  );
}

/**
 * Individual protections that can be applied while Streamer Mode is active.
 */
export type StreamerProtection =
  | "personal"
  | "invites"
  | "notifications"
  | "sounds";

const PROTECTION_KEYS = {
  personal: "streamer:hide_personal",
  invites: "streamer:hide_invites",
  notifications: "streamer:disable_notifications",
  sounds: "streamer:disable_sounds",
} as const;

/**
 * Whether Streamer Mode is active AND the given protection is enabled.
 * @param settings Settings store
 * @param protection Protection to check
 */
export function streamerModeHides(
  settings: Settings,
  protection: StreamerProtection,
): boolean {
  return (
    streamerModeActive(settings) &&
    (settings.getValue(PROTECTION_KEYS[protection]) ?? false)
  );
}
