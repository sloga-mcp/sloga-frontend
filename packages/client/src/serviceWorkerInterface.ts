import { createSignal } from "solid-js";

import { registerSW } from "virtual:pwa-register";

const [pendingUpdate, setPendingUpdate] = createSignal<() => void>();

export { pendingUpdate };

// Sloga Desktop (bundled Tauri shell, slice 6.2b; Electron shell, EL1.2 —
// audit F6): never register the service worker. The signed
// installer/updater is the sole version authority there — a SW would add
// a second, stale-prone cache layer over installer-shipped assets, and
// desktop notifications/updates don't use web push. (The Electron shell
// additionally refuses SW registration at the scheme level; this clause
// makes the frontend not even try.)
if (
  import.meta.env.PROD &&
  !("__TAURI__" in window) &&
  !("slogaShell" in window)
) {
  const updateSW = registerSW({
    onNeedRefresh() {
      setPendingUpdate(() => void updateSW(true));
    },
    onOfflineReady() {
      console.info("Ready to work offline =)");
      // toast to users
    },
    onRegistered(r) {
      // registration = r;

      // Check for updates every hour
      setInterval(() => r!.update(), 36e5);
    },
  });
}
