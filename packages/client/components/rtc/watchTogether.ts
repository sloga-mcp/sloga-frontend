/**
 * Watch-together store (plan §2) — a sub-object of the Voice state, beside
 * `remoteControl`, because the player must outlive every component: the
 * call card unmounts the moment the user browses to a text channel, and
 * the player element must never be detached (a detached iframe loses its
 * browsing context and reloads; a detached <video> is paused by spec).
 *
 * Owns:
 * - the session as last received over the WS (`WatchSessionUpdate`, full
 *   state, applied iff `seq` advances for the same session id);
 * - the ONE player host `<div>` that `VoiceCallCard.tsx` mounts as a direct
 *   child of its persistent `<Float>` (never inside a card) and positions
 *   over whatever rect the overlay reserves (`setAnchor`);
 * - the current provider (YouTube in slice 1) and its element;
 * - the clock offset (server − local) from the HTTP round trips;
 * - the sync loop: viewers run the pure `reconcile()` every 500 ms; the
 *   host heartbeats its REAL position every 5 s and PATCHes on every
 *   observed provider state change, keeping ONE request in flight.
 *
 * Sloga relays control state only. The media is fetched by each viewer from
 * the provider on their own machine — nothing here touches a Sloga server
 * except the tiny session JSON.
 */
import { createSignal, type Accessor, type Setter } from "solid-js";

import type { Channel, WatchMediaData, WatchResult, WatchSessionData } from "stoat.js";

import { CONFIGURATION } from "@revolt/common";

import { JellyfinApi } from "@revolt/ui/components/features/voice/watch/providers/jellyfin/api";
import {
  JellyfinProvider,
  loadHls,
} from "@revolt/ui/components/features/voice/watch/providers/jellyfin/jellyfinProvider";
import { describeTranscode } from "@revolt/ui/components/features/voice/watch/providers/jellyfin/jellyfinWire";
import {
  getQuality,
  getServer,
  listServers,
  touchServer,
} from "@revolt/ui/components/features/voice/watch/providers/jellyfin/servers";
import { registerServers } from "@revolt/ui/components/features/voice/watch/providers/jellyfin/transport";
import type { Provider, ProviderStatus } from "@revolt/ui/components/features/voice/watch/providers/provider";
import { YouTubeProvider } from "@revolt/ui/components/features/voice/watch/providers/youtubeProvider";
import {
  expectedPosition,
  INITIAL_SYNC_STATE,
  RATE_NORMAL,
  reconcile,
  type SyncAction,
  type SyncState,
} from "@revolt/ui/components/features/voice/watch/syncController";
import {
  hostUnreachable,
  hostWriteIsNoop,
  isHostTransition,
  needsTapToStart,
  pauseIsEnvironmental,
  pausedScrubTracker,
  pausedScrubWrite,
  shouldResumeSuspendedHost,
  type PausedScrubTracker,
} from "@revolt/ui/components/features/voice/watch/watchPolicy";

/** Viewer corrector tick. */
const TICK_MS = 500;
/** Host heartbeat: real position + playing, even when nothing changed. */
const HEARTBEAT_MS = 5000;
/** Host scrub coalescing: at most one PATCH per this window while seeking. */
const SCRUB_DEBOUNCE_MS = 250;
/** Host-unreachable re-check cadence. */
const UNREACHABLE_CHECK_MS = 5000;
/** Jellyfin playstate progress report (plan §5.5: every 10 s). */
const JELLYFIN_PROGRESS_MS = 10000;
/** Jellyfin transcode-state poll for the stats overlay (plan §7.1). */
const JELLYFIN_TRANSCODE_MS = 10000;

const LS_VOLUME = "sloga:watch:volume";
const LS_MUTED = "sloga:watch:muted";

/** A neutral provider status for surfacing an error before/without a player. */
const EMPTY_STATUS: ProviderStatus = {
  state: "idle",
  currentTimeMs: null,
  durationMs: null,
  ratePermille: RATE_NORMAL,
  error: null,
  title: null,
  muted: false,
  volume: 100,
};

export interface WatchStats {
  driftMs: number | null;
  expectedMs: number;
  currentMs: number | null;
  offsetMs: number;
  seq: number;
  heartbeatAgeMs: number | null;
  providerState: string;
  nudgeRate: number;
  /** PATCHes actually sent in the last 60 s (host; 0 for viewers) — the
   * §7.2c write-rate check, on the stats line where the leg can see it. */
  writesLastMin: number;
}

export interface WatchContext {
  /** The connected call's channel (undefined when not in a call). */
  channel: Accessor<Channel | undefined>;
  /** `voice.state() === "CONNECTED"`. */
  connected: Accessor<boolean>;
  /** This user's id (for host detection). */
  localUserId: Accessor<string | undefined>;
}

export class WatchTogether {
  /** Current session for THE CALL WE ARE IN, or undefined. */
  readonly session: Accessor<WatchSessionData | undefined>;
  #setSession: Setter<WatchSessionData | undefined>;
  /** Live provider status (state/title/error/duration…), for the UI. */
  readonly providerStatus: Accessor<ProviderStatus | undefined>;
  #setProviderStatus: Setter<ProviderStatus | undefined>;
  /** Last API error id shown in the overlay (cleared on next success). */
  readonly error: Accessor<string | undefined>;
  #setError: Setter<string | undefined>;
  /** Autoplay was blocked for this viewer → show "Tap to start". */
  readonly needsTap: Accessor<boolean>;
  #setNeedsTap: Setter<boolean>;
  /** No update for >60 s while the session says playing (plan §1). */
  readonly hostUnreachable: Accessor<boolean>;
  #setHostUnreachable: Setter<boolean>;
  /** The paste-URL picker is open (no session yet). */
  readonly pickerOpen: Accessor<boolean>;
  readonly setPickerOpen: Setter<boolean>;
  /** Per-viewer volume / mute (localStorage, never synced). */
  readonly volume: Accessor<number>;
  #setVolume: Setter<number>;
  readonly muted: Accessor<boolean>;
  #setMuted: Setter<boolean>;
  /** Debug line for the live leg (plan §9). */
  readonly stats: Accessor<WatchStats | undefined>;
  #setStats: Setter<WatchStats | undefined>;
  /** A request is in flight (buttons disable). */
  readonly busy: Accessor<boolean>;
  #setBusy: Setter<boolean>;
  /**
   * A Jellyfin session names a server this viewer hasn't signed into. Holds
   * the display info for the overlay's "Sign in to {server} to watch"
   * button; NOTHING is fetched from the server until the viewer clicks (plan
   * §5.1 — a session broadcast is another user's data).
   */
  readonly needsJellyfinSignin: Accessor<
    { serverUrl: string; serverId: string; itemName: string } | undefined
  >;
  #setNeedsJellyfinSignin: Setter<
    { serverUrl: string; serverId: string; itemName: string } | undefined
  >;
  /** Server-side transcode note for the stats overlay (plan §7.1). */
  readonly serverTranscode: Accessor<string | undefined>;
  #setServerTranscode: Setter<string | undefined>;

  /**
   * The ONE player host. Mounted by `VoiceCallCard.tsx` inside `<Float>`
   * (pointer-events re-enabled — Float itself is `pointer-events: none`),
   * hidden until an overlay anchors it somewhere.
   */
  readonly host: HTMLDivElement;

  #ctx: WatchContext | undefined;
  #provider: Provider | undefined;
  #providerUnsub: (() => void) | undefined;
  #providerKey: string | undefined;
  #syncState: SyncState = INITIAL_SYNC_STATE;
  #offsetMs = 0;
  #offsetRtt = Number.POSITIVE_INFINITY;
  #lastUpdateLocalMs: number | null = null;
  #lastSeqBySession = new Map<string, number>();
  #endedSessions = new Set<string>();
  /**
   * Host: the last OPINIONATED provider state (playing / paused / ended).
   * buffering / cued / unstarted are "no opinion" for the host too — a
   * heartbeat landing mid-buffer must not write `playing:false` and pause
   * the whole call (plan §3, applied to the host's writes).
   */
  #hostOpinion: "playing" | "paused" | "ended" | null = null;
  #lastProviderState: string | undefined;
  #tick: ReturnType<typeof setInterval> | undefined;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #unreachableTimer: ReturnType<typeof setInterval> | undefined;
  #playAskedAt: number | null = null;
  #anchor: HTMLElement | undefined;
  #anchorObserver: ResizeObserver | undefined;
  #anchorPoll: ReturnType<typeof setInterval> | undefined;
  /** Host write coalescing: one in flight, latest intent queued. */
  #inFlight: Promise<void> | undefined;
  #queued: { playing?: boolean; positionMs?: number; ratePermille?: number; media?: WatchMediaData } | undefined;
  #scrubTimer: ReturnType<typeof setTimeout> | undefined;
  /** Paused-scrub stability across ticks (§7.2c write-rate governor). */
  #scrubTrack: PausedScrubTracker = pausedScrubTracker();
  /** Local send times of the last minute's PATCHes, for the stats line. */
  #writeSentAt: number[] = [];
  #nudgeRate = RATE_NORMAL;
  /** Jellyfin: the per-server client + the current PlaybackInfo choice, so
   * playstate can be reported and the transcode freed on teardown (§5.5). */
  #jellyfinApi: JellyfinApi | undefined;
  #jellyfinPlay:
    | { playSessionId: string; mediaSourceId: string; itemId: string }
    | undefined;
  #jellyfinProgressTimer: ReturnType<typeof setInterval> | undefined;
  #jellyfinTranscodeTimer: ReturnType<typeof setInterval> | undefined;
  /** Fires Stopped + ActiveEncodings-delete (keepalive) if the tab closes
   * mid-play, so the server doesn't keep transcoding for a gone viewer. */
  #jellyfinPagehide: (() => void) | undefined;
  /** Guards against two concurrent async Jellyfin provider builds for the
   * same session (a re-entrant onUpdate while PlaybackInfo is in flight). */
  #jellyfinStarting: string | undefined;
  /** The browser paused OUR (host) player in a hidden tab — not host
   * intent. While set, the session keeps playing, heartbeats extrapolate
   * the position from the session timeline, and the tick rejoins it once
   * the tab is shown (plan §7.2c finding 1). */
  #hostSuspended = false;
  /** Session id we last claimed the `watching` roster flag for (§7.3 4b). */
  #watchingClaimedFor: string | undefined;

  constructor() {
    [this.session, this.#setSession] = createSignal<WatchSessionData | undefined>();
    [this.providerStatus, this.#setProviderStatus] = createSignal<ProviderStatus | undefined>();
    [this.error, this.#setError] = createSignal<string | undefined>();
    [this.needsTap, this.#setNeedsTap] = createSignal(false);
    [this.hostUnreachable, this.#setHostUnreachable] = createSignal(false);
    [this.pickerOpen, this.setPickerOpen] = createSignal(false);
    [this.stats, this.#setStats] = createSignal<WatchStats | undefined>();
    [this.busy, this.#setBusy] = createSignal(false);
    [this.needsJellyfinSignin, this.#setNeedsJellyfinSignin] = createSignal<
      { serverUrl: string; serverId: string; itemName: string } | undefined
    >();
    [this.serverTranscode, this.#setServerTranscode] = createSignal<string | undefined>();
    [this.volume, this.#setVolume] = createSignal(readVolume());
    [this.muted, this.#setMuted] = createSignal(readMuted());

    const host = document.createElement("div");
    host.className = "sloga-watch-host";
    // z-index 3: the docked card's `Base` is an absolute sibling at z2 in
    // the same Float stacking context — at z1 the iframe would paint UNDER
    // the card (audio only). The overlay hides the anchor while a BLOCKING
    // card banner is up, since at z3 we would also paint over that.
    host.style.cssText =
      "position:absolute;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:auto;overflow:hidden;border-radius:8px;background:#000;z-index:3";
    this.host = host;

    // Repopulate the native shell's forwarding table on boot: the shell's
    // state outlives a webview reload, so whatever the last page pushed
    // (including a mid-connect probe entry) would otherwise linger until
    // the next change (§7.2b item 6). No-op on web.
    void registerServers(listServers());
  }

  /** Wire the Voice state's accessors (once, from the Voice constructor). */
  setContext(ctx: WatchContext) {
    this.#ctx = ctx;
  }

  /** Are WE the host of the current session? */
  isHost(): boolean {
    const s = this.session();
    const me = this.#ctx?.localUserId();
    return !!s && !!me && s.host_id === me;
  }

  /** Where the overlay wants the player: the host follows this element's rect. */
  setAnchor(el: HTMLElement | undefined) {
    this.#anchor = el;
    this.#anchorObserver?.disconnect();
    this.#anchorObserver = undefined;
    if (this.#anchorPoll) clearInterval(this.#anchorPoll);
    this.#anchorPoll = undefined;
    if (!el) {
      // Parked: keep playing (audio continues), just invisible and zero-size.
      this.host.style.visibility = "hidden";
      this.host.style.width = "0px";
      this.host.style.height = "0px";
      return;
    }
    const follow = () => this.#followAnchor();
    this.#anchorObserver = new ResizeObserver(follow);
    this.#anchorObserver.observe(el);
    // Docking/PiP transitions move the Float without resizing the slot —
    // a cheap poll covers transforms the observer cannot see.
    this.#anchorPoll = setInterval(follow, 300);
    follow();
  }

  #followAnchor() {
    const el = this.#anchor;
    const parent = this.host.parentElement;
    if (!el || !parent) return;
    const a = el.getBoundingClientRect();
    const p = parent.getBoundingClientRect();
    if (a.width < 2 || a.height < 2) {
      this.host.style.visibility = "hidden";
      return;
    }
    this.host.style.left = `${a.left - p.left}px`;
    this.host.style.top = `${a.top - p.top}px`;
    this.host.style.width = `${a.width}px`;
    this.host.style.height = `${a.height}px`;
    this.host.style.visibility = "visible";
  }

  // ---- WS events (called from state.tsx, already scoped to our call) -----

  onUpdate(detail: { channelId: string; session: WatchSessionData }) {
    // THE flag gate for receivers (plan: one flag darkens the lot). A lit
    // client starting a session must not make dark clients spawn a hidden
    // autoplaying iframe they have no UI to stop.
    if (!CONFIGURATION.ENABLE_WATCH_TOGETHER) return;
    const s = detail.session;
    // A reordered update for a session we already saw END (delta's PATCH fan
    // and voice-ingress' leave fan are two processes with no ordering) must
    // not resurrect it.
    if (this.#endedSessions.has(s.id)) return;
    const last = this.#lastSeqBySession.get(s.id) ?? -1;
    if (s.seq <= last) return; // stale / reordered
    // New session id: forget older counters (bounded memory).
    if (!this.#lastSeqBySession.has(s.id)) this.#lastSeqBySession.clear();
    this.#lastSeqBySession.set(s.id, s.seq);
    this.#lastUpdateLocalMs = Date.now();
    this.#setHostUnreachable(false);
    this.#setError(undefined);
    // Handoff (§7.3 4a): the same session under a new host. Reset BEFORE
    // the session lands so a promoted viewer's first heartbeat and a
    // demoted host's next tick both see clean state.
    if (isHostTransition({ prevId: this.session()?.id, prevHostId: this.session()?.host_id, nextId: s.id, nextHostId: s.host_id })) {
      this.#onHostTransition(s);
    }
    this.#setSession(s);
    this.setPickerOpen(false);
    this.#ensureProvider(s);
    this.#ensureLoops();
    // Roster hint (§7.3 4b): tell the channel we have this session attached.
    // Best-effort — an undeployed backend 404s and nothing depends on it.
    if (this.#watchingClaimedFor !== s.id) {
      this.#watchingClaimedFor = s.id;
      this.#claimWatching(true);
    }
  }

  /**
   * The host-only residue that must not survive a handoff (§7.3 rev 2):
   * without the rate reset, a viewer promoted mid-correction keeps its
   * nudged rate (±10 %) as the new ground truth and every heartbeat writes
   * that fast clock — the whole call then chases an accelerating timeline.
   * The provider itself is deliberately NOT re-keyed (an iframe rebuild
   * reloads the video and its ad break).
   */
  #onHostTransition(s: WatchSessionData) {
    this.#hostOpinion = null;
    this.#lastProviderState = undefined;
    this.#scrubTrack = pausedScrubTracker();
    this.#syncState = INITIAL_SYNC_STATE;
    this.#writeSentAt = [];
    this.#queued = undefined;
    if (this.#scrubTimer) clearTimeout(this.#scrubTimer);
    this.#scrubTimer = undefined;
    this.#nudgeRate = RATE_NORMAL;
    this.#provider?.setRate(s.rate_permille);
    // Tap-to-start is viewer machinery the host tick never evaluates or
    // clears — a stale prompt would sit over the new host's controls.
    this.#playAskedAt = null;
    this.#setNeedsTap(false);
    // A stale environment-pause latch gates the opinion path (it is not
    // host-scoped) and would misbehave on a later re-promotion.
    this.#hostSuspended = false;
  }

  onEnd(detail: { channelId: string; id: string }) {
    this.#endedSessions.add(detail.id);
    const current = this.session();
    if (current && current.id !== detail.id) this.#endedSessions.add(current.id);
    // Bounded: only the last few ids matter for reordering.
    if (this.#endedSessions.size > 16) {
      const first = this.#endedSessions.values().next().value;
      if (first) this.#endedSessions.delete(first);
    }
    this.#clearSession();
  }

  // ---- call lifecycle (from state.tsx) ----------------------------------

  /** On CONNECTED (and on bonfire `ready` / reconnect): learn the session. */
  async attach() {
    if (!CONFIGURATION.ENABLE_WATCH_TOGETHER) return;
    if (!this.#ctx?.channel()) return;
    await this.refetch(true);
  }

  /** On leaving CONNECTED: host ends its session; player disposed. */
  detach() {
    const wasHost = this.isHost();
    const ch = this.#ctx?.channel();
    if (wasHost && ch) void ch.endWatch();
    this.#clearSession();
    this.setPickerOpen(false);
  }

  /**
   * GET the session. A 404 clears a session we thought existed. On
   * `NotInVoiceChannel` retry once (LiveKit `connected` can race ingress
   * writing `vc_members`).
   */
  async refetch(retry = false) {
    const ch = this.#ctx?.channel();
    if (!ch) return;
    const r = await ch.fetchWatch();
    if (r.ok) {
      this.#noteClock(r);
      this.onUpdate({ channelId: ch.id, session: r.body.session });
      return;
    }
    if (r.status === 404) {
      this.#clearSession();
      return;
    }
    if (retry && r.error === "NotInVoiceChannel") {
      setTimeout(() => void this.refetch(false), 1000);
    }
  }

  // ---- host / starter actions -------------------------------------------

  async start(media: WatchMediaData): Promise<boolean> {
    const ch = this.#ctx?.channel();
    if (!ch) return false;
    this.#setBusy(true);
    this.#setError(undefined);
    try {
      const r = await ch.startWatch(media);
      if (!r.ok) {
        this.#setError(r.error);
        return false;
      }
      this.#noteClock(r);
      this.onUpdate({ channelId: ch.id, session: r.body.session });
      return true;
    } finally {
      this.#setBusy(false);
    }
  }

  /**
   * Host or manager: hand the session to another call participant (§7.3
   * 4a). The result's `NotInVoiceChannel` refers to the TARGET (they left
   * between the menu opening and the click) — a plain refusal, never the
   * self-join retry-once rule.
   */
  async handoff(userId: string): Promise<boolean> {
    const ch = this.#ctx?.channel();
    if (!ch) return false;
    this.#setBusy(true);
    try {
      const r = await ch.watchHost(userId);
      if (!r.ok) {
        this.#setError(r.error);
        return false;
      }
      this.#noteClock(r);
      this.onUpdate({ channelId: ch.id, session: r.body.session });
      return true;
    } finally {
      this.#setBusy(false);
    }
  }

  async end(): Promise<void> {
    const ch = this.#ctx?.channel();
    if (!ch) return;
    this.#setBusy(true);
    try {
      const r = await ch.endWatch();
      if (!r.ok) this.#setError(r.error);
      else this.#clearSession();
    } finally {
      this.#setBusy(false);
    }
  }

  /** Host: play/pause/seek/rate — local player first, then the write. */
  hostPlay() {
    this.#provider?.play();
    this.#queueWrite({ playing: true });
  }
  hostPause() {
    this.#provider?.pause();
    this.#queueWrite({ playing: false });
  }
  hostSeek(ms: number) {
    this.#provider?.seek(ms);
    this.#queueWrite({ positionMs: ms }, /* scrub */ true);
  }
  hostSetRate(permille: number) {
    this.#provider?.setRate(permille);
    this.#queueWrite({ ratePermille: permille });
  }
  /** Host: swap the video without ending the session. */
  hostSwap(media: WatchMediaData) {
    this.#queueWrite({ media, positionMs: 0, playing: false });
  }

  // ---- viewer-local --------------------------------------------------------

  setVolume(v: number) {
    const vol = Math.max(0, Math.min(100, Math.round(v)));
    this.#setVolume(vol);
    try {
      localStorage.setItem(LS_VOLUME, String(vol));
    } catch {
      /* private mode */
    }
    this.#provider?.setVolume(vol);
  }
  setMuted(m: boolean) {
    this.#setMuted(m);
    try {
      localStorage.setItem(LS_MUTED, m ? "1" : "0");
    } catch {
      /* private mode */
    }
    this.#provider?.setMuted(m);
  }
  /** "Tap to start" — issue play from the user's gesture. */
  tapToStart() {
    this.#setNeedsTap(false);
    this.#playAskedAt = Date.now();
    this.#provider?.play();
  }

  /** The provider's element, for tests / debugging. */
  providerElement(): HTMLElement | undefined {
    return this.#provider?.element;
  }

  // ---- internals -------------------------------------------------------------

  /** Best-effort roster claim (§7.3 4b): failures are invisible on purpose
   * — an undeployed backend 404s, a leave races NotInVoiceChannel, and the
   * hint is advisory either way. */
  #claimWatching(value: boolean) {
    const ch = this.#ctx?.channel();
    if (!ch) return;
    void ch.setWatching(value).catch(() => undefined);
  }

  #noteClock(r: Extract<WatchResult, { ok: true }>) {
    if (!r.body) return;
    const rtt = r.receivedAt - r.sentAt;
    // Min-RTT sample wins: the tightest round trip has the least asymmetry.
    if (rtt <= this.#offsetRtt || !Number.isFinite(this.#offsetRtt)) {
      this.#offsetRtt = rtt;
      this.#offsetMs = r.body.server_now - (r.sentAt + rtt / 2);
    }
  }

  #serverNow(): number {
    return Date.now() + this.#offsetMs;
  }

  #clearSession() {
    if (this.#watchingClaimedFor) {
      this.#watchingClaimedFor = undefined;
      // Best-effort: session end already cleared the flag server-side; a
      // leave clears it with the voice state. Idempotent either way.
      this.#claimWatching(false);
    }
    this.#setSession(undefined);
    this.#setNeedsTap(false);
    this.#setHostUnreachable(false);
    this.#setNeedsJellyfinSignin(undefined);
    this.#setStats(undefined);
    this.#lastUpdateLocalMs = null;
    this.#disposeProvider();
    this.#stopLoops();
    this.#queued = undefined;
    if (this.#scrubTimer) clearTimeout(this.#scrubTimer);
    this.#scrubTimer = undefined;
  }

  #ensureProvider(s: WatchSessionData) {
    const key = providerKey(s.media);
    if (this.#provider && this.#providerKey === key) return;
    this.#disposeProvider();
    this.#providerKey = key;
    this.#syncState = INITIAL_SYNC_STATE;
    this.#nudgeRate = RATE_NORMAL;
    this.#hostOpinion = null;
    this.#lastProviderState = undefined;
    this.#scrubTrack = pausedScrubTracker();
    if (s.media.provider === "youtube") {
      const p = new YouTubeProvider({
        videoId: s.media.video_id,
        // The host gets YouTube's own bar as a control surface; viewers
        // don't, so scrubbing it can't desync them (plan §4.1).
        controls: this.isHost(),
        // A paused session must not blip audio at 0 before the corrector
        // pauses it; the corrector issues play() when the host plays.
        autoplay: s.playing,
        volume: this.volume(),
        muted: this.muted(),
      });
      this.#provider = p;
      this.host.appendChild(p.element);
      this.#providerUnsub = p.onChange((st) => this.#onProviderChange(st));
      this.#setProviderStatus(p.status());
      this.#playAskedAt = s.playing ? Date.now() : null;
    } else {
      // Jellyfin (slice 2): async — needs a PlaybackInfo round trip, and
      // only if the viewer has signed into this server (plan §5.1).
      this.#provider = undefined;
      this.#setProviderStatus(undefined);
      void this.#startJellyfin(s, key);
    }
  }

  /**
   * Build the Jellyfin provider for the current session, IF this viewer has
   * saved the server. Nothing is fetched until here — reached only from
   * `#ensureProvider` (a session we chose to join) or the "Sign in" button,
   * never from a raw broadcast (plan §5.1).
   */
  async #startJellyfin(s: WatchSessionData, key: string) {
    if (s.media.provider !== "jellyfin") return;
    if (this.#jellyfinStarting === key) return;
    const server = getServer(s.media.server_id);
    if (!server) {
      // Known server not saved: show the sign-in affordance; contact nothing.
      this.#setNeedsJellyfinSignin({
        serverUrl: s.media.server_url,
        serverId: s.media.server_id,
        itemName: s.media.item_name,
      });
      return;
    }
    this.#setNeedsJellyfinSignin(undefined);
    this.#jellyfinStarting = key;
    try {
      // Make sure the shell's forwarder knows our saved servers before any
      // fetch goes through the `jf` scheme.
      await registerServers(listServers());
      const api = new JellyfinApi(server);
      // hls.js loads as its own chunk in parallel with PlaybackInfo — it
      // never bloats the main bundle (flag-dark path stays weightless).
      const [Hls, choice] = await Promise.all([
        loadHls(),
        api.playbackInfo(s.media.item_id, getQuality()),
      ]);
      // The session may have moved on (ended / swapped) while we awaited.
      if (this.#providerKey !== key || this.session()?.id !== s.id) {
        await api.stopTranscode(choice.playSessionId).catch(() => undefined);
        return;
      }
      const p = new JellyfinProvider({
        Hls,
        hlsUrl: api.hlsUrl(choice.transcodingUrl),
        runtimeMs: choice.runtimeMs || s.media.runtime_ms,
        autoplay: s.playing,
        volume: this.volume(),
        muted: this.muted(),
        onFatal: (detail) => this.#setProviderStatus({ ...(this.#provider?.status() ?? EMPTY_STATUS), state: "error", error: detail }),
      });
      this.#provider = p;
      this.#jellyfinApi = api;
      this.#jellyfinPlay = {
        playSessionId: choice.playSessionId,
        mediaSourceId: choice.mediaSourceId,
        itemId: s.media.item_id,
      };
      this.host.appendChild(p.element);
      this.#providerUnsub = p.onChange((st) => this.#onProviderChange(st));
      this.#setProviderStatus(p.status());
      this.#playAskedAt = s.playing ? Date.now() : null;
      touchServer(server.id);
      // Playstate: tell the server we started, then report progress on a
      // timer, and poll our own transcode state for the stats overlay.
      void api.reportPlaying({
        itemId: s.media.item_id,
        playSessionId: choice.playSessionId,
        mediaSourceId: choice.mediaSourceId,
        positionMs: 0,
        paused: !s.playing,
      });
      this.#startJellyfinTimers();
    } catch (e) {
      if (this.#providerKey === key) {
        this.#setProviderStatus({
          ...EMPTY_STATUS,
          state: "error",
          error: e instanceof Error ? e.message : "Jellyfin error",
        });
      }
    } finally {
      if (this.#jellyfinStarting === key) this.#jellyfinStarting = undefined;
    }
  }

  #startJellyfinTimers() {
    if (!this.#jellyfinPagehide) {
      const handler = () => {
        const api = this.#jellyfinApi;
        const play = this.#jellyfinPlay;
        if (!api || !play) return;
        const posMs = this.#provider?.status().currentTimeMs ?? 0;
        void api.reportStopped({
          itemId: play.itemId,
          playSessionId: play.playSessionId,
          mediaSourceId: play.mediaSourceId,
          positionMs: posMs,
        });
        void api.stopTranscode(play.playSessionId);
      };
      window.addEventListener("pagehide", handler);
      this.#jellyfinPagehide = () => window.removeEventListener("pagehide", handler);
    }
    if (!this.#jellyfinProgressTimer) {
      this.#jellyfinProgressTimer = setInterval(() => this.#reportJellyfinProgress(), JELLYFIN_PROGRESS_MS);
    }
    if (!this.#jellyfinTranscodeTimer) {
      const poll = async () => {
        const api = this.#jellyfinApi;
        if (!api) return;
        const t = await api.transcodeState();
        this.#setServerTranscode(describeTranscode(t) ?? undefined);
      };
      void poll();
      this.#jellyfinTranscodeTimer = setInterval(() => void poll(), JELLYFIN_TRANSCODE_MS);
    }
  }

  #reportJellyfinProgress() {
    const api = this.#jellyfinApi;
    const play = this.#jellyfinPlay;
    const p = this.#provider;
    if (!api || !play || !p) return;
    const st = p.status();
    void api.reportProgress({
      itemId: play.itemId,
      playSessionId: play.playSessionId,
      mediaSourceId: play.mediaSourceId,
      positionMs: st.currentTimeMs ?? 0,
      paused: st.state !== "playing",
    });
  }

  /** Stop the server's transcode + playstate for a departing Jellyfin
   * viewer (plan §5.5 — or ffmpeg keeps running on their machine). */
  #teardownJellyfin() {
    if (this.#jellyfinProgressTimer) clearInterval(this.#jellyfinProgressTimer);
    if (this.#jellyfinTranscodeTimer) clearInterval(this.#jellyfinTranscodeTimer);
    this.#jellyfinPagehide?.();
    this.#jellyfinPagehide = undefined;
    this.#jellyfinProgressTimer = undefined;
    this.#jellyfinTranscodeTimer = undefined;
    const api = this.#jellyfinApi;
    const play = this.#jellyfinPlay;
    if (api && play) {
      const posMs = this.#provider?.status().currentTimeMs ?? 0;
      void api.reportStopped({
        itemId: play.itemId,
        playSessionId: play.playSessionId,
        mediaSourceId: play.mediaSourceId,
        positionMs: posMs,
      });
      void api.stopTranscode(play.playSessionId);
    }
    this.#jellyfinApi = undefined;
    this.#jellyfinPlay = undefined;
    this.#jellyfinStarting = undefined;
    this.#setServerTranscode(undefined);
  }

  #disposeProvider() {
    this.#teardownJellyfin();
    this.#providerUnsub?.();
    this.#providerUnsub = undefined;
    this.#provider?.dispose();
    this.#provider = undefined;
    this.#providerKey = undefined;
    this.#hostSuspended = false;
    this.#setProviderStatus(undefined);
  }

  /** The "Sign in to {server}" button landed a token — retry the provider. */
  retryJellyfin() {
    const s = this.session();
    if (!s || s.media.provider !== "jellyfin") return;
    this.#setNeedsJellyfinSignin(undefined);
    void this.#startJellyfin(s, providerKey(s.media));
  }

  #onProviderChange(st: ProviderStatus) {
    this.#setProviderStatus(st);
    const transition = st.state !== this.#lastProviderState;
    this.#lastProviderState = st.state;
    if (st.state === "playing") {
      this.#playAskedAt = null;
      this.#setNeedsTap(false);
      this.#hostSuspended = false;
    }
    if (st.state === "playing" || st.state === "paused" || st.state === "ended") {
      if (
        pauseIsEnvironmental({
          isHost: this.isHost(),
          providerState: st.state,
          documentHidden: documentHidden(),
          sessionPlaying: this.session()?.playing === true,
        })
      ) {
        // The browser paused our muted player in a hidden tab (§7.2c) —
        // never host intent (a hidden tab cannot be clicked). The opinion
        // stays "playing" so neither this transition nor a heartbeat writes
        // a pause; the tick rejoins the timeline when the tab is shown.
        this.#hostSuspended = true;
      } else if (!(this.#hostSuspended && st.state === "paused")) {
        // While suspended, repeat paused reports (volume changes etc.)
        // must not sneak the opinion back to paused either.
        this.#hostOpinion = st.state;
      }
    }
    if (this.isHost()) {
      // A STATE TRANSITION the host's player reports (clicked the video,
      // ended, stalled-then-resumed) is host truth — write it (plan §1,
      // rev 3). Volume/mute/rate/duration changes also come through here
      // and must NOT each cost a PATCH (the bucket is 60/10 s).
      if (transition && this.#hostOpinion && st.state === this.#hostOpinion) {
        this.#queueWrite({ playing: st.state === "playing" });
      }
      // Title learned from the embed: write it once so late joiners see it.
      const s = this.session();
      if (st.title && s?.media.provider === "youtube" && !s.media.title) {
        this.#queueWrite({ media: { ...s.media, title: st.title } });
      }
    }
  }

  #ensureLoops() {
    if (!this.#tick) this.#tick = setInterval(() => this.#onTick(), TICK_MS);
    if (!this.#heartbeat) this.#heartbeat = setInterval(() => this.#onHeartbeat(), HEARTBEAT_MS);
    if (!this.#unreachableTimer) {
      this.#unreachableTimer = setInterval(() => {
        const s = this.session();
        if (!s) return;
        if (this.isHost()) return;
        const unreachable = hostUnreachable({
          playing: s.playing,
          lastUpdateLocalMs: this.#lastUpdateLocalMs,
          nowLocalMs: Date.now(),
        });
        if (unreachable !== this.hostUnreachable()) {
          this.#setHostUnreachable(unreachable);
          if (unreachable) void this.refetch(false);
        }
      }, UNREACHABLE_CHECK_MS);
    }
  }

  #stopLoops() {
    if (this.#tick) clearInterval(this.#tick);
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    if (this.#unreachableTimer) clearInterval(this.#unreachableTimer);
    this.#tick = this.#heartbeat = this.#unreachableTimer = undefined;
  }

  #onTick() {
    const s = this.session();
    const p = this.#provider;
    if (!s || !p) return;
    const st = p.status();
    const nowLocal = Date.now();
    const nowServer = this.#serverNow();

    if (this.isHost()) {
      // Environment-suspended (§7.2c): the browser paused our player in a
      // hidden tab. Rejoin the session's timeline once the tab is shown;
      // a real session pause (moderator, our own control) clears the mode.
      if (this.#hostSuspended) {
        if (!s.playing) {
          this.#hostSuspended = false;
        } else if (
          shouldResumeSuspendedHost({
            suspended: true,
            documentHidden: documentHidden(),
            sessionPlaying: s.playing,
          })
        ) {
          // Re-issued each tick until the playing transition clears the
          // flag — the first play() after a long suspension can be eaten
          // by a still-booting embed.
          const expected = expectedPosition(
            { playing: s.playing, positionMs: s.position_ms, positionAt: s.position_at, ratePermille: s.rate_permille },
            nowServer,
          );
          p.seek(expected);
          p.play();
        }
      }
      // Host is ground truth: no correction. But a host scrubbing YouTube's
      // own bar WHILE PAUSED produces no state transition — the viewers
      // would only learn the new position at the next heartbeat. Write when
      // the real position has moved away from the session's by > 1 s AND
      // held still for two ticks (`pausedScrubWrite` — a clock that keeps
      // moving under a paused claim is a provider contradiction, and
      // chasing it once wrote ~1 PATCH per tick, §7.2c).
      if (!s.playing && this.#hostOpinion === "paused") {
        const d = pausedScrubWrite(this.#scrubTrack, st.currentTimeMs, s.position_ms);
        this.#scrubTrack = d.tracker;
        if (d.write && st.currentTimeMs != null) {
          this.#queueWrite({ positionMs: st.currentTimeMs }, /* scrub */ true);
        }
      } else {
        this.#scrubTrack = pausedScrubTracker();
      }
      this.#setStats({
        driftMs: null,
        expectedMs: st.currentTimeMs ?? 0,
        currentMs: st.currentTimeMs,
        offsetMs: Math.round(this.#offsetMs),
        seq: s.seq,
        heartbeatAgeMs: this.#lastUpdateLocalMs == null ? null : nowLocal - this.#lastUpdateLocalMs,
        providerState: st.state,
        nudgeRate: RATE_NORMAL,
        writesLastMin: this.#writesLastMin(nowLocal),
      });
      return;
    }

    // Post-seek hold (plan §7.1): while OUR HLS seek is still rebuffering
    // (a transcode restart costs ~4-5 s), don't judge position — the frozen
    // currentTime would read as huge drift and trigger a second seek,
    // restarting ffmpeg forever. Provider-capped so a wedged seek recovers.
    if (p.postSeekHold?.()) {
      this.#setStats({
        driftMs: null,
        expectedMs: Math.round(
          expectedPosition(
            { playing: s.playing, positionMs: s.position_ms, positionAt: s.position_at, ratePermille: s.rate_permille },
            nowServer,
          ),
        ),
        currentMs: st.currentTimeMs == null ? null : Math.round(st.currentTimeMs),
        offsetMs: Math.round(this.#offsetMs),
        seq: s.seq,
        heartbeatAgeMs: this.#lastUpdateLocalMs == null ? null : nowLocal - this.#lastUpdateLocalMs,
        providerState: st.state,
        nudgeRate: this.#nudgeRate,
        writesLastMin: this.#writesLastMin(nowLocal),
      });
      return;
    }

    const result = reconcile(
      {
        session: {
          playing: s.playing,
          positionMs: s.position_ms,
          positionAt: s.position_at,
          ratePermille: s.rate_permille,
        },
        provider: {
          state: st.state,
          currentTimeMs: st.currentTimeMs,
          ratePermille: st.ratePermille,
          capabilities: p.capabilities,
        },
        nowLocalMs: nowLocal,
        nowServerMs: nowServer,
      },
      this.#syncState,
    );
    this.#syncState = result.state;
    for (const a of result.actions) this.#apply(p, a);

    // Autoplay-blocked detection: we asked for play and nothing happened.
    // The rule (incl. `idle` — §7.2a bug B — and the ready-anchored idle
    // grace) lives in watchPolicy so it runs under `node --test`.
    if (
      needsTapToStart({
        sessionPlaying: s.playing,
        playAskedAtMs: this.#playAskedAt,
        nowLocalMs: nowLocal,
        providerState: st.state,
        readyAtMs: p.readyAtMs ? p.readyAtMs() : undefined,
      })
    ) {
      this.#setNeedsTap(true);
    } else if (!s.playing && this.needsTap()) {
      // The prompt is a set-only latch otherwise — a session the host
      // paused (or that ended playback) has nothing to tap-start anymore.
      this.#setNeedsTap(false);
    }

    this.#setStats({
      driftMs: result.driftMs == null ? null : Math.round(result.driftMs),
      expectedMs: Math.round(result.expectedMs),
      currentMs: st.currentTimeMs == null ? null : Math.round(st.currentTimeMs),
      offsetMs: Math.round(this.#offsetMs),
      seq: s.seq,
      heartbeatAgeMs: this.#lastUpdateLocalMs == null ? null : nowLocal - this.#lastUpdateLocalMs,
      providerState: st.state,
      nudgeRate: this.#nudgeRate,
      writesLastMin: this.#writesLastMin(nowLocal),
    });
  }

  /** Prune-and-count the last minute's sent PATCHes. */
  #writesLastMin(nowLocal: number): number {
    while (this.#writeSentAt.length && nowLocal - this.#writeSentAt[0] > 60_000) {
      this.#writeSentAt.shift();
    }
    return this.#writeSentAt.length;
  }

  #apply(p: Provider, a: SyncAction) {
    switch (a.type) {
      case "seek":
        p.seek(a.ms);
        break;
      case "play":
        if (this.#playAskedAt == null) this.#playAskedAt = Date.now();
        p.play();
        break;
      case "pause":
        p.pause();
        break;
      case "setRate":
        this.#nudgeRate = a.permille;
        p.setRate(a.permille);
        break;
    }
  }

  #onHeartbeat() {
    if (!this.isHost()) return;
    this.#queueWrite({});
  }

  /**
   * Host write: always the FULL host-owned state (the provider's REAL
   * position + playing, plus whatever the caller overrides), one request in
   * flight, latest intent coalesced. Scrubs are additionally debounced.
   */
  #queueWrite(
    over: { playing?: boolean; positionMs?: number; ratePermille?: number; media?: WatchMediaData },
    scrub = false,
  ) {
    this.#queued = { ...(this.#queued ?? {}), ...over };
    if (scrub) {
      if (this.#scrubTimer) return;
      this.#scrubTimer = setTimeout(() => {
        this.#scrubTimer = undefined;
        void this.#flush();
      }, SCRUB_DEBOUNCE_MS);
      return;
    }
    void this.#flush();
  }

  async #flush(): Promise<void> {
    if (this.#inFlight) {
      // Another write is running; it re-checks the queue when it lands.
      return;
    }
    const ch = this.#ctx?.channel();
    const s = this.session();
    const p = this.#provider;
    if (!ch || !s || !this.isHost()) {
      this.#queued = undefined;
      return;
    }
    const over = this.#queued ?? {};
    this.#queued = undefined;
    const st = p?.status();
    // Only an opinionated provider state decides `playing`; mid-buffer
    // (every seek, every pause passes through it) keeps the last opinion.
    const playing =
      over.playing ?? (this.#hostOpinion ? this.#hostOpinion === "playing" : s.playing);
    // A suspended host's player clock is frozen by the browser (§7.2c) —
    // heartbeats extrapolate from the session timeline instead, so viewers
    // are not dragged back to the freeze point every 5 s.
    const positionMs = Math.max(
      0,
      Math.round(
        over.positionMs ??
          (this.#hostSuspended
            ? expectedPosition(
                { playing: s.playing, positionMs: s.position_ms, positionAt: s.position_at, ratePermille: s.rate_permille },
                this.#serverNow(),
              )
            : st?.currentTimeMs ?? s.position_ms),
      ),
    );
    const ratePermille = over.ratePermille ?? s.rate_permille;
    // Write governor (§7.2c): a keyed write whose body tells the server
    // nothing the session doesn't already say is dropped — whatever
    // provider flap composed it, the steady-state rate stays bounded by
    // the heartbeat (which, as an EMPTY override, always goes: it carries
    // the TTL refresh and the host-liveness signal).
    if (
      hostWriteIsNoop({
        isHeartbeat: Object.keys(over).length === 0,
        hasMedia: over.media !== undefined,
        playing,
        positionMs,
        ratePermille,
        sessionPlaying: s.playing,
        sessionRatePermille: s.rate_permille,
        sessionExpectedMs: expectedPosition(
          { playing: s.playing, positionMs: s.position_ms, positionAt: s.position_at, ratePermille: s.rate_permille },
          this.#serverNow(),
        ),
      })
    ) {
      return;
    }
    this.#writeSentAt.push(Date.now());
    this.#inFlight = (async () => {
      const r = await ch.updateWatch({
        playing,
        position_ms: positionMs,
        rate_permille: ratePermille,
        ...(over.media ? { media: over.media } : {}),
      });
      if (r.ok) {
        this.#noteClock(r);
        // Adopt the stamped seq/position_at without waiting for our own event.
        this.onUpdate({ channelId: ch.id, session: r.body.session });
      } else if (r.status === 404) {
        this.#clearSession();
      } else if (r.status === 403) {
        // We are no longer host (handoff / moderator) — stop writing, and
        // re-GET so a raced-out host converges on who is (§7.3 rev 2).
        this.#setError(r.error);
        void this.refetch(false);
      }
    })().finally(() => {
      this.#inFlight = undefined;
      if (this.#queued) void this.#flush();
    });
    await this.#inFlight;
  }
}

/** Whether the document is hidden — the environment-pause tell (§7.2c). */
function documentHidden(): boolean {
  return typeof document !== "undefined" && document.hidden === true;
}

function providerKey(m: WatchMediaData): string {
  return m.provider === "youtube" ? `yt:${m.video_id}` : `jf:${m.server_url}:${m.item_id}`;
}

function readVolume(): number {
  try {
    const raw = localStorage.getItem(LS_VOLUME);
    if (raw == null) return 100;
    const v = Number(raw);
    return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 100;
  } catch {
    return 100;
  }
}

function readMuted(): boolean {
  try {
    return localStorage.getItem(LS_MUTED) === "1";
  } catch {
    return false;
  }
}
