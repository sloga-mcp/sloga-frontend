import { For, Match, Show, Switch } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { Channel } from "stoat.js";
import { styled } from "styled-system/jsx";

import { useUsers } from "@revolt/markdown/users";
import { useVoice } from "@revolt/rtc";
import { Avatar, Ripple, Text } from "@revolt/ui/components/design";
import { Row } from "@revolt/ui/components/layout";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { useCallPrejoinMode } from "../useCallPrejoinMode";

/**
 * Call card (preview)
 */
export function VoiceCallCardPreview(props: { channel: Channel }) {
  const voice = useVoice();
  const { t } = useLingui();

  const ids = () => [...props.channel.voiceParticipants.keys()];
  const users = useUsers(ids);

  /**
   * Pre-join recording warning. Reads the SAME roster this card already renders
   * participants from, so it needs no extra probe — and it is the reason the
   * `recording` flag lives on voice state: the fact has to be knowable BEFORE
   * connecting, while declining to join is still an option.
   */
  const recorderIds = () => {
    const ids: string[] = [];
    for (const participant of props.channel.voiceParticipants.values()) {
      if (participant.isRecording()) ids.push(participant.userId);
    }
    return ids;
  };
  const recorders = useUsers(recorderIds);
  const recorderNames = () =>
    recorders()
      .map((user) => user?.username)
      .filter((name): name is string => !!name);

  // Pre-join mode (§3.4 compose-time = send-time rule + A3 cap warning): show
  // what mode the call WILL use before joining, refreshed on roster change.
  const prejoin = useCallPrejoinMode(() => ({
    channelId: props.channel.id,
    version: props.channel.voiceParticipants.size,
  }));

  function subtext() {
    const names = users()
      .map((user) => user?.username)
      .filter((x) => x);

    return names.length ? t`With ${names.join(", ")}` : t`Start the call`;
  }

  // Inert while a join for this channel is in flight or while the server's
  // last answer for it was a terminal refusal (joinRefusalPolicy). The
  // 2026-09-06 storm was one attempt per press on an affordance that
  // re-rendered as if nothing had happened; a refused card says why instead.
  const blocked = () => voice.joinBlocked(props.channel);

  return (
    <Preview
      blocked={!!blocked()}
      aria-disabled={!!blocked()}
      onClick={() => {
        if (!blocked()) voice.connect(props.channel);
      }}
    >
      <Ripple disabled={!!blocked()} />
      <Row>
        <For
          each={users()}
          fallback={
            <Symbol size={24} color="#FF8A00">
              voice_chat
            </Symbol>
          }
        >
          {(user) => (
            <Avatar size={24} src={user?.avatar} fallback={user?.username} />
          )}
        </For>
      </Row>
      <Text class="title" size="large">
        <Show
          when={voice.state() === "READY"}
          fallback={<Trans>Switch to this voice channel</Trans>}
        >
          <Trans>Join the voice channel</Trans>
        </Show>
      </Text>
      <Text class="body">
        {voice.joinRefusalMessage(props.channel) ?? subtext()}
      </Text>
      {/* Warn BEFORE the click that joins. Placed above the encryption badge
          because it is the more consequential fact: an encrypted call that is
          being recorded is still being recorded. */}
      <Show when={recorderIds().length}>
        <RecordingWarning>
          <Symbol size={14}>fiber_manual_record</Symbol>
          {/* Stated as fact rather than hedged ("says they are recording"),
              which is honest here: the flag can only ever OVER-report — a
              client could claim it without recording, which merely over-warns.
              It cannot under-report in any way wording would fix, and nothing
              on this card implies the converse (that no warning means nobody
              is recording). "audio" is load-bearing: without it people assume
              video is being captured too.

              Branched on count rather than joining names, because "is" makes a
              joined list ungrammatical — "JeffS, Bob is recording audio". At
              two or more the names are dropped for a count; who they are is on
              the roster, and the fact that matters before joining is that it
              is happening at all. */}
          <Switch fallback={<Trans>Someone here is recording audio</Trans>}>
            <Match when={recorderNames().length === 1}>
              <Trans>{recorderNames()[0]} is recording audio</Trans>
            </Match>
            <Match when={recorderNames().length > 1}>
              <Trans>{recorderNames().length} people are recording audio</Trans>
            </Match>
          </Switch>
        </RecordingWarning>
      </Show>
      <Show when={prejoin()}>
        {(mode) => (
          <PrejoinBadge kind={mode().mode}>
            <Symbol size={14}>
              {mode().mode === "e2ee-open" || mode().mode === "will-e2ee"
                ? "lock"
                : mode().mode === "self-plain"
                  ? "no_encryption"
                  : ""}
            </Symbol>
            <Switch>
              <Match when={mode().mode === "e2ee-open"}>
                <Show
                  when={
                    mode().mode === "e2ee-open" &&
                    (mode() as { full: boolean }).full
                  }
                  fallback={<Trans>End-to-end encrypted call</Trans>}
                >
                  <Trans>Call full for encryption (100)</Trans>
                </Show>
              </Match>
              <Match when={mode().mode === "will-e2ee"}>
                <Trans>Will be end-to-end encrypted</Trans>
              </Match>
              <Match when={mode().mode === "self-plain"}>
                <Trans>
                  You'll join unencrypted — the call will show a warning
                </Trans>
              </Match>
            </Switch>
          </PrejoinBadge>
        )}
      </Show>
    </Preview>
  );
}

const RecordingWarning = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    marginTop: "var(--gap-sm)",
    fontSize: "0.75rem",
    fontWeight: 700,
    color: "var(--md-sys-color-error)",
  },
});

const PrejoinBadge = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    marginTop: "var(--gap-sm)",
    fontSize: "0.75rem",
    fontWeight: 600,
  },
  variants: {
    kind: {
      "e2ee-open": { color: "var(--md-sys-color-primary)" },
      "will-e2ee": { color: "var(--md-sys-color-on-surface-variant)" },
      "self-plain": { color: "var(--md-sys-color-error)" },
      plain: { display: "none" },
    },
  },
});

const Preview = styled("div", {
  base: {
    position: "relative", // <Ripple />
    borderRadius: "var(--borderRadius-lg)",

    height: "100%",
    justifyContent: "center",

    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",
    padding: "var(--gap-lg)",

    color: "var(--md-sys-color-on-surface)",
  },
  variants: {
    blocked: {
      true: {
        cursor: "not-allowed",
        opacity: 0.7,
      },
      false: {},
    },
  },
  defaultVariants: {
    blocked: false,
  },
});
