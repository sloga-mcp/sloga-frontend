import { onCleanup, onMount } from "solid-js";

import { setDetectedStreamingApp } from "@revolt/state/streamer";

type TauriEventApi = {
  event: {
    listen(
      name: string,
      cb: (event: { payload: string | null }) => void,
    ): Promise<() => void>;
  };
};

/**
 * Receives streaming-app detection events from the desktop app (Tauri) so
 * Streamer Mode can automatically activate while OBS & friends are running.
 * No-op on web and mobile — processes cannot be observed there.
 */
export function StreamerModeWorker() {
  onMount(() => {
    const tauri = (window as { __TAURI__?: TauriEventApi }).__TAURI__;
    if (!tauri?.event) return;

    let unlisten: (() => void) | undefined;
    tauri.event
      .listen("streamer-activity", (event) =>
        setDetectedStreamingApp(event.payload),
      )
      .then((fn) => (unlisten = fn))
      .catch(() => {});

    onCleanup(() => unlisten?.());
  });

  return null;
}
