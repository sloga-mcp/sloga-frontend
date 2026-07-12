import { Show, createMemo, createSignal, onCleanup } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { useUsers } from "@revolt/markdown/users";
import { useVoice } from "@revolt/rtc";
import { Button } from "@revolt/ui/components/design";

import { participantUserId } from "../participantIdentity";

/**
 * The §3.4 whole-call downgrade banner (slice 6.5). Blocking strip over the
 * participant grid whenever the call is `mixed` (a non-enrolled participant is
 * present, local publishing PAUSED) or `interlude` (a confirmed / announced
 * plaintext window). Names the non-enrolled participant(s) with the §0.2 #9
 * attribution. The ONLY control that resumes publishing as plaintext is
 * "Turn off encryption" → the session's native confirm dialog (T3/T5); an
 * announce (T4) never resumes on its own.
 *
 * First paint is debounced by `MIX_BANNER_DEBOUNCE_MS` (judgment call 5) so a
 * cap-refused joiner's brief in/out never flashes the banner — the fail-closed
 * publish pause is immediate and undebounced regardless.
 */
const MIX_BANNER_DEBOUNCE_MS = 3_000;

export function VoiceCallDowngradeBanner() {
  const voice = useVoice();
  const { t } = useLingui();

  const mode = () => voice.callMode();
  const isDowngrade = () =>
    mode()?.kind === "mixed" ||
    mode()?.kind === "interlude" ||
    // ME-10 terminal-loud: the call failed to secure — offer the blocking
    // Leave / Stay-unencrypted choice instead of leaving the user parked
    // muted behind a chip.
    voice.callTerminalLoud();

  // Debounce first paint: only show once the downgrade state has persisted.
  const [visible, setVisible] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  createMemo(() => {
    if (isDowngrade()) {
      if (!visible() && timer === undefined) {
        timer = setTimeout(() => {
          timer = undefined;
          if (isDowngrade()) setVisible(true);
        }, MIX_BANNER_DEBOUNCE_MS);
      }
    } else {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      setVisible(false);
    }
  });
  onCleanup(() => timer !== undefined && clearTimeout(timer));

  const nonEnrolledIds = () =>
    voice.callNonEnrolled().map((identity) => participantUserId(identity));
  const users = useUsers(nonEnrolledIds);

  const names = () =>
    users()
      .map((u) => u?.username)
      .filter((x): x is string => !!x);

  const localConfirmed = () => {
    const m = mode();
    return m?.kind === "interlude" && m.localConfirmed;
  };

  return (
    <Show when={visible()}>
      <Banner interlude={mode()?.kind === "interlude"}>
        <Text>
          <Show
            when={voice.callTerminalLoud()}
            fallback={
              <Show
                when={mode()?.kind === "interlude" && voice.callAnnouncedBy()}
                fallback={
                  <Show
                    when={names().length}
                    fallback={
                      <Trans>
                        Someone in this call is not using encrypted calls. Your
                        audio and video stay paused until you turn off
                        encryption.
                      </Trans>
                    }
                  >
                    <Trans>
                      {names().join(", ")} is not using encrypted calls. Your
                      audio and video stay paused until you turn off encryption.
                    </Trans>
                  </Show>
                }
              >
                <Trans>
                  A participant turned off encryption for this call. Resume to
                  be heard — the server will be able to read this call.
                </Trans>
              </Show>
            }
          >
            <Trans>
              This call could not be secured. Your audio and video stay paused —
              leave, or continue without encryption.
            </Trans>
          </Show>
        </Text>
        <Actions>
          <Show when={!localConfirmed()}>
            <Button
              size="sm"
              variant="error"
              onPress={() => void voice.confirmCallPlaintext()}
            >
              <Show
                when={mode()?.kind === "interlude"}
                fallback={
                  voice.callTerminalLoud()
                    ? t`Stay unencrypted`
                    : t`Turn off encryption`
                }
              >
                {t`Resume unencrypted`}
              </Show>
            </Button>
          </Show>
          <Button size="sm" variant="plain" onPress={() => voice.disconnect()}>
            <Trans>Leave call</Trans>
          </Button>
        </Actions>
      </Banner>
    </Show>
  );
}

const Banner = styled("div", {
  base: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 5,

    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "var(--gap-md)",

    padding: "var(--gap-md) var(--gap-lg)",
    background: "var(--md-sys-color-error-container)",
    color: "var(--md-sys-color-on-error-container)",
    borderRadius: "var(--borderRadius-lg) var(--borderRadius-lg) 0 0",
  },
  variants: {
    interlude: {
      true: {
        background: "var(--md-sys-color-tertiary-container)",
        color: "var(--md-sys-color-on-tertiary-container)",
      },
    },
  },
});

const Text = styled("div", {
  base: {
    flex: 1,
    minWidth: "180px",
    fontSize: "0.8125rem",
    fontWeight: 500,
  },
});

const Actions = styled("div", {
  base: {
    display: "flex",
    gap: "var(--gap-sm)",
    flexShrink: 0,
  },
});
