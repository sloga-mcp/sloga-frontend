import { Capacitor } from "@capacitor/core";
import {
  For,
  Match,
  Show,
  Switch,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";

import {
  browserShareDeps,
  cardOffersInvite,
  desktopShell,
  inviteOutcomeShown,
  shareInviteText,
} from "@revolt/app/interface/channels/text/encryptedOnlyInvite";
import type { BackupStatusView } from "@revolt/client";
import { useClient, useE2EE } from "@revolt/client";
import { latchedForClient } from "@revolt/client/encryptedOnlyLatch";
import { backupNoteCopy, backupTextCopy } from "@revolt/client/protectedCopy";
import { useModals } from "@revolt/modal";
import { useE2EESplit } from "@revolt/modal/modals/E2EEDeviceShared";
import { E2EEOwnDeviceList } from "@revolt/modal/modals/E2EERemoveDevice";
import { useOnlyAdvert } from "@revolt/modal/modals/EncryptedOnlyOnboarding";
import { onlyCardState } from "@revolt/modal/modals/encryptedOnlySetup";
import { platformMediaE2EESupported } from "@revolt/rtc";
import {
  callMediaE2EEOffered,
  fetchIosCallSwitchValue,
  iosCallSwitch,
} from "@revolt/rtc/iosCallSwitch";
import {
  CategoryButton,
  Checkbox,
  Column,
  Text,
  iconSize,
  useSnackbar,
} from "@revolt/ui";

import MdDevices from "@material-design-icons/svg/outlined/devices.svg?component-solid";
import MdKey from "@material-design-icons/svg/outlined/key.svg?component-solid";
import MdLock from "@material-design-icons/svg/outlined/lock.svg?component-solid";
import MdShare from "@material-design-icons/svg/outlined/share.svg?component-solid";
import MdVideocam from "@material-design-icons/svg/outlined/videocam.svg?component-solid";
import MdWarning from "@material-design-icons/svg/outlined/warning.svg?component-solid";

import {
  backupTextLines,
  lastRestoreText,
  onRestoreText,
} from "./backupTextLines";

/**
 * Encryption settings page (sidebar id `security`, kept for deep links).
 *
 * Hosts the per-device end-to-end encryption opt-in for direct messages, the
 * always-on call encryption indicator, and the recovery-code backup. Renders
 * only where a native crypto layer exists (Tauri desktop); the web build has
 * no key material and the server refuses its E2EE routes.
 *
 * The remote-control trust list that used to sit at the bottom of this page
 * moved to its own Remote Control page — it is a consent setting, not
 * encryption, and it must not inherit this page's native-E2EE gate.
 */
export function EncryptionSettings() {
  return (
    <Column gap="lg">
      <DeviceStateCards />
      <EncryptionCard />
      <EncryptedOnlyCard />
      <CallEncryptionCard />
      <RecoveryBackupCard />
      <OwnDevicesCard />
    </Column>
  );
}

/**
 * Multi-device states that need the user (D3, D5, D8). Each card is the
 * persistent entry behind a dismissable auto-modal, so closing the modal is
 * never the end of it:
 * - removed (D8): this device was removed from the account's encryption; set
 *   it up again as a new device. Outranks the other two, which cannot finish
 *   for a removed device.
 * - publishPending (D3): keys never registered (a restore's second prompt).
 * - deviceShared (D5): this install shares its device with another install.
 *   The refused twin also gets the modal; the install that only sees
 *   divergence gets just this card. Offered only while the server advertises
 *   the split (`splitSupported` exactly true); "Not now" dismisses the
 *   signal for this device.
 */
function DeviceStateCards() {
  const e2ee = useE2EE();
  const { openModal } = useModals();
  const split = useE2EESplit();

  if (!e2ee) return null;

  const removed = () => !!e2ee.deviceRemoved.get("state");
  const pending = () => !!e2ee.publishPending.get("state");
  const shared = () => !!e2ee.deviceShared.get("state");

  return (
    <>
      <Show when={removed()}>
        <CategoryButton.Group>
          <CategoryButton
            icon={<MdWarning {...iconSize(24)} />}
            action="chevron"
            description={
              <Trans>
                This device was removed from your account's encryption. Set it
                up again as a new device?
              </Trans>
            }
            onClick={() => openModal({ type: "e2ee_device_removed" })}
          >
            <Trans>Set up as a new device</Trans>
          </CategoryButton>
        </CategoryButton.Group>
      </Show>

      <Show when={pending() && !removed()}>
        <CategoryButton.Group>
          <CategoryButton
            icon={<MdKey {...iconSize(24)} />}
            action="chevron"
            description={
              <Trans>
                This device is not registered for encryption yet, so it cannot
                send or receive encrypted messages. Confirm your identity to
                finish.
              </Trans>
            }
            onClick={() => openModal({ type: "e2ee_finish_setup" })}
          >
            <Trans>Finish setting up encryption on this device</Trans>
          </CategoryButton>
        </CategoryButton.Group>
      </Show>

      <Show
        when={
          shared() && !removed() && e2ee.splitSupported.get("state") === true
        }
      >
        <CategoryButton.Group>
          <CategoryButton
            icon={<MdDevices {...iconSize(24)} />}
            disabled={split.busy()}
            description={
              <Trans>
                This app shares its encryption identity with another of your
                apps (it was restored from your recovery code). Messages can go
                missing on one of them. Make this app a separate device: it
                keeps its message history, and your contacts will see you added
                a device.
              </Trans>
            }
            onClick={() => void split.run()}
          >
            <Trans>Make this a separate device</Trans>
          </CategoryButton>
          <CategoryButton
            icon="blank"
            disabled={split.busy()}
            onClick={() => e2ee.dismissDeviceShared()}
          >
            <Trans>Not now</Trans>
          </CategoryButton>
        </CategoryButton.Group>
        <Show when={split.notice()}>
          <Text class="label">{split.notice()}</Text>
        </Show>
      </Show>
    </>
  );
}

/**
 * Multi-device D7: the user's own encrypted devices, with Remove for the
 * others. Only for a registered device (the listing is keyed on it).
 */
function OwnDevicesCard() {
  const e2ee = useE2EE();

  if (!e2ee) return null;

  const enabled = () => {
    const state = e2ee.status.get("state");
    return !!state?.enabled && !!state?.published;
  };

  return (
    <Show when={enabled() && !e2ee.deviceRemoved.get("state")}>
      <E2EEOwnDeviceList title={<Trans>Your devices</Trans>} />
    </Show>
  );
}

/**
 * "Encrypt my calls" opt-in for this device (media E2EE, slice 6.5 §0.2 #9).
 * LOCAL per-device (the `Voice` store is not synced). Enabling requires text-
 * E2EE enrollment (shared infrastructure) — the row routes through the enable
 * flow first when off. Gated on MEDIA capability (`nativeKeyPushAvailable`, not
 * merely `useE2EE`): on Android (E2EE-enrolled but media-fail-closed until 6.7)
 * the card renders DISABLED with explanatory copy so a user can't believe their
 * calls are encrypted when they are not (FE-6). The same holds on iPhone while
 * the server's kill switch is off (plan D14), with its own copy.
 */
function CallEncryptionCard() {
  const e2ee = useE2EE();
  const client = useClient();
  const { openModal } = useModals();

  if (!e2ee) return null;
  // Electron shell (EL1.2): media E2EE is fail-closed until EL4's audited
  // slice — hide the toggle entirely so a user can't believe their calls
  // are encrypted when they are not (same FE-6 rationale as the Android
  // disabled state; hidden rather than disabled because no ETA copy fits).
  if (!platformMediaE2EESupported()) return null;

  // Media E2EE requires a native key-push channel (desktop today; Android 6.7).
  const mediaCapable = () => e2ee.nativeKeyPushAvailable();
  // The server's iPhone kill switch (plan D14), fetched from `GET /` because
  // `client.configuration` is a local stub that never carries it (Stage 5
  // B1). The RAW value goes to `iosCallSwitch`: absent or unreachable reads
  // ON, only a strict `false` pauses. Off iOS nothing is fetched and the
  // switch always answers "on", so this card is unchanged there. On iOS the
  // card waits for the (bounded) answer rather than claim "Always on" first.
  const platform = Capacitor.getPlatform();
  const [switchRead, setSwitchRead] = createSignal<{ serverValue: unknown }>();
  onMount(() => {
    if (platform !== "ios") return;
    void fetchIosCallSwitchValue({
      fetchRoot: () => client().api.get("/"),
      setTimeout,
      clearTimeout,
    }).then((serverValue) => setSwitchRead({ serverValue }));
  });
  const switchKnown = () => platform !== "ios" || switchRead() !== undefined;
  const offered = () =>
    callMediaE2EEOffered(
      mediaCapable(),
      iosCallSwitch({ platform, serverValue: switchRead()?.serverValue }),
    );
  // This device could encrypt, but the server has paused it: not "not
  // available on this device", which would be false (iosCallSwitch rule 6).
  const pausedByServer = () => mediaCapable() && !offered();
  const textEnrolled = () => {
    const s = e2ee.status.get("state");
    return !!s?.enabled && !!s?.published;
  };
  // Media E2EE is MANDATORY — there is no off switch (Discord/DAVE parity).
  // Once this device can actually encrypt, the row is a plain status line
  // with a lock — not a checked checkbox, which implies it can be unchecked
  // and reads as a control that does nothing.
  //
  // "Can actually encrypt" still requires text-E2EE enrollment, so an
  // unenrolled user must NOT see it presented as on — that would claim
  // encryption the gate will not deliver (FE-6). For them the row shows an
  // unchecked box and routes into the enrolment flow, which is the one
  // remaining click here.
  const enabled = () => offered() && textEnrolled();

  const onClick = () => {
    if (!offered()) return; // unsupported shell or paused by the server — no-op
    openModal({ type: "e2ee_enable" });
  };

  return (
    <Show when={switchKnown()}>
      <CategoryButton.Group>
        <CategoryButton
          // Greyed out only when this device cannot encrypt at all (or the
          // server has paused it). The always-on state is informational rather
          // than disabled: it has no click handler, so it renders without the
          // link cursor.
          disabled={!offered()}
          action={
            <Show
              when={enabled()}
              fallback={
                <span style={{ "pointer-events": "none", display: "flex" }}>
                  <Checkbox checked={false} />
                </span>
              }
            >
              <MdLock {...iconSize(20)} />
            </Show>
          }
          icon={<MdVideocam {...iconSize(24)} />}
          description={
            <Show
              when={offered()}
              fallback={
                <Show
                  when={pausedByServer()}
                  fallback={
                    <Trans>
                      Encrypted calls aren't available on this device yet.
                    </Trans>
                  }
                >
                  <Trans>
                    Encrypted calls on iPhone are paused right now. Calls on
                    this device are not encrypted.
                  </Trans>
                </Show>
              }
            >
              <Show
                when={enabled()}
                fallback={
                  <Trans>
                    Set up secure device keys to encrypt your calls. Web
                    participants can't join encrypted calls, and server features
                    that need the raw audio or video (recording, transcoding)
                    are turned off in encrypted calls.
                  </Trans>
                }
              >
                <Trans>
                  Always on. Your voice and video are end-to-end encrypted on
                  this device whenever everyone in the call supports it.
                </Trans>
              </Show>
            </Show>
          }
          onClick={enabled() ? undefined : onClick}
        >
          <Show when={enabled()} fallback={<Trans>Encrypt my calls</Trans>}>
            <Trans>Calls are end-to-end encrypted</Trans>
          </Show>
        </CategoryButton>
      </CategoryButton.Group>
    </Show>
  );
}

/**
 * End-to-end encryption opt-in for this device (implementation plan slice 3).
 */
function EncryptionCard() {
  const e2ee = useE2EE();
  const { openModal } = useModals();

  if (!e2ee) return null;

  const state = () => e2ee.status.get("state");
  const enabled = () => !!state()?.enabled && !!state()?.published;

  return (
    <CategoryButton.Group>
      <CategoryButton
        // A checkbox as a pure indicator (clicks pass through to the row via
        // pointer-events:none), so it always reflects the real native status
        // and never desyncs on a cancelled flow. The row toggles: checked →
        // disable flow, unchecked → enable flow.
        action={
          <span style={{ "pointer-events": "none", display: "flex" }}>
            <Checkbox checked={enabled()} />
          </span>
        }
        icon={<MdLock {...iconSize(24)} />}
        description={
          enabled() ? (
            <Trans>
              Direct messages with contacts who also have encryption on are
              end-to-end encrypted on this device. Encrypted history is stored
              only here — uncheck to turn encryption off on this device.
            </Trans>
          ) : (
            <Trans>
              Turn on end-to-end encrypted direct messages for this device.
            </Trans>
          )
        }
        // Keys that were never registered (D3) finish setup rather than
        // starting the opt-in again.
        onClick={() =>
          openModal({
            type: enabled()
              ? "e2ee_disable"
              : e2ee.publishPending.get("state")
                ? "e2ee_finish_setup"
                : "e2ee_enable",
          })
        }
      >
        <Switch>
          <Match when={enabled()}>
            <Trans>Encrypted messaging is on</Trans>
          </Match>
          <Match when={!enabled()}>
            <Trans>Encrypted direct messages</Trans>
          </Match>
        </Switch>
      </CategoryButton>
    </CategoryButton.Group>
  );
}

/**
 * Encrypted-only chats, an account setting. Shown only while the server
 * advertises it. Off: the row opens the guided setup (disabled while the
 * server does not offer it). On: the row opens the leave flow. A device
 * still latched after the setting was turned off elsewhere offers to turn
 * it off here too, or on again.
 */
function EncryptedOnlyCard() {
  const { t } = useLingui();
  const client = useClient();
  const snackbar = useSnackbar();
  const { openModal, isOpen } = useModals();
  const advert = useOnlyAdvert();
  // The servers' refusal is stated only while they enforce it
  const enforced = () => advert()?.enforced === true;

  const state = () =>
    onlyCardState({
      advert: advert(),
      userKnown: !!client().user,
      latched: latchedForClient(client().user?.id),
      serverOn: client().user?.e2eeOnly === true,
      // The setup latches before the server answers
      settingUp: isOpen("encrypted_only_onboarding"),
    });

  /**
   * Share the invite to turn on encryption: the share sheet, or else the
   * clipboard with a toast. A desktop shell always copies. Settings render
   * in the main window, where the snackbar is.
   */
  async function shareInvite() {
    const outcome = await shareInviteText(
      t`Sloga's servers refuse unencrypted direct messages to me. To message me, turn on encryption in the Sloga app: Settings > Encryption.`,
      browserShareDeps(desktopShell()),
    );
    const shown = inviteOutcomeShown(outcome, true);
    if (!shown) return;
    snackbar.show({
      message:
        shown.kind === "copied"
          ? t`Invite copied to the clipboard.`
          : t`Could not copy to the clipboard.`,
      placement: "bottom",
      closeable: true,
    });
  }

  return (
    <Show when={state() !== "hidden"}>
      <CategoryButton.Group>
        <CategoryButton
          disabled={state() === "unavailable"}
          action={
            <span style={{ "pointer-events": "none", display: "flex" }}>
              <Checkbox checked={state() === "on"} />
            </span>
          }
          icon={<MdLock {...iconSize(24)} />}
          description={
            <Switch>
              <Match when={state() === "on"}>
                <Trans>On for your account.</Trans>{" "}
                <Show when={enforced()}>
                  <Trans>
                    Sloga's servers refuse unencrypted direct messages to you,
                    and nobody can add you to an unencrypted group.
                  </Trans>{" "}
                </Show>
                <Trans>
                  Other people can see that you only accept encrypted messages.
                </Trans>
              </Match>
              <Match when={state() === "turned-off-elsewhere"}>
                <Trans>Turned off on another device</Trans>.{" "}
                <Trans>
                  This device still only sends encrypted messages. Turn it off
                  here too, or turn it on again for your account.
                </Trans>
              </Match>
              <Match when={state() === "unavailable"}>
                <Trans>Not available on this server yet.</Trans>
              </Match>
              <Match when={state() === "off"}>
                <Trans>
                  Only send encrypted direct messages and group messages from
                  this account.
                </Trans>
                <Show when={enforced()}>
                  {" "}
                  <Trans>
                    Sloga's servers refuse unencrypted direct messages to you,
                    and nobody can add you to an unencrypted group.
                  </Trans>
                </Show>
              </Match>
            </Switch>
          }
          onClick={() => {
            const current = state();
            if (current === "on") {
              openModal({ type: "encrypted_only_leave" });
            } else if (current === "off") {
              openModal({ type: "encrypted_only_onboarding" });
            }
          }}
        >
          <Trans>Encrypted-only chats</Trans>
        </CategoryButton>

        <Show when={state() === "turned-off-elsewhere"}>
          <CategoryButton
            icon={<MdWarning {...iconSize(24)} />}
            action="chevron"
            onClick={() =>
              openModal({ type: "encrypted_only_leave", elsewhere: true })
            }
          >
            <Trans>Turn off on this device too</Trans>
          </CategoryButton>
          <CategoryButton
            icon="blank"
            action="chevron"
            onClick={() => openModal({ type: "encrypted_only_onboarding" })}
          >
            <Trans>Turn on again</Trans>
          </CategoryButton>
        </Show>

        <Show when={cardOffersInvite(state(), advert())}>
          <CategoryButton
            icon={<MdShare {...iconSize(24)} />}
            action="chevron"
            onClick={() => void shareInvite()}
          >
            <Trans>Share invite</Trans>
          </CategoryButton>
        </Show>
      </CategoryButton.Group>
      <Text class="label">
        <Trans>
          A device restored from a recovery code has no backup of its own until
          you make a new recovery code.
        </Trans>
      </Text>
    </Show>
  );
}

/**
 * Recovery-code key backup (implementation plan slice 5.5). Lives directly
 * beneath the encryption toggle because a backup is only meaningful once
 * encryption is on. The recovery CODE is shown/entered only in the native
 * recovery window — never here. Rotate and delete are re-auth-gated (MFA),
 * matching the wipe flow; create needs no MFA (the upload is device-bound).
 *
 * Protected channels (design 8.5): under the backup rows, what the last
 * bundle the server kept left out of the protected channel history, and
 * what the last restore on this device could not bring back. Both come
 * from `backupTextLines`; nothing is shown for a bundle or a restore that
 * reported nothing.
 */
function RecoveryBackupCard() {
  const e2ee = useE2EE();
  const client = useClient();
  const { mfaFlow, showError } = useModals();

  if (!e2ee) return null;

  const enabled = () => {
    const state = e2ee.status.get("state");
    return !!state?.enabled && !!state?.published;
  };

  const [status, setStatus] = createSignal<BackupStatusView | undefined>();
  const [busy, setBusy] = createSignal(false);

  async function reload() {
    if (!e2ee || !enabled()) return;
    try {
      setStatus(await e2ee.backupStatus());
    } catch (error) {
      console.error("[e2ee] backup status failed", error);
    }
  }

  onMount(reload);

  /** Prove account ownership; returns the MFA ticket token or undefined. */
  async function reauth(): Promise<string | undefined> {
    const mfa = await client().account.mfa();
    const ticket = await mfaFlow(mfa);
    return ticket?.token;
  }

  async function create() {
    if (!e2ee) return;
    setBusy(true);
    try {
      await e2ee.createRecoveryCode();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
      // The native window couriers the upload asynchronously; refresh soon.
      setTimeout(reload, 500);
    }
  }

  async function rotate() {
    if (!e2ee) return;
    setBusy(true);
    try {
      const token = await reauth();
      if (!token) return;
      await e2ee.rotateRecoveryCode();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
      setTimeout(reload, 500);
    }
  }

  async function remove() {
    if (!e2ee) return;
    setBusy(true);
    try {
      const token = await reauth();
      if (!token) return;
      await e2ee.deleteBackup(token);
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
      void reload();
    }
  }

  /**
   * §6.4 durable re-enroll (design §8 HIGH-1). A device whose server-side
   * identity row was revoked while it was dead (typically after a restore) is
   * stranded receive-broken — its keys are `published=true` locally but the
   * server has no row, so it must re-publish as a first publication. This is the
   * PERSISTENT recovery entry — shown whenever the bridge has `reenrollNeeded`
   * armed, which survives a dismissed auto-modal and a restart (re-raised on
   * reconnect by the bridge's `#onClaimResult` re-detection). It re-auths and
   * re-publishes the restored keys as a first publication; deliberately NOT a
   * one-shot.
   */
  async function finishRestore() {
    if (!e2ee) return;
    // Flag already cleared (re-enrolled elsewhere / accepted claim) — don't
    // burn an MFA prompt on a stale affordance.
    if (!e2ee.reenrollNeeded.get("state")) return;
    setBusy(true);
    try {
      const token = await reauth();
      if (!token) return;
      await e2ee.finishReenroll(token);
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
      setTimeout(reload, 500);
    }
  }

  const hasBackup = () => !!status()?.exists;
  const reenrollNeeded = () => !!e2ee.reenrollNeeded.get("state");

  // The server's history setting flag: off, the backup says nothing about
  // protected channel history.
  const historyFlag = () => e2ee.protectedFlag().historySetting === true;
  const bundleLines = () =>
    backupTextLines(
      e2ee.backupText.get("state")?.truncated,
      undefined,
      historyFlag(),
    );

  // The last restore's summary is recorded by the enable dialog, which can
  // run while this page is open.
  const [restoreText, setRestoreText] = createSignal({
    text: lastRestoreText(e2ee),
  });
  onCleanup(
    onRestoreText(() => setRestoreText({ text: lastRestoreText(e2ee) })),
  );
  const restoreLines = () =>
    backupTextLines(undefined, restoreText().text, historyFlag());

  return (
    <>
      {/*
       * §6.4 durable re-enroll entry. Its own `<Show>` (independent of
       * `enabled()`) because it must appear whenever the bridge has
       * `reenrollNeeded` armed. NB a stranded restored device is `published=
       * true` (restore imports the source's published flag), so `enabled()` is
       * ALSO true for it — the re-enroll entry and the backup-management block
       * below are mutually exclusive via `!reenrollNeeded()` there, so a strand
       * shows only this recovery affordance (design §8 HIGH-1).
       */}
      <Show when={reenrollNeeded()}>
        <CategoryButton.Group>
          <CategoryButton
            icon={<MdKey {...iconSize(24)} />}
            disabled={busy()}
            description={
              <Trans>
                This device was logged out remotely, so it must be re-registered
                before it can send and receive encrypted messages again. Confirm
                your identity to finish — your contacts will see it come back
                with no security warning, because its keys are unchanged.
              </Trans>
            }
            onClick={() => void finishRestore()}
          >
            <Trans>Finish restoring on this device</Trans>
          </CategoryButton>
        </CategoryButton.Group>
      </Show>

      <Show when={enabled() && !reenrollNeeded()}>
        <CategoryButton.Group>
          <CategoryButton
            icon={<MdKey {...iconSize(24)} />}
            disabled={busy()}
            description={
              hasBackup() ? (
                <>
                  <Trans>
                    You have a recovery code. Anyone with this code and access
                    to your account can read your message history — Sloga cannot
                    recover it for you. Choose "Change recovery code" to replace
                    it.
                  </Trans>{" "}
                  <Trans>
                    This changes the recovery code for this device's backup
                    only.
                  </Trans>
                </>
              ) : (
                <Trans>
                  Without a recovery code, your encrypted messages cannot be
                  restored if you lose this device. Create one and store it
                  somewhere safe.
                </Trans>
              )
            }
            onClick={() => (hasBackup() ? void rotate() : void create())}
          >
            <Switch>
              <Match when={hasBackup()}>
                <Trans>Change recovery code</Trans>
              </Match>
              <Match when={!hasBackup()}>
                <Trans>Create a recovery code</Trans>
              </Match>
            </Switch>
          </CategoryButton>

          <Show when={hasBackup()}>
            <CategoryButton
              icon={<MdKey {...iconSize(24)} />}
              disabled={busy()}
              description={
                <Trans>
                  Remove the backup stored on the server. Your encrypted history
                  on this device is unaffected.
                </Trans>
              }
              onClick={() => void remove()}
            >
              <Trans>Delete backup</Trans>
            </CategoryButton>
          </Show>
        </CategoryButton.Group>
        <Show when={historyFlag()}>
          <Text class="label">{backupNoteCopy.textBudget()}</Text>
        </Show>
        <Show when={hasBackup()}>
          <For each={bundleLines()}>
            {(kind) => <Text class="label">{backupTextCopy(kind)}</Text>}
          </For>
        </Show>
      </Show>

      <For each={restoreLines()}>
        {(kind) => <Text class="label">{backupTextCopy(kind)}</Text>}
      </For>
    </>
  );
}
