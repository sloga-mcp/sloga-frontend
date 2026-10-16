import { For, Show, createResource, createSignal } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import type { SafetyNumber } from "@revolt/client";
import { useClient, useE2EE } from "@revolt/client";
import { nativeE2EEAvailable } from "@revolt/client/e2ee";
import { resolveDmConversation } from "@revolt/client/e2eeSelfDm";
import { Column, Dialog, DialogProps, Text } from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

import {
  IdentityConfirmNotice,
  IdentityConfirmStep,
  identityConfirmErrorStep,
  identityConfirmOutcomeStep,
  identityConfirmRefetches,
  offersMarkVerified,
} from "./e2eeIdentityConfirm.copy";

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
 *
 * This screen is not the gate. On the native shells "Mark as verified"
 * opens a system dialog that shows the safety number for that device; that
 * dialog is the confirm, and native commits only the keys it showed.
 */
export function E2EEVerifyModal(
  props: DialogProps & Modals & { type: "e2ee_verify" },
) {
  const { t } = useLingui();
  const client = useClient();
  const e2ee = useE2EE();
  const { showError } = useModals();

  const [busy, setBusy] = createSignal(false);
  const [notice, setNotice] = createSignal<IdentityConfirmNotice | null>(null);

  const peer = () => client().users.get(props.peerUserId);

  const [state, { refetch }] = createResource(
    () => props.peerUserId,
    async (peerUserId) => {
      const conv = await e2ee?.conversationState(peerUserId);
      if (!conv) return [];
      // A safety number can be computed only for a device whose identity
      // binding is signature-proven (both key types pinned), and only an
      // Active pin can be marked verified: an identity-changed device is
      // accepted first, on its own screen.
      const verifiable = conv.devices.filter(offersMarkVerified);
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

  function noticeText(shown: IdentityConfirmNotice): string {
    switch (shown) {
      case "busy":
        return t`Try again in a moment.`;
      case "keys_changed":
        return t`The keys changed while the system dialog was open. Check them again.`;
      default: {
        const exhaustive: never = shown;
        return exhaustive;
      }
    }
  }

  async function markVerified(deviceId: string) {
    if (!e2ee) return;
    setBusy(true);
    setNotice(null);
    let step: IdentityConfirmStep;
    try {
      step = identityConfirmOutcomeStep(
        await e2ee.markVerified(props.peerUserId, deviceId),
      );
    } catch (error) {
      // A decline is the user's answer, not an error: only a real failure
      // reaches showError
      step = identityConfirmErrorStep(error);
      if (step.kind === "error") showError(error);
    }
    try {
      if (identityConfirmRefetches(step)) await refetch();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
    if (step.kind === "stay") setNotice(step.notice);
  }

  /**
   * Per-conversation downgrade to plaintext (design §5.2). The native layer
   * shows a BLOCKING OS confirmation; declining aborts cleanly. Reachable
   * from here — the "manage this conversation's encryption" surface.
   */
  async function turnOff() {
    if (!e2ee) return;
    // Never our own id: every DM contains it, so a plain recipient lookup
    // would pick (and offer to downgrade) the first DM in the cache.
    const found = resolveDmConversation(
      props.peerUserId,
      client().user?.id,
      client().channels.values(),
    );
    if (found.kind !== "existing") return;
    const channel = found.channel;
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
              <Show
                when={props.context === "call"}
                fallback={
                  <Trans>
                    No verifiable devices yet — send or receive an encrypted
                    message first, then reopen this screen.
                  </Trans>
                }
              >
                <Trans>
                  This participant's device is not verified yet. Compare safety
                  numbers in person to verify them.
                </Trans>
              </Show>
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

        <Show when={notice()}>
          {(shown) => <NoticeText>{noticeText(shown())}</NoticeText>}
        </Show>

        <Show
          when={
            nativeE2EEAvailable() &&
            state()?.some((entry) => !entry.number.user_verified)
          }
        >
          <Text size="small">
            <Trans>You'll confirm this in a system dialog.</Trans>
          </Text>
        </Show>

        <Text size="small">
          <Trans>
            Verifying protects against someone swapping this contact's keys. In
            group chats, remember that who is in the group is managed by the
            server — watch the member list.
          </Trans>
        </Text>

        {/* FE-10: the DM-only downgrade button is hidden in call context —
            it no-ops without a DM channel and is dangerously adjacent in
            meaning to the whole-call downgrade. */}
        <Show when={props.context !== "call"}>
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
        </Show>
      </Column>
    </Dialog>
  );
}

const NoticeText = styled("span", {
  base: {
    color: "var(--md-sys-color-error)",
  },
});
