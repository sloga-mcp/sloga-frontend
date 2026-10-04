import { Trans } from "@lingui-solid/solid/macro";
import {
  Match,
  Show,
  Switch,
  createResource,
  onCleanup,
  onMount,
} from "solid-js";

import {
  fullScreenCallAlertsBlocked,
  openFullScreenCallAlertSettings,
  useNotifications,
} from "@revolt/client";
import {
  pushProvider,
  unifiedPushStatus,
} from "@revolt/client/NotificationsController";
import { useState } from "@revolt/state";
import { CategoryButton, Checkbox, Column, iconSize } from "@revolt/ui";

import MdMarkUnreadChatAlt from "@material-design-icons/svg/outlined/mark_unread_chat_alt.svg?component-solid";
import MdNotifications from "@material-design-icons/svg/outlined/notifications.svg?component-solid";
import MdNotificationsOff from "@material-design-icons/svg/outlined/notifications_off.svg?component-solid";
import MdPhoneLocked from "@material-design-icons/svg/outlined/phone_locked.svg?component-solid";
import Sounds from "./Sounds";

/** ntfy, the UnifiedPush app we point the Google-free build at */
const NTFY_FDROID_URL = "https://f-droid.org/packages/io.heckel.ntfy/";

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

  // Google-free build only: whether a UnifiedPush app is installed. That also
  // happens outside the app, so it's re-read on return too. A null status
  // (the plugin call failed) keeps the toggle: better a working control than
  // an install prompt that may be wrong. Other builds never ask.
  const [unifiedPush, { refetch: refetchUnifiedPush }] = createResource(
    () => pushProvider() === "unifiedpush",
    unifiedPushStatus,
  );

  const noUnifiedPushApp = () => unifiedPush()?.distributors.length === 0;

  function recheckOnReturn() {
    if (document.visibilityState === "visible") {
      refetch();
      refetchUnifiedPush();
    }
  }

  /**
   * Same push state and handler as the other builds. Enabling with no
   * UnifiedPush app fails without a toast, so re-read the status afterwards
   * and let the install card explain it.
   */
  async function toggleUnifiedPush() {
    try {
      await togglePushPermission(true);
    } finally {
      refetchUnifiedPush();
    }
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
          <Show when={!props.isDesktop && pushProvider() !== "unifiedpush"}>
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
          <Switch>
            <Match
              when={pushProvider() === "unifiedpush" && noUnifiedPushApp()}
            >
              <CategoryButton
                onClick={() => window.open(NTFY_FDROID_URL, "_blank")}
                icon={<MdNotificationsOff {...iconSize(22)} />}
                action="external"
                description={
                  <Trans>
                    No UnifiedPush app installed. This Google-free build can't
                    get notifications while it's closed until you install one.
                  </Trans>
                }
              >
                <Trans>Get ntfy on F-Droid</Trans>
              </CategoryButton>
            </Match>
            <Match when={pushProvider() === "unifiedpush"}>
              <CategoryButton
                action={
                  <Checkbox
                    checked={settings.pushNotificationsState === "allowed"}
                  />
                }
                onClick={toggleUnifiedPush}
                icon={<MdMarkUnreadChatAlt {...iconSize(22)} />}
                description={
                  <Trans>Delivered through your UnifiedPush app</Trans>
                }
              >
                <Trans>Background notifications (UnifiedPush)</Trans>
              </CategoryButton>
            </Match>
          </Switch>
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
