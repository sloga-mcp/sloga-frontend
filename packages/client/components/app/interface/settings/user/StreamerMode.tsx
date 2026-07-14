import { JSX, Show } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";

import { useState } from "@revolt/state";
import type { TypeSettings } from "@revolt/state/stores/Settings";
import {
  detectedStreamingApp,
  streamerModeActive,
} from "@revolt/state/streamer";
import { CategoryButton, Checkbox, Column, Text } from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

/**
 * Streamer Mode settings page — hide personal information while streaming
 * on YouTube, Twitch, etc.
 */
export function StreamerModeSettings() {
  const state = useState();

  return (
    <Column gap="lg">
      <CategoryButton.Group>
        <ToggleSetting
          key="streamer:enabled"
          icon={<Symbol size={22}>videocam</Symbol>}
          title={<Trans>Enable Streamer Mode</Trans>}
          description={
            <Trans>
              Hide personal details, invite links, notifications and sounds
              while you are live.
            </Trans>
          }
        />
        <Show when={window.native}>
          <ToggleSetting
            key="streamer:auto_detect"
            icon={<Symbol size={22}>sensors</Symbol>}
            title={<Trans>Automatically enable</Trans>}
            description={
              <Trans>
                Turn Streamer Mode on while a streaming app (OBS, Streamlabs,
                XSplit, ...) is running.
              </Trans>
            }
          />
        </Show>
      </CategoryButton.Group>

      <Show when={detectedStreamingApp()}>
        <Text class="label">
          <Trans>Streaming app detected: {detectedStreamingApp()}</Trans>
        </Text>
      </Show>
      <Show when={streamerModeActive(state.settings)}>
        <Text class="label">
          <Trans>Streamer Mode is currently active.</Trans>
        </Text>
      </Show>

      <CategoryButton.Group>
        <ToggleSetting
          key="streamer:hide_personal"
          icon={<Symbol size={22}>visibility_off</Symbol>}
          title={<Trans>Hide personal information</Trans>}
          description={
            <Trans>Keep your email address masked in account settings.</Trans>
          }
        />
        <ToggleSetting
          key="streamer:hide_invites"
          icon={<Symbol size={22}>link_off</Symbol>}
          title={<Trans>Hide invite links</Trans>}
          description={
            <Trans>
              Hide invites in chat and blur newly created invite links so
              viewers can't join your servers.
            </Trans>
          }
        />
        <ToggleSetting
          key="streamer:disable_notifications"
          icon={<Symbol size={22}>notifications_off</Symbol>}
          title={<Trans>Disable notifications</Trans>}
          description={
            <Trans>
              Suppress desktop notification popups so messages don't appear on
              stream.
            </Trans>
          }
        />
        <ToggleSetting
          key="streamer:disable_sounds"
          icon={<Symbol size={22}>volume_off</Symbol>}
          title={<Trans>Disable sounds</Trans>}
          description={
            <Trans>Mute message, call and notification sounds.</Trans>
          }
        />
      </CategoryButton.Group>
    </Column>
  );
}

/**
 * A single boolean Streamer Mode setting rendered as a category button
 * with a checkbox.
 */
function ToggleSetting(props: {
  key: keyof TypeSettings & `streamer:${string}`;
  icon: JSX.Element;
  title: JSX.Element;
  description: JSX.Element;
}) {
  const state = useState();

  return (
    <CategoryButton
      icon={props.icon}
      description={props.description}
      action={
        <Checkbox
          checked={(state.settings.getValue(props.key) as boolean) ?? false}
          onChange={(event) =>
            state.settings.setValue(props.key, event.currentTarget.checked)
          }
        />
      }
      onClick={() =>
        state.settings.setValue(props.key, !state.settings.getValue(props.key))
      }
    >
      {props.title}
    </CategoryButton>
  );
}
