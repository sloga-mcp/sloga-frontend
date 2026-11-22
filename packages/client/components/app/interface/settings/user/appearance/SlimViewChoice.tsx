import { Show, createMemo } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";

import { useClient } from "@revolt/client";
import { deviceStateOf } from "@revolt/client/encryptedOnlyGuard";
import { latchedForClient } from "@revolt/client/encryptedOnlyLatch";
import { useSlimOffered } from "@revolt/client/useSlimMode";
import { useModals } from "@revolt/modal";
import { useOnlyAdvert } from "@revolt/modal/modals/EncryptedOnlyOnboarding";
import { onlyCardState } from "@revolt/modal/modals/encryptedOnlySetup";
import { useVoice } from "@revolt/rtc";
import { useState } from "@revolt/state";
import { Button, Checkbox, Text } from "@revolt/ui";

/**
 * Slim view on or off, for this device: the layout that shows chats and
 * calls and hides servers. The stored setting is `appearance:slim_view`;
 * whether it takes effect is `useSlimMode`'s answer, not this row's.
 *
 * The row shows where Slim view is offered (the Android and iOS apps, never
 * a staff account), and also wherever the setting is already on, so it can
 * always be switched off. A staff account that has it stored sees the row
 * for that reason only: Slim view stays inactive for it either way.
 *
 * It cannot be changed during a call: the box is disabled while one is up,
 * with a line under it saying so.
 *
 * Under it sits a short offer of Encrypted-only chats (`EncryptedOnlyOffer`).
 */
export function SlimViewChoice() {
  const state = useState();
  const voice = useVoice();
  const offered = useSlimOffered();

  const enabled = () =>
    state.settings.getValue("appearance:slim_view") === true;

  const visible = () => offered() || enabled();

  // The call card's own test for being in a call (`VoiceCallCard.tsx`): the
  // channel is set from the moment a call starts connecting until it is
  // hung up, through any reconnect, for DMs, groups and server voice alike.
  const inCall = () => !!voice.channel();

  return (
    <Show when={visible()}>
      <Checkbox
        checked={enabled()}
        disabled={inCall()}
        onChange={(event) => {
          // A disabled checkbox sends no change. Should one arrive anyway,
          // put the box back and leave the setting alone.
          if (inCall()) {
            event.currentTarget.checked = enabled();
            return;
          }

          state.settings.setValue(
            "appearance:slim_view",
            event.currentTarget.checked,
          );
        }}
      >
        <Trans>Slim view (beta)</Trans>
      </Checkbox>
      <Text class="label" size="small">
        <Trans>
          Shows only your chats and calls. Servers are hidden, not left. Server
          notifications and the app icon's unread count can still include
          servers. Turn Slim view off to see servers again.
        </Trans>
      </Text>
      <Show when={inCall()}>
        <Text class="label" size="small">
          <Trans>You can't change Slim view during a call.</Trans>
        </Text>
      </Show>
      <EncryptedOnlyOffer />
    </Show>
  );
}

/**
 * A short offer of Encrypted-only chats under the Slim view choice. Shown
 * only in an app (never on the website), while the server offers the
 * setting and this account does not have it on. The button opens the
 * guided setup, which does the rest.
 */
function EncryptedOnlyOffer() {
  const client = useClient();
  const { openModal, isOpen } = useModals();
  const advert = useOnlyAdvert();

  // The settings card's own states: "off" is the one that opens the setup
  const shown = createMemo(
    () =>
      deviceStateOf(client()) !== "web" &&
      onlyCardState({
        advert: advert(),
        userKnown: !!client().user,
        latched: latchedForClient(client().user?.id),
        serverOn: client().user?.e2eeOnly === true,
        settingUp: isOpen("encrypted_only_onboarding"),
      }) === "off",
  );

  return (
    <Show when={shown()}>
      <Text class="label" size="small">
        <Trans>Encrypted-only chats</Trans>:{" "}
        <Trans>
          Only send encrypted direct messages and group messages from this
          account.
        </Trans>
      </Text>
      <div>
        <Button
          size="sm"
          onPress={() => openModal({ type: "encrypted_only_onboarding" })}
        >
          <Trans>Set up Encrypted-only chats</Trans>
        </Button>
      </div>
    </Show>
  );
}
