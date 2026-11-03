import {
  Match,
  Show,
  Switch,
  createComputed,
  createMemo,
  createSignal,
  onCleanup,
  untrack,
} from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { useClient, useE2EE } from "@revolt/client";
import { useUsers } from "@revolt/markdown/users";
import { useModals } from "@revolt/modal";
import { useVoice } from "@revolt/rtc";
import { storeOwnerMismatch } from "@revolt/rtc/e2eeStoreOwner";
import type { CallBanner, PauseClause } from "@revolt/rtc/mlsCallModePolicy";
import {
  type HoldState,
  NO_HOLD,
  holdExpiresIn,
  holdPauseClause,
} from "@revolt/rtc/pauseClauseHold";
import { Button } from "@revolt/ui/components/design";

import { participantUserId } from "../participantIdentity";

/**
 * The §3.4 whole-call downgrade banner (slice 6.5). Blocking strip over the
 * participant grid whenever the call owes the user an explanation: it is
 * `mixed` (a non-enrolled participant is present), in an `interlude` (a
 * confirmed / announced plaintext window), `securing` (a session exists but
 * has not reached a verdict yet), terminally loud, unable to verify its
 * roster, or not encrypted for a DEVICE-level reason. Names the non-enrolled
 * participant(s) with the §0.2 #9 attribution. The ONLY control that resumes
 * publishing as plaintext is "Turn off encryption" → the session's native
 * confirm dialog (T3/T5); an announce (T4) never resumes on its own.
 *
 * The banner is derived ONCE, in `mlsCallModePolicy.callBanner`, on two axes
 * that this component only renders:
 *
 *  - `kind` — Line A, WHAT is wrong (the state clause). Decided under a spec
 *    that asserts no red chip can reach `none`.
 *  - `pause` — Line B, what the user should expect of their OWN media (the
 *    pause clause). `held` means a gate reason is held and NOTHING more: the
 *    2026-09-08 join-race legs proved a held reason is not a quiet wire (a
 *    seat showed this banner while the other seat decrypted its frames for 24
 *    minutes), so every `held` sentence is HEDGED ("should"), never a promise.
 *    `disproved` means the publish gate's sweep FAILED TO PROVE the wire quiet
 *    under a held gate AND a confirming re-sweep actually ran — the policy
 *    folds `callPauseDisproved` and `callPauseDisproofConfirmed` together, so a
 *    budget-exhausted single observation stays `held`. `none` says nothing.
 *
 * 🔴 `disproved` is a ONE-DIRECTIONAL WITHDRAWAL. It cannot raise the banner
 * (visibility is `visible()` ← `isDowngrade()` ← `kind !== "none"`), cannot
 * claim a pause, and cannot turn a green into a red; it only replaces Line B
 * with copy that points at Leave. Its FALSE is what every episode start,
 * every 1→0 transition and every empty gate leave behind, so it never means
 * "proven paused" — which is why there is no `proven` clause to render.
 *
 * On the way DOWN from `disproved` the clause is HELD for
 * `PAUSE_DISPROOF_HOLD_MS` (`pauseClauseHold`), so a sweep that flickers
 * between disproved and not does not flicker the sentence — the same bounce
 * rationale as the re-upgrade hysteresis. The hold drops IMMEDIATELY when the
 * kind goes `none` or the pause goes `none`: a 1→0 resume is real, and "may
 * still be sending" must never sit over a green call.
 *
 * It ALSO carries the two DEVICE-level states, whose cause and remedy are not
 * this call's: this install could encrypt calls but is not set up for the
 * signed-in account, and this shell can never encrypt. They exist because a
 * red NOT-ENCRYPTED chip used to be a dead end there — no banner, no
 * explanation, and (for a device that simply needs setting up) a one-click fix
 * the user was never shown.
 *
 * The two device states are NOT interchangeable, and the copy tracks the
 * difference rather than the label: a never-enrolled device never attempted
 * anything, so nothing is paused and there is nothing to "stay" unencrypted
 * from; a device the server refuses stays E2EE-capable, so its publishing is
 * held by the `negotiating` gate and the release is the only way to be heard.
 * `voice.callCanStayUnencrypted()` is the single term that decides which,
 * instead of a per-arm guess.
 *
 * `ios_paused` (readiness `paused`, the server's iPhone kill switch) renders
 * exactly like the unsupported shell — notice colour, nothing held, Leave
 * only — with its own sentence, because "not available on this device" would
 * be false and nothing here can promise when it comes back.
 *
 * First paint is debounced by `MIX_BANNER_DEBOUNCE_MS` (judgment call 5) so a
 * cap-refused joiner's brief in/out never flashes the banner — the fail-closed
 * publish pause is immediate and undebounced regardless. `securing` rides
 * through the same debounce: a join that settles inside 3 s shows nothing.
 */
const MIX_BANNER_DEBOUNCE_MS = 3_000;

export function VoiceCallDowngradeBanner() {
  const voice = useVoice();
  const { t } = useLingui();

  const mode = () => voice.callMode();
  const banner = (): CallBanner => voice.callBanner();
  const kind = () => banner().kind;
  const readiness = () => voice.callEncryptionReadiness();
  const isDowngrade = () => kind() !== "none";

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

  // The HELD pause clause: the policy's `pause` run through the hysteresis
  // hold. The pure function owns the arithmetic (inject `now`); this component
  // owns the ONE timer that re-evaluates when the hold expires, mirroring the
  // debounce above. `hold` is read UNTRACKED so writing the next state back
  // does not re-run the computation on itself; everything else it reads
  // (`banner()`) is tracked, so a kind or pause change re-evaluates at once —
  // which is what lets a `none` drop the hold immediately.
  const [hold, setHold] = createSignal<HoldState>(NO_HOLD);
  const [pause, setPause] = createSignal<PauseClause>("none");
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  const clearHoldTimer = () => {
    if (holdTimer !== undefined) {
      clearTimeout(holdTimer);
      holdTimer = undefined;
    }
  };
  const evaluatePause = (current: CallBanner) => {
    const now = Date.now();
    const next = holdPauseClause(untrack(hold), { banner: current, now });
    setHold(next.state);
    setPause(next.pause);
    clearHoldTimer();
    const remaining = holdExpiresIn(next.state, now);
    if (remaining > 0) {
      holdTimer = setTimeout(() => {
        holdTimer = undefined;
        evaluatePause(untrack(banner));
      }, remaining);
    }
  };
  createComputed(() => evaluatePause(banner()));
  onCleanup(clearHoldTimer);

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
  const { mfaFlow, showError, openModal } = useModals();
  // The native refusal, which KNOWS the store's owner because it read the row.
  const ownerMismatch = () => storeOwnerMismatch(voice.callEncryptionError());
  // 🔴 The store-owner accessor does NOT widen this. It reads a local row,
  // but it compares it against `client.user.id`, which the server assigns in
  // the `Ready` frame — so a compromised bonfire can manufacture the mismatch
  // on a healthy device, and this button wipes local E2EE state including
  // stored encrypted messages. Reset stays on the NATIVE refusal, which is
  // raised by a crypto path the server does not drive
  // (media-e2ee-reviewer, HIGH-2).
  // The same fault seen from outside: the server would not accept this
  // device's identity. Deliberately does NOT claim another account owns it —
  // a hard-revoked device of the signed-in account lands here too.
  //
  // 🔴 It also does NOT get the Reset button. That control wipes local E2EE
  // state including stored encrypted messages, and this verdict is assembled
  // entirely from SERVER answers (a rejected claim, an absent directory row);
  // letting it summon a destructive prompt inside a call hands a hostile or
  // compromised server a lever it should not have (media-e2ee-reviewer,
  // HIGH-3). Reset stays on `ownerMismatch`, which native produced by READING
  // the store's own row. Here the user is routed to Settings → Encryption
  // instead, where the same remedy sits behind the same MFA and native
  // confirm, with the whole picture in front of them.
  const deviceRefused = () => readiness() === "owned_elsewhere";

  // Where a fresh join is the remedy: the roster could not be verified
  // (`cannot_verify`) or the session ended loud. `connect()` disconnects
  // first and clears every latch by construction (the recovery `2b78f7aa`
  // hardened), so this is the same full-join path as the card's Rejoin. Not
  // offered next to Reset (a store owned by another account fails the rejoin
  // identically, and Reset is the specific remedy there) and not into a call
  // that is FULL (terminal, auto-leaving; a rejoin is refused the same way).
  // Offered for `terminal_loud` as well as `cannot_verify`: a fresh
  // `connect()` clears every latch by construction, so it is a real recovery
  // for a media-origin or un-keyed control latch too (disclosed deviation
  // from the wave-3 contract, which named `cannot_verify` only).
  const rejoinable = () =>
    !ownerMismatch() &&
    mode()?.kind !== "call_full" &&
    (kind() === "cannot_verify" || kind() === "terminal_loud");

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

  /**
   * Take the user to the one place that fixes this: Settings → Encryption,
   * deep-linked so they do not have to find it while a call is up. Setting
   * encryption up mid-call does not rescue THIS call — the session is decided
   * at connect — so the copy promises the next one, not this one.
   */
  const openEncryptionSettings = () =>
    openModal({
      type: "settings",
      config: "user",
      context: { page: "security" },
    });

  return (
    <Show when={visible()}>
      <Banner
        interlude={kind() === "interlude"}
        // A NOTICE, not a failure, only where nothing failed: a shell that
        // can never encrypt (or whose calls the server has paused), a device
        // that was never set up here, a plain call, and a session still on
        // its way to a verdict. A device the server REFUSED keeps the error
        // colour — its publishing is held — and so does ANY kind whose pause
        // is disproved: "may still be sending" is never a notice.
        notice={
          pause() !== "disproved" &&
          (kind() === "device_unsupported" ||
            kind() === "ios_paused" ||
            kind() === "unencrypted_notice" ||
            kind() === "securing" ||
            (kind() === "device_not_set_up" && !deviceRefused()))
        }
      >
        <Text>
          {/* Line A — the state clause, on `kind`. Every arm is a sentence
              about the CALL or the DEVICE; none of them claims anything about
              this seat's own media, which is Line B's job. */}
          <Switch
            fallback={
              <Trans>Someone in this call is not using encrypted calls.</Trans>
            }
          >
            <Match when={kind() === "device_unsupported"}>
              <Trans>
                Encrypted calls aren't available on this device, so your audio
                and video are not encrypted here. Everyone else in this call can
                see that.
              </Trans>
            </Match>
            <Match when={kind() === "ios_paused"}>
              {/* The server's iPhone switch, not this device: "not available
                  here" would be false. No remedy exists in the call and none
                  is promised; Leave is the only control. */}
              <Trans>
                Encrypted calls on iPhone are paused right now. This call is not
                encrypted.
              </Trans>
            </Match>
            <Match when={ownerMismatch()}>
              <Trans>
                Encryption on this device is set up for a different account, so
                calls here cannot be encrypted. Resetting clears this device's
                encryption — including encrypted messages stored on it — and
                sets it up again for the account you are signed in as.
              </Trans>
            </Match>
            <Match when={kind() === "device_not_set_up" && deviceRefused()}>
              <Trans>
                This device's encryption isn't registered to your account, so
                this call can't be encrypted. Set encryption up again on this
                device, continue without it, or leave.
              </Trans>
            </Match>
            <Match when={kind() === "device_not_set_up"}>
              <Trans>
                Encrypted calls aren't set up on this device, so your audio and
                video are not encrypted here. Set encryption up to encrypt your
                next call.
              </Trans>
            </Match>
            <Match when={kind() === "securing"}>
              <Trans>Securing this call.</Trans>
            </Match>
            <Match when={localConfirmed()}>
              <Trans>
                You turned off encryption for this call. Your audio and video
                are being sent unencrypted — the server will be able to read
                this call.
              </Trans>
            </Match>
            <Match when={mode()?.kind === "call_full"}>
              {/* Terminal in the session (A3 cap, auto-leave), so the
                  plaintext release is hidden (`plaintextReleaseAvailable`) —
                  the copy must not offer it. */}
              <Trans>
                This call is full, so this device could not be admitted to it.
              </Trans>
            </Match>
            <Match when={kind() === "cannot_verify"}>
              {/* The group IS established and our media IS keyed; what failed
                  is confirming WHO holds those keys. Never "not encrypted". */}
              <Trans>We can't confirm who is in this call.</Trans>
            </Match>
            <Match when={kind() === "terminal_loud"}>
              {/* A media-origin latch has an established group and GCM'd
                  media — what failed is verification, so this never says the
                  call "could not be secured". */}
              <Trans>This call's encryption could not be confirmed.</Trans>
            </Match>
            <Match when={kind() === "unencrypted_notice"}>
              {/* The honest floor: nothing is latched, so nothing is paused
                  and there is nothing to promise. */}
              <Trans>This call is not encrypted.</Trans>
            </Match>
            <Match when={kind() === "interlude"}>
              {/* Not locally confirmed (that arm is above), so a participant
                  did. Says what is true of THEIR media only: a remote announce
                  cancels our re-upgrade, it does not switch our E2EE off. */}
              <Trans>
                A participant turned off encryption; their audio and video are
                no longer encrypted.
              </Trans>
            </Match>
            <Match when={names().length}>
              <Trans>{names().join(", ")} is not using encrypted calls.</Trans>
            </Match>
          </Switch>
          {/* Line B — the pause clause, on the HELD `pause`. A SIBLING of Line
              A, never nested inside it (nested JSX in `<Trans>` renders the
              text three times). `held` is hedged in every arm: a reason is
              held, the wire is unproven. `disproved` withdraws even that. */}
          <Show when={pause() !== "none"}>
            {" "}
            <Switch
              fallback={
                /* terminal_loud, cannot_verify, the refused device — and any
                   held kind a future change invents, which gets the hedge
                   rather than silence. */
                <Trans>Your audio and video should stay paused.</Trans>
              }
            >
              <Match when={pause() === "disproved"}>
                <Trans>
                  Your microphone, camera or screen share may still be sending.
                  Leave the call to stop it.
                </Trans>
              </Match>
              <Match when={kind() === "securing"}>
                <Trans>
                  Your audio and video should stay held back until it's
                  encrypted.
                </Trans>
              </Match>
              <Match when={kind() === "mixed"}>
                <Trans>
                  Your audio and video should be paused until you turn off
                  encryption.
                </Trans>
              </Match>
              <Match when={kind() === "interlude"}>
                <Trans>
                  Resume to be heard — yours should stay paused until you do.
                </Trans>
              </Match>
            </Switch>
          </Show>
        </Text>
        {/* `securing` is a notice with nothing to decide yet: NO controls —
            unless the pause is disproved, when Line B points at Leave and
            that one button must exist. */}
        <Show when={kind() !== "securing" || pause() === "disproved"}>
          <Actions>
            <Show when={kind() !== "securing"}>
              {/* Offered, never forced: this destroys local E2EE state, so it
                sits alongside "Stay unencrypted" rather than replacing it. */}
              <Show when={!!ownerMismatch() && !!e2ee}>
                <Button
                  size="sm"
                  variant="text"
                  isDisabled={resetting()}
                  onPress={() => void resetDevice()}
                >
                  <Trans>Reset encryption</Trans>
                </Button>
              </Show>
              {/* The route to device setup — the escape the ME-7 dead end
                lacked, and (per the `deviceRefused` note above) the ONLY
                remedy offered for a server-asserted refusal. The Encryption
                page serves both: an unenrolled device gets the enable flow, a
                provisioned one the disable-then-enrol flow, each behind its
                own gates. */}
              {/* Not alongside Reset, where that is offered: it is the specific
                remedy there and a second button to the same page is
                clutter. */}
              <Show
                when={
                  !ownerMismatch() &&
                  (readiness() === "needs_setup" ||
                    readiness() === "owned_elsewhere")
                }
              >
                <Button
                  size="sm"
                  variant="text"
                  onPress={openEncryptionSettings}
                >
                  <Trans>Set up encryption</Trans>
                </Button>
              </Show>
              {/* Same full-join path as the card status's Rejoin: leaves first,
                so every latch this call accumulated is cleared. */}
              <Show when={rejoinable() && voice.channel()}>
                {(channel) => (
                  <Button
                    size="sm"
                    variant="text"
                    onPress={() => void voice.connect(channel())}
                  >
                    {t`Rejoin`}
                  </Button>
                )}
              </Show>
              {/* Shown only where it would do something: `callCanStayUnencrypted`
                is false with no session and no hold (a never-enrolled device,
                an unsupported shell — nothing is paused, so the press is a
                silent no-op) and for the terminal `call_full`, where the
                session returns immediately. */}
              <Show when={!localConfirmed() && voice.callCanStayUnencrypted()}>
                <Button
                  size="sm"
                  variant="text"
                  onPress={() => void voice.confirmCallPlaintext()}
                >
                  <Show
                    when={mode()?.kind === "interlude"}
                    fallback={
                      kind() === "terminal_loud" ||
                      kind() === "cannot_verify" ||
                      kind() === "device_not_set_up"
                        ? t`Stay unencrypted`
                        : t`Turn off encryption`
                    }
                  >
                    {t`Resume unencrypted`}
                  </Show>
                </Button>
              </Show>
            </Show>
            <Button size="sm" variant="text" onPress={() => voice.disconnect()}>
              <Trans>Leave call</Trans>
            </Button>
          </Actions>
        </Show>
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
    // States where nothing failed: the device notices and the securing
    // stretch. They must not wear the failure colour. The chip stays whatever
    // the media says — that is the fail-closed statement — while the strip
    // explains and, where there is one, offers the remedy.
    notice: {
      true: {
        background: "var(--md-sys-color-secondary-container)",
        color: "var(--md-sys-color-on-secondary-container)",
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
