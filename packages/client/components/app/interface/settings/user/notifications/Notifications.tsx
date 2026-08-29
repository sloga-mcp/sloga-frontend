import { Trans } from "@lingui-solid/solid/macro";
import { Show, createResource, onCleanup, onMount } from "solid-js";

import {
  fullScreenCallAlertsBlocked,
  openFullScreenCallAlertSettings,
  useNotifications,
} from "@revolt/client";
import { useState } from "@revolt/state";
import { CategoryButton, Checkbox, Column, iconSize } from "@revolt/ui";

import MdMarkUnreadChatAlt from "@material-design-icons/svg/outlined/mark_unread_chat_alt.svg?component-solid";
import MdNotifications from "@material-design-icons/svg/outlined/notifications.svg?component-solid";
import MdPhoneLocked from "@material-design-icons/svg/outlined/phone_locked.svg?component-solid";
import Sounds from "./Sounds";

/**
 * Notifications Page
 */
export default function Notifications(props: { isDesktop: boolean }) {
  const { settings } = useState();

  const { toggleNotificationPermission, togglePushPermission } =
    useNotifications();

  // Android 14+ only: shown when calls can't light up a locked screen. The
  // grant happens in system settings, so re-check whenever the user comes
  // back to the app rather than leaving a stale row on screen.
  const [callAlertsBlocked, { refetch }] = createResource(
    fullScreenCallAlertsBlocked,
  );

  function recheckOnReturn() {
    if (document.visibilityState === "visible") refetch();
  }

  onMount(() => document.addEventListener("visibilitychange", recheckOnReturn));
  onCleanup(() =>
    document.removeEventListener("visibilitychange", recheckOnReturn),
  );

  return (
    <Column gap="lg">
      <Column>
        <CategoryButton.Group>
          <Show when={settings.desktopNotificationsState !== "unsupported"}>
            <CategoryButton
              action={
                <Checkbox
                  checked={settings.desktopNotificationsState === "allowed"}
                />
              }
              onClick={() => toggleNotificationPermission(true)}
              icon={<MdNotifications {...iconSize(22)} />}
              description={
                props.isDesktop ? (
                  <Trans>
                    Receive notifications while the app is open and in the
                    background.
                  </Trans>
                ) : (
                  <Trans>Receive notifications while the tab is open.</Trans>
                )
              }
            >
              <Trans>Enable Desktop Notifications</Trans>
            </CategoryButton>
          </Show>
          <Show when={!props.isDesktop}>
            <CategoryButton
              action={
                <Checkbox
                  checked={settings.pushNotificationsState === "allowed"}
                />
              }
              onClick={() => togglePushPermission(true)}
              icon={<MdMarkUnreadChatAlt {...iconSize(22)} />}
              description={
                <Trans>
                  Receive push notifications while the app is closed.
                </Trans>
              }
            >
              <Trans>Enable Push Notifications</Trans>
            </CategoryButton>
          </Show>
          <Show when={callAlertsBlocked()}>
            <CategoryButton
              onClick={openFullScreenCallAlertSettings}
              icon={<MdPhoneLocked {...iconSize(22)} />}
              description={
                <Trans>
                  Incoming calls ring, but cannot turn on your screen while it
                  is locked. Open system settings to allow it.
                </Trans>
              }
            >
              <Trans>Allow full-screen call alerts</Trans>
            </CategoryButton>
          </Show>
        </CategoryButton.Group>
      </Column>
      <Sounds />
    </Column>
  );
}
