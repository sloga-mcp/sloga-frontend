import { createEffect, createSignal, on, onCleanup } from "solid-js";

import { Client } from "stoat.js";
import { ProtocolV1 } from "stoat.js/lib/events/v1";

import { useClient, useClientLifecycle } from "@revolt/client";
import { IS_OVERLAY_WINDOW, IS_POPOUT_WINDOW } from "@revolt/client/popout";

import { useState } from ".";
import { ensureAccountOwner } from "./accountReset";

/**
 * How long a local edit waits before it is uploaded (ms)
 */
const SAVE_DELAY_MS = 1_000;

/**
 * Manage synchronisation of settings to-from API
 */
export function SyncWorker() {
  // The friends popout is a lean second client: it hydrates settings from
  // the shared localStorage but must not become a second sync writer (two
  // State instances doing local→remote save would last-writer-win each
  // other) — the main window owns synchronisation.
  // The voice overlay has no client at all (MountContext short-circuits
  // before this ever mounts) — this is defence in depth for the same reason.
  if (IS_POPOUT_WINDOW || IS_OVERLAY_WINDOW) return null;

  const state = useState();
  const client = useClient();
  const { isLoggedIn } = useClientLifecycle();

  // The client of the session whose account the synced stores were checked
  // against; nothing is saved until the current session has been
  const [checked, setChecked] = createSignal<Client>();

  // sync REMOTE->LOCAL settings
  createEffect(
    on(
      () => isLoggedIn(),
      (isLoggedIn) => {
        if (!isLoggedIn) return;

        const current = client();
        let active = true;
        const isCurrent = () => active && client() === current;
        onCleanup(() => {
          active = false;
          setChecked(undefined);
        });

        // The stores may still hold another account's data, so this runs
        // before the first sync and before any sync event. The session's
        // user id is known at sign-in; client.user only arrives with Ready.
        try {
          if (
            !ensureAccountOwner(
              state,
              state.auth.getSession()?.userId ?? current.user?.id,
            )
          ) {
            console.error("[sync] no user id for this session; not syncing");
            return;
          }
        } catch (err) {
          console.error("[sync] failed to reset another account's data", err);
          return;
        }

        setChecked(() => current);
        state.sync.initialSync(current, isCurrent);

        /**
         * Handle incoming events
         * @param event Event
         */
        const handleEvent = (event: ProtocolV1["server"]) => {
          if (event.type === "UserSettingsUpdate" && isCurrent()) {
            state.sync.consumeEvent(event.update);
          }
        };

        // Bound to this session's client: by cleanup, client() may be the next
        current.events.addListener("event", handleEvent);
        onCleanup(() => current.events.removeListener("event", handleEvent));
      },
    ),
  );

  // sync LOCAL->REMOTE settings
  //
  // Held back briefly so a burst of edits goes out as one upload: dragging
  // the accent picker writes the theme on every input event. Edits made while
  // the timer runs join the same upload. Anything that stops the save (sign
  // out, a new session, the queue being forgotten) re-runs this and the
  // cleanup cancels the timer.
  createEffect(
    on(
      [() => state.sync.shouldSync, isLoggedIn, checked],
      ([shouldSync, isLoggedIn, checked]) => {
        if (
          !shouldSync ||
          !isLoggedIn ||
          checked === undefined ||
          checked !== client()
        ) {
          return;
        }

        const timer = setTimeout(() => {
          if (checked === client()) state.sync.save(checked);
        }, SAVE_DELAY_MS);
        onCleanup(() => clearTimeout(timer));
      },
    ),
  );

  return null;
}
