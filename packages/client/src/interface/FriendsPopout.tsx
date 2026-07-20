import { onMount } from "solid-js";

import { useClientLifecycle } from "@revolt/client";
import { Navigate } from "@revolt/routing";

import { Friends } from "./Friends";

/**
 * Standalone friends list for popout window — no sidebar chrome
 */
export function FriendsPopout() {
  const { isLoggedIn } = useClientLifecycle();

  onMount(() => {
    document.title = "Friends — Sloga";
  });

  if (!isLoggedIn()) {
    return <Navigate href="/login" />;
  }

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        display: "flex",
        "flex-direction": "column",
        overflow: "hidden",
        background: "var(--md-sys-color-surface)",
      }}
    >
      <Friends popout />
    </div>
  );
}
