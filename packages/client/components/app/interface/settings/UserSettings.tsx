import { Show, createResource } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { Server } from "stoat.js";
import { css } from "styled-system/css";

import {
  allowsDonationLinks,
  nativeE2EEAvailable,
  useClient,
} from "@revolt/client";
import { fetchStreamingFlags } from "@revolt/client/streamConnections";
import { CONFIGURATION, tauriInvoke } from "@revolt/common";
import { useUser } from "@revolt/markdown/users";
import { useModals } from "@revolt/modal";
import {
  fetchAllChangelogs,
  fetchAppVersion,
} from "@revolt/modal/modals/Changelog";
import { overlayShellAvailable } from "@revolt/rtc/overlay/shell";
import { ColouredText, Column, Text, iconSize } from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import MdAccountCircle from "@material-design-icons/svg/outlined/account_circle.svg?component-solid";
import MdCampaign from "@material-design-icons/svg/outlined/campaign.svg?component-solid";
import MdCoffee from "@material-design-icons/svg/outlined/coffee.svg?component-solid";
import MdGavel from "@material-design-icons/svg/outlined/gavel.svg?component-solid";
import MdLanguage from "@material-design-icons/svg/outlined/language.svg?component-solid";
import MdLogout from "@material-design-icons/svg/outlined/logout.svg?component-solid";
import MdMic from "@material-design-icons/svg/outlined/mic.svg?component-solid";
import MdNotifications from "@material-design-icons/svg/outlined/notifications.svg?component-solid";
import MdPalette from "@material-design-icons/svg/outlined/palette.svg?component-solid";
import MdPolicy from "@material-design-icons/svg/outlined/policy.svg?component-solid";
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
import { ConnectionsSettings } from "./user/Connections";
import { EncryptionSettings } from "./user/Encryption";
import { Feedback } from "./user/Feedback";
import { LanguageSettings } from "./user/Language";
import Native from "./user/Native";
import Notifications from "./user/notifications/Notifications";
import { PrivacySettings } from "./user/Privacy";
import { EditProfile } from "./user/profile";
import { RemoteControlSettings } from "./user/RemoteControl";
import { Sessions } from "./user/Sessions";
import { StreamerModeSettings } from "./user/StreamerMode";
import { EditSubscription } from "./user/subscriptions";
import { OverlaySettingsPage } from "./user/voice/OverlaySettings";
import { VideoSettings } from "./user/voice/VideoSettings";
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
        return <EncryptionSettings />;
      case "privacy":
        return <PrivacySettings />;
      case "remote_control":
        return <RemoteControlSettings />;
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
      case "video":
        return <VideoSettings />;
      case "overlay":
        return <OverlaySettingsPage />;
      case "notifications":
        return <Notifications isDesktop={!!window.native} />;
      case "streamer":
        return <StreamerModeSettings />;
      case "connections":
        return <ConnectionsSettings />;
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
    const client = useClient();

    // Which streaming platforms this server can link. Connections is a dead
    // page ("not enabled on this server yet") wherever both are off, so the
    // row hides there — unless the account already carries a link, which the
    // page can still show and unlink. Hidden while the flags load too, so a
    // server with linking off never flashes the row.
    const [streamingFlags] = createResource(fetchStreamingFlags);
    const connectionsUnavailable = () =>
      !client().user?.connections?.length &&
      (streamingFlags.state !== "ready" ||
        (!streamingFlags()?.twitch && !streamingFlags()?.youtube));

    // The release version comes from the patch notes, not the root
    // package.json — that file stopped tracking releases at 0.48.0, so every
    // client reported "0.48.0" to support regardless of what was installed.
    const [appVersion] = createResource(fetchAppVersion);

    // The Windows (Tauri) shell has no `window.native`; ask the shell itself.
    // `plugin:app|version` is granted through `core:default`, so this works
    // against shells already in the field. Resolves undefined everywhere else.
    const [tauriShellVersion] = createResource(() =>
      tauriInvoke()?.<string>("plugin:app|version").catch(() => undefined),
    );

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
            <span class={css({ userSelect: "all" })}>
              {appVersion() ?? pkg.version}
            </span>
          </Text>
          <Show when={tauriShellVersion()}>
            <Text class="label">Sloga for Desktop {tauriShellVersion()}</Text>
          </Show>
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
          // Who you are and how you sign in. Ordered from "the account
          // itself" outward: credentials, then what others see, then where
          // you are signed in, then what is linked to it.
          title: <Trans>Account</Trans>,
          entries: [
            // Username, email, password, 2FA, delete. This used to be a hidden
            // stub reachable only through the header card, while the Profile
            // page told people to "go to account settings" — a page that had
            // no row in a section called Account.
            {
              id: "account",
              icon: <Symbol size={20}>manage_accounts</Symbol>,
              title: <Trans>Account Info</Trans>,
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
              id: "connections",
              icon: <Symbol size={20}>link</Symbol>,
              title: <Trans>Connections</Trans>,
              // A getter, so the sidebar's <Show> tracks the flag fetch and
              // the row appears once the server says linking is on.
              get hidden() {
                return connectionsUnavailable();
              },
            },
          ],
        },
        {
          // Who can see and do what. Everything here is an audience or a
          // consent decision — none of it changes what your profile says or
          // how the app looks.
          title: <Trans>Privacy & Safety</Trans>,
          entries: [
            {
              id: "privacy",
              icon: <Symbol size={20}>shield_person</Symbol>,
              title: <Trans>Privacy</Trans>,
            },
            {
              // Sidebar id stays `security` (deep links); the page is the
              // E2EE toggles + recovery backup and nothing else now.
              id: "security",
              icon: <MdSecurity {...iconSize(20)} />,
              title: <Trans>Encryption</Trans>,
              // Only meaningful where the native E2EE layer exists (desktop);
              // the web build has no key material.
              hidden: !nativeE2EEAvailable(),
            },
            {
              // Remembered people + Express Connect. Gated on the release flag
              // and the Tauri command bridge — the same two things
              // `rc.supported()` checks first — NOT on E2EE, which is where
              // this list used to live and why it vanished on any shell
              // without native key material.
              id: "remote_control",
              icon: <Symbol size={20}>arrow_selector_tool</Symbol>,
              title: <Trans>Remote Control</Trans>,
              hidden: !CONFIGURATION.ENABLE_REMOTE_CONTROL || !tauriInvoke(),
            },
            // Streamer Mode hides personal details, invites and notifications
            // while live — a privacy feature that only sat under App Settings
            // because Discord's does.
            {
              id: "streamer",
              icon: <Symbol size={20}>videocam</Symbol>,
              title: <Trans>Streamer Mode</Trans>,
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
          title: <Trans>App Settings</Trans>,
          entries: [
            // {
            //   id: "audio",
            //   icon: <MdSpeaker {...iconSize(20)} />,
            //   title: t("app.settings.pages.audio.title"),
            //   hidden:
            //     !getController("state").experiments.isEnabled("voice_chat"),
            // },
            // Ordered by how often they actually get opened — Appearance and
            // Notifications are changed far more than anything below them.
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
            // Voice and Video are separate pages: the combined one had grown
            // to a dozen sections (devices, tests, processing, mic mode, PTT,
            // camera, filters, backgrounds, screen share, overlay) and the
            // camera controls sat below a long scroll of microphone ones.
            {
              id: "voice",
              icon: <MdMic {...iconSize(20)} />,
              title: <Trans>Voice</Trans>,
            },
            {
              id: "video",
              icon: <Symbol size={20}>camera_video</Symbol>,
              title: <Trans>Video</Trans>,
              hidden: !CONFIGURATION.ENABLE_VIDEO,
            },
            {
              // Desktop shells only — the same probe the page itself uses,
              // so no shell ever sees a row that opens an empty page.
              id: "overlay",
              icon: <Symbol size={20}>picture_in_picture</Symbol>,
              title: <Trans>Game Overlay</Trans>,
              hidden: !overlayShellAvailable(),
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
              // Electron exposes window.native; the Windows (Tauri) shell
              // is detected by its command bridge instead.
              hidden: !window.native && !tauriInvoke(),
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
          // Bots belong to the account that made them, but they are not a
          // setting about the account — they are things you build. Their own
          // section keeps the Account list to identity and sign-in.
          title: <Trans>Developer</Trans>,
          entries: [
            {
              id: "bots",
              icon: <MdSmartToy {...iconSize(20)} />,
              title: <Trans>My Bots</Trans>,
            },
            // Copy-ID and admin-panel context-menu shortcuts: developer /
            // staff tooling, not app preferences.
            {
              id: "advanced",
              icon: <MdScience {...iconSize(20)} />,
              title: <Trans>Advanced</Trans>,
            },
          ],
        },
        {
          // Everything here leaves the app or opens a one-shot dialog — none of
          // it is a setting, which is why it sits below the settings instead of
          // in the middle of them.
          title: <Trans>About</Trans>,
          entries: [
            {
              id: "donate",
              // Google Play treats linking out to donations as a payments-policy
              // grey area and Sloga is not a registered nonprofit, so this is
              // hidden in Play builds only — web, desktop and the sloga.gg APK
              // all still show it.
              hidden: !allowsDonationLinks(),
              // Brand orange, matching the Home screen donate button and the
              // sloga.gg header — this entry is meant to stand out.
              icon: <MdCoffee {...iconSize(20)} fill="#FF8A00" />,
              title: (
                <ColouredText colour="#FF8A00">
                  <Trans>Donate to Sloga</Trans>
                </ColouredText>
              ),
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
            {
              id: "feedback",
              icon: <MdRateReview {...iconSize(20)} />,
              title: <Trans>Feedback</Trans>,
            },
            // Reachable copies of the policies a user accepted at registration.
            // Play expects them findable in-app, not only on the website.
            {
              id: "terms",
              icon: <MdGavel {...iconSize(20)} />,
              title: <Trans>Terms of Service</Trans>,
              href: "https://sloga.gg/legal/terms.html",
            },
            {
              // Not `privacy` — that id is the Privacy settings page, and the
              // sidebar highlights by id.
              id: "privacy_policy",
              icon: <MdPolicy {...iconSize(20)} />,
              title: <Trans>Privacy Policy</Trans>,
              href: "https://sloga.gg/legal/privacy.html",
            },
          ],
        },
        {
          entries: [
            {
              id: "logout",
              icon: (
                <MdLogout {...iconSize(20)} fill="var(--md-sys-color-error)" />
              ),
              title: (
                <ColouredText colour="var(--md-sys-color-error)">
                  <Trans>Sign out</Trans>
                </ColouredText>
              ),
              onClick() {
                // Close settings first, then confirm — the same dialog the
                // user menu's Sign out opens, so neither route signs you out
                // on a single click.
                pop();
                openModal({ type: "sign_out" });
              },
            },
          ],
        },
      ],
    };
  },
};

export default Config;
