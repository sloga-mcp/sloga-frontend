import { For, Show, createResource, createSignal } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";

import type { SafetyNumber } from "@revolt/client";
import { useClient, useE2EE } from "@revolt/client";
import { Column, Dialog, DialogProps, Text } from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

/**
 * Safety-number verification screen (implementation plan slice 5, design §3).
 *
 * The real defense behind TOFU pinning: today trust rests on the server
 * honestly attributing (device → identity). Comparing safety numbers in
 * person upgrades a pinned device to user-verified — after which any identity
 * change on it takes the heavier accept path.
 *
 * Scope note (design §3.1): verification defends against key substitution on
 * a KNOWN device. It does NOT decide group membership — who is in a group is
 * a separate, server-visible trust surface. The copy says so.
 *
 * The number is computed natively from PINNED keys only (a server swapping
 * bundles cannot change it) and only the digits cross the IPC — never key
 * bytes.
 */
export function E2EEVerifyModal(
  props: DialogProps & Modals & { type: "e2ee_verify" },
) {
  const { t } = useLingui();
  const client = useClient();
  const e2ee = useE2EE();
  const { showError } = useModals();

  const [busy, setBusy] = createSignal(false);

  const peer = () => client().users.get(props.peerUserId);

  const [state, { refetch }] = createResource(
    () => props.peerUserId,
    async (peerUserId) => {
      const conv = await e2ee?.conversationState(peerUserId);
      if (!conv) return [];
      // A safety number can be computed only for a device whose identity
      // binding is signature-proven (both key types pinned).
      const verifiable = conv.devices.filter(
        (d) => d.status !== "revoked" && d.binding_verified,
      );
      const out: Array<{ device_id: string; number: SafetyNumber }> = [];
      for (const device of verifiable) {
        try {
          out.push({
            device_id: device.device_id,
            number: await e2ee!.safetyNumber(peerUserId, device.device_id),
          });
        } catch {
          /* skip devices we cannot yet number (e.g. no ed25519 pinned) */
        }
      }
      return out;
    },
  );

  async function markVerified(deviceId: string) {
    if (!e2ee) return;
    setBusy(true);
    try {
      await e2ee.markVerified(props.peerUserId, deviceId);
      await refetch();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Per-conversation downgrade to plaintext (design §5.2). The native layer
   * shows a BLOCKING OS confirmation; declining aborts cleanly. Reachable
   * from here — the "manage this conversation's encryption" surface.
   */
  async function turnOff() {
    if (!e2ee) return;
    const channel = [...client().channels.values()].find(
      (c) =>
        c.type === "DirectMessage" && c.recipientIds.has(props.peerUserId),
    );
    if (!channel) return;
    setBusy(true);
    try {
      await e2ee.downgradeConversation(channel);
      props.onClose();
    } catch (error) {
      if ((error as { type?: string })?.type !== "declined") showError(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title={<Trans>Verify security</Trans>}
      isDisabled={busy()}
      actions={[{ text: <Trans>Close</Trans>, onClick: () => props.onClose() }]}
    >
      <Column>
        <Text>
          <Trans>
            Compare these numbers with {peer()?.username ?? t`your contact`} in
            person or over a call you trust. If they match on both devices, your
            messages are private to the two of you.
          </Trans>
        </Text>

        <Show
          when={state()?.length}
          fallback={
            <Text>
              <Trans>
                No verifiable devices yet — send or receive an encrypted message
                first, then reopen this screen.
              </Trans>
            </Text>
          }
        >
          <For each={state()}>
            {(entry) => (
              <Column
                gap="sm"
                style={{
                  padding: "12px 14px",
                  "border-radius": "10px",
                  border: "1px solid var(--md-sys-color-outline-variant)",
                  background: "var(--md-sys-color-surface-container-high)",
                }}
              >
                <span
                  style={{
                    "font-family": "monospace",
                    "font-size": "1.05em",
                    "letter-spacing": "0.04em",
                    "word-spacing": "0.3em",
                  }}
                >
                  {entry.number.digits}
                </span>
                <div
                  style={{
                    display: "flex",
                    "align-items": "center",
                    "justify-content": "space-between",
                    gap: "10px",
                  }}
                >
                  <span
                    style={{
                      "font-family": "monospace",
                      "font-size": "0.75em",
                      opacity: "0.7",
                    }}
                  >
                    {entry.device_id.slice(0, 12)}…
                  </span>
                  <Show
                    when={!entry.number.user_verified}
                    fallback={
                      <span style={{ color: "#2FBF71", "font-weight": "600" }}>
                        <Trans>Verified</Trans>
                      </span>
                    }
                  >
                    <button
                      disabled={busy()}
                      onClick={() => void markVerified(entry.device_id)}
                      style={{
                        padding: "6px 12px",
                        "border-radius": "8px",
                        border: "none",
                        background: "var(--md-sys-color-primary)",
                        color: "var(--md-sys-color-on-primary)",
                        cursor: busy() ? "default" : "pointer",
                        "font-weight": "600",
                      }}
                    >
                      <Trans>Mark as verified</Trans>
                    </button>
                  </Show>
                </div>
              </Column>
            )}
          </For>
        </Show>

        <Text size="small">
          <Trans>
            Verifying protects against someone swapping this contact's keys. In
            group chats, remember that who is in the group is managed by the
            server — watch the member list.
          </Trans>
        </Text>

        <button
          disabled={busy()}
          onClick={() => void turnOff()}
          style={{
            "align-self": "flex-start",
            padding: "6px 12px",
            "border-radius": "8px",
            border: "1px solid var(--md-sys-color-outline-variant)",
            background: "transparent",
            color: "var(--md-sys-color-error)",
            cursor: busy() ? "default" : "pointer",
            "font-weight": "500",
          }}
        >
          <Trans>Turn off encryption for this conversation</Trans>
        </button>
      </Column>
    </Dialog>
  );
}
