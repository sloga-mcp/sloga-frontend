import type { ChangelogResponse } from "./Changelog";

/**
 * Acutest patch notes, newest first.
 *
 * To publish a new entry: add an object to the TOP of this array with a new
 * unique `id` (bump the number) and a `published_at` ISO timestamp. Users see
 * the newest entry once, automatically, next time they open the app.
 */
export const CHANGELOGS: ChangelogResponse[] = [
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
- New orange Acutest app icon on Android.
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
- Acutest theme: orange highlights, cyan accents, near-black background.
- Send button now shows the Acutest logo.

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
