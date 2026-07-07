import { For, Show, createResource, createSignal } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";

import { useClient, useE2EE } from "@revolt/client";
import { Column, Dialog, DialogProps, Text } from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

/**
 * Peer identity-change warning + explicit acceptance (implementation plan
 * slice 3, item 4; assumption crypto-2).
 *
 * A pinned contact presented different identity keys — a reinstall, or a
 * server-side key substitution attempt. Sending is BLOCKED (fail closed)
 * until the user explicitly accepts, which is the ONLY unblock path.
 * Acceptance tears down old sessions and re-handshakes; the user is told to
 * verify out-of-band first.
 */
export function E2EEIdentityChangeModal(
  props: DialogProps & Modals & { type: "e2ee_identity_change" },
) {
  const { t } = useLingui();
  const client = useClient();
  const e2ee = useE2EE();
  const { showError } = useModals();

  const [busy, setBusy] = createSignal(false);

  const peer = () => client().users.get(props.peerUserId);

  const [state, { refetch }] = createResource(
    () => props.peerUserId,
    (peerUserId) => e2ee?.conversationState(peerUserId),
  );

  const changedDevices = () =>
    state()?.devices.filter((d) => d.status === "identity_changed") ?? [];

  async function accept(deviceId: string) {
    if (!e2ee) return;
    setBusy(true);
    try {
      await e2ee.acceptIdentityChange(props.peerUserId, deviceId);
      await refetch();
      if (changedDevices().length === 0) props.onClose();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title={<Trans>Security identity changed</Trans>}
      isDisabled={busy()}
      actions={[{ text: <Trans>Close</Trans>, onClick: () => props.onClose() }]}
    >
      <Column>
        <Text>
          <Trans>
            The security identity for {peer()?.username ?? t`this contact`}{" "}
            changed. This happens when they reinstall or set up a new device —
            but it can also mean someone is attempting to intercept your
            messages.
          </Trans>
        </Text>
        <Text>
          <Trans>
            Verify the change with them through another channel before you
            continue. Accepting trusts the new identity and resumes sending;
            past encrypted messages are unaffected.
          </Trans>
        </Text>

        <Show
          when={changedDevices().length}
          fallback={
            <Text>
              <Trans>No pending identity changes remain.</Trans>
            </Text>
          }
        >
          <For each={changedDevices()}>
            {(device) => (
              <button
                disabled={busy()}
                onClick={() => void accept(device.device_id)}
                style={{
                  display: "flex",
                  "align-items": "center",
                  "justify-content": "space-between",
                  gap: "12px",
                  padding: "10px 14px",
                  "border-radius": "10px",
                  border: "1px solid var(--md-sys-color-outline-variant)",
                  background: "var(--md-sys-color-surface-container-high)",
                  cursor: busy() ? "default" : "pointer",
                  "text-align": "left",
                }}
              >
                <span
                  style={{
                    "font-family": "monospace",
                    "font-size": "0.8em",
                    opacity: "0.8",
                  }}
                >
                  {device.device_id.slice(0, 16)}…
                </span>
                <span style={{ "font-weight": "600", color: "#FF8A00" }}>
                  <Trans>Accept new identity</Trans>
                </span>
              </button>
            )}
          </For>
        </Show>
      </Column>
    </Dialog>
  );
}
