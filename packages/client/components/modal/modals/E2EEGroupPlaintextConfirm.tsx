import {
  Match,
  Show,
  Switch,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { useClient, useE2EE } from "@revolt/client";
import { useError } from "@revolt/i18n";
import { Column, Dialog, DialogProps, Text } from "@revolt/ui";

import { Modals } from "../types";

type PromptKind = "unconfirmed" | "unestablished";

/**
 * The native refusals that mean the group's state moved after the prompt
 * was shown: `reason` = encrypted traffic arrived (unconfirmed became
 * unestablished), `conversation_id` = the group became established. Both
 * are answered by re-reading the state, never by retrying the ack.
 */
function isStateChanged(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const native = error as { type?: unknown; field?: unknown };
  return (
    native.type === "invalid_argument" &&
    (native.field === "reason" || native.field === "conversation_id")
  );
}

/**
 * Plaintext confirm for a group this device holds no encryption state for
 * (design §11).
 *
 * The copy and the `expected` value both come from a FRESH native verdict
 * read on open, so the user acknowledges exactly the state they were shown
 * and the native layer refuses the ack if it moved in between. This protects
 * against an honest server and client state loss; a malicious server can
 * still pass the device-listing proof for any device that has no row for
 * the group (a fresh device, or one never delivered `group_enable`).
 * Confirm records the ack and closes; it never resends, so the user
 * presses send again.
 */
export function E2EEGroupPlaintextConfirmModal(
  props: DialogProps & Modals & { type: "e2ee_group_plaintext_confirm" },
) {
  const client = useClient();
  const e2ee = useE2EE();
  const err = useError();

  // undefined = loading, or the state could not be read: nothing to confirm
  const [kind, setKind] = createSignal<PromptKind>();
  const [busy, setBusy] = createSignal(false);
  // Boxed so a falsy rejection value still shows
  const [error, setError] = createSignal<{ value: unknown }>();

  let live = true;
  onCleanup(() => (live = false));

  // Proof first: a group the device-listing proof clears needs no ack (an
  // ack is permanent), so null closes and the next send goes through. Only
  // then the bare verdict picks the copy. Throws on native error.
  async function readKind(): Promise<PromptKind | null> {
    const channel = client().channels.get(props.channelId);
    if (!e2ee || !channel) return null;
    const mode = await e2ee.sendModeNowFor(channel, { proof: true });
    if (mode === "plaintext") return null;
    return e2ee.groupPlaintextPromptKind(props.channelId);
  }

  async function load() {
    try {
      const fresh = await readKind();
      if (!live) return;
      if (fresh === null) props.onClose();
      else setKind(fresh);
    } catch (reason) {
      if (live) setError({ value: reason });
    }
  }

  onMount(() => void load());

  // Returned (as a Promise) from the action onClick: Dialog closes on
  // resolve and STAYS OPEN on reject, so every path that must keep the
  // prompt up rethrows.
  async function confirm() {
    const expected = kind();
    if (!e2ee || !expected) throw new Error("group state not loaded");

    setBusy(true);
    setError(undefined);
    try {
      await e2ee.acknowledgeGroupPlaintext(props.channelId, expected);
    } catch (refusal) {
      if (!isStateChanged(refusal)) {
        setError({ value: refusal });
        throw refusal;
      }

      let fresh: PromptKind | null;
      try {
        fresh = await readKind();
      } catch (reread) {
        // The shown copy may be stale now, so take the confirm away.
        setKind(undefined);
        setError({ value: reread });
        throw reread;
      }

      // Nothing left to acknowledge (the group became established, or the
      // proof now clears it)
      if (fresh === null) return;

      setKind(fresh);
      throw refusal;
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title={
        <Switch>
          <Match when={kind() === "unconfirmed"}>
            <Trans>Send unencrypted?</Trans>
          </Match>
          <Match when={kind() === "unestablished"}>
            <Trans>This group may be encrypted</Trans>
          </Match>
        </Switch>
      }
      isDisabled={busy()}
      actions={[
        {
          text: <Trans>Cancel</Trans>,
        },
        {
          text: <Trans>Allow unencrypted</Trans>,
          onClick: confirm,
          isDisabled: !kind() || busy(),
        },
      ]}
    >
      <Column>
        <Switch>
          <Match when={kind() === "unconfirmed"}>
            <Text>
              <Trans>
                This device can't confirm this group is unencrypted. Other
                members may have turned on encryption. Send unencrypted?
              </Trans>
            </Text>
          </Match>
          <Match when={kind() === "unestablished"}>
            <Text>
              <Trans>
                Encrypted messages for this group reached this device, but it
                doesn't have the group's keys. Anything you send now is
                unencrypted, and members using encryption won't see it.
              </Trans>
            </Text>
          </Match>
        </Switch>

        <Show when={kind()}>
          <Text>
            <Trans>
              If you allow it, messages and files you send to this group from
              this device won't be end-to-end encrypted and can be read by the
              server. This device will remember this choice for this group.
              Nothing has been sent yet.
            </Trans>
          </Text>
        </Show>

        <Show when={error()}>
          {(shown) => <ErrorText>{err(shown().value)}</ErrorText>}
        </Show>
      </Column>
    </Dialog>
  );
}

const ErrorText = styled("span", {
  base: {
    color: "var(--md-sys-color-error)",
  },
});
