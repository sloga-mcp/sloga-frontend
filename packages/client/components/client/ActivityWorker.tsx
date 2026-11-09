import { createEffect, createSignal, onCleanup, onMount } from "solid-js";

import { useState } from "@revolt/state";

import { createActivitySync } from "./activitySync.ts";
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

  /** Sends each change once and retries a failed one with backoff */
  const sync = createActivitySync({
    push(target) {
      // Read at send time: a retry may run long after the change it carries.
      const user = client().user;
      if (!user) return Promise.reject(new Error("no user"));
      return target
        ? user.edit({
            status: { activity: { name: target } },
          } as Parameters<typeof user.edit>[0])
        : // `remove` is a real field on the route but absent from stoat-api's
          // generated edit type, so this needs the two-step widening rather
          // than a direct assertion.
          user.edit({ remove: ["StatusActivity"] } as unknown as Parameters<
            typeof user.edit
          >[0]);
    },
  });
  onCleanup(() => sync.dispose());

  createEffect(() => {
    if (!isDesktop()) return;
    const game = detectedGame();
    const share = state.settings.getValue("activity:share");
    const user = client().user;
    if (!user) return;

    sync.update(share ? game : null, () => !!user.activity);
  });

  return null;
}
