import { Show } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { Server } from "stoat.js";
import { css } from "styled-system/css";

import {
  nativeE2EEAvailable,
  useClient,
  useClientLifecycle,
} from "@revolt/client";
import { CONFIGURATION } from "@revolt/common";
import { useUser } from "@revolt/markdown/users";
import { useModals } from "@revolt/modal";
import { fetchAllChangelogs } from "@revolt/modal/modals/Changelog";
import { ColouredText, Column, Text, iconSize } from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import MdAccountCircle from "@material-design-icons/svg/outlined/account_circle.svg?component-solid";
import MdCampaign from "@material-design-icons/svg/outlined/campaign.svg?component-solid";
import MdCoffee from "@material-design-icons/svg/outlined/coffee.svg?component-solid";
import MdLanguage from "@material-design-icons/svg/outlined/language.svg?component-solid";
import MdLogout from "@material-design-icons/svg/outlined/logout.svg?component-solid";
import MdMemory from "@material-design-icons/svg/outlined/memory.svg?component-solid";
import MdMic from "@material-design-icons/svg/outlined/mic.svg?component-solid";
import MdNotifications from "@material-design-icons/svg/outlined/notifications.svg?component-solid";
import MdPalette from "@material-design-icons/svg/outlined/palette.svg?component-solid";
import MdRateReview from "@material-design-icons/svg/outlined/rate_review.svg?component-solid";
import MdScience from "@material-design-icons/svg/outlined/science.svg?component-solid";
import MdSecurity from "@material-design-icons/svg/outlined/security.svg?component-solid";
import MdSmartToy from "@material-design-icons/svg/outlined/smart_toy.svg?component-solid";
import MdVerifiedUser from "@material-design-icons/svg/outlined/verified_user.svg?component-solid";
import MdWorkspacePremium from "@material-design-icons/svg/outlined/workspace_premium.svg?component-solid";

import pkg from "../../../../../../package.json";

import { SettingsConfiguration } from ".";
import { AccountCard, BackCard } from "./user/_AccountCard";
import { MyAccount } from "./user/Account";
import AdvancedSettings from "./user/Advanced";
import { AppearanceMenu } from "./user/appearance";
import { MyBots, ViewBot } from "./user/bots";
import { Feedback } from "./user/Feedback";
import { LanguageSettings } from "./user/Language";
import Native from "./user/Native";
import Notifications from "./user/notifications/Notifications";
import { EditProfile } from "./user/profile";
import { SecurityAndPrivacy } from "./user/SecurityAndPrivacy";
import { Sessions } from "./user/Sessions";
import { StreamerModeSettings } from "./user/StreamerMode";
import { EditSubscription } from "./user/subscriptions";
import { VoiceSettings } from "./user/voice/VoiceSettings";

const Config: SettingsConfiguration<{ server: Server }> = {
  /**
   * Page titles
   * @param key
   */
  title(ctx, key) {
    if (key.startsWith("bots/")) {
      const user = useUser(key.substring(5));
      return user()!.username;
    }

    return ctx.entries
      .flatMap((category) => category.entries)
      .find((entry) => entry.id === key)?.title as string;
  },

  /**
   * Render the current client settings page
   */
  // we take care of the reactivity ourselves
  /* eslint-disable solid/reactivity */
  /* eslint-disable solid/components-return-once */
  render(props) {
    const id = props.page();
    const client = useClient();

    if (id?.startsWith("bots/")) {
      const bot = client().bots.get(id.substring("bots/".length))!;
      return <ViewBot bot={bot!} />;
    }

    switch (id) {
      case "account":
        return <MyAccount />;
      case "appearance":
        return <AppearanceMenu />;
      case "advanced":
        return <AdvancedSettings />;
      case "profile":
        return <EditProfile />;
      case "sessions":
        return <Sessions />;
      case "security":
        return <SecurityAndPrivacy />;
      case "bots":
        return <MyBots />;
      case "language":
        return <LanguageSettings />;
      case "feedback":
        return <Feedback />;
      case "subscribe":
        return <EditSubscription />;
      case "native":
        return <Native />;
      case "voice":
        return <VoiceSettings />;
      case "notifications":
        return <Notifications isDesktop={!!window.native} />;
      case "streamer":
        return <StreamerModeSettings />;
      default:
        return null;
    }
  },
  /* eslint-enable solid/reactivity */
  /* eslint-enable solid/components-return-once */

  /**
   * Generate list of categories / entries for client settings
   * @returns List
   */
  list(_, onClose) {
    const { pop, openModal } = useModals();
    const { logout } = useClientLifecycle();

    return {
      context: null!,
      prepend: (
        <Column gap="s">
          <BackCard onClose={onClose} />
          <AccountCard />
          <div />
        </Column>
      ),
      append: (
        <Column gap="none">
          <Text class="label">
            <span class={css({ userSelect: "none", fontWeight: "bold" })}>
              <Trans>Version:</Trans>
            </span>{" "}
            <span class={css({ userSelect: "all" })}>{pkg.version}</span>
          </Text>
          <Show when={window.native}>
            <Text class="label">
              Sloga for Desktop {window.native.versions.desktop()}
            </Text>
            <Text class="label">
              <span
                class={css({
                  fontSize: "0.8em",
                  lineHeight: "0.8em",
                  opacity: "0.5",
                })}
              >
                {window.native.versions.electron()},{" "}
                {window.native.versions.node()},{" "}
                {window.native.versions.chrome()}
              </span>
            </Text>
          </Show>
        </Column>
      ),
      entries: [
        {
          title: <Trans>User Settings</Trans>,
          entries: [
            {
              id: "account",
              icon: <></>,
              title: <></>,
              hidden: true,
            },
            {
              id: "profile",
              icon: <MdAccountCircle {...iconSize(20)} />,
              title: <Trans>Profile</Trans>,
            },
            {
              id: "sessions",
              icon: <MdVerifiedUser {...iconSize(20)} />,
              title: <Trans>Sessions</Trans>,
            },
            {
              id: "security",
              icon: <MdSecurity {...iconSize(20)} />,
              title: <Trans>Security & Privacy</Trans>,
              // Only meaningful where the native E2EE layer exists (desktop);
              // the web build has no key material.
              hidden: !nativeE2EEAvailable(),
            },
          ],
        },
        {
          title: "Sloga",
          entries: [
            {
              id: "bots",
              icon: <MdSmartToy {...iconSize(20)} />,
              title: <Trans>My Bots</Trans>,
            },
            {
              id: "feedback",
              icon: <MdRateReview {...iconSize(20)} />,
              title: <Trans>Feedback</Trans>,
            },
            {
              id: "donate",
              icon: <MdCoffee {...iconSize(20)} />,
              title: <Trans>Donate to Sloga</Trans>,
              href: "https://ko-fi.com/slogatech",
            },
            {
              id: "changelog",
              icon: <MdCampaign {...iconSize(20)} />,
              title: <Trans>Patch Notes</Trans>,
              async onClick() {
                const changelogs = await fetchAllChangelogs();
                if (changelogs.length) {
                  openModal({ type: "changelog_history", changelogs });
                }
              },
            },
          ],
        },
        {
          title: <Trans>Subscriptions</Trans>,
          hidden: true,
          entries: [
            {
              id: "subscribe",
              icon: <MdWorkspacePremium {...iconSize(20)} />,
              title: "[premium]",
            },
          ],
        },
        {
          title: <Trans>Client Settings</Trans>,
          entries: [
            // {
            //   id: "audio",
            //   icon: <MdSpeaker {...iconSize(20)} />,
            //   title: t("app.settings.pages.audio.title"),
            //   hidden:
            //     !getController("state").experiments.isEnabled("voice_chat"),
            // },
            {
              id: "voice",
              icon: <MdMic {...iconSize(20)} />,
              title: CONFIGURATION.ENABLE_VIDEO ? (
                <Trans>Voice & Video</Trans>
              ) : (
                <Trans>Voice</Trans>
              ),
            },
            {
              id: "appearance",
              icon: <MdPalette {...iconSize(20)} />,
              title: <Trans>Appearance</Trans>,
            },
            // {
            //   id: "accessibility",
            //   icon: <MdAccessibility {...iconSize(20)} />,
            //   title: t("app.settings.pages.accessibility.title"),
            // },
            // {
            //   id: "plugins",
            //   icon: <MdExtension {...iconSize(20)} />,
            //   title: t("app.settings.pages.plugins.title"),
            //   hidden: !getController("state").experiments.isEnabled("plugins"),
            // },
            {
              id: "notifications",
              icon: <MdNotifications {...iconSize(20)} />,
              title: <Trans>Notifications</Trans>,
            },
            {
              id: "streamer",
              icon: <Symbol size={20}>videocam</Symbol>,
              title: <Trans>Streamer Mode</Trans>,
            },
            // {
            //   id: "keybinds",
            //   icon: <MdKeybinds {...iconSize(20)} />,
            //   title: t("app.settings.pages.keybinds.title"),
            // },
            {
              id: "language",
              icon: <MdLanguage {...iconSize(20)} />,
              title: <Trans>Language</Trans>,
            },
            // {
            //   id: "sync",
            //   icon: <MdSync {...iconSize(20)} />,
            //   title: t("app.settings.pages.sync.title"),
            // },
            {
              id: "native",
              hidden: !window.native,
              icon: <Symbol size={20}>desktop_windows</Symbol>,
              title: <Trans>Desktop</Trans>,
            },
            // {
            //   id: "experiments",
            //   icon: <MdScience {...iconSize(20)} />,
            //   title: <Trans>Experiments</Trans>,
            // },
          ],
        },
        {
          entries: [
            {
              id: "advanced",
              icon: <MdScience {...iconSize(20)} />,
              title: <Trans>Advanced</Trans>,
            },
            {
              id: "logout",
              icon: (
                <MdLogout {...iconSize(20)} fill="var(--md-sys-color-error)" />
              ),
              title: (
                <ColouredText colour="var(--md-sys-color-error)">
                  <Trans>Log Out</Trans>
                </ColouredText>
              ),
              onClick() {
                pop();
                logout();
              },
            },
          ],
        },
      ],
    };
  },
};

export default Config;
