import { Show, createMemo, createSignal, onCleanup } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { useClient, useE2EE } from "@revolt/client";
import { useUsers } from "@revolt/markdown/users";
import { useModals } from "@revolt/modal";
import { useVoice } from "@revolt/rtc";
import { storeOwnerMismatch } from "@revolt/rtc/e2eeStoreOwner";
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
 * Copy and gate agree by construction — ALMOST. Every state that renders "your
 * audio and video stay paused" holds the `negotiating` / `mixed` reason (the
 * session until its verdict or loud fallback; a call with no session through
 * the R2-4 setup hold in state.tsx), and a confirmed interlude gets its own
 * copy so the promise is withdrawn the moment publishing resumes.
 *
 * 🔴 But holding the REASON is not the wire being quiet, which is what the
 * 2026-09-08 join-race legs proved: a seat showed this banner while the other
 * seat decrypted its frames for 24 minutes. So when the publish gate's sweep
 * CONFIRMS local media is still on the wire (`callPauseDisproved`), every arm
 * below is replaced by copy that does not claim a pause. That is a WITHDRAWAL,
 * not a new state — this signal never raises the banner on its own, and it
 * therefore needs no chip precedence and no new affordance.
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

  // The call failed to secure because THIS INSTALL's E2EE store belongs to a
  // different account — a device-level fault no call-level control can fix.
  // "Stay unencrypted" would work for this one call and the next call would
  // fail identically, so the banner also offers the only real remedy.
  const e2ee = useE2EE();
  const client = useClient();
  const { mfaFlow, showError } = useModals();
  const ownerMismatch = () => storeOwnerMismatch(voice.callEncryptionError());

  const [resetting, setResetting] = createSignal(false);

  /**
   * Reset this device's encryption so it can enrol under the signed-in
   * account. Uses `E2EEBridge.disable` rather than raw `e2ee_wipe`: the wipe
   * alone leaves the device in the server's key directory, so peers keep
   * encrypting to a device that can no longer decrypt.
   *
   * Two deliberate gates, both cancellable with nothing changed: MFA proves
   * account ownership, then native shows a BLOCKING OS confirm (design §9a —
   * a webview can never destroy this on its own). Declining either is a
   * silent no-op, not an error worth a toast.
   */
  const resetDevice = async () => {
    if (resetting() || !e2ee) return;
    setResetting(true);
    try {
      const mfa = await client().account.mfa();
      const ticket = await mfaFlow(mfa);
      if (!ticket?.token) return; // cancelled at the re-auth step
      await e2ee.disable(ticket.token);
    } catch (error) {
      // The native decline is typed `declined` and means "user said no".
      // Anything else is a genuine failure the user should see, because they
      // just asked for something destructive and it did not happen.
      if ((error as { type?: string } | null)?.type !== "declined") {
        showError(error);
      }
    } finally {
      setResetting(false);
    }
  };

  return (
    <Show when={visible()}>
      <Banner interlude={mode()?.kind === "interlude"}>
        <Text>
          <Show
            when={voice.callPauseDisproved()}
            fallback={
              <Show
                when={ownerMismatch()}
                fallback={
                  <Show
                    when={localConfirmed()}
                    fallback={
                      <Show
                        when={voice.callTerminalLoud()}
                        fallback={
                          <Show
                            when={
                              mode()?.kind === "interlude" &&
                              voice.callAnnouncedBy()
                            }
                            fallback={
                              <Show
                                when={names().length}
                                fallback={
                                  <Trans>
                                    Someone in this call is not using encrypted
                                    calls. Your audio and video stay paused
                                    until you turn off encryption.
                                  </Trans>
                                }
                              >
                                <Trans>
                                  {names().join(", ")} is not using encrypted
                                  calls. Your audio and video stay paused until
                                  you turn off encryption.
                                </Trans>
                              </Show>
                            }
                          >
                            <Trans>
                              A participant turned off encryption for this call.
                              Resume to be heard — the server will be able to
                              read this call.
                            </Trans>
                          </Show>
                        }
                      >
                        <Trans>
                          This call could not be secured. Your audio and video
                          stay paused — leave, or continue without encryption.
                        </Trans>
                      </Show>
                    }
                  >
                    <Trans>
                      You turned off encryption for this call. Your audio and
                      video are being sent unencrypted — the server will be able
                      to read this call.
                    </Trans>
                  </Show>
                }
              >
                <Trans>
                  Encryption on this device is set up for a different account,
                  so calls here cannot be encrypted. Resetting clears this
                  device's encryption — including encrypted messages stored on
                  it — and sets it up again for the account you are signed in
                  as.
                </Trans>
              </Show>
            }
          >
            <Trans>
              This call could not be secured, and your audio and video may still
              be sending. Leave the call to stop them.
            </Trans>
          </Show>
        </Text>
        <Actions>
          {/* Offered, never forced: this destroys local E2EE state, so it sits
              alongside "Stay unencrypted" rather than replacing it. */}
          <Show when={ownerMismatch()}>
            <Button
              size="sm"
              variant="text"
              isDisabled={resetting()}
              onPress={() => void resetDevice()}
            >
              <Trans>Reset encryption</Trans>
            </Button>
          </Show>
          <Show when={!localConfirmed()}>
            <Button
              size="sm"
              variant="text"
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
          <Button size="sm" variant="text" onPress={() => voice.disconnect()}>
            <Trans>Leave call</Trans>
          </Button>
        </Actions>
      </Banner>
    </Show>
  );
}

// Positioning now belongs to `<TopBanners>` in VoiceCallCardActiveRoom, which
// stacks this with the recording notice — a call can be both mixed-encryption
// and recorded, and two `top: 0` strips would hide one another. FE-12 is
// unaffected: the stack is still outside the chrome `<Show>`, so this stays
// visible in fullscreen and theater mode.
const Banner = styled("div", {
  base: {
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

    // banner actions: dark app background + the banner's own text colour
    // (tracks both the error and interlude banner variants)
    "& button": {
      background: "var(--md-sys-color-surface)",
      "--color": "currentColor",
    },
  },
});
