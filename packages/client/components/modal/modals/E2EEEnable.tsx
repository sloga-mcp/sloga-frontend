import { Match, Show, Switch, createSignal } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";

import { useClient, useE2EE } from "@revolt/client";
import { Column, Dialog, DialogProps, Text } from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

/**
 * Opt in to end-to-end encryption on THIS device (implementation plan
 * slice 3, item 1) — now also the restore-vs-start-fresh gate for a returning
 * user on a new device (slice 5.5, design §6.1).
 *
 * The consent gate is the MFA-gated key publish inside the native layer —
 * NOT the `e2ee_enabled` profile flag (a pure UI hint, invariant 2). The
 * start-fresh flow: generate the device identity natively → MFA ticket →
 * publish keys under that ticket → mark published → claim the device.
 *
 * The RESTORE flow (design §6.1) is offered as an explicit choice BEFORE
 * minting a fresh identity, because the two branches are mutually exclusive:
 * restore recovers the old device's identity + history from a server backup
 * and must run as the FIRST E2EE op on this fresh install, whereas start-fresh
 * provisions a new identity (after which restore would refuse,
 * `StoreAlreadyProvisioned`). Each branch takes exactly one MFA prompt (the
 * choice is presented up front rather than probing `GET /e2ee/backup` first,
 * which would burn a single-use ticket for users who just want to start
 * fresh). The recovery CODE is entered only on the native surface (the
 * bundled recovery window on desktop / a native dialog from the Capacitor
 * E2ee plugin on Android and iOS) — it never reaches this webview;
 * `restoreFromBackup` only couriers opaque ciphertext.
 *
 * Restore REPLACES a device, it never adds one: the backup carries the old
 * device's identity and device_id unchanged (design §2, §6.4). If the old
 * install is still running, both installs share one device. The account's own
 * fan-out skips that device id, so neither install receives what the other
 * sends, and a peer's message opens only on whichever install drains it first.
 * So the restore button opens a warning step first ("Only restore if that
 * device no longer runs Sloga"), and that step offers Start fresh as the way
 * to add a device. Only the warning step's button calls restore().
 */
export function E2EEEnableModal(
  props: DialogProps & Modals & { type: "e2ee_enable" },
) {
  const { t } = useLingui();
  const client = useClient();
  const e2ee = useE2EE();
  const { mfaFlow, showError } = useModals();

  const [busy, setBusy] = createSignal(false);
  const [done, setDone] = createSignal(false);
  // Restore was attempted but the account had no backup for this device — let
  // the user fall back to starting fresh instead of surfacing a hard error.
  const [noBackup, setNoBackup] = createSignal(false);
  // The restore button was pressed: say what restore does to the other device
  // before anything runs (design §6.4).
  const [confirmRestore, setConfirmRestore] = createSignal(false);

  /** Prove account ownership; returns the MFA ticket token or undefined. */
  async function reauth(): Promise<string | undefined> {
    const mfa = await client().account.mfa();
    const ticket = await mfaFlow(mfa);
    return ticket?.token;
  }

  async function enable() {
    if (!e2ee) return;
    setBusy(true);
    try {
      // MFA ticket gates the server-side key publication (the real consent
      // gate). The user proves account ownership before any device binds.
      const token = await reauth();
      if (!token) {
        setBusy(false);
        return;
      }

      await e2ee.enable(token);
      // Provisioned now — clear the returning-device prompt signal so the
      // shell never re-offers restore for this (now non-fresh) install.
      e2ee.restoreAvailable.delete("state");
      setDone(true);
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }

  async function restore() {
    if (!e2ee) return;
    setBusy(true);
    setNoBackup(false);
    try {
      // One MFA ticket gates `GET /e2ee/backup` (the restoring device has no
      // keys yet, so it cannot be device-bound — design §5). The native
      // surface then drives code entry + the atomic store rebuild.
      const token = await reauth();
      if (!token) {
        setBusy(false);
        return;
      }

      const count = await e2ee.restoreFromBackup(token);
      if (count === 0) {
        // No blob for this account (or the native surface was dismissed).
        // Keep the dialog open so the user can start fresh instead.
        setConfirmRestore(false);
        setNoBackup(true);
        setBusy(false);
        return;
      }

      // Desktop: the recovery WINDOW is now open and drives code entry +
      // republish asynchronously (the completion courier lives in the bridge).
      // Capacitor (Android, iOS): the native dialog already restored before
      // resolving (a cancel there returned 0 above). Either way this device
      // is on its way to provisioned — close the prompt.
      e2ee.restoreAvailable.delete("state");
      props.onClose();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }

  const leadRestore = () => !!props.offerRestore;

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title={
        confirmRestore() && !done() ? (
          <Trans>Restoring replaces your other device</Trans>
        ) : leadRestore() && !done() ? (
          <Trans>Restore your encrypted messages</Trans>
        ) : (
          <Trans>Turn on encrypted direct messages</Trans>
        )
      }
      isDisabled={busy()}
      actions={
        done()
          ? [
              {
                text: <Trans>Create recovery code</Trans>,
                onClick: () => {
                  // Never a silent no-op. Desktop (Tauri, Electron) opens the
                  // bundled recovery window, and the bridge uploads the bundle
                  // when it closes. Capacitor (Android, and iOS with its
                  // native E2ee plugin) shows a native dialog and uploads the
                  // bundle on return; cancelling it resolves quietly. Any
                  // other failure, including a shell that lacks the command
                  // or plugin method (Capacitor rejects UNIMPLEMENTED), lands
                  // in showError. With no native layer there is no bridge and
                  // enable() bails before this button can show. If the user
                  // skips or cancels, the Encryption settings card keeps
                  // offering to create one.
                  void e2ee?.createRecoveryCode().catch((error) =>
                    showError(error),
                  );
                  props.onClose();
                },
              },
              { text: <Trans>Skip for now</Trans>, onClick: () => props.onClose() },
            ]
          : confirmRestore()
            ? [
                {
                  text: <Trans>Back</Trans>,
                  onClick: () => {
                    setConfirmRestore(false);
                    return false;
                  },
                  isDisabled: busy(),
                },
                {
                  text: <Trans>Start fresh</Trans>,
                  onClick: () => {
                    void enable();
                    return false;
                  },
                  isDisabled: busy(),
                },
                {
                  text: <Trans>Restore and replace</Trans>,
                  onClick: () => {
                    void restore();
                    return false;
                  },
                  isDisabled: busy(),
                  destructive: true,
                },
              ]
            : [
                {
                  text: <Trans>Cancel</Trans>,
                  onClick: () => {
                    props.onClose();
                    return false;
                  },
                },
                {
                  text: <Trans>Restore from a recovery code</Trans>,
                  onClick: () => {
                    setNoBackup(false);
                    setConfirmRestore(true);
                    return false;
                  },
                  isDisabled: busy(),
                },
                {
                  text: leadRestore() ? (
                    <Trans>Start fresh</Trans>
                  ) : (
                    <Trans>Turn on</Trans>
                  ),
                  onClick: () => {
                    void enable();
                    return false;
                  },
                  isDisabled: busy(),
                },
              ]
      }
    >
      <Column>
        <Switch>
          <Match when={done()}>
            <Text>
              <Trans>
                Encrypted direct messages are on for this device. Messages you
                send in an encrypted conversation are stored only on the
                devices that receive them — not on the server, and not in your
                web session.
              </Trans>
            </Text>
            <Text>
              <Trans>
                Create a recovery code so you can restore your identity and
                message history if you lose this device. Without one, encrypted
                history is gone for good if the device is lost. You can also do
                this later from Settings › Privacy & Safety › Encryption.
              </Trans>
            </Text>
          </Match>
          <Match when={confirmRestore()}>
            <Text>
              <Trans>
                A recovery code moves the encryption identity of the device that
                created it onto this one. It does not add a second device.
              </Trans>
            </Text>
            <Text>
              <Trans>
                Only restore if that device no longer runs Sloga — it was lost,
                wiped or replaced. If both keep running, some encrypted messages
                will open on only one of them and encrypted calls may not
                connect.
              </Trans>
            </Text>
            <Text>
              <Trans>
                To use encryption here and keep using your other device, choose
                Start fresh instead.
              </Trans>
            </Text>
          </Match>
          <Match when={leadRestore()}>
            <Text>
              <Trans>
                You have encryption set up on your account. If the device that
                holds it was lost, wiped or replaced, restore your recovery code
                here to move your identity and message history onto this device
                — your contacts will not see a security warning.
              </Trans>
            </Text>
            <Text>
              <Trans>
                Still using that device? Start fresh to set this up as a new
                device alongside it. You keep sending and receiving encrypted
                messages on both, but earlier history stays on the other device.
              </Trans>
            </Text>
          </Match>
          <Match when={!leadRestore()}>
            <Text>
              <Trans>
                New direct messages with contacts who also have encryption on
                will be end-to-end encrypted. Only your devices can read them —
                the server relays ciphertext it cannot decrypt.
              </Trans>
            </Text>
            <Text>
              <Trans>
                Replacing a lost or wiped device? Choose "Restore from a
                recovery code" to move its identity and history here. Otherwise,
                encrypted history lives on THIS device only and cannot be
                recovered if the device is lost. You will confirm your identity
                to continue.
              </Trans>
            </Text>
          </Match>
        </Switch>

        <Show when={noBackup()}>
          <Text>
            <Trans>
              No recovery backup was found for your account, or the recovery
              window was closed. You can start fresh instead.
            </Trans>
          </Text>
        </Show>
      </Column>
    </Dialog>
  );
}
