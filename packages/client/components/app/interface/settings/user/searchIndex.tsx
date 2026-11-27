import { useLingui } from "@lingui-solid/solid/macro";

import type { SettingsSearchItem } from "../_layout/searchMatch";

/**
 * What the settings search box can find in user settings.
 *
 * 🔴 Every label is the exact text the page itself shows, so it reuses that
 * string's existing translation. A label that differs by even one character
 * is a new message with no catalog entry, and lingui renders a missing
 * message as its hash id, not as English. Copy labels from the page; never
 * paraphrase them here.
 *
 * `keywords` are extra English words that find an item but are never shown
 * (so they need no translation).
 *
 * Items for pages the sidebar hides (by platform, build or Slim view) are
 * dropped by the search itself, so this list does not repeat those rules.
 */
export function userSettingsSearchIndex(): SettingsSearchItem[] {
  const { t } = useLingui();

  const page = (
    id: string,
    label: string,
    keywords?: string,
  ): SettingsSearchItem => ({ page: id, label, isPage: true, keywords });

  const on = (id: string, labels: string[], keywords?: string) =>
    labels.map((label): SettingsSearchItem => ({ page: id, label, keywords }));

  return [
    // Account
    page(
      "account",
      t`Account Info`,
      "username email password login 2fa mfa two factor otp",
    ),
    ...on("account", [
      t`Username`,
      t`Email`,
      t`Password`,
      t`Two-Factor Recovery Codes`,
      t`Authenticator App`,
      t`Disable Account`,
      t`Delete Account`,
    ]),
    page("profile", t`Profile`, "avatar banner bio nickname"),
    ...on("profile", [
      t`Display Name`,
      t`Pronouns`,
      t`Avatar`,
      t`Banner`,
      t`Profile Bio`,
      t`Name style`,
      t`Server Identities`,
      t`Game IDs`,
    ]),
    page("referrals", t`Referrals`, "invite friends"),
    ...on("referrals", [
      t`Your referral code`,
      t`Your referral link`,
      t`Your referrals`,
      t`Rewards`,
    ]),
    page("supporter", t`Supporter`, "ko-fi kofi donate perks badge"),
    ...on("supporter", [
      t`Supporter perks`,
      t`Supporter code`,
      t`Show supporter badges on my profile`,
    ]),
    page("cipher", t`Cipher`, "membership subscription"),
    page("prot", t`Prot`),
    page("sessions", t`Sessions`, "devices logged in sign out"),
    ...on("sessions", [t`Current Session`, t`Log Out Other Sessions`]),
    page("connections", t`Connections`, "twitch youtube kick stream"),

    // Privacy & Safety
    page("privacy", t`Privacy`),
    ...on("privacy", [
      t`Profile visibility`,
      t`Share Game Activity`,
      t`Encrypted-only chats`,
    ]),
    page("security", t`Encryption`, "e2ee end-to-end security keys"),
    ...on("security", [
      t`Your devices`,
      t`Encrypt my calls`,
      t`Encrypted direct messages`,
      t`Encrypted-only chats`,
      t`Change recovery code`,
      t`Create a recovery code`,
      t`Delete backup`,
    ]),
    page("remote_control", t`Remote Control`),
    ...on("remote_control", [t`Express Connect`, t`Forget everyone`]),
    page("streamer", t`Streamer Mode`, "streaming hide"),
    ...on("streamer", [
      t`Enable Streamer Mode`,
      t`Automatically enable`,
      t`Hide personal information`,
      t`Hide invite links`,
      t`Disable notifications`,
      t`Disable sounds`,
      t`Show reminder banner`,
    ]),

    // App Settings
    page("appearance", t`Appearance`, "theme dark mode light colours"),
    ...on("appearance", [
      t`Colors`,
      t`Light`,
      t`Dark`,
      t`Style`,
      t`Background`,
      t`Custom background color`,
      t`Contrast`,
      t`Sidebar highlight`,
      t`Messages`,
      t`Show message timestamps`,
      t`Show usernames`,
      t`Show animated name effects`,
      t`Compact mode`,
      t`Message Size`,
      t`Avatar Size`,
      t`Message Group Spacing`,
      t`Fonts`,
      t`Interface Font`,
      t`Monospace Font`,
      t`Layout`,
      t`Message width`,
      t`Message alignment`,
      t`Ultrawide layout`,
      t`Arrangement`,
      t`Member list`,
      t`Chat Input`,
      t`Show send message button`,
      t`Turn emoticons like :D into emoji`,
      t`Emoji Pack (affects your messages only)`,
      t`Friends and direct messages`,
      t`Slim view (beta)`,
    ]),
    page("notifications", t`Notifications`, "alerts push sounds"),
    ...on("notifications", [
      t`Enable Desktop Notifications`,
      t`Enable Push Notifications`,
      t`Ring for calls on this device`,
      t`Allow full-screen call alerts`,
      t`When someone messages me`,
      t`Sounds`,
      t`Message Received`,
      t`Message Sent`,
      t`Incoming Call Ringtone`,
      t`Outgoing Call Ringtone`,
      t`User Joined Call`,
      t`User Left Call`,
      t`Stream Start`,
      t`Stream End`,
    ]),
    page(
      "voice",
      t`Voice`,
      "microphone mic audio headset speaker ptt noise echo",
    ),
    ...on("voice", [
      t`Select audio input`,
      t`Select audio output`,
      t`Output Volume`,
      t`Microphone Test`,
      t`Microphone Gain`,
      t`Input Gain`,
      t`Voice Processing`,
      t`Select noise suppression`,
      t`Browser Echo Cancellation`,
      t`Automatic Gain Control`,
      t`Voice Shaper`,
      t`Voice Changer`,
      t`Voice Pitch`,
      t`Level Incoming Voices`,
      t`Microphone Mode`,
      t`Voice Activity Detection`,
      t`Push to Talk`,
      t`Push to Talk Key`,
      t`Input Sensitivity`,
      t`Voice Channels`,
      t`Entrance Sound`,
      t`Attenuation`,
    ]),
    page("video", t`Video`, "camera webcam screen share"),
    ...on("video", [
      t`Select video input`,
      t`Camera Brightness`,
      t`Camera Quality`,
      t`Screen Share Settings`,
      t`Share Computer Sound`,
      t`Filters`,
      t`Background effect`,
      t`Virtual background`,
    ]),
    page("overlay", t`Game Overlay`, "in-game"),
    ...on("overlay", [
      t`Show overlay during calls`,
      t`Screen position`,
      t`Overlay opacity`,
      t`Overlay size`,
      t`Show latency`,
    ]),
    page("keybinds", t`Keybinds`, "shortcuts hotkeys keyboard"),
    ...on("keybinds", [t`Global keybinds`, t`Clear all keybinds`]),
    page("language", t`Language`, "locale translate"),
    ...on("language", [
      t`Select your language`,
      t`Translate messages`,
      t`Live call captions`,
      t`Date format`,
      t`Time format`,
    ]),
    page("native", t`Desktop`, "startup autostart windows tray"),
    ...on("native", [
      t`Start with Computer`,
      t`Allow Multiple Instances`,
      t`Use the Windows title bar`,
    ]),

    // Developer
    page("bots", t`My Bots`, "developer api"),
    page("advanced", t`Advanced`, "developer"),
    ...on("advanced", [t`Show 'copy ID' in context menus`]),

    // About
    page("donate", t`Support Sloga`, "donate ko-fi"),
    page("changelog", t`Patch Notes`, "changelog updates"),
    page("feedback", t`Feedback`, "bug report"),
    page("terms", t`Terms of Service`, "legal"),
    page("privacy_policy", t`Privacy Policy`, "legal"),
    page("take_it_down", t`Remove intimate images`),
    page("logout", t`Sign out`, "log out logout"),
  ];
}
