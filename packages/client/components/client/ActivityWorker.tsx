import { createEffect, createSignal, onCleanup, onMount } from "solid-js";

import { useState } from "@revolt/state";

import { useClient } from "./index";

type TauriEventApi = {
  event: {
    listen(
      name: string,
      cb: (event: { payload: string | null }) => void,
    ): Promise<() => void>;
  };
};

/**
 * Syncs game activity detected by the desktop app (Tauri) to the user's
 * status. No-op on web and mobile.
 */
export function ActivityWorker() {
  const client = useClient();
  const state = useState();

  const [detectedGame, setDetectedGame] = createSignal<string | null>(null);

  /**
   * Whether this client has the desktop game-detection bridge. Only the
   * desktop app may manage activity status — a web tab or the mobile app
   * never receives game events, so letting them "sync" would wipe the
   * activity the desktop just set every time they open.
   */
  const [isDesktop, setIsDesktop] = createSignal(false);

  onMount(() => {
    const tauri = (window as { __TAURI__?: TauriEventApi }).__TAURI__;
    if (!tauri?.event) return;

    setIsDesktop(true);

    let unlisten: (() => void) | undefined;
    tauri.event
      .listen("game-activity", (event) => setDetectedGame(event.payload))
      .then((fn) => (unlisten = fn))
      .catch(() => {});

    onCleanup(() => unlisten?.());
  });

  /** Last activity name we pushed to the server, to avoid redundant PATCHes */
  let synced: string | null | undefined;

  createEffect(() => {
    if (!isDesktop()) return;
    const game = detectedGame();
    const share = state.settings.getValue("activity:share");
    const user = client().user;
    if (!user) return;

    const target = share ? game : null;
    if (target === synced) return;
    if (synced === undefined && target === null && !user.activity) {
      // nothing to clear on first run
      synced = null;
      return;
    }

    synced = target;
    (target
      ? user.edit({
          status: { activity: { name: target } },
        } as Parameters<typeof user.edit>[0])
      : user.edit({ remove: ["StatusActivity"] } as Parameters<
          typeof user.edit
        >[0])
    ).catch(() => {
      // retry on next change
      synced = undefined;
    });
  });

  return null;
}
