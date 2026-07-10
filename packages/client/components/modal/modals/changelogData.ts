import type { ChangelogResponse } from "./Changelog";

/**
 * Sloga patch notes, newest first.
 *
 * To publish a new entry: add an object to the TOP of this array with a new
 * unique `id` (bump the number) and a `published_at` ISO timestamp. Users see
 * the newest entry once, automatically, next time they open the app.
 */
export const CHANGELOGS: ChangelogResponse[] = [
  {
    id: "sloga-2026-07-10",
    title: "Patch Notes",
    published_at: "2026-07-10T20:00:00.000Z",
    markdown_content: `## v0.7.0 — Events, encrypted DMs & translation

### 📅 Server Events
- **Schedule events in your server** — one-off or repeating, with a title, time, and description.
- **Invite people or entire roles** — everyone can RSVP with Accept or Decline.
- Get **notified** when an event you joined is starting.
- Open the calendar from the top of your server to browse what's coming up.

### 🔐 End-to-end encrypted DMs (native apps)
- **Opt-in E2EE for direct messages** — messages are encrypted on your device and only you and the other person can read them. The server only ever sees scrambled ciphertext.
- Works in **1:1 and group DMs**, including **attachments** — photos and files are encrypted before they leave your device.
- **Safety numbers** let you verify you're really talking to who you think you are.
- **Key backup with a recovery code** — restore your encrypted conversations on a new device.
- Available in the desktop and Android apps. Both sides need E2EE turned on.

### 🌍 Message translation
- New in **Settings → Language**: automatically detect and **translate other people's messages** into the language you choose — in servers and DMs.
- Translations appear right under the original message with a "Translated from …" note.
- Your privacy is respected: **encrypted messages are never sent for translation**.

### 🎲 Dice rolls
- Roll dice right in chat from the composer — rolls are made **by the server**, so results can't be faked.

### 🖥️ Interface
- The **left sidebar can now expand** — click the arrow to see server and DM names at a glance.
- Dark theme is now the default for new users.

### 🛠️ Fixes & stability
- Fixed a **reconnect loop** after network drops — the app now recovers cleanly when your connection blips.
- Images, videos and downloads now load reliably behind the new sloga.gg address.

*Sloga — Hop in.*`,
  },
  {
    id: "sloga-2026-07-06",
    title: "Patch Notes",
    published_at: "2026-07-06T02:00:00.000Z",
    markdown_content: `## v0.6.0 — Sloga has a home: sloga.gg 🌐

Sloga now lives at a permanent address: **app.sloga.gg**. No more moving links — bookmark it, share it, it's here to stay.

### 🔑 Sign in with Google
- **One-click login** — hit *Continue with Google* on the login screen. No password needed.
- Already have an account? Signing in with Google using the same email links straight to it.
- Two-factor authentication is still respected — Google sign-in never skips your 2FA.

### 🔄 Automatic updates
- **Desktop**: the app now updates itself — when a new version ships, you'll get a prompt to install and restart. This is the last version you'll ever install by hand.
- **Android**: the app checks for new versions on launch and installs them in-app — no more sideloading every update.

### 🖥️ Desktop
- Fresh installer with the new Sloga look.
- The app now connects through sloga.gg, so it works from anywhere.

*Sloga — Hop in.*`,
  },
  {
    id: "sloga-2026-07-04",
    title: "Patch Notes",
    published_at: "2026-07-04T20:00:00.000Z",
    markdown_content: `## v0.5.0 — We are now Sloga! 🎉

**Acutest is now Sloga** — from the Serbian word for *unity and concord*.

### What's new
- **New name, new logo**: the circle of dots is us — different people, one circle.
- Everything else works exactly as before: your account, messages, friends, and servers are unchanged.

*Sloga — Hop in.*`,
  },
  {
    id: "acutest-2026-07-04",
    title: "Patch Notes",
    published_at: "2026-07-04T12:00:00.000Z",
    markdown_content: `## v0.4.0 — July 4, 2026

### 🔔 Push Notifications
- **You now get notified when the app is closed!** Messages, incoming calls, and friend requests reach you on every platform.
- **Browser**: enable in Settings → Notifications → Enable Push Notifications.
- **Android app**: notifications arrive in the notification bar with sound — messages show the sender and text; **incoming calls ring with your phone's ringtone and Answer/Decline buttons**. Answer drops you straight into the call.
- Android tip: for instant delivery, set Settings → Apps → Sloga → Battery → **Unrestricted**.

### 📢 Patch Notes
- These notes now pop up after updates — check "Don't show this again" to snooze them until the next release.
- Read them anytime in Settings → Patch Notes.

### 🎮 Desktop
- Game detection list now updates from the server — new games are detected without reinstalling the app.

### 📞 Calls
- Added a video call button next to the voice call button.
- Mute and camera states now sync correctly between participants.`,
  },
  {
    id: "acutest-2026-07-03",
    title: "Patch Notes",
    published_at: "2026-07-03T12:00:00.000Z",
    markdown_content: `## July 3, 2026

### ✨ Added
- **Game activity** — the desktop app detects what you're playing and shows "Playing …" to friends, with play time on your profile. Toggle in Settings → Profile.
- **Incoming call ringing** — calls now ring with your chosen ringtone and stop when answered or when the caller hangs up.
- **"Keep me logged in"** checkbox on the login screen.
- **Voice calls keep running in the background** on Android, with an ongoing notification.
- New orange Sloga app icon on Android.
- **Patch notes are now in-app** — this popup! New updates appear here automatically.

### 🐛 Fixed
- Android app login ("Failed to fetch").
- Garbled labels in voice settings.
- Camera brightness slider now works live during calls.
- Voice connection failures ("engine not connected").
- "Playing …" status now clears when you quit the game.`,
  },
  {
    id: "acutest-2026-07-02",
    title: "Patch Notes",
    published_at: "2026-07-02T12:00:00.000Z",
    markdown_content: `## July 2, 2026

### 🎨 New Look
- Sloga theme: orange highlights, cyan accents, near-black background.
- Send button now shows the Sloga logo.

### 🔊 Sounds
- 5 message sounds, 10 ringtones, and 5 disconnect sounds — pick yours in Settings → Notifications.

### 🎙️ Voice
- Microphone gain slider (0–200%).
- Connection quality badge on call tiles.

### 🔐 Channels
- Password-protected channels with a lock icon in the sidebar.

### 🤝 Social
- "Invite a friend" in the server right-click menu.`,
  },
];
