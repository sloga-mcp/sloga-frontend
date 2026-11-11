/**
 * Protected channel hooks (W4 lane B6, plan 4.3 and D27).
 *
 * - `useProtectedShield(channelId)`: READ-ONLY. The design 9.1 shield
 *   from the main bridge's `protectedChannels` map plus the SDK flags. It
 *   sends no request, so chat windows and channel rows may call it freely.
 * - `useProtectedChannelOpen(channel)`: the open/refresh lifecycle (D8).
 *   Mounted ONCE, in `TextChannel.tsx` (lane C17). Chat windows never mount
 *   it (product choice 7); as a second guard it is a no-op outside the main
 *   window context.
 * - `useProtectedMessage(messageId)` / `useProtectedTimeline(channelId)`:
 *   read-only views of the bridge's `protectedViews` and
 *   `protectedTimelineMarkers` maps (D22).
 *
 * Chat windows are same-realm children of the main window
 * (`childWindow.ts`): every component inside them runs in the main realm
 * and reads the same bridge, so they show the same shield and views.
 *
 * The bridge methods are reached through the A1 `ProtectedUiApi` type and a
 * runtime shape check, never through bridge internals: a build whose bridge
 * has no protected surface (web, Electron, Android) reads "not capable"
 * and empty maps, which the shield turns into `not_available`.
 *
 * The decisions are small pure exported functions; the shield itself is
 * A2's `explainShield` + `shieldInputsFromView`, imported, not rewritten.
 * This module imports the client context, so `node --test` cannot load it
 * directly; `useProtectedChannel.test.ts` loads a type-stripped copy (the
 * pure functions) and scans the hook bodies.
 */
import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
} from "solid-js";

import type { Channel, Client } from "stoat.js";

import { useClient } from ".";
import type { E2EEBridge } from "./e2ee";
import { IS_OVERLAY_WINDOW, IS_POPOUT_WINDOW } from "./popout.ts";
import {
  type ShieldExplanation,
  explainShield,
  ROSTER_MISMATCH_UNVERIFIED_MS,
  shieldInputsFromView,
} from "./protectedShield.ts";
import { REFRESH_INTERVAL_MS } from "./protectedTextPolicy.ts";
import type {
  ProtectedChannelView,
  ProtectedMessageView,
  ProtectedUiApi,
  TimelineMarker,
} from "./protectedTextTypes";
import { MAIN_CTX, useWindowCtx } from "./windowCtx.ts";

// ---------------------------------------------------------------------------
// Pure decisions
// ---------------------------------------------------------------------------

/** The shield plus what the pill panel needs from the same read. */
export type ProtectedShield = ShieldExplanation & {
  /** The manager's view; null while loading or with no bridge surface. */
  view: ProtectedChannelView | null;
  serverProtected: boolean;
  locallyPinned: boolean;
  capable: boolean;
};

const UI_METHODS = [
  "protectedTextCapable",
  "protectedOpen",
  "protectedClose",
] as const;

const UI_MAPS = [
  "protectedChannels",
  "protectedViews",
  "protectedTimelineMarkers",
] as const;

/**
 * The bridge's `ProtectedUiApi`, or null when the bridge is absent or has
 * no protected surface. Every method and map must be present.
 */
export function protectedUiOf(bridge: unknown): ProtectedUiApi | null {
  if (typeof bridge !== "object" || bridge === null) return null;
  const b = bridge as Record<string, unknown>;
  for (const m of UI_METHODS) if (typeof b[m] !== "function") return null;
  for (const m of UI_MAPS) {
    const map = b[m] as { get?: unknown } | null | undefined;
    if (typeof map?.get !== "function") return null;
  }
  return bridge as ProtectedUiApi;
}

/**
 * Binding (W4a audit HIGH 1): the server says protected only while the
 * channel object carries `protected: true` AND this session has not seen
 * the server strip it (the SDK's per-session latch).
 */
export function serverProtectedOf(
  isProtected: boolean,
  flagStripped: boolean,
): boolean {
  return isProtected === true && flagStripped !== true;
}

/**
 * D3's notice split, notice only (never the state): a Tauri main window
 * whose bridge is merely off or unprovisioned gets `enable_e2ee`; every
 * other incapable case keeps `not_available`. An unknown status is not
 * "off".
 */
export function tauriE2eeOffOf(i: {
  tauri: boolean;
  bridgePresent: boolean;
  capable: boolean;
  status: { enabled: boolean; published: boolean } | undefined;
}): boolean {
  if (!i.tauri || !i.bridgePresent || i.capable || !i.status) return false;
  return !i.status.enabled || !i.status.published;
}

/**
 * Milliseconds until the shield's age-dependent step 6 changes
 * (`roster_mismatch` turning `unverified`), or null when nothing is timed.
 */
export function shieldRecheckInMs(
  view: ProtectedChannelView | null | undefined,
  nowMs: number,
): number | null {
  const since = view?.rosterMismatchSinceMs ?? null;
  if (since === null || !Number.isFinite(since)) return null;
  const left = since + ROSTER_MISMATCH_UNVERIFIED_MS - nowMs;
  return left > 0 ? left : null;
}

/**
 * Whether this mount runs the D8 open/refresh lifecycle: only in the main
 * window context (chat windows are read-only, D27 / choice 7), only for a
 * server text channel the SDK holds protected or pinned.
 */
export function shouldRunOpenLifecycle(i: {
  windowCtxId: string;
  channelType: string | undefined;
  protectedOrPinned: boolean;
}): boolean {
  return (
    i.windowCtxId === MAIN_CTX.id &&
    !IS_POPOUT_WINDOW &&
    !IS_OVERLAY_WINDOW &&
    i.channelType === "TextChannel" &&
    i.protectedOrPinned === true
  );
}

/**
 * What a raw `GET /channels/:id` body says about `protected`. Only a channel
 * object for THIS id is a full object; anything else proves nothing and
 * must never latch a strip (a failed or foreign read is not a strip).
 */
export function rawProtectedRead(
  channelId: string,
  body: unknown,
): { apply: true; value: unknown } | { apply: false } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { apply: false };
  }
  const b = body as Record<string, unknown>;
  if (b._id !== channelId) return { apply: false };
  return { apply: true, value: b.protected };
}

/**
 * The D8 read: raw `GET /channels/:id`, then ALWAYS
 * `client.applyProtectedFlag(id, raw.protected, true)` for a body that is
 * this channel (one-way `true`, strip latch otherwise). A failed request
 * changes nothing. Never rejects.
 */
export async function readChannelProtectedFlag(
  client: Pick<Client, "api" | "applyProtectedFlag">,
  channelId: string,
): Promise<void> {
  let body: unknown;
  try {
    body = await client.api.get(`/channels/${channelId as ""}`);
  } catch {
    // Network, 403 or 404 (visibility loss, design 7.5): unknown, not a
    // strip. The next 60 s cycle tries again.
    return;
  }
  const read = rawProtectedRead(channelId, body);
  if (!read.apply) {
    console.warn("[protected] channel read ignored", { channelId });
    return;
  }
  client.applyProtectedFlag(channelId, read.value, true);
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

type MaybeAccessor<T> = T | Accessor<T>;

function access<T>(v: MaybeAccessor<T>): T {
  return typeof v === "function" ? (v as Accessor<T>)() : v;
}

function isTauriShell(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as { __TAURI__?: { core?: { invoke?: unknown } } }).__TAURI__
      ?.core?.invoke === "function"
  );
}

/** The bridge's protected surface, tracked through `useE2EE`. */
function useProtectedUi(): Accessor<ProtectedUiApi | null> {
  const client = useClient();
  // Re-read per access so a client switch picks up the new bridge.
  return () => protectedUiOf(client()?.e2ee);
}

/**
 * READ-ONLY design 9.1 shield for a channel (no requests). Null for a
 * channel that is neither server-protected nor pinned.
 */
export function useProtectedShield(
  channelId: MaybeAccessor<string | undefined>,
): Accessor<ProtectedShield | null> {
  const client = useClient();
  const ui = useProtectedUi();
  const tauri = isTauriShell();
  const [now, setNow] = createSignal(Date.now());

  const view = createMemo((): ProtectedChannelView | null => {
    const id = access(channelId);
    if (!id) return null;
    return ui()?.protectedChannels.get(id) ?? null;
  });

  // Re-evaluate exactly when step 6's grace runs out.
  createEffect(() => {
    const wait = shieldRecheckInMs(view(), Date.now());
    if (wait === null) return;
    const timer = setTimeout(() => setNow(Date.now()), wait + 1);
    onCleanup(() => clearTimeout(timer));
  });

  const shield = createMemo((): ProtectedShield | null => {
    const id = access(channelId);
    if (!id) return null;
    const c = client();
    if (!c) return null;

    const serverProtected = serverProtectedOf(
      c.channels.get(id)?.isProtected ?? false,
      c.isProtectedFlagStripped(id),
    );
    const locallyPinned = c.protectedPins.has(id);
    const api = ui();
    const capable = api?.protectedTextCapable() === true;
    const e2ee = c.e2ee as E2EEBridge | undefined;
    const status = e2ee?.status.get("state");
    const v = view();
    const explanation = explainShield(
      shieldInputsFromView(
        v,
        {
          serverProtected,
          locallyPinned,
          capable,
          tauriE2eeOff: tauriE2eeOffOf({
            tauri,
            bridgePresent: !!e2ee,
            capable,
            status,
          }),
        },
        Math.max(now(), Date.now()),
      ),
    );
    if (!explanation) return null;
    return { ...explanation, view: v, serverProtected, locallyPinned, capable };
  });
  return shield;
}

/**
 * The D8 open/refresh lifecycle for the channel shown in the main view:
 * `protectedOpen` (manager refresh + its 60 s loop), the raw channel read
 * now and every 60 s with `applyProtectedFlag` after each, and
 * `protectedClose` on leave. Mount once, in `TextChannel.tsx`; never in a
 * chat window.
 */
export function useProtectedChannelOpen(
  channel: MaybeAccessor<Channel | undefined>,
): void {
  const client = useClient();
  const ui = useProtectedUi();
  const windowCtxId = useWindowCtx().id;

  // A string key, so a pin landing on an already protected channel (or any
  // other tracked change) does not close and reopen the lifecycle.
  const target = createMemo((): string | null => {
    const ch = access(channel);
    const c = client();
    if (!ch || !c) return null;
    const run = shouldRunOpenLifecycle({
      windowCtxId,
      channelType: ch.type,
      protectedOrPinned: c.isProtectedChannel(ch.id),
    });
    return run ? ch.id : null;
  });

  createEffect(
    on(
      target,
      (id) => {
        const c = client();
        if (!id || !c) return;
        let alive = true;
        let inFlight = false;

        const read = () => {
          if (!alive || inFlight) return;
          inFlight = true;
          void readChannelProtectedFlag(c, id).finally(() => {
            inFlight = false;
          });
        };

        const api = ui();
        try {
          api?.protectedOpen(id);
        } catch {
          console.error("[protected] open failed", { channelId: id });
        }
        read();
        const timer = setInterval(read, REFRESH_INTERVAL_MS);

        onCleanup(() => {
          alive = false;
          clearInterval(timer);
          try {
            api?.protectedClose(id);
          } catch {
            console.error("[protected] close failed", { channelId: id });
          }
        });
      },
      { defer: false },
    ),
  );
}

/**
 * READ-ONLY decrypted view (or marker) for a protected message; null when
 * the bridge has none (no bridge surface, or not requested yet).
 */
export function useProtectedMessage(
  messageId: MaybeAccessor<string | undefined>,
): Accessor<ProtectedMessageView | null> {
  const ui = useProtectedUi();
  const view = createMemo(() => {
    const id = access(messageId);
    if (!id) return null;
    return ui()?.protectedViews.get(id) ?? null;
  });
  return view;
}

const NO_MARKERS: readonly TimelineMarker[] = Object.freeze([]);

/** READ-ONLY local timeline markers for a channel (D22). */
export function useProtectedTimeline(
  channelId: MaybeAccessor<string | undefined>,
): Accessor<readonly TimelineMarker[]> {
  const ui = useProtectedUi();
  const markers = createMemo(() => {
    const id = access(channelId);
    if (!id) return NO_MARKERS;
    return ui()?.protectedTimelineMarkers.get(id) ?? NO_MARKERS;
  });
  return markers;
}
