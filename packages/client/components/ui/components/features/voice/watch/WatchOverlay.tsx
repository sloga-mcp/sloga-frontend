import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";

import { useLingui } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import { CONFIGURATION } from "@revolt/common";
import { useError } from "@revolt/i18n";
import { useVoice } from "@revolt/rtc";
import { Button, IconButton } from "@revolt/ui/components/design";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { JellyfinBrowser } from "./JellyfinBrowser";
import { JellyfinConnect } from "./JellyfinConnect";
import { parseYouTubeInput } from "./providers/youtubeWire";
import { watchOverlayVisible } from "./watchPolicy";

/**
 * Watch-together overlay (plan §2.1). Copies the MinigameChip placement:
 * mounted inside the `<Participants>` relative container of the active
 * call card, zIndex 4, covering the participant AREA only — the controls
 * bar below stays clickable, the banner strip (z5) and dice (z6) stay on
 * top. Theater mode hides it (it is chrome).
 *
 * It holds OUR chrome only — title, host controls / viewer volume, the
 * paste-URL picker, "Tap to start", the debug stats line — and RESERVES a
 * rect for the player: the iframe itself lives in the store's player host
 * inside `VoiceCallCard`'s persistent `<Float>` and is positioned over the
 * `PlayerSlot` here via `voice.watch.setAnchor()`. It is never a child of
 * this card, so browsing away and back never reloads it.
 *
 * No transparent click-shield over the player (YouTube API ToS forbids
 * overlays obscuring it); stray clicks on the video by a viewer are
 * corrected by the sync controller's pending-command latch.
 */
export function WatchOverlay() {
  const voice = useVoice();
  const client = useClient();
  const { t } = useLingui();
  const translateError = useError();
  const watch = voice.watch;

  // The in-slot "sign in to {server}" form is open (a Jellyfin session named
  // a server this viewer hasn't added — nothing is fetched until they click).
  const [signinOpen, setSigninOpen] = createSignal(false);

  const visible = () =>
    watchOverlayVisible({
      enabled: CONFIGURATION.ENABLE_WATCH_TOGETHER,
      connected: voice.state() === "CONNECTED",
      hasSession: !!watch.session(),
      immersive: voice.immersive(),
    });
  const pickerVisible = () =>
    CONFIGURATION.ENABLE_WATCH_TOGETHER &&
    voice.state() === "CONNECTED" &&
    !watch.session() &&
    watch.pickerOpen() &&
    !voice.immersive();

  // A BLOCKING card banner (the E2EE downgrade / terminal-loud banner, z5
  // inside the card) must stay on top; the player host sits at Float level
  // ABOVE the card, so park it (audio continues) while one is showing.
  const blockingBanner = () => {
    const kind = voice.callMode()?.kind;
    return kind === "mixed" || kind === "interlude" || voice.callTerminalLoud();
  };

  // Anchor the player host to the slot whenever the slot exists.
  const [slot, setSlot] = createSignal<HTMLDivElement>();
  createEffect(() => {
    watch.setAnchor(visible() && !blockingBanner() ? slot() : undefined);
  });
  onCleanup(() => watch.setAnchor(undefined));

  const hostName = createMemo(() => {
    const id = watch.session()?.host_id;
    if (!id) return "";
    return client()?.users.get(id)?.displayName ?? id;
  });

  const title = () => {
    const s = watch.session();
    if (!s) return "";
    if (s.media.provider === "youtube")
      return s.media.title ?? watch.providerStatus()?.title ?? `YouTube ${s.media.video_id}`;
    return s.media.item_name;
  };

  const canControl = () =>
    watch.isHost() || !!voice.channel()?.havePermission("ManageChannel");

  // Handoff (§7.3 4a): every other current call participant, from the same
  // roster the sidebar renders. The backend re-validates (in-call, not a
  // bot, holds the bit in server channels), so a stale row just errors.
  const [handoffOpen, setHandoffOpen] = createSignal(false);
  const handoffCandidates = createMemo(() => {
    const hostId = watch.session()?.host_id;
    const ch = voice.channel();
    if (!ch) return [] as string[];
    return [...ch.voiceParticipants.keys()].filter((id) => id !== hostId);
  });

  // Debug stats line for the live leg (plan §9) — off by default, toggled
  // from the header; remembered per device.
  const [showStats, setShowStats] = createSignal(
    (() => {
      try {
        return localStorage.getItem("sloga:watch:stats") === "1";
      } catch {
        return false;
      }
    })(),
  );
  const toggleStats = () => {
    const next = !showStats();
    setShowStats(next);
    try {
      localStorage.setItem("sloga:watch:stats", next ? "1" : "0");
    } catch {
      /* private mode */
    }
  };

  return (
    <>
      <Show when={pickerVisible()}>
        <Overlay>
          <Header>
            <HeaderTitle>
              <Symbol size={18}>movie</Symbol>
              {t`Watch together`}
            </HeaderTitle>
            <IconButton size="xs" variant="tonal" onPress={() => watch.setPickerOpen(false)}>
              <Symbol>close</Symbol>
            </IconButton>
          </Header>
          <Picker />
        </Overlay>
      </Show>
      <Show when={visible()}>
        <Overlay>
          <Header>
            <HeaderTitle title={title()}>
              <Symbol size={18}>movie</Symbol>
              <span>{title()}</span>
            </HeaderTitle>
            <HeaderMeta>
              <Show when={watch.isHost()} fallback={<HostedBy name={hostName()} />}>
                {t`You're hosting`}
              </Show>
            </HeaderMeta>
            <IconButton
              size="xs"
              variant={showStats() ? "filled" : "tonal"}
              onPress={toggleStats}
              use:floating={{ tooltip: { placement: "top", content: t`Sync stats` } }}
            >
              <Symbol>insights</Symbol>
            </IconButton>
            <Show when={canControl() && handoffCandidates().length > 0}>
              <IconButton
                size="xs"
                variant={handoffOpen() ? "filled" : "tonal"}
                isDisabled={watch.busy()}
                onPress={() => setHandoffOpen((v) => !v)}
                use:floating={{ tooltip: { placement: "top", content: t`Make someone else the host` } }}
              >
                <Symbol>switch_account</Symbol>
              </IconButton>
            </Show>
            <Show when={canControl()}>
              <IconButton
                size="xs"
                variant="tonal"
                isDisabled={watch.busy()}
                onPress={() => void watch.end()}
                use:floating={{ tooltip: { placement: "top", content: t`Stop watching together` } }}
              >
                <Symbol>stop_circle</Symbol>
              </IconButton>
            </Show>
          </Header>
          <Show when={handoffOpen() && canControl()}>
            <HandoffRow>
              <HandoffLabel>{t`Make host`}</HandoffLabel>
              <For each={handoffCandidates()}>
                {(id) => (
                  <Button
                    variant="tonal"
                    isDisabled={watch.busy()}
                    onPress={() =>
                      void watch.handoff(id).then((ok) => {
                        if (ok) setHandoffOpen(false);
                      })
                    }
                  >
                    {client()?.users.get(id)?.displayName ?? id}
                  </Button>
                )}
              </For>
            </HandoffRow>
          </Show>
          <PlayerSlot ref={setSlot}>
            {/* The iframe is positioned over this slot by the store. These
                are the states where the slot itself needs to say something. */}
            <Show when={watch.providerStatus()?.state === "error"}>
              <SlotMessage>{watch.providerStatus()?.error}</SlotMessage>
            </Show>
            <Show when={watch.needsJellyfinSignin()}>
              {(info) => (
                <SlotSignin>
                  <SlotMessage>{t`This session is playing from ${info().serverUrl}. Sign in to that Jellyfin to watch along.`}</SlotMessage>
                  <Show
                    when={signinOpen()}
                    fallback={
                      <Button variant="filled" onPress={() => setSigninOpen(true)}>
                        <Symbol>login</Symbol>
                        {t`Sign in to watch`}
                      </Button>
                    }
                  >
                    <JellyfinConnect
                      prefillUrl={info().serverUrl}
                      onCancel={() => setSigninOpen(false)}
                      onDone={() => {
                        setSigninOpen(false);
                        watch.retryJellyfin();
                      }}
                    />
                  </Show>
                </SlotSignin>
              )}
            </Show>
          </PlayerSlot>
          <Show when={watch.needsTap()}>
            <TapRow>
              <Button variant="filled" onPress={() => watch.tapToStart()}>
                <Symbol>play_arrow</Symbol>
                {t`Tap to start`}
              </Button>
              <TapHint>{t`Your browser blocked autoplay — one tap and you're in sync.`}</TapHint>
            </TapRow>
          </Show>
          <Show when={watch.hostUnreachable()}>
            <Notice>{t`The host seems to have dropped — waiting for them to come back…`}</Notice>
          </Show>
          <Show when={watch.error()}>
            <Notice>{translateError({ type: watch.error() })}</Notice>
          </Show>
          <Controls />
          <Show when={showStats()}>
            <Stats />
          </Show>
        </Overlay>
      </Show>
    </>
  );
}

/** Bare-identifier interpolation so the msgid extracts as `Hosted by {name}`. */
function HostedBy(props: { name: string }) {
  const { t } = useLingui();
  // The JSX expression is a tracked scope, so this re-evaluates when
  // `props.name` changes; the bare `name` identifier is what the extractor
  // turns into the `{name}` placeholder.
  return (
    <>
      {(() => {
        const name = props.name;
        return t`Hosted by ${name}`;
      })()}
    </>
  );
}

/** Host: play/pause, seek, rate. Everyone: volume, mute. */
function Controls() {
  const voice = useVoice();
  const { t } = useLingui();
  const watch = voice.watch;
  const status = () => watch.providerStatus();
  const duration = () => status()?.durationMs ?? 0;
  const playing = () => {
    const s = watch.session();
    return watch.isHost() ? status()?.state === "playing" : !!s?.playing;
  };
  // Position for the bar, from the store's per-tick stats (the provider
  // status signal only changes on state transitions): the host's own real
  // position; viewers the session's expected line. Frozen while the host
  // is dragging so the tick doesn't fight the thumb.
  const [dragging, setDragging] = createSignal(false);
  const [dragValue, setDragValue] = createSignal(0);
  const positionMs = () => {
    if (dragging()) return dragValue();
    const st = watch.stats();
    if (!st) return 0;
    return watch.isHost() ? (st.currentMs ?? 0) : st.expectedMs;
  };

  const RATES = [750, 1000, 1250, 1500, 2000];

  return (
    <ControlsRow>
      <Show when={watch.isHost()}>
        <IconButton
          size="xs"
          variant="tonal"
          onPress={() => (playing() ? watch.hostPause() : watch.hostPlay())}
        >
          <Symbol>{playing() ? "pause" : "play_arrow"}</Symbol>
        </IconButton>
      </Show>
      <Time>{fmt(positionMs())}</Time>
      <Seek
        type="range"
        min={0}
        max={Math.max(1, Math.round(duration()))}
        value={Math.min(Math.round(positionMs()), Math.max(1, Math.round(duration())))}
        disabled={!watch.isHost()}
        onPointerDown={() => setDragging(true)}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
        onInput={(e) => {
          const v = Number(e.currentTarget.value);
          setDragValue(v);
          if (watch.isHost()) watch.hostSeek(v);
        }}
        onChange={() => setDragging(false)}
        aria-label={t`Seek`}
      />
      <Time>{fmt(duration())}</Time>
      <Show when={watch.isHost()}>
        <RateSelect
          value={watch.session()?.rate_permille ?? 1000}
          onChange={(e) => watch.hostSetRate(Number(e.currentTarget.value))}
          aria-label={t`Playback speed`}
        >
          <For each={RATES}>{(r) => <option value={r}>{(r / 1000).toFixed(2).replace(/\.?0+$/, "")}×</option>}</For>
        </RateSelect>
      </Show>
      <Spacer />
      <IconButton size="xs" variant="tonal" onPress={() => watch.setMuted(!watch.muted())}>
        <Symbol>{watch.muted() ? "volume_off" : "volume_up"}</Symbol>
      </IconButton>
      <Volume
        type="range"
        min={0}
        max={100}
        value={watch.volume()}
        onInput={(e) => watch.setVolume(Number(e.currentTarget.value))}
        aria-label={t`Volume`}
      />
    </ControlsRow>
  );
}

/** Paste a YouTube URL or id. v1: no search (no Data API key), no playlists. */
function Picker() {
  const voice = useVoice();
  const { t } = useLingui();
  const translateError = useError();
  const watch = voice.watch;
  const [raw, setRaw] = createSignal("");
  const [bad, setBad] = createSignal(false);
  const [tab, setTab] = createSignal<"youtube" | "jellyfin">("youtube");

  const submit = () => {
    const id = parseYouTubeInput(raw());
    if (!id) {
      setBad(true);
      return;
    }
    setBad(false);
    void watch.start({ provider: "youtube", video_id: id });
  };

  return (
    <PickerBox>
      <Tabs>
        <Tab data-active={tab() === "youtube"} onClick={() => setTab("youtube")}>
          <Symbol size={16}>smart_display</Symbol>
          {t`YouTube`}
        </Tab>
        <Tab data-active={tab() === "jellyfin"} onClick={() => setTab("jellyfin")}>
          <Symbol size={16}>dns</Symbol>
          {t`Jellyfin`}
        </Tab>
      </Tabs>
      <Show when={tab() === "jellyfin"}>
        <JellyfinBrowser />
      </Show>
      <Show when={tab() === "youtube"}>
      <PickerText>
        {t`Paste a YouTube link. Everyone in the call watches it in sync, each from YouTube directly — Sloga never touches the video.`}
      </PickerText>
      <PickerRow>
        <PickerInput
          type="url"
          placeholder="https://youtu.be/…"
          value={raw()}
          onInput={(e) => setRaw(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          autofocus
        />
        <Button variant="filled" isDisabled={watch.busy()} onPress={submit}>
          {t`Watch`}
        </Button>
      </PickerRow>
      <Show when={bad()}>
        <Notice>{t`That doesn't look like a YouTube link or video id.`}</Notice>
      </Show>
      <Show when={watch.error()}>
        <Notice>{translateError({ type: watch.error() })}</Notice>
      </Show>
      <PickerHint>
        {t`Loads from youtube-nocookie.com. The server sees what you watch — also in encrypted calls. Videos with embedding disabled won't play. Headphones recommended: an open mic will carry the movie into the call.`}
      </PickerHint>
      </Show>
    </PickerBox>
  );
}

/** Debug line for the live leg (plan §9): drift / expected / offset / seq. */
function Stats() {
  const voice = useVoice();
  const s = () => voice.watch.stats();
  const transcode = () => voice.watch.serverTranscode();
  return (
    <Show when={s()}>
      {(st) => (
        <StatsLine>
          {`${st().providerState} · cur ${fmt(st().currentMs ?? 0)} · exp ${fmt(st().expectedMs)} · drift ${
            st().driftMs == null ? "—" : `${st().driftMs} ms`
          } · rate ${st().nudgeRate} · off ${st().offsetMs} ms · seq ${st().seq} · hb ${
            st().heartbeatAgeMs == null ? "—" : `${Math.round(st().heartbeatAgeMs! / 1000)}s`
          } · wr ${st().writesLastMin}/m${transcode() ? ` · ${transcode()}` : ""}`}
        </StatsLine>
      )}
    </Show>
  );
}

function fmt(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

/**
 * Fills the participant AREA only — the controls bar and the top banners are
 * outside/above it on purpose (the MinigameChip Overlay, verbatim z-stack).
 */
const Overlay = styled("div", {
  base: {
    position: "absolute",
    inset: 0,
    zIndex: 4,
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",
    padding: "var(--gap-md)",
    borderRadius: "12px",
    background:
      "color-mix(in srgb, var(--md-sys-color-surface-container-low) 92%, transparent)",
    backdropFilter: "blur(6px)",
    color: "var(--md-sys-color-on-surface)",
  },
});

const Header = styled("div", {
  base: { display: "flex", alignItems: "center", gap: "var(--gap-sm)", minHeight: "32px" },
});
const HeaderTitle = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    fontWeight: 600,
    minWidth: 0,
    flex: "1 1 auto",
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
    "& > span": { overflow: "hidden", textOverflow: "ellipsis" },
  },
});
const HeaderMeta = styled("span", {
  base: { fontSize: "12px", color: "var(--md-sys-color-on-surface-variant)", whiteSpace: "nowrap" },
});
const PlayerSlot = styled("div", {
  base: {
    position: "relative",
    flex: "1 1 0",
    minHeight: 0,
    borderRadius: "8px",
    background: "#000",
    overflow: "hidden",
    display: "grid",
    placeItems: "center",
  },
});
const SlotMessage = styled("div", {
  base: {
    color: "#fff",
    fontSize: "13px",
    textAlign: "center",
    padding: "var(--gap-md)",
    maxWidth: "40ch",
  },
});
const TapRow = styled("div", {
  base: { display: "flex", alignItems: "center", gap: "var(--gap-md)" },
});
const TapHint = styled("span", {
  base: { fontSize: "12px", color: "var(--md-sys-color-on-surface-variant)" },
});
const HandoffRow = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "var(--gap-sm)",
  },
});
const HandoffLabel = styled("span", {
  base: { fontSize: "12px", color: "var(--md-sys-color-outline)" },
});
const Notice = styled("div", {
  base: {
    fontSize: "12px",
    padding: "4px 8px",
    borderRadius: "6px",
    background: "var(--md-sys-color-error-container)",
    color: "var(--md-sys-color-on-error-container)",
  },
});
const ControlsRow = styled("div", {
  base: { display: "flex", alignItems: "center", gap: "var(--gap-sm)", minHeight: "32px" },
});
const Time = styled("span", {
  base: { fontSize: "12px", fontVariantNumeric: "tabular-nums", minWidth: "5ch", textAlign: "center" },
});
const Seek = styled("input", {
  base: { flex: "1 1 auto", minWidth: "60px", accentColor: "var(--md-sys-color-primary)" },
});
const Volume = styled("input", {
  base: { width: "90px", accentColor: "var(--md-sys-color-primary)" },
});
const RateSelect = styled("select", {
  base: {
    fontSize: "12px",
    padding: "2px 4px",
    borderRadius: "6px",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface)",
    border: "1px solid var(--md-sys-color-outline-variant)",
  },
});
const Spacer = styled("span", { base: { flex: "1 1 auto" } });
const StatsLine = styled("div", {
  base: {
    fontSize: "11px",
    fontFamily: "monospace",
    color: "var(--md-sys-color-on-surface-variant)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
});
const PickerBox = styled("div", {
  base: { display: "flex", flexDirection: "column", gap: "var(--gap-md)", width: "100%", maxWidth: "60ch", margin: "auto", minHeight: 0 },
});
const Tabs = styled("div", { base: { display: "flex", gap: "var(--gap-sm)", justifyContent: "center" } });
const Tab = styled("button", {
  base: {
    display: "flex", alignItems: "center", gap: "6px", padding: "6px 14px", borderRadius: "999px",
    border: "1px solid var(--md-sys-color-outline-variant)", background: "transparent",
    color: "var(--md-sys-color-on-surface-variant)", cursor: "pointer", fontSize: "13px", fontWeight: 500,
    "&[data-active='true']": {
      background: "var(--md-sys-color-secondary-container)",
      color: "var(--md-sys-color-on-secondary-container)",
      borderColor: "transparent",
    },
  },
});
const SlotSignin = styled("div", {
  base: { display: "flex", flexDirection: "column", gap: "var(--gap-md)", alignItems: "center", padding: "var(--gap-md)", maxWidth: "48ch", width: "100%" },
});
const PickerText = styled("p", { base: { fontSize: "14px" } });
const PickerHint = styled("p", {
  base: { fontSize: "12px", color: "var(--md-sys-color-on-surface-variant)" },
});
const PickerRow = styled("div", { base: { display: "flex", gap: "var(--gap-sm)" } });
const PickerInput = styled("input", {
  base: {
    flex: "1 1 auto",
    padding: "8px 10px",
    borderRadius: "8px",
    border: "1px solid var(--md-sys-color-outline-variant)",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface)",
    fontSize: "14px",
  },
});
