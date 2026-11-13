import { Show } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";

import { useSlimOffered } from "@revolt/client/useSlimMode";
import { useVoice } from "@revolt/rtc";
import { useState } from "@revolt/state";
import { Checkbox, Text } from "@revolt/ui";

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
    </Show>
  );
}
