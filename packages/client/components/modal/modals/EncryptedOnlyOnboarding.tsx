import { Capacitor } from "@capacitor/core";
import {
  type Accessor,
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
} from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import type { Channel, Client } from "stoat.js";

import { useClient, useE2EE } from "@revolt/client";
import { recoveryPollMs } from "@revolt/client/e2eePlatform";
import {
  buildPlainWriteInput,
  deviceStateOf,
} from "@revolt/client/encryptedOnlyGuard";
import {
  clearLatch,
  latchAccountId,
  latchedForClient,
  setLatch,
} from "@revolt/client/encryptedOnlyLatch";
import { useError } from "@revolt/i18n";
import { Checkbox, Column, Dialog, DialogProps, Text } from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

import {
  type BackupSnapshot,
  type OnlyAdvert,
  classifyRouteFailure,
  groupsToLeave,
  isUnencryptedGroup,
  keepLatchAfterFailure,
  parseOnlyAdvert,
  recoveryCodeMadeThisRun,
  turnOnPrecheck,
} from "./encryptedOnlySetup";

/** How long the recovery step keeps re-reading on its own. */
const RECOVERY_POLL_FOR_MS = 15 * 60 * 1000;

/**
 * The server's Encrypted-only advert, read from `GET /` once on mount
 * (`client.configuration` may still be the app's local stub). `undefined`
 * while loading; `null` when the server does not know the feature. A
 * failed fetch falls back to `client.configuration`.
 * @returns Accessor
 */
export function useOnlyAdvert(): Accessor<OnlyAdvert | null | undefined> {
  const client = useClient();
  const [advert, setAdvert] = createSignal<OnlyAdvert | null | undefined>();
  let live = true;
  onCleanup(() => {
    live = false;
  });

  onMount(() => {
    client()
      .api.get("/")
      .then((root: unknown) => {
        if (live) setAdvert(parseOnlyAdvert(root));
      })
      .catch(() => {
        if (live) setAdvert(parseOnlyAdvert(client().configuration));
      });
  });

  return advert;
}

/** Prove account ownership; returns the MFA ticket token or undefined. */
async function reauth(
  client: Client,
  mfaFlow: ReturnType<typeof useModals>["mfaFlow"],
): Promise<string | undefined> {
  const mfa = await client.account.mfa();
  const ticket = await mfaFlow(mfa);
  return ticket?.token;
}

/**
 * The account's flag as the server holds it now, for when the route's reply
 * was lost. A full user object leaves the field out when it is false.
 * @returns The flag, or `undefined` when it could not be read
 */
async function readServerFlag(client: Client): Promise<boolean | undefined> {
  try {
    const me: unknown = await client.api.get("/users/@me");
    if (typeof me !== "object" || me === null) return undefined;
    return (me as { e2ee_only?: unknown }).e2ee_only === true;
  } catch {
    return undefined;
  }
}

/** Clear the latch for the session's account and the server's, if they differ. */
function clearLatchFor(client: Client): void {
  const account = latchAccountId(client.user?.id);
  clearLatch(account);
  if (client.user?.id && client.user.id !== account) clearLatch(client.user.id);
}

/** Groups the user was already in that stay unencrypted, read now. */
function unencryptedGroupsOf(client: Client): Channel[] {
  return [...client.channels.values()].filter(
    (channel) =>
      channel.type === "Group" &&
      isUnencryptedGroup(buildPlainWriteInput(client, channel)),
  );
}

type Step = "explain" | "device" | "groups" | "recovery" | "finish" | "done";

/**
 * Turn on Encrypted-only chats: explain what changes → set up encryption on
 * this device if needed → choose what happens to each unencrypted group
 * (listed once this device has learned which groups already send
 * encrypted) → make a recovery code (required) → check the server and the
 * device → ticket → latch → route. Groups the user chose to leave are left
 * only once the setting is on.
 */
export function EncryptedOnlyOnboardingModal(
  props: DialogProps & Modals & { type: "encrypted_only_onboarding" },
) {
  const { t } = useLingui();
  const client = useClient();
  const e2ee = useE2EE();
  const { openModal, mfaFlow, showError } = useModals();
  const describe = useError();
  const advert = useOnlyAdvert();
  // The servers' refusal is stated only while they enforce it
  const enforced = () => advert()?.enforced === true;
  // Android and iPhone show the code in a dialog that can be cancelled;
  // the desktop window saves it even when closed
  const cancellableDialog = Capacitor.isNativePlatform();

  let live = true;
  onCleanup(() => {
    live = false;
  });

  // A recovery code counts only if it was made after this moment
  const runStartedAt = Math.floor(Date.now() / 1000);

  const [step, setStep] = createSignal<Step>("explain");
  const [busy, setBusy] = createSignal(false);
  const [leaving, setLeaving] = createSignal<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = createSignal<string>();
  const [leaveFailed, setLeaveFailed] = createSignal<string[]>([]);

  // Every backup status read is behind this, as on the Encryption page
  const enabled = () => {
    const state = e2ee?.status.get("state");
    return !!state?.enabled && !!state?.published;
  };
  const deviceReady = () =>
    !!e2ee &&
    deviceStateOf(client()) === "ready" &&
    !e2ee.publishPending.get("state") &&
    !e2ee.deviceRemoved.get("state") &&
    !e2ee.reenrollNeeded.get("state");

  const groups = createMemo(() => unencryptedGroupsOf(client()));
  const groupIds = () => groups().map((group) => group.id);

  // Learn which groups already send encrypted from this device, so they are
  // not listed as unencrypted. Runs once the device is ready; the list is
  // shown only after this finished.
  const [primed, setPrimed] = createSignal(false);
  let priming = false;
  createEffect(() => {
    if (!e2ee || !deviceReady() || priming) return;
    priming = true;
    const ids = untrack(() =>
      [...client().channels.values()]
        .filter((channel) => channel.type === "Group")
        .map((channel) => channel.id),
    );
    void (async () => {
      for (const id of ids) {
        if (!live) return;
        await e2ee.primeGroupMode(id).catch(() => {});
      }
      if (live) setPrimed(true);
    })();
  });

  function toggleLeave(channelId: string, leave: boolean) {
    const next = new Set(leaving());
    if (leave) next.add(channelId);
    else next.delete(channelId);
    setLeaving(next);
  }

  // Recovery code (required)
  const [backup, setBackup] = createSignal<BackupSnapshot>();
  const [recoveryStarted, setRecoveryStarted] = createSignal(false);
  // A create or rotate has not settled yet (a bridge whose status reads
  // block the main thread pauses the polling then; none does today)
  const [minting, setMinting] = createSignal(false);
  const recoveryDone = () => recoveryCodeMadeThisRun(backup(), runStartedAt);
  // A code was made during this setup (here or in the enable dialog) and
  // its upload may still be on the way
  const recoveryPending = () =>
    !recoveryDone() &&
    (recoveryStarted() ||
      (backup()?.exists === true &&
        (backup()?.createdAt ?? 0) >= runStartedAt));

  async function readBackup(): Promise<BackupSnapshot | undefined> {
    // Nothing reaches native unless this device is set up
    if (!e2ee || !enabled() || !deviceReady()) return undefined;
    try {
      const status = await e2ee.backupStatus();
      setBackup(status);
      return status;
    } catch (error) {
      console.error("[e2ee-only] backup status failed", error);
      return undefined;
    }
  }

  async function makeRecoveryCode() {
    if (busy() || !e2ee || !enabled() || !deviceReady()) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const before = await e2ee.backupStatus();
      if (before.exists) {
        // A backup made before this setup does not count: replace its code.
        // Re-auth as the settings card does for a rotate.
        const token = await reauth(client(), mfaFlow);
        if (!token) return;
      }
      setMinting(true);
      try {
        if (before.exists) await e2ee.rotateRecoveryCode();
        else await e2ee.createRecoveryCode();
      } finally {
        setMinting(false);
      }
      setRecoveryStarted(true);
      await readBackup();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }

  // The desktop recovery window uploads after it closes: keep re-reading
  // while waiting on this step, every 3 s. Where each read would block the
  // shell's main thread (`backupCommandsBlockMainThread`; no shipped bridge
  // since Tauri's backup commands went async): none while a create or rotate
  // runs, and at most every 15 s after (`recoveryPollMs`)
  createEffect(() => {
    if (step() !== "recovery" || !recoveryPending()) return;
    const every = recoveryPollMs({
      blocksMainThread: e2ee?.backupCommandsBlockMainThread ?? true,
      minting: minting(),
    });
    if (every === null) return;
    const until = Date.now() + RECOVERY_POLL_FOR_MS;
    const timer = setInterval(() => {
      if (Date.now() > until) {
        clearInterval(timer);
        return;
      }
      void readBackup();
    }, every);
    onCleanup(() => clearInterval(timer));
  });

  onMount(() => {
    void readBackup();
  });

  function openDeviceSetup() {
    if (!e2ee) return;
    openModal({
      type: e2ee.deviceRemoved.get("state")
        ? "e2ee_device_removed"
        : e2ee.reenrollNeeded.get("state")
          ? "e2ee_reenroll"
          : e2ee.publishPending.get("state")
            ? "e2ee_finish_setup"
            : "e2ee_enable",
    });
  }

  function goToRecovery() {
    setNotice(undefined);
    setStep("recovery");
    void readBackup();
  }

  function goOn() {
    setNotice(undefined);
    if (!deviceReady()) {
      setStep("device");
      return;
    }
    if (!primed() || groups().length > 0) {
      setStep("groups");
      return;
    }
    goToRecovery();
  }

  // Ticked groups still listed now
  const toLeave = () => groupsToLeave(leaving(), groupIds());

  async function leaveChosenGroups(current: Client) {
    const failed: string[] = [];
    // Read again now: a ticked group that turned out to be encrypted stays
    const listed = unencryptedGroupsOf(current).map((group) => group.id);
    for (const id of groupsToLeave(leaving(), listed)) {
      const channel: Channel | undefined = current.channels.get(id);
      if (!channel || channel.type !== "Group") continue;
      try {
        await channel.delete();
      } catch (error) {
        console.error("[e2ee-only] leaving a group failed", error);
        failed.push(channel.name ?? id);
      }
    }
    setLeaveFailed(failed);
  }

  async function turnOn() {
    if (busy()) return;
    const current = client();
    setBusy(true);
    setNotice(undefined);
    let routeCalled = false;
    try {
      // Checked before the ticket: the server burns it before the request
      let fresh: OnlyAdvert | null = null;
      try {
        fresh = parseOnlyAdvert(await current.api.get("/"));
      } catch {
        fresh = null;
      }
      const block = turnOnPrecheck({
        advert: fresh,
        deviceReady: deviceReady(),
      });
      if (block === "unavailable") {
        setNotice(
          t`Encrypted-only chats isn't available on this server right now.`,
        );
        return;
      }
      if (block === "device") {
        setNotice(
          t`Finish setting up encryption on this device to use your chats.`,
        );
        return;
      }
      if (!recoveryDone()) {
        setStep("recovery");
        return;
      }

      const token = await reauth(current, mfaFlow);
      if (!token) return;

      const latchWasOn = latchedForClient(current.user?.id);
      // The latch goes on before the route, so nothing plain slips out
      // while it runs
      setLatch(latchAccountId(current.user?.id));

      let serverOn: boolean | undefined;
      let failure: unknown;
      routeCalled = true;
      try {
        serverOn = await current.setEncryptedOnly(true, token);
      } catch (error) {
        failure = error;
        serverOn = await readServerFlag(current);
      }

      if (serverOn === true) {
        await leaveChosenGroups(current);
        setStep("done");
        return;
      }

      // Cleared only when the server is known to have it off
      if (
        !keepLatchAfterFailure(
          latchWasOn,
          serverOn,
          current.user?.e2eeOnly === true,
        )
      ) {
        clearLatchFor(current);
      }

      const lead =
        serverOn === undefined
          ? t`Sloga couldn't confirm whether Encrypted-only chats turned on. For now, this device only sends encrypted messages.`
          : t`Encrypted-only chats was not turned on.`;
      switch (failure === undefined ? "other" : classifyRouteFailure(failure)) {
        case "unavailable":
          setNotice(
            `${lead} ${t`Encrypted-only chats isn't available on this server right now.`}`,
          );
          break;
        case "device":
          setNotice(
            `${lead} ${t`Finish setting up encryption on this device to use your chats.`}`,
          );
          break;
        case "ticket":
          setNotice(
            `${lead} ${t`Your identity check didn't go through. Try again.`}`,
          );
          break;
        default:
          setNotice(
            failure === undefined ? lead : `${lead} ${describe(failure)}`,
          );
      }
    } catch (error) {
      // The latch is left as it is: before the route it was not set here,
      // after it the route's outcome already decided it
      console.error("[e2ee-only] turning on failed", error);
      setNotice(
        routeCalled
          ? describe(error)
          : `${t`Encrypted-only chats was not turned on.`} ${describe(error)}`,
      );
    } finally {
      setBusy(false);
    }
  }

  const close = () => {
    if (!busy()) props.onClose();
  };

  const actions = () => {
    switch (step()) {
      case "explain":
        return [
          { text: <Trans>Cancel</Trans> },
          {
            text: <Trans>Continue</Trans>,
            onClick: () => {
              goOn();
              return false;
            },
          },
        ];
      case "device":
        return [
          { text: <Trans>Cancel</Trans> },
          {
            text: <Trans>Turn on encryption</Trans>,
            onClick: () => {
              openDeviceSetup();
              return false;
            },
            isDisabled: deviceReady(),
          },
          {
            text: <Trans>Continue</Trans>,
            onClick: () => {
              goOn();
              return false;
            },
            isDisabled: !deviceReady(),
          },
        ];
      case "groups":
        return [
          { text: <Trans>Cancel</Trans> },
          {
            text: <Trans>Continue</Trans>,
            onClick: () => {
              goToRecovery();
              return false;
            },
            isDisabled: !primed(),
          },
        ];
      case "recovery":
        return [
          { text: <Trans>Cancel</Trans> },
          ...(recoveryPending()
            ? [
                {
                  text: <Trans>Check again</Trans>,
                  onClick: () => {
                    void readBackup();
                    return false;
                  },
                },
              ]
            : []),
          ...(recoveryDone()
            ? []
            : [
                {
                  text: backup()?.exists ? (
                    <Trans>Change recovery code</Trans>
                  ) : (
                    <Trans>Create recovery code</Trans>
                  ),
                  onClick: () => {
                    void makeRecoveryCode();
                    return false;
                  },
                  isDisabled: busy(),
                },
              ]),
          {
            text: <Trans>Continue</Trans>,
            onClick: () => {
              setNotice(undefined);
              setStep("finish");
              return false;
            },
            isDisabled: !recoveryDone(),
          },
        ];
      case "finish":
        return [
          { text: <Trans>Cancel</Trans> },
          {
            text: <Trans>Turn on</Trans>,
            onClick: () => {
              void turnOn();
              return false;
            },
            isDisabled: busy(),
          },
        ];
      case "done":
        return [{ text: <Trans>Done</Trans> }];
    }
  };

  return (
    <Dialog
      show={props.show}
      onClose={close}
      title={<Trans>Encrypted-only chats</Trans>}
      isDisabled={busy()}
      actions={actions()}
    >
      <Column>
        <Show
          when={e2ee}
          fallback={
            <Text>
              <Trans>
                Open the Sloga app to read and send encrypted chats.
              </Trans>
            </Text>
          }
        >
          <Switch>
            <Match when={step() === "explain"}>
              <Text>
                <Trans>
                  You will only send encrypted direct messages and group
                  messages from this account. Channels in servers work as
                  before.
                </Trans>
              </Text>
              <Show when={enforced()}>
                <Text>
                  <Trans>
                    Sloga's servers refuse unencrypted direct messages to you,
                    and nobody can add you to an unencrypted group.
                  </Trans>
                </Text>
              </Show>
              <Text>
                <Trans>
                  Groups you were already in stay unencrypted for other members
                  until the group is encrypted or you leave.
                </Trans>
              </Text>
              <Show when={enforced()}>
                <Text>
                  <Trans>
                    Older Sloga apps on your other devices are stopped by
                    Sloga's servers, not by the app itself. Update them.
                  </Trans>
                </Text>
              </Show>
              <Text>
                <Trans>
                  Calls in direct messages and groups are not covered by this
                  setting.
                </Trans>
              </Text>
              <Text>
                <Trans>
                  Message content is encrypted. Names, group names, descriptions
                  and pictures, who is in a group and when messages are sent are
                  not.
                </Trans>
              </Text>
              <Text>
                <Trans>
                  Other people can see that you only accept encrypted messages.
                </Trans>
              </Text>
              <Text>
                <Trans>Encrypted files can be up to 20 MB.</Trans>
              </Text>
              <Text class="label">
                <Trans>
                  You need encryption on this device and a recovery code. You
                  will confirm your identity before it turns on.
                </Trans>
              </Text>
            </Match>

            <Match when={step() === "groups"}>
              <Switch>
                <Match when={!primed()}>
                  <Text>
                    <Trans>Checking your groups.</Trans>
                  </Text>
                </Match>
                <Match when={groups().length === 0}>
                  <Text>
                    <Trans>You are not in any unencrypted groups.</Trans>
                  </Text>
                </Match>
                <Match when={groups().length > 0}>
                  <Text class="label">
                    <Trans>Your unencrypted groups</Trans>
                  </Text>
                  <Text>
                    <Trans>
                      Tick a group to leave it once Encrypted-only chats is on.
                      Groups you keep become read-only for you.
                    </Trans>
                  </Text>
                  <For each={groups()}>
                    {(group) => (
                      <Checkbox
                        checked={leaving().has(group.id)}
                        onChange={(event) =>
                          toggleLeave(group.id, event.currentTarget.checked)
                        }
                      >
                        {group.name}
                      </Checkbox>
                    )}
                  </For>
                </Match>
              </Switch>
            </Match>

            <Match when={step() === "device"}>
              <Show
                when={deviceReady()}
                fallback={
                  <Text>
                    <Trans>
                      Turn on encryption on this device first. You will confirm
                      your identity.
                    </Trans>
                  </Text>
                }
              >
                <Text>
                  <Trans>Encryption is on for this device.</Trans>
                </Text>
              </Show>
            </Match>

            <Match when={step() === "recovery"}>
              <Text>
                <Trans>
                  Make a recovery code. You need it to restore this device's
                  encrypted backup. The backup holds what was on this device
                  when the code was made. This step can't be skipped.
                </Trans>
              </Text>
              <Switch>
                <Match when={recoveryDone()}>
                  <Text class="label">
                    <Trans>
                      Your recovery code was made and its backup is saved on
                      Sloga's servers. Keep the code somewhere safe.
                    </Trans>
                  </Text>
                </Match>
                <Match when={recoveryPending()}>
                  <Text class="label">
                    <Trans>Waiting for your recovery code.</Trans>
                    <Show when={cancellableDialog}>
                      {" "}
                      <Trans>If you cancelled it, make it again.</Trans>
                    </Show>
                  </Text>
                </Match>
              </Switch>
            </Match>

            <Match when={step() === "finish"}>
              <Text>
                <Trans>
                  Last step: confirm your identity to turn on Encrypted-only
                  chats.
                </Trans>
              </Text>
              <Show when={toLeave().length > 0}>
                <Text>
                  <Trans>Once it is on, you leave the groups you ticked.</Trans>
                </Text>
              </Show>
            </Match>

            <Match when={step() === "done"}>
              <Text>
                <Trans>Encrypted-only chats is on.</Trans>
              </Text>
              <For each={leaveFailed()}>
                {(name) => (
                  <Text>
                    {t`Could not leave ${name}. You can leave it from the group's menu.`}
                  </Text>
                )}
              </For>
            </Match>
          </Switch>

          <Show when={notice()}>
            <Text class="label">{notice()}</Text>
          </Show>
        </Show>
      </Column>
    </Dialog>
  );
}

/**
 * Turn Encrypted-only chats off: confirm → ticket → route → clear this
 * device's latch, only after the server said off. Works on the website.
 * `elsewhere`: it was already turned off on another device and this device
 * is still latched.
 */
export function EncryptedOnlyLeaveModal(
  props: DialogProps & Modals & { type: "encrypted_only_leave" },
) {
  const { t } = useLingui();
  const client = useClient();
  const { mfaFlow } = useModals();
  const describe = useError();

  const [busy, setBusy] = createSignal(false);
  const [notice, setNotice] = createSignal<string>();

  async function turnOff() {
    const current = client();
    setBusy(true);
    setNotice(undefined);
    try {
      const token = await reauth(current, mfaFlow);
      if (!token) return;

      const value = await current.setEncryptedOnly(false, token);
      if (value !== false) {
        setNotice(t`Encrypted-only chats is still on. Try again.`);
        return;
      }

      clearLatchFor(current);
      props.onClose();
    } catch (error) {
      // The latch stays on: the server did not confirm
      const lead = t`Encrypted-only chats is still on.`;
      setNotice(
        classifyRouteFailure(error) === "ticket"
          ? `${lead} ${t`Your identity check didn't go through. Try again.`}`
          : `${lead} ${describe(error)}`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      show={props.show}
      onClose={() => {
        if (!busy()) props.onClose();
      }}
      title={
        props.elsewhere ? (
          <Trans>Turn off on this device too?</Trans>
        ) : (
          <Trans>Turn off Encrypted-only chats?</Trans>
        )
      }
      isDisabled={busy()}
      actions={[
        { text: <Trans>Cancel</Trans> },
        {
          text: <Trans>Turn off</Trans>,
          onClick: () => {
            void turnOff();
            return false;
          },
          isDisabled: busy(),
          destructive: true,
        },
      ]}
    >
      <Column>
        <Show
          when={props.elsewhere}
          fallback={
            <>
              <Text>
                <Trans>
                  Sloga's servers will accept unencrypted direct messages to you
                  again, and people can add you to unencrypted groups.
                </Trans>
              </Text>
              <Text>
                <Trans>
                  Your contacts' apps may show that you turned it off.
                </Trans>
              </Text>
            </>
          }
        >
          <Text>
            <Trans>
              Encrypted-only chats was turned off on another device. This device
              still only sends encrypted messages until you turn it off here
              too.
            </Trans>
          </Text>
        </Show>
        <Text>
          <Trans>Chats that are already encrypted stay encrypted.</Trans>
        </Text>
        <Text class="label">
          <Trans>You will confirm your identity to continue.</Trans>
        </Text>
        <Show when={notice()}>
          <Text class="label">{notice()}</Text>
        </Show>
      </Column>
    </Dialog>
  );
}
