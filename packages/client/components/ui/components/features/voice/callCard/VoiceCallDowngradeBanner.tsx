import {
  Match,
  Show,
  Switch,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";

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
 * Copy and gate agree by construction: every state that renders "your audio
 * and video stay paused" holds the `negotiating` / `mixed` reason (the
 * session until its verdict or loud fallback; a call with no session through
 * the R2-4 setup hold in state.tsx), and a confirmed interlude gets its own
 * copy so the promise is withdrawn the moment publishing resumes.
 *
 * It ALSO carries the two DEVICE-level states, whose cause and remedy are not
 * this call's: this install could encrypt calls but is not set up for the
 * signed-in account, and this shell can never encrypt. They exist because a
 * red NOT-ENCRYPTED chip used to be a dead end there — no banner, no
 * explanation, and (for a device that simply needs setting up) a one-click fix
 * the user was never shown. Which banner applies is decided once, in
 * `mlsCallModePolicy.callBannerState`, under a spec that asserts no red chip
 * can reach `none`.
 *
 * The two device states are NOT interchangeable, and the copy tracks the
 * difference rather than the label: a never-enrolled device never attempted
 * anything, so nothing is paused and there is nothing to "stay" unencrypted
 * from; a device the server refuses stays E2EE-capable, so its publishing IS
 * held by the `negotiating` gate and the release is the only way to be heard.
 * `voice.callCanStayUnencrypted()` is the single term that decides which,
 * instead of a per-arm guess.
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
  const banner = () => voice.callBannerState();
  const readiness = () => voice.callEncryptionReadiness();
  const isDowngrade = () => banner() !== "none";

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
  const { mfaFlow, showError, openModal } = useModals();
  // The native refusal, which KNOWS the store's owner because it read the row.
  const ownerMismatch = () => storeOwnerMismatch(voice.callEncryptionError());
  // The same fact, read straight off this disk by the store-owner accessor
  // rather than waiting for a crypto call to fail. Local and unforgeable by a
  // server, which is what qualifies it — like `ownerMismatch` and unlike the
  // server-assembled verdict — to offer the destructive reset.
  const storeIsAnotherAccounts = () =>
    !!e2ee?.storeOwnedByAnotherAccount.has("state");
  const provenNotOurs = () => !!ownerMismatch() || storeIsAnotherAccounts();
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
        interlude={banner() === "interlude"}
        // A NOTICE, not a failure, only where nothing is paused and nothing
        // failed: a shell that can never encrypt, and a device that was never
        // set up here. A device the server REFUSED keeps the error colour —
        // its publishing really is held.
        notice={
          banner() === "device_unsupported" ||
          banner() === "unencrypted_notice" ||
          (banner() === "device_not_set_up" && !deviceRefused())
        }
      >
        <Text>
          <Switch
            fallback={
              <Trans>
                Someone in this call is not using encrypted calls. Your audio
                and video stay paused until you turn off encryption.
              </Trans>
            }
          >
            <Match when={banner() === "device_unsupported"}>
              <Trans>
                Encrypted calls aren't available on this device, so your audio
                and video are not encrypted here. Everyone else in this call can
                see that.
              </Trans>
            </Match>
            {/* Widened from the native refusal alone: with LOCAL proof the
                definite sentence is honest, and it is the one that explains
                the Reset button beside it. Without either, the hedged arm
                below names the server's answer and nothing more. */}
            <Match when={provenNotOurs()}>
              <Trans>
                Encryption on this device is set up for a different account, so
                calls here cannot be encrypted. Resetting clears this device's
                encryption — including encrypted messages stored on it — and
                sets it up again for the account you are signed in as.
              </Trans>
            </Match>
            <Match when={banner() === "device_not_set_up" && deviceRefused()}>
              <Trans>
                This device's encryption isn't registered to your account, so
                this call can't be encrypted. Your audio and video stay paused —
                set encryption up again on this device, continue without it, or
                leave.
              </Trans>
            </Match>
            <Match when={banner() === "device_not_set_up"}>
              <Trans>
                Encrypted calls aren't set up on this device, so your audio and
                video are not encrypted here. Set encryption up to encrypt your
                next call.
              </Trans>
            </Match>
            <Match when={localConfirmed()}>
              <Trans>
                You turned off encryption for this call. Your audio and video
                are being sent unencrypted — the server will be able to read
                this call.
              </Trans>
            </Match>
            <Match when={mode()?.kind === "call_full"}>
              {/* Terminal in the session, so the plaintext release is hidden
                  (`plaintextReleaseAvailable`) — the copy must not offer it. */}
              <Trans>
                This call could not be secured. Your audio and video stay
                paused.
              </Trans>
            </Match>
            <Match when={banner() === "terminal_loud"}>
              <Trans>
                This call could not be secured. Your audio and video stay paused
                — leave, or continue without encryption.
              </Trans>
            </Match>
            <Match when={banner() === "unencrypted_notice"}>
              {/* The honest floor: nothing is latched, so nothing is paused
                  and there is nothing to promise. */}
              <Trans>This call is not encrypted.</Trans>
            </Match>
            <Match when={banner() === "interlude" && voice.callAnnouncedBy()}>
              <Trans>
                A participant turned off encryption for this call. Resume to be
                heard — the server will be able to read this call.
              </Trans>
            </Match>
            <Match when={names().length}>
              <Trans>
                {names().join(", ")} is not using encrypted calls. Your audio
                and video stay paused until you turn off encryption.
              </Trans>
            </Match>
          </Switch>
        </Text>
        <Actions>
          {/* Offered, never forced: this destroys local E2EE state, so it sits
              alongside "Stay unencrypted" rather than replacing it. */}
          <Show when={provenNotOurs() && !!e2ee}>
            <Button
              size="sm"
              variant="text"
              isDisabled={resetting()}
              onPress={() => void resetDevice()}
            >
              <Trans>Reset encryption</Trans>
            </Button>
          </Show>
          {/* The route to device setup — the escape the ME-7 dead end lacked,
              and (per the `deviceRefused` note above) the ONLY remedy offered
              for a server-asserted refusal. The Encryption page serves both:
              an unenrolled device gets the enable flow, a provisioned one the
              disable-then-enrol flow, each behind its own gates. */}
          {/* Not alongside Reset: where the store is PROVEN another account's,
              Reset is the specific remedy and a second button to the same page
              is clutter. This is for the cases with no local proof — never
              enrolled, or only the server saying so. */}
          <Show
            when={
              !provenNotOurs() &&
              (readiness() === "needs_setup" ||
                readiness() === "owned_elsewhere")
            }
          >
            <Button size="sm" variant="text" onPress={openEncryptionSettings}>
              <Trans>Set up encryption</Trans>
            </Button>
          </Show>
          {/* Shown only where it would do something: `callCanStayUnencrypted`
              is false with no session and no hold (a never-enrolled device, an
              unsupported shell — nothing is paused, so the press is a silent
              no-op) and for the terminal `call_full`, where the session
              returns immediately. */}
          <Show when={!localConfirmed() && voice.callCanStayUnencrypted()}>
            <Button
              size="sm"
              variant="text"
              onPress={() => void voice.confirmCallPlaintext()}
            >
              <Show
                when={mode()?.kind === "interlude"}
                fallback={
                  banner() === "terminal_loud" ||
                  banner() === "device_not_set_up"
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
    // Device states where nothing is paused and nothing failed: they must not
    // wear the failure colour. The chip stays red — that is the fail-closed
    // statement about the media — while the strip explains and offers the
    // remedy.
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
