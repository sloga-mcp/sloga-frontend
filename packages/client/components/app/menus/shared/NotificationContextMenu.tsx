import { For, Match, Show, Switch } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import dayjs from "dayjs";
import { Channel } from "stoat.js";

import {
  type DmPreviewMode,
  DM_PREVIEW_DEFAULT,
  isDmPreviewMode,
} from "@revolt/client/notificationPreviewPolicy";
import { IS_POPOUT_WINDOW } from "@revolt/client/popout";
import { channelNounOf } from "@revolt/common/lib/channelNoun";
import { useState } from "@revolt/state";
import { Column, Text, Time } from "@revolt/ui";

import MdAlternateEmail from "@material-design-icons/svg/outlined/alternate_email.svg?component-solid";
import MdNotificationsActive from "@material-design-icons/svg/outlined/notifications_active.svg?component-solid";
import MdNotificationsOff from "@material-design-icons/svg/outlined/notifications_off.svg?component-solid";

import MdDoNotDisturbOff from "@material-symbols/svg-400/outlined/do_not_disturb_off.svg?component-solid";
import MdDoNotDisturbOn from "@material-symbols/svg-400/outlined/do_not_disturb_on.svg?component-solid";
import MdNotificationSettings from "@material-symbols/svg-400/outlined/notification_settings.svg?component-solid";
import MdPerson from "@material-symbols/svg-400/outlined/person.svg?component-solid";
import MdPreview from "@material-symbols/svg-400/outlined/preview.svg?component-solid";
import MdQuickreply from "@material-symbols/svg-400/outlined/quickreply.svg?component-solid";
import MdRadioButtonChecked from "@material-symbols/svg-400/outlined/radio_button_checked-fill.svg?component-solid";
import MdRadioButtonUnchecked from "@material-symbols/svg-400/outlined/radio_button_unchecked.svg?component-solid";
import MdVisibilityOff from "@material-symbols/svg-400/outlined/visibility_off.svg?component-solid";

import { ContextMenuButton, ContextMenuSubMenu } from "../ContextMenu";

export function NotificationContextMenu(props: { channel: Channel }) {
  const state = useState();

  /**
   * Noun the channel goes by in the mute labels; DMs, groups and server
   * channels resolve to "channel" and keep the original strings
   */
  const noun = () => channelNounOf(props.channel);

  /**
   * Message previews are a DM and group chat setting only. The override is
   * also hidden in the friends popout: settings are not synced between
   * windows, so a write there would be clobbered by, or clobber, the main
   * window's copy.
   */
  const showPreviewOverride = () =>
    !IS_POPOUT_WINDOW &&
    (props.channel.type === "DirectMessage" || props.channel.type === "Group");

  /**
   * The mode this conversation follows when it has no override of its own
   */
  const globalPreviewMode = (): DmPreviewMode => {
    const value = state.settings.getValue("notifications:dm_preview");
    return isDmPreviewMode(value) ? value : DM_PREVIEW_DEFAULT;
  };

  /**
   * This conversation's own pick, if any
   */
  const previewOverride = (): DmPreviewMode | undefined => {
    const value = state.settings.getValue(
      "notifications:dm_preview_overrides",
    )?.[props.channel.id];
    return isDmPreviewMode(value) ? value : undefined;
  };

  /**
   * Save this conversation's override, keeping every other conversation's.
   *
   * Clearing writes `undefined` for this channel rather than deleting the key
   * from a copy: the settings store merges an object written over an object,
   * so a missing key would survive, while one set to `undefined` is removed.
   * @param mode Mode to use here, or undefined to follow the global setting
   */
  function setPreviewOverride(mode: DmPreviewMode | undefined) {
    state.settings.setValue("notifications:dm_preview_overrides", {
      ...state.settings.getValue("notifications:dm_preview_overrides"),
      [props.channel.id]: mode,
    } as Record<string, DmPreviewMode>);
  }

  return (
    <>
      <Show
        when={!state.notifications.isChannelMuted(props.channel)}
        fallback={
          <ContextMenuButton
            onClick={() =>
              state.notifications.setChannelMute(props.channel, undefined)
            }
            symbol={MdDoNotDisturbOff}
            _titleCase={false}
          >
            <Column gap="none">
              <Switch fallback={<Trans>Unmute Channel</Trans>}>
                <Match when={noun() === "post"}>
                  <Trans>Unmute Post</Trans>
                </Match>
                <Match when={noun() === "thread"}>
                  <Trans>Unmute Thread</Trans>
                </Match>
              </Switch>
              <Show
                when={state.notifications.getChannelMute(props.channel)?.until}
              >
                <Text class="label" size="small">
                  <Trans>
                    Muted until{" "}
                    <Time
                      format="datetime"
                      value={
                        state.notifications.getChannelMute(props.channel)!.until
                      }
                    />
                  </Trans>
                </Text>
              </Show>
            </Column>
          </ContextMenuButton>
        }
      >
        <ContextMenuSubMenu
          onClick={() => state.notifications.setChannelMute(props.channel, {})}
          buttonContent={
            <Switch fallback={<Trans>Mute Channel</Trans>}>
              <Match when={noun() === "post"}>
                <Trans>Mute Post</Trans>
              </Match>
              <Match when={noun() === "thread"}>
                <Trans>Mute Thread</Trans>
              </Match>
            </Switch>
          }
          symbol={MdDoNotDisturbOn}
        >
          <For
            each={
              [
                [15, <Trans>For 15 minutes</Trans>],
                [60, <Trans>For 1 hour</Trans>],
                [180, <Trans>For 3 hours</Trans>],
                [480, <Trans>For 8 hours</Trans>],
                [1440, <Trans>For 24 hours</Trans>],
                [undefined, <Trans>Until I turn it back on</Trans>],
              ] as const
            }
          >
            {([timeMin, i18n]) => (
              <ContextMenuButton
                onClick={() =>
                  state.notifications.setChannelMute(props.channel, {
                    until: timeMin
                      ? +dayjs().add(timeMin, "minutes")
                      : undefined,
                  })
                }
                _titleCase={false}
              >
                {i18n}
              </ContextMenuButton>
            )}
          </For>
        </ContextMenuSubMenu>
      </Show>

      <ContextMenuSubMenu
        symbol={MdNotificationSettings}
        buttonContent={<Trans>Notifications</Trans>}
      >
        <ContextMenuButton
          onClick={() =>
            state.notifications.setChannel(props.channel, undefined)
          }
          actionSymbol={
            typeof state.notifications.getChannel(props.channel) === "undefined"
              ? MdRadioButtonChecked
              : MdRadioButtonUnchecked
          }
        >
          <Column gap="none">
            <Show when={props.channel.server} fallback={<Trans>Default</Trans>}>
              <Trans>Server Default</Trans>
            </Show>
            <Text class="label" size="small">
              <Switch fallback={<Trans>None</Trans>}>
                <Match
                  when={
                    props.channel.server
                      ? state.notifications.computeForServer(
                          props.channel.server!,
                        ) === "all"
                      : true
                  }
                >
                  <Trans>All Messages</Trans>
                </Match>
                <Match
                  when={
                    props.channel.server &&
                    state.notifications.computeForServer(
                      props.channel.server!,
                    ) === "mention"
                  }
                >
                  <Trans>Mentions Only</Trans>
                </Match>
              </Switch>
            </Text>
          </Column>
        </ContextMenuButton>

        <ContextMenuButton
          icon={MdNotificationsActive}
          onClick={() => state.notifications.setChannel(props.channel, "all")}
          actionSymbol={
            state.notifications.getChannel(props.channel) === "all"
              ? MdRadioButtonChecked
              : MdRadioButtonUnchecked
          }
        >
          <Trans>All Messages</Trans>
        </ContextMenuButton>
        <ContextMenuButton
          icon={MdAlternateEmail}
          onClick={() =>
            state.notifications.setChannel(props.channel, "mention")
          }
          actionSymbol={
            state.notifications.getChannel(props.channel) === "mention"
              ? MdRadioButtonChecked
              : MdRadioButtonUnchecked
          }
        >
          <Trans>Mentions Only</Trans>
        </ContextMenuButton>
        <ContextMenuButton
          icon={MdNotificationsOff}
          onClick={() => state.notifications.setChannel(props.channel, "none")}
          actionSymbol={
            state.notifications.getChannel(props.channel) === "none"
              ? MdRadioButtonChecked
              : MdRadioButtonUnchecked
          }
        >
          <Trans>None</Trans>
        </ContextMenuButton>
      </ContextMenuSubMenu>

      <Show when={showPreviewOverride()}>
        <ContextMenuSubMenu
          symbol={MdPreview}
          buttonContent={<Trans>Message previews</Trans>}
        >
          <ContextMenuButton
            onClick={() => setPreviewOverride(undefined)}
            actionSymbol={
              typeof previewOverride() === "undefined"
                ? MdRadioButtonChecked
                : MdRadioButtonUnchecked
            }
          >
            <Column gap="none">
              <Trans>Default</Trans>
              <Text class="label" size="small">
                <Switch fallback={<Trans>Off</Trans>}>
                  <Match when={globalPreviewMode() === "full_reply"}>
                    <Trans>Show message</Trans>
                  </Match>
                  <Match when={globalPreviewMode() === "sender"}>
                    <Trans>Show sender only</Trans>
                  </Match>
                </Switch>
              </Text>
            </Column>
          </ContextMenuButton>

          <ContextMenuButton
            symbol={MdQuickreply}
            onClick={() => setPreviewOverride("full_reply")}
            actionSymbol={
              previewOverride() === "full_reply"
                ? MdRadioButtonChecked
                : MdRadioButtonUnchecked
            }
          >
            <Trans>Show message</Trans>
          </ContextMenuButton>
          <ContextMenuButton
            symbol={MdPerson}
            onClick={() => setPreviewOverride("sender")}
            actionSymbol={
              previewOverride() === "sender"
                ? MdRadioButtonChecked
                : MdRadioButtonUnchecked
            }
          >
            <Trans>Show sender only</Trans>
          </ContextMenuButton>
          <ContextMenuButton
            symbol={MdVisibilityOff}
            onClick={() => setPreviewOverride("off")}
            actionSymbol={
              previewOverride() === "off"
                ? MdRadioButtonChecked
                : MdRadioButtonUnchecked
            }
          >
            <Trans>Off</Trans>
          </ContextMenuButton>
        </ContextMenuSubMenu>
      </Show>
    </>
  );
}
