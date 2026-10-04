import type { ChangelogResponse } from "./Changelog";

/**
 * Sloga patch notes, newest first.
 *
 * To publish a new entry: add an object to the TOP of this array with a new
 * unique `id` (bump the number) and a `published_at` ISO timestamp. Users see
 * the newest entry once, automatically, next time they open the app.
 */
export const CHANGELOGS: ChangelogResponse[] = [
  // ==========================================================================
  // v0.65.0 (written 2026-10-04 by the merge steward from the v0.65 inbox,
  // ~/.claude/plans/v065-release-inbox.md; feedback-1001, forum layouts and
  // the stoat.js mentioned fix folded in after they landed in ac0d16ee). NOT
  // CUT YET: the release sweep bumps the root version and sets `published_at`
  // to the release day. Fold later items into THIS entry; never add a second
  // v0.65 entry. The popup is keyed on `id` only, so any web dist deploy from
  // main before the cut pops this entry on web early: no interim web deploy
  // past this commit without accepting that.
  // Copy constraints, load-bearing — READ BEFORE EDITING:
  // - Support Sloga (2d774aac): LEFT OUT. These notes show in the Play and
  //   App Store builds too (there is no distribution gate; see the v0.63 rule:
  //   no Ko-fi, donating, payment or supporter-perk copy). Announce it on
  //   sloga.gg and socials instead.
  // - Ward (d09e183f): display only. No price, no exchange rate, no date, no
  //   cash value, nothing can be spent yet. "Soon" is the approved wording
  //   (user ruling 2026-10-04: keep it), even though Protected channels is not
  //   built yet.
  // - Encrypted "too large" message (e2124749 + desktop 80bbf7a1): desktop and
  //   Android only (web has no E2EE). It only works in shells built from the
  //   new e2ee core (see the inbox table). Do NOT say updating opens the file,
  //   do NOT say the sender uses a newer version, do NOT mention 5 GB or larger
  //   attachments (no cap was raised).
  // - Silent messages (2ac67a49): LEFT OUT. The live server stores a silent
  //   send as flags 0 (MessageFlagsValue::has checks value 2 before acutest
  //   d41d5dc6), so the client guard never fires until delta+crond from
  //   >= d41d5dc6 deploy, which H-6 holds until AFTER this client ships. Add
  //   the bullet in the release after that deploy.
  // - @everyone/@online (stoat.js 515954b2): do NOT mention silent messages,
  //   do NOT say the mention badge or count changes (the local badge still
  //   counts direct mentions only), do NOT imply anyone can use @everyone.
  //   The "notify" half is desktop + browser only: phone WebViews have no
  //   in-app notification API, and phone push is server-side (unchanged).
  // - Forum layouts (72c4b167): worded as a personal, per-device choice. The
  //   moderator "Default layout" setting and the reply counts / last poster
  //   need backend forum-layouts (acutest 1473d787, NOT deployed; H-6 holds
  //   its delta). Without it Classic and Classic+ show a dash for replies.
  //   Add the moderator-default and reply-count wording only once that
  //   backend is live.
  // - Upload errors (0ab543e4): the new error strings are English-only for
  //   now. The Android attach snapshot is NOT claimed (unverified against the
  //   Xiaomi report).
  // - LEFT OUT until deployed (server-side, landed on acutest, NOT live): the
  //   ban purge of thread/forum messages + thread push to removed users,
  //   threads appearing when access is granted, hidden new channels,
  //   mark-server-read acking threads, the suspension-email appeal link. Add
  //   each bullet only once its service is deployed.
  {
    id: "sloga-2026-10-04",
    title: "Patch Notes",
    published_at: "2026-10-04T12:00:00.000Z",
    web_version: "0.65.0",
    markdown_content: `## v0.65.0 — Ward for Referrals and Forum Layouts

### 🎁 Referrals
- **Referrals now show the Ward you've earned.** Every qualified referral earns Ward, which you'll soon be able to spend on Protected channels and servers.

### 💬 Forums
- **Pick how a forum looks.** Show a forum as Modern cards, Classic rows or a Classic+ table from its layout button. Your choice is saved for that forum on this device.
- **Forum post previews show formatting.** Bold text, links, mentions and emoji in a post's preview now render instead of showing as raw text.
- **Threads and forum posts are now called threads and posts.** Their menus and settings now say "thread" or "post" instead of "channel".
- **New forum posts get suggestions.** The body of a new post now suggests emoji, members and channels as you type, like the message box.

### 🛠️ Roles
- **Duplicate a role.** Role settings have a new "Duplicate role" button that copies the name, color, hoist setting and server permissions.

### 🔔 Fixes
- **@everyone and @online mentions now highlight the message**, like a direct mention does. In the desktop apps and in the browser, they also notify you in channels set to "Mentions only".
- **Spoilers stay hidden.** A spoiler with formatting inside it no longer reveals the next spoiler on the same line, and an unclosed \`||\` now hides the rest of its paragraph instead of dropping part of it.
- **Reply previews show channel links and timestamps** instead of raw codes.
- **Monochrome explains your accent color.** With the Monochrome style, a note now says that it uses only grays and ignores your color.
- **Failed uploads now say why.** If a file fails to upload, the unsent message now shows the reason instead of saying the upload reached 100%.
- **Encrypted attachments that are too large for your app now say so.** In the desktop and Android apps, an encrypted attachment that is larger than your version of the app can open now says that, instead of showing a tampering warning.
- **Fewer glitches after leaving a server or a bulk delete.** Threads and forum posts from a server you left no longer linger in the app, and going back to a channel after messages in it were bulk-deleted no longer shows blank rows.
`,
  },
  // ==========================================================================
  // v0.64.0 (cut 2026-09-30 at main `99ae1b47`; written 2026-09-29 by the
  // merge steward from the v0.64 inbox, ~/.claude/plans/v064-patch-notes-inbox.md).
  // The live web serves nothing newer than `sloga-2026-09-23` (v0.63.0), so
  // this entry pops once. A further edit after the cut moves the cut point.
  // Copy constraints, load-bearing — READ BEFORE EDITING:
  // - 🔴 This entry may only ship AFTER the AFK + voice-move backend is
  //   deployed (bonfire, then every delta, then crond, then voice-ingress, at
  //   acutest f07d2b99 or later). The frontend on main needs it; see the
  //   merge ledger.
  // - AFK and moves: no live two-client test ran (waived by the operator
  //   2026-09-29). The bullets say what the code does, with no speed or
  //   reliability claims. "Using Sloga" means input in the visible window,
  //   not any activity on the computer. Only members on this version report
  //   idle. Anyone in a call from before the deploy is disconnected, not
  //   moved, until they rejoin. Moderator moves ignore the user limit and
  //   need no Connect for the member (ruling D0): true, deliberately left
  //   out. The old settings line "Members who can't connect to this channel
  //   won't be moved." was false and is gone; never repeat it. An older
  //   client is disconnected, not moved; do not say it "can join the new
  //   channel" (a moderator may move someone where they can't connect).
  //   Backend revision 72 designates a server's single unchecked "afk"
  //   voice channel at deploy with no timeout, hence that bullet.
  // - Screen shares: always on, no setting. The device legs were waived; the
  //   web legs passed. Recordings leave out the sound of shares you aren't
  //   watching (an accepted trade-off in the plan), hence that bullet.
  // - Late-drain guard (27f87779): encrypted calls run in the desktop and
  //   phone apps, so it reaches people with this release's app builds.
  // - Color picker (e961314b): nobody tapped the swatches signed in (a
  //   9-test spec and a built dist). The theme is saved per device, NOT
  //   synced; do not claim the "theme reset after updating" report is fixed.
  //   The light-mode sentence is load-bearing (bright swatches render
  //   darker). Old installs with the upstream #FF5733 stay Sloga blue.
  // - Tooltips (b9763ffd + adaacb11): checked in a harness with the real
  //   directive, not signed in.
  // - Referral colors (536a2332): never viewed in a browser; the red may be
  //   low-contrast in dark mode (open audit note).
  // - Encrypted-call resume (fix/mls-rejoin-resume-w2, landed 2026-09-30):
  //   hang-up then rejoin within ~10 s only. 🔴 Never mention page reloads
  //   or Ctrl+R (a reload did not resume in live tests, 0 of 4: the app does
  //   not rejoin by itself after a reload) and never quote "0 s" or any
  //   measured number. Live legs on the final tip: 6 of 7 rejoins resumed;
  //   the miss fell back to a normal secure join.
  //   Hence "usually", and not "near-instant": click to call-ready is
  //   still a few seconds; only the encryption step is fast.
  // - Audio link embeds (flag ON 2026-09-30 03:40Z on january, verified
  //   through app.sloga.gg; wording from the audio session). Direct links to
  //   audio files the host serves as audio only (MP3, M4A/AAC, WAV, Ogg/Opus,
  //   FLAC, WebM audio); not pages with a player, playlists, AIFF/WMA/MIDI or
  //   generic downloads. New links only. No player in encrypted chats (the
  //   server can't see the link). Files over the cap (50 MB, deliberately not
  //   printed) and slow or cold hosts (the preview gives up after ~10 s) get
  //   no player. Ogg/Opus/WebM may not play on iPhone/iPad. Never say "every
  //   audio link" or "plays everywhere", and never say Sloga doesn't see the
  //   link: our server fetches it; only the host never sees the listener.
  //   Editing a message re-embeds it (message_edit re-queues process_embeds),
  //   and the flag flipped BEFORE the release, so never write "links posted
  //   before this update". Page links (SoundCloud, YouTube) keep their old
  //   preview; do not list them as "just the link".
  {
    id: "sloga-2026-09-29",
    title: "Patch Notes",
    published_at: "2026-09-30T12:00:00.000Z",
    web_version: "0.64.0",
    markdown_content: `## v0.64.0 — AFK Channels and Moving Members

### 💤 AFK Channel
- **Give your server an AFK channel.** In a voice channel's settings, **Make AFK Channel** turns it into the server's AFK channel; when you create a voice channel, tick **AFK channel** instead (you need Manage Server). A server has one; picking a new one replaces the old.
- **Already had a voice channel named "afk"?** If your server had exactly one, with no age, password or spoiler check, it is now your server's AFK channel: nobody can speak, turn on their camera or share their screen in it. No idle timeout is set, so nobody is moved there until someone with Manage Server picks one. To undo it, open the channel's settings and press **Stop being the AFK Channel**.
- **Idle members get moved there.** Choose how long someone can sit idle in a call before they're moved: 1, 5, 15 or 30 minutes, or 1 hour. Talking, holding push-to-talk, sharing your screen or camera, watching a share, or using Sloga counts as activity.
- **Only people on this version of Sloga are moved when idle.** The app is what notices someone is idle, so a member on an older version stays where they are.
- **The AFK channel is quiet by design.** Nobody can speak, turn on their camera or share their screen there, including the server owner. Move to another voice channel to talk again.
- **An AFK channel can't have an age, password or spoiler check,** and a channel that is the AFK channel can't be given one. Remove the check, or pick another AFK channel first.
- **The muted-microphone icon in the channel list now marks your server's AFK channel,** not any channel that happens to be named "afk".
- **Importing a server from Discord now brings over its AFK channel and idle timeout,** unless that channel has an age, password or spoiler check.

### ↔️ Moving members between voice channels
- **Move someone to another voice channel.** Right-click a member in a call and choose **Move to…**, or drag them onto another voice channel in the sidebar. You need Move Members in both channels and permission to connect to the one you move them into. Bots can't be moved, but they can still be disconnected.
- **A move only affects the device someone is in the call on.** Their other windows and devices aren't pulled into the call.
- **You can move yourself too,** from the device that's in the call.
- **Channels with a check stay behind their check.** If you're moved into a channel with an age, password or spoiler check you haven't passed on this device, Sloga leaves your old call and tells you why instead of putting you in. Open the channel, pass the check, then join.
- **Someone on an older version of Sloga is disconnected from the call instead of being moved.** The same goes for anyone who was already in a call when this update reached our servers, until they rejoin once.

### 🖥️ Screen shares and the call view
- **You choose which screen shares to watch.** When someone shares their screen, you see their name and a **Watch stream** button instead. Nothing from the share, picture or sound, reaches you until you press it, and **Stop watching** turns it off again. Each new share asks again.
- **A share with only sound has no tile.** Right-click the person in the call and choose **Listen to stream audio**.
- **Recordings leave out the sound of screen shares you aren't watching.**
- **Hide participants without video.** A new button in the call view keeps only the people with their camera or a share on, so the video gets more room. A note shows how many people are hidden; click it to show everyone again. Sloga remembers the choice on this device.
- **With it on, a new share no longer takes over the view** while two or more videos are showing; they sit side by side at the same size.

### 🎵 Messages
- **Links to audio files now play right in chat.** Paste a direct link to an MP3, M4A, WAV, Ogg, Opus, FLAC or WebM audio file and it shows up as a player, the same way an uploaded audio file does. You can usually skip around in the track, and the audio streams through Sloga, so the site hosting the file never sees who is listening.
- **Where there's no player, just the link:** in encrypted chats, in messages sent before audio links were turned on (editing the message can add one), on very large files, on files the site sends as a plain download, and sometimes when the site hosting the file is slow to answer. People on an older version of Sloga also see just the link.
- **Links to a web page with a player on it, like SoundCloud or YouTube, keep the preview they had before.** If the site later deletes the file, the card keeps the link but can't play it. In Safari and on iPhone and iPad, Ogg, Opus and WebM files may not play.

### 🔐 Encrypted calls
- **Rejoining an encrypted call is now much faster.** If you hang up and rejoin within about 10 seconds, Sloga usually picks up where you left off instead of re-securing the whole call. When it does, your call is encrypted again in under a second, and nobody else in the call gets re-keyed.

### 🔔 Fixes
- **Encrypted calls recover more reliably when you join while the call is changing.** If the server could not supply some of the call's security updates, Sloga now re-secures the call instead of getting stuck. A device that joins late now confirms it has the call's latest keys before showing the call as encrypted. If it cannot confirm them, it says so rather than showing green.
- **Picking a color in Appearance now works on the Sloga theme.** The color swatches only appeared, and only did anything, under **Material You**, so on the default Sloga theme changing your color seemed to do nothing. **Settings → Appearance** now shows them under both themes. On Sloga, your color takes the place of the blue and the navy look stays. Sloga blue is the first swatch if you want to go back. In light mode a very bright color is shown darker, so text on it stays readable.
- **Tooltips no longer get stuck or show old text.** A tooltip that was showing could stay on screen after it no longer applied, or keep its old text after the thing it described changed.

### 🎁 Referrals
- **Your referral counts are color-coded.** On **Settings → Referrals**, the Qualified, Pending and Expired counts are shown in green, yellow and red.
`,
  },
  // ==========================================================================
  // v0.63.0 (cut 2026-09-25 at main `5a6c9ee0`). Copy constraints, load-bearing:
  // - The entry was written provisionally from 2026-09-23 and folded in as
  //   fixes landed. The `id` keeps its 2026-09-23 date on purpose: the live
  //   web served nothing newer than `sloga-2026-09-21` at the cut, so nobody
  //   has seen this entry and it pops once. `published_at` is the release
  //   day, set by the sweep. A further edit after the cut moves the cut point.
  // - 🔴 The quick-reaction bullet must NOT promise more than the menu does.
  //   Nobody has clicked the row in a signed-in session: it is covered by tsc,
  //   eslint, and a built bundle that boots, never by use. It says what the
  //   row IS and what a click does, and stops there.
  // - Never name phones. Whether the phone app's long-press opens this same
  //   menu was not checked.
  // - The heart line is deliberate: the row sends the picker's exact heart, so
  //   a quick heart adds to an existing heart instead of starting a twin.
  // - The Singapore node (sg1) went live on the server side 2026-09-24, before
  //   this release; only the "Asia (Singapore)" dropdown label ships here. A
  //   real call passed on it the same day (region pin, webhooks, cleanup),
  //   but from New Jersey: no latency was measured from Asia, so still no
  //   millisecond figures.
  //   Only the call's FIRST joiner picks the server, so "Sloga picks for you"
  //   stays conditional ("calls you start"). 🔴 A region the server owner
  //   pinned overrides the measurement, hence "unless the server owner has
  //   chosen a region"; never drop that clause.
  // - The own-message fix has two halves. The server half went live
  //   2026-09-24 for EVERY app version: sending marks the channel read for
  //   its author. Checked in the database on one real send plus the organic
  //   traffic after it, never by watching a second device, so the bullet
  //   says what happens to the channel and makes no claim about how fast.
  //   The client half (own messages never add to a count) ships here.
  // - 🔴 Keep the scheduled-message exception. A scheduled message only marks
  //   the channel read if the author had already read everything in it, so
  //   dropping that sentence would promise something false.
  // - Self-mentions: the author is filtered out of mention and push fan-out,
  //   including @everyone and role mentions, so "does not notify you" holds.
  // - Scheduled messages: server-side only. It went live 2026-09-24 for EVERY
  //   app version (crond now runs the task workers, backend `cedfa612`).
  //   Before that, a scheduled message never marked the channel unread, never
  //   recorded mentions, and never sent a push. The prod crond log shows the
  //   channel-unread update firing for real scheduled deliveries. The mention
  //   and push path is covered only by an ignored integration test and has
  //   never been watched on a scheduled message in prod. So the bullet says
  //   "the same as a message you send yourself" and lists nothing it cannot
  //   back. 🔴 Do not add link previews or a DM reopening: neither was checked.
  // - Worker fix: server-side only, live 2026-09-24 on delta, crond, pushd and
  //   bonfire (backend `65ddc651`, deployed from `344701ad`). NEITHER trigger
  //   has been seen in prod. The fix is covered by tests: a deleted-channel
  //   regression test on both database drivers, a supervisor restart test,
  //   and an ignored end-to-end worker test against a local broker. So the
  //   bullet says what COULD happen, never that anyone lost notifications or
  //   how often.
  //   🔴 "Restarts itself" means after a 1 to 60 s backoff. Never "instantly".
  //   🔴 Keep the extra-notification sentence. When the online check fails,
  //   everyone is now treated as offline, so people who have Sloga open can
  //   get a push. The same fallback can also show people as offline in a
  //   connection made during that outage. The copy leaves that out on
  //   purpose, but must never claim that presence is unaffected.
  // - 2026-09-25 additions. NONE of these was clicked through live; each is
  //   covered by unit/route tests with negative controls and nothing else.
  //   - Server-side and live for EVERY app version: owner rank (delta
  //     `99b84f74`, deployed 09-25), password reset for unverified accounts
  //     (`bd12181f`, same deploy), http->https (Caddy, 09-24). The forum
  //     ReadMessageHistory bullet is server-side too: live 2026-09-25 05:28Z
  //     in delta `938b7508` (with the soundboard migration below).
  //   - Client-side, ships here: the call leaving on a revoked session, the
  //     disappearing timer hidden under E2EE, the member list behind the
  //     gates, the forum-post Permissions entry, permission headings and the
  //     Remote Control row.
  //   - 🔴 The disappearing-timer bullet must not say the timer WORKS
  //     anywhere. It deletes from the sending tab after the delay, so a closed
  //     tab never deletes. The bullet only says it is gone where it never
  //     took effect.
  //   - 🔴 The Remote Control row: the bit is enforced on the server for
  //     server channels (code-verified, never a live leg), and it governs who
  //     may HAND OVER their own screen, never who may take one. Owners and
  //     staff always have it. The copy says only that the setting exists.
  //   - 🔴 The "signing out stops push" bullet must NOT say signing out ends
  //     the session on the server: it deliberately does not (deleting a
  //     session deletes its E2EE device). It only drops the subscription.
  //   - 🔴 Forum Read Message History: only FETCHING is gated (the post
  //     list's starters, message_fetch on threads). Live delivery is not, so
  //     a connected member still sees new posts and replies arrive. Keep
  //     "older" / "earlier"; never "cannot read replies".
  //   - Sloga Helper moved to heart1 2026-09-25: it connected, authenticated
  //     and synced its commands. No command was run by hand afterwards, so
  //     the bullet says "back online", not that each command was tested.
  //   - The soundboard bullet is server-side (migration revision 70, runs
  //     when delta starts with it). Live 2026-09-25 05:28Z in delta
  //     `938b7508`; prod migrations are at revision 71. Covers servers
  //     created before 2026-07-15 only.
  //   - 🔴 The sign-out bullet says the device LEAVES the call when the
  //     server ends its session. It must not say "instantly": it happens
  //     when the server's logout message arrives or, failing that, at the
  //     first refused reconnect.
  //   - 🔴 Roles by touch: proven only in a browser harness with synthetic
  //     touches under an emulated Android browser, never on a real phone. The
  //     switch is `useDevice().isMobile` (a mobile-browser check), so it says
  //     "on a phone": a Windows touch laptop does not get the hold. Saying
  //     the handle "did not work with a finger" is exact; it armed the list
  //     but never started a drag itself.
  //   - 🔴 Stuck panes (frontend `eba358cb`): this does NOT fix whatever
  //     threw in the Android report behind it. That cause is still unknown.
  //     The boundary only stops one error from freezing a pane for the rest
  //     of the session. So the bullet promises recovery and an error message,
  //     never "fixed the freeze", and it asks for the screenshot we need.
  //     Proven in a node harness on the real solid-js; never seen on a device.
  //   - 🔴 Stuck drawer (`4619cf0f`): proven only in a node harness with
  //     simulated touches (the two stuck cases fail on the old code), never
  //     on a phone. The edge back-swipe and the notification shade are the
  //     documented ways Android cancels a touch; do not add other triggers.
  //   - Profile badges (`a87b2c95`, merged as `badafac2`): every badge SVG
  //     was the same blank white square. Seen only in a headless preview
  //     render, never in the running app. The joke-badge flag mix-up and
  //     the dropped raccoon badge are left out on purpose; nobody on Sloga
  //     could have had either.
  //   - 🔴 Android backups (`4a8bdcc0`, audit L5): the push SharedPreferences
  //     held the API URL and a live session token, and the backup rules let
  //     Google cloud backup and device transfer carry it. Only backups made
  //     AFTER this update leave it out; one already stored keeps its copy
  //     until the phone replaces it. So the bullet says backups made after
  //     "you update the Android app", never that old backups are clean. The
  //     fix lives in the APK: Play still carries vc66 (vc67-69 were never
  //     uploaded), so nothing changes on a phone until it installs this
  //     release. The same holds for the other-apps bullet below, hence its
  //     "after this update". Signing out does NOT end
  //     the session on the server (see above), so do not suggest it as the
  //     remedy; removing the session in Settings → Sessions does.
  //   - Deliberately left out: the web push re-subscribe on a VAPID key
  //     change (`c826eb0e`). Nothing visible happens until the server key
  //     rotates, and that rollout (R3+) has not happened.
  //   - 🔴 Other apps controlling Sloga (frontend `fdbc539b`, audit H2): the
  //     launcher activity is exported, so an app with no permissions could
  //     start it with crafted notification extras. They were pasted into the
  //     JavaScript run inside the app (code injection in Sloga's origin), and
  //     `sloga_answer_call` joined that channel's call. Fixed with a
  //     per-install nonce on every notification Intent plus JSON-built
  //     payloads. Compile-checked on both flavors and code-reviewed; never
  //     run on a phone. Android only, hence "on your phone". Nothing shows it
  //     was ever used, so never say anyone was affected. A notification
  //     posted by the old version opens the app but not its channel after the
  //     update; left out, it lasts one notification.
  //   - Deliberately left out: the Recents replay (`e2c5874e`). Reopening
  //     from Recents after the process died could re-run an earlier Answer
  //     tap. It follows from how Android recreates activities but was never
  //     reproduced, so it gets no bullet.
  //   - 🔴 Server hardening from the 2026-09-24 audit, server-side and live
  //     for EVERY app version. bonfire moved to tungstenite 0.20.1
  //     (CVE-2023-43669; backend `34ef5670`, live 2026-09-25 13:40:51Z, exe
  //     `a7c36915`). Push delivery is held to the browsers' push services:
  //     delta has refused other endpoints since `9fbcc76e` (live 05:28Z) and
  //     pushd re-checks every send and gives up after 10 s (`a7e0fe52`, live
  //     13:41:53Z, exe `8d256e1e`). Proven by unit tests (a real handshake,
  //     a silent socket, a redirect that must not be followed) and a live
  //     handshake through the edge (101). Neither problem was ever seen in
  //     prod and pushd refused 0 stored endpoints at deploy, so never say
  //     anyone was attacked or that a notification went astray.
  //   - 🔴 Clearing a display name (stoat.js `45070b6`, frontend `fb36822a`
  //     and `beaee6d2`): two bugs. The profile editor sent
  //     `display_name: ""` for a blank field, which the server rejects (2-32
  //     chars), so a display name could not be removed at all; it now sends
  //     `remove: ["DisplayName"]` (the bot profile editor is the same
  //     component). And UserUpdate never handled `clear: ["DisplayName"]`,
  //     so a removed name, including a deleted account's or bot's
  //     (`mark_deleted`), stayed on every open client until a reload.
  //     Checked live on the web client against production, two accounts:
  //     clearing and restoring one's name updated the other's DM list and
  //     message authors without a reload. The field was emptied by script
  //     (the test browser dropped Backspace); Save was a real click. Not
  //     checked on the desktop or Android apps.
  //   - 🔴 Encrypted-call fixes (frontend `1fbab1e0` + `bd1b7de5`, merged as
  //     `9139682a`). Proven in the multi-member test harness and a build-level
  //     check only; the two-seat live leg was SKIPPED by operator ruling, so
  //     neither has been seen in a real call. The bullets say what could
  //     happen and no longer does, with no frequency and no speed.
  //     `1fbab1e0`: call-encryption messages queued while a member's
  //     connection was down were replayed on reconnect through DM decryption,
  //     failed, and were deleted; another group's messages could also disturb
  //     the current call. `bd1b7de5`: in calls of 7 or more, a member who
  //     rejoined inside the 10 s leave grace could be removed again.
  //     🔴 NEVER say rejoining is instant or faster. The rejoin-latency work
  //     is NOT in this release; rejoin speed is unchanged.
  //   - 🔴 Deleted-channel badges and the newest-message marker: server-side,
  //     live for EVERY app version since 2026-09-26 01:17-01:23Z (delta,
  //     crond, pushd on heart1). Both were found in code review; neither was
  //     reported or seen as a wrong badge in prod, so "could" and no numbers.
  //     🔴 The deleted-channel bullet is iOS ICON BADGE ONLY and MENTIONS
  //     ONLY. The orphaned row is visible only through pushd get_badge_count
  //     (apn.rs), which sums mentions across every unread row without
  //     checking the channel exists; web, desktop and Android ignore rows for
  //     deleted channels. A read receipt recreates the row with no mentions,
  //     which adds nothing, and a deleted channel has no badge of its own. Do
  //     not widen it to "unread badges" or other platforms. "No way to clear
  //     it" was never checked, so it stays out.
  //     "Soon after getting back in" in the rejoin bullet is deliberate: the
  //     re-removal came 12 s or more later, so never "right after".
  //     Badges already stuck before the deploy were NOT cleaned up, so never
  //     say they are gone. Deleting a channel already cleared its unreads, so
  //     never present that as new. Keep these apart from the "Notifications
  //     no longer quietly stop" bullet: different bugs.
  // - 2026-09-25 referrals (frontend `feat/referrals-client` `0a64e3ad`,
  //   backend `feat/referrals` as merged in wt-referrals-merge `8de325b4`).
  //   It is the bigger change, so the headline names it and its section
  //   goes FIRST. 🔴 NOBODY HAS USED THIS ON PRODUCTION. Every check ran on
  //   a local test stack: the onboarding field, the /r/ link, pending ->
  //   qualified, the badges, the color trial, the name-style editor, and a
  //   second account seeing the styles in the member list and author line.
  //   So the bullets say what the feature IS and what the rules are, and
  //   never how fast anything happens (crond sweeps hourly; not a promise).
  //   - 🔴 NO Ko-fi, supporting, donating, payment, supporter perks or
  //     tiers, or anything bought with money. Store builds (Google Play and
  //     iOS) show these same notes and store policy forbids perk-for-money
  //     copy there; Ko-fi is not switched on yet either. The app hides its
  //     own Support rows behind allowsDonationLinks(); these notes have no
  //     such gate, so they cover earned referral rewards only.
  //   - 🔴 The 50-referral upload reward is NOT announced. It is off on the
  //     server until the config gains a [features.limits.perk] table
  //     (User::limits, users/model.rs), and nobody can reach 50 for weeks
  //     anyway. The ladder bullet stops at 25 and says "more further up":
  //     never a size, never a retention. The 100-referral custom badge is
  //     left out with it, so the list skips no rung. Outside this file:
  //     the Referrals page renders every rung the server sends, so it does
  //     show the upload reward's label today.
  //   - 🔴 The counting rule is the server's (Referral::evaluate in
  //     referrals/model.rs, numbers in referrals/tiers.rs), NOT the
  //     Referrals page's looser "used Sloga regularly for a week, chatting on
  //     several different days". All of: a verified
  //     email; 7 days since onboarding recorded the referral; activity on 4
  //     distinct UTC days, one of them day 7 or later ("second week or
  //     later"); 10 messages, or 3 plus a server join through an invite the
  //     referrer did not create. Activity is a message sent anywhere but
  //     Saved Notes (an encrypted send only once it reached someone else),
  //     a channel marked read (not Saved Notes), or an invite join. At most
  //     10 qualify per referrer per rolling 7 days; the rest stay pending
  //     and still expire 60 days after onboarding, hence the two sentences
  //     sit together.
  //   - 🔴 The bullets do NOT publish those thresholds (10 messages, 4 days,
  //     10 per 7 days): spelling them out is a how-to for gaming the check.
  //     They reuse the Referrals page's own wording ("used Sloga regularly
  //     for a week, chatting on several different days"), which ships in the
  //     same build, plus the verified email. Keep "a
  //     week" vague; never "after 7 days", which the rule does not promise.
  //   - Left out: a bot, deleted, banned or spam-flagged invitee never
  //     counts, a suspended one waits, a deleted referrer's referrals
  //     expire, a self-referral is never recorded, and staff can revoke.
  //   - Server invites credit the invite's creator only when the sign-up
  //     started at an /invite/ link and no referral code was entered (a
  //     code wins). Referral codes are SLOGA- plus four characters; the
  //     field accepts them with or without the prefix, in any case.
  //   - The /r/ link: signed out, it keeps a well-formed code and opens
  //     account creation, and the code is pre-filled in the optional field
  //     at the username step (FlowLogin and FlowOAuthCallback alike).
  //     Signed in, it only opens the app. The link's host comes from the
  //     server config, so the copy names no domain.
  //   - The friend's reward starts when the referral QUALIFIES, not at
  //     sign-up: the "Joined Sloga through a friend" badge (it stays) and
  //     a name-color perk for 30 days (WELCOME_TRIAL_DAYS). After that the
  //     stored color is kept but no longer shown.
  //   - 🔴 Name styles: the server sends every viewer only the parts the
  //     owner's perks allow; only clients from this release draw them
  //     (nameStyle.ts is new here), hence "everyone using this version".
  //     In a server a role color beats the personal color (nameLayers.ts)
  //     while font and effect still show. A masquerade shows nothing
  //     personal and staff names keep their brand letters; both left out.
  //   - Effects animate only in a message's author line (sent or still
  //     sending; not in search results), the profile banner and the
  //     Appearance preview, and only while "Show animated name effects" is
  //     on (the default); everywhere else they are a still frame, as they
  //     are under reduced motion. The Name style editor preview is the
  //     exception: it always plays (NameStyleEditor never reads the
  //     setting), hence the parenthesis in the bullet.
  {
    id: "sloga-2026-09-23",
    title: "Patch Notes",
    published_at: "2026-09-26T12:00:00.000Z",
    web_version: "0.63.0",
    markdown_content: `## v0.63.0 — Referral Program, Get Perks

### 🎁 Referral Program - Invite Friends
- **Invite friends to Sloga and earn rewards.** Your referral code and link are on the new **Settings → Referrals** page. Your link opens sign-up and fills in your code at the username step, and a friend who signs up through one of your server invites counts too.
- **Anyone signing up can enter a code.** It goes in the optional **Referral code** field when they choose a username, with or without the SLOGA- in front.
- **A referral counts once your friend has settled in.** It shows as pending until they have verified their email and used Sloga regularly for a week, chatting on several different days.
- **Pending referrals don't wait forever.** Only so many of your referrals can count each week, and any more stay pending until there is room. A referral that has not counted within 60 days of sign-up expires.
- **Your friend gets something too.** When their referral counts, they get a **Joined Sloga through a friend** badge and 30 days of a custom name color.
- **What you can earn.** A Recruiter badge at 1 referral, a custom name color at 3, an Elite recruiter badge at 5, a name font at 10 and an animated name effect at 25. There are more rewards further up.
- **Style your name.** Once you unlock them, **Settings → Profile → Name style** sets your name's color, one of five fonts, and a Shimmer, Glow or Rainbow effect. Everyone using this version of Sloga sees it next to your messages, in member lists and on your profile.
- **Role colors still come first in servers.** Where you have a colored role, your name shows the role's color there instead of yours. Your font and effect still show.
- **Animated effects move next to messages and on profiles, and hold still everywhere else.** To keep them still on your screen, turn off **Show animated name effects** in **Settings → Appearance** (the Name style preview still plays them).

### 💬 Messages
- **React without opening the emoji picker.** Right-click a message, or open its **⋯** menu, and 👍 👎 ❤ 🙂 🙁 sit across the top. One click adds the reaction; a highlighted one is already yours, and clicking it again takes it back off.
- **A quick heart joins the hearts already there.** It is the same heart the emoji picker sends, so it adds to the existing count rather than starting a second one that looks identical.
- **You only see the ones you can use.** The row is hidden where you do not have permission to react, and on a message that only accepts certain reactions, only those appear.

### 🌏 Voice
- **Sloga now has a voice server in Asia, in Singapore.** If you are in the Philippines, Indonesia, Malaysia, Thailand, Vietnam or nearby, calls you start no longer have to cross the Pacific to reach the US. Unless the server owner has chosen a region, Sloga measures which server is fastest for you and uses it, so there is nothing to set.
- **Server owners can pin calls to it.** **Server Settings → Overview → Voice region** now lists **Asia (Singapore)** alongside US East and South America (São Paulo).

### 🔔 Fixes
- **Your own message no longer shows up as a new notification.** If you were the last person to post in a channel, it could come back marked unread, with a +1 on the badge, on your other devices and every time you reopened Sloga. Sending a message now marks that channel read for you everywhere. The one exception is a scheduled message: if there was something you had not read yet when it went out, the channel stays unread so you do not miss it.
- **Mentioning yourself no longer notifies you.** That includes **@everyone** and a role you have.
- **Scheduled messages now arrive like normal ones.** A message you scheduled used to go out without a push notification, without counting as a mention for anyone it @mentioned, and without marking the channel unread for people who were not online. It now goes out the same as a message you send yourself.
- **Notifications no longer quietly stop after a problem on our servers.** Two rare problems could stop the part of Sloga that delivers mentions, unread badges and push notifications. One was an **@everyone** or role mention in a channel that was deleted a few seconds later. The other was a brief outage of the service that tracks who is online. Each could lose a batch of notifications, and if it happened enough times, delivery stopped until the server restarted. Sloga now handles both, and if that part of Sloga stops for any other reason, it restarts itself. If the online check has an outage now, the worst case is a push notification on a device where you already have Sloga open.
- **A channel deleted at the wrong moment can no longer leave a mention stuck on the app icon.** On iPhone and iPad, a mention that arrived just as its channel was being deleted could keep counting in the app icon's badge after the channel was gone.
- **New messages can no longer slip past the unread marker.** When several parts of Sloga updated a channel's newest-message marker at nearly the same moment, it could be moved backwards, and a new message, including a scheduled one, might then not mark the channel unread. The marker now only moves forward.
- **Signing a device out from somewhere else now takes it out of the call too.** If you remove a session in your settings, or sign out everywhere, a device that was in a voice call leaves it when its session ends. It used to stay connected, even behind the "You were logged out" screen.
- **Encrypted calls no longer throw away encryption updates sent while you were disconnected.** If your connection dropped during an encrypted call, the encryption updates the rest of the call sent in the meantime were discarded when you reconnected, which could leave you out of step with everyone else. They are now kept and applied. Encryption messages meant for a different call can no longer disturb the one you are in, either.
- **Coming back to a large encrypted call no longer gets you removed again.** In an encrypted call of 7 or more people, someone who left and rejoined within 10 seconds could be taken out of the call again soon after getting back in.
- **Forgot your password before verifying your email? The reset email now arrives.** It used to say "check your email" and send nothing. Setting a new password from that email also verifies your address, so you can sign straight in.
- **The disappearing-messages timer is no longer offered in encrypted chats.** It never deleted encrypted messages, so it showed a timer that did nothing there.
- **Forum posts no longer show an empty Permissions page in their settings.** A post follows its forum's permissions, so there is nothing to set on the post itself.
- **Permission lists keep their section titles.** On some channel types a section's title went missing and its settings ran on under the section before.
- **You can reorder roles on a phone.** In **Server Settings → Roles**, press and hold a role, then drag it into place. The small handle beside each role did not work with a finger.
- **The channel list and chat no longer stay stuck after an error.** If one of them runs into a problem, it now shows what went wrong and a **Try again** button, and tapping another server or channel brings it back too. Before, it could stop updating until you restarted Sloga, while the server list beside it kept working. If you see this message, please send us a screenshot of it: it tells us what to fix.
- **The side panel on a phone no longer stops sliding.** If a swipe was interrupted, for example by the back gesture from the edge of the screen or by pulling down the notification shade, the panel could stop responding until you restarted Sloga. It now slides back into place.
- **Signing out now stops push notifications to that device.** A phone you signed out of could keep receiving notifications for the account.
- **The soundboard works on older servers.** On servers created before the soundboard arrived in July, members got an error when they tried to play a sound.
- **The Windows app no longer shows a push notification switch that could not work.** Notifications while Sloga is open are unchanged.
- **Sloga Helper is back online.** Its commands (**/remind**, **/giveaway**, **/coinflip** and **/8ball**) had stopped answering since late August.
- **Profile badges now show their icons.** Every badge on a profile was drawn as the same blank white square. Each one now has its own icon.
- **You can remove your display name.** Emptying **Display Name** in **Settings → Profile** and saving did not remove it, so there was no way back to showing just your username. It now does, and anyone who already has Sloga open sees the change without reloading. The same goes for a deleted account or bot, whose old display name used to stay on screen until a reload.

### 🛡️ Safety and privacy
- **A channel's member list now stays behind its age, password or spoiler screen.** Until you get past that screen, the member list beside the channel list stays hidden too. Before, a mature channel showed who was in it right next to the "are you 18?" prompt.
- **Forum posts and threads now sit behind their channel's screen.** A post in a mature, password-protected or spoiler forum used to open straight away, with no screen at all. Getting past the forum's screen once covers its posts.
- **Voice channels too.** Who is in a gated voice channel's call stays hidden in the channel list until you get past its screen, and double-clicking the channel opens the screen instead of joining.
- **Moderators can no longer mute, deafen or rename the server owner.** An owner with no roles counted as the lowest rank, so anyone allowed to mute members could mute them too.
- **Forum posts now respect Read Message History.** A role denied it can still see which posts exist and their titles, but can no longer open older posts or read their earlier replies.
- **Server owners can choose who may hand over control of their screen.** **Remote Control** now appears under **Voice** in a server's and channel's permissions. It covers handing over your own shared screen; nobody can take control of someone else's.
- **Android backups no longer include your sign-in.** The Android app keeps a copy of it so push notifications can renew themselves, and Google backup and moving to a new phone carried that copy along. Once you update the Android app, backups made after that leave it out.
- **Other apps on your phone can no longer control Sloga after this update.** An app installed on the same Android phone could open Sloga as if it were one of Sloga's own notifications, and use that to run its own code inside Sloga or put you in a voice call. Sloga now only acts on notifications it created itself.
- **A malformed connection can no longer tie up Sloga's servers.** A specially built connection request could keep the server that delivers your messages live busy for minutes. The part that handles those connections is now on a version that is not affected.
- **Push notifications only go to real push services.** Sloga's servers now refuse to send a browser push notification anywhere other than the browser's own push service, and stop waiting on one that does not answer.
- **sloga.gg and app.sloga.gg now always use a secure connection.** Typing an \`http://\` address sends you to the \`https://\` one.
`,
  },
  // ==========================================================================
  // v0.62.0 (2026-09-21). Copy constraints, load-bearing — READ BEFORE EDITING
  // THE SCREEN-AUDIO SECTION. It went live under the 2026-09-21 operator ruling
  // that SKIPPED the live legs (L1-L17 and the S11.9 grandchild negative
  // control), so every word of it is verified by construction and none of it by
  // use. That is exactly why the wording below is what it is:
  // - Windows DESKTOP SHELL only. Never claim it for the web — a Windows
  //   browser tab has no native capture and still echoes the call — and never
  //   for macOS, which ships this release but has no native system-audio
  //   capture of its own. (It is NOT held back any more — see the macOS
  //   bullet below, which supersedes the old "never name the Mac" rule.)
  // - The upstream Chromium bug was DRAFTED, NOT FILED. Say the browser engine
  //   needs the fix; do not say a bug is open.
  // - ENTIRE-SCREEN shares only. Re-verified 2026-09-21: `state.tsx` gates the
  //   capture on `wantsAudio && entireScreen`. If window shares (slice 2) ever
  //   land, that bullet is wrong and must go.
  // - PARAPHRASE the dialog strings, never quote them: they are the release's
  //   deploy gate markers, and quoting them here would put them in the changelog
  //   chunk, so a dist grep would pass on the notes alone.
  // - 🔴 SAY NOTHING ABOUT ENCRYPTION. Deliberate. A "your system audio is
  //   end-to-end encrypted" line would be false in two reachable states: a
  //   mixed/downgraded call publishes screen audio in plaintext by design, and
  //   S7 records that even on a full-E2EE call the assertion is a detector
  //   rather than a preventer.
  // - 🔴 The echo bullet says what Sloga DOES ("leaves its own output out of
  //   that capture"), never that no echo is possible. The exclusion covers the
  //   target process and its DIRECT children, one level, measured on ONE box; a
  //   grandchild-owned render session is not excluded, and system sounds (pid 0)
  //   are under no root at all.
  // - 🔴 Failures are NOT always surfaced: probe failure/timeout, no Tauri
  //   bridge, refusing to start over an existing session, and the
  //   SLOGA_NO_SCREEN_AUDIO=1 opt-out all degrade to a silent share.
  // - No live click-through of anything in this release. Nothing here may claim
  //   one, and no bullet may promise an outcome.
  // - 🔴 macOS COMES CURRENT in this release (0.59.0 -> 0.62.0), so the old
  //   "never name the Mac" rule is LIFTED and the Mac section below exists
  //   because of it. It ships only once the keybinds clear-lock fix is in the
  //   build; if the Mac slips out of this release, that section must come out
  //   with it. 🔴 Nothing GATES that — there is no SLOGA_EXPECT_* variable for
  //   the Mac the way there is for screen audio — so the copy is hedged
  //   ("is coming current with") rather than stated as accomplished fact. Do not enumerate what 0.60/0.61 contained — point at the
  //   entries below instead, so this copy cannot drift from them.
  // - Screen-share system audio stays Windows + Linux only. The Mac coming
  //   current does NOT give it system audio.
  // - 🔴 The floating-call-card bullet covers the MUTED case ONLY. Both the
  //   before and the after were seen in a real two-seat call, but the pane
  //   that drove both seats blocks the microphone, so every participant read
  //   as muted: an unmuted column and the speaking ring are unverified. No
  //   copy here may describe what an unmuted person's card looks like. The
  //   four-person cap is named on purpose - it is a trade, not a feature, and
  //   a big call now shows fewer faces in that card than it used to.
  // - 🔴 The double-click bullet must NOT promise a join. Nobody has
  //   double-clicked a real voice channel: the path is covered by a unit
  //   spec and the typecheck, never by use, so the copy says what the
  //   gesture DOES in the channel list and stops there. It is also the one
  //   change in this release that alters what an existing habit does, which
  //   is why the bullet names the off switch in the same breath.
  // - 🔴 The channel-reordering bullets must NOT promise that a drag succeeds
  //   on any given handset. NO DEVICE LEG WAS EVER RUN. The feature is covered
  //   by a 30-case unit spec, tsc, eslint and prettier and by nothing else - it
  //   has never executed on a phone, on any OS (operator ruling 2026-09-22
  //   skipped the leg; the approved plan had written it in as a hard merge
  //   gate). That is why the second bullet names the failure modes out loud
  //   rather than claiming coverage, why neither bullet says the gesture
  //   "works", and why both lean on Save being the only thing that writes.
  //   Runsheet still owed in full: ~/Downloads/CHANREORDER-HANDOFF.md.
  //   🔴 This is the THIRD user-visible change in v0.62.0 with its live leg
  //   skipped, after the screen-audio legs and double-click join.
  {
    id: "sloga-2026-09-21",
    title: "Patch Notes",
    published_at: "2026-09-21T23:30:00.000Z",
    web_version: "0.62.0",
    markdown_content: `## v0.62.0 — Windows screen shares carry your computer's sound

### 🔊 Screen sharing in the Windows desktop app
- **Share your whole screen and your computer's sound goes with it.** Sloga captures what your machine is playing directly, and leaves its own output out of that capture, so your game, your video and your music reach everyone.
- **There is no system-audio checkbox to remember any more.** The Windows picker used to offer one, and ticking it was what fed the call back into the share. Sound follows your screen-share audio setting instead, so there is one less thing to get wrong.
- **Whole-screen shares only, for now.** Sharing a single window still carries no sound.
- **When we can tell why the sound did not start, we say so** — on older Windows builds, for instance, or when a second copy of Sloga is already running and holding the capture. Some setups still share silently without an explanation; if that is you, the screen-share settings dialog says what it can.
- **This replaces the advice under v0.54.0 below,** which told Windows users to redo the share with the system-audio box ticked. On this build there is no such box.

### 🎧 Getting into a voice channel
- **Double-click a voice channel to join it.** Until now the channel list only opened a voice channel and the join sat behind the call button in the header; a double-click now does both steps at once. A single click is unchanged — it still just opens the channel — so nothing you already do behaves differently. Not to your taste? Settings → Voice → Voice Channels turns it off.

### 📱 On your phone
- **Channels can be rearranged from the phone app.** Press and hold a channel or a category header, choose **Rearrange channels**, then hold a row to pick it up and drag it where you want it. **Save** applies the new order and **Cancel** throws it away — nothing is written to your server until you press Save. Reordering had been desktop-only; on a phone there was no way to do it at all.
- **This part is brand new, and phones differ.** Press-and-hold has to share the screen with scrolling and with Android's own press-and-hold menu, and that arrangement is not the same on every handset. If a row will not pick up, or the page slides away mid-drag, tell us which phone you are on — and remember nothing changes for anyone else unless you press Save.

### 🔔 Fixes
- **Notifications stop coming back every time you open Sloga.** Channels you had already read were being marked unread again at startup, so the app opened with a pile of notifications for channels that had nothing new in them. Your read positions were saved correctly the whole time — the app was throwing them away as it started, and now it keeps them.
- **The small floating call card no longer hides whoever is muted.** When someone muted, their mute icon was drawn on top of their avatar instead of beside it, so their face vanished altogether — with two people in the card you saw one face and one mute icon, and the icon read as a marker on the person next to them. Everyone in the card now has their name under their avatar, and a muted person gets a small mute icon of their own between the two. The card names up to four people and counts the rest, since names need more room than the bare icons did.
- **In forum settings, "Use this order for everyone" saves.** It was failing with an error every time while the rest of the screen, auto-archive included, saved fine.
- **A channel menu item that read \`a/HlD/\` says "Move to category" again.**

### 🍎 If you are on a Mac
The Mac app has been held back at 0.59.0 while we fixed a keybinds problem that only affected it. It is coming current with this release, so everything in the entries below — from v0.61.0 down to v0.60.0 — arrives on the Mac at once. None of that is new in this release; it is just new to the Mac.

### What has not changed
- This is the Windows desktop app. Sharing system audio **in a web browser still picks up everything the machine is playing, the call included** — that one needs a fix in the browser engine itself, and we are chasing it upstream.
- **Linux** has its own separate capture path and already carries screen audio; nothing about it changes here.
- **macOS** screen shares still carry no system audio.
`,
  },
  // ==========================================================================
  // v0.61.0 (2026-09-20). Copy constraints, load-bearing:
  // - A MINOR bump, not a patch: the encrypted-call banner changes what users
  //   are told about their own call. The label fix alone would have been
  //   0.60.5; that version was cut and never published, so its entry was
  //   replaced by this one rather than kept alongside it.
  // - 🔴 HEDGE THE BANNER COPY EXACTLY AS THE PRODUCT DOES. The strings say
  //   your audio and video "should" stay paused, never "are" paused, because
  //   the client cannot prove the send actually stopped. Do not upgrade
  //   "should" to "will" here. See the bytes-cannot-prove-plaintext finding.
  // - 🔴 NO LIVE LEG WAS RUN. The two-native-seat leg was skipped by operator
  //   ruling. Nothing here may say this was verified in a real call.
  // - Never claim a call IS encrypted. The whole point of the slice is that
  //   "encrypted", "not encrypted" and "cannot be confirmed" are three
  //   different states that previously looked like two.
  // - macOS is STILL held at 0.59.0. No bullet may say "every app" or name
  //   the Mac.
  // - 🔴 Native Windows screen-share audio is merged but DARK
  //   (ENABLE_WIN_NATIVE_SCREEN_AUDIO off in every dist). It is unreachable,
  //   so it is not mentioned. Its entry stays the held-back comment block
  //   above. That silence is a decision, not an oversight.
  {
    id: "sloga-2026-09-20c",
    title: "Patch Notes",
    published_at: "2026-09-20T23:59:00.000Z",
    web_version: "0.61.0",
    markdown_content: `## v0.61.0 — encrypted calls say what they actually know

### 🔒 Call encryption
- **"Not encrypted" and "we can't confirm this is encrypted" are now two different messages.** They used to look the same, which meant a call that was merely still setting up looked as alarming as one that genuinely was not protected.
- **While a call is still being secured it says so** — *Securing this call* — instead of flashing a warning you cannot act on.
- **When something is wrong, it says what to do about it.** If encryption could not be confirmed, or someone in the call turned it off, you are told which it is, and told that your microphone and camera **should** stay held back until it is sorted. We say *should* deliberately: Sloga holds your audio and video back, but it cannot promise a device has stopped sending, so if it matters, leave the call.
- **If a participant turns encryption off mid-call, you find out.** Previously that could change quietly underneath you.
- **If this device's encryption is not registered to your account**, the call now explains that plainly and offers you the three real choices: set encryption up again, continue without it, or leave.

### 🔤 Fixes
- **The Windows, Linux and Android apps were showing codes like \`6kwTPA\` where menu labels belong** — the forum auto-archive durations, the **A-Z** view button, **Use this order for everyone** and the description under it. They read properly now. Only the labels were wrong; every one of those options already did what it said, so nothing you set needs redoing.
- **Read receipts keep up across your devices**, and unread marks stop getting lost when you close a tab mid-read.
`,
  },
  // v0.60.4 (2026-09-20). Copy constraints, load-bearing:
  // - Web, Windows, Linux and Android ship this build. macOS does NOT: it is
  //   still held at 0.59.0 for the keybinds fix, so no bullet may say "every
  //   app" or name the Mac.
  // - A-Z and the forced view need the server deployed. Both shipped together
  //   here; if the copy is ever reused for a client-only build, they must come
  //   out, because the sort parameter does not exist on an older server.
  // - The forced view is enforced by the SERVER, not just hidden in the UI.
  //   Say "cannot change it", because that is now true of any client.
  // - Custom durations are 1 minute to 2 years. Do not round that to "any
  //   length": past two years the server refuses.
  // - Moving a channel changes its CATEGORY. It does not reorder channels
  //   within one — that is still drag-only and still not possible on mobile,
  //   so the bullet must not imply otherwise.
  // - No live click-through was done before this shipped. Nothing here may
  //   claim one.
  {
    id: "sloga-2026-09-20",
    title: "Patch Notes",
    published_at: "2026-09-20T21:00:00.000Z",
    web_version: "0.60.4",
    markdown_content: `## v0.60.4 — A-Z forums, info boards, and a fistful of fixes

### 💬 Forums
- **Browse posts A-Z.** The view button now offers **A-Z** alongside Latest activity and Creation date. A-Z lists numbers first, then letters, and ignores capitals.
- **Pin one view for the whole server.** In **forum settings**, pick a sort order and turn on **Use this order for everyone**. Everybody browsing that forum sees it that way and cannot change it — which is what you want for a forum that serves as an info board.
- **Pick any auto-archive duration.** Alongside the presets — now **1, 3, 5, 7, 10, 15, 20, 25, 30 and 90 days**, plus 1 hour and Never — there is a **Custom** option that takes anything from **1 minute to 2 years**.

### 📱 Fixes
- **The friends pop-out button no longer appears on phones.** It opened a window that a phone has nowhere to put.
- **Your account badge follows your date settings**, and it can actually be tapped on Android.
- **The sticker and emoji panel fits on screen again** instead of overflowing off the edge.
- **Move a channel into a category from its own menu.** Right-press a channel and choose **Move to category** — this works on mobile, where dragging did not. Reordering channels inside a category is still drag-only.
`,
  },
  // v0.60.3 (2026-09-19). Copy constraints, load-bearing:
  // - Web and the server only. The desktop and Android apps bundle their own
  //   copy of the client, so they get this with their next build; the entry
  //   must not promise it everywhere.
  // - "Never" is a real option (0 minutes on the wire). Say it plainly.
  // - Existing forums become 7 days for NEW posts. That is a behavior change
  //   for every forum that never chose one, so it is stated.
  // - Who can change a post's setting is exact: its author, or anyone with
  //   Manage Channel. An author who cannot post in the forum cannot change it
  //   either — the server refuses, so do not imply otherwise.
  // - No live click-through was done before this shipped. Nothing here may
  //   claim one.
  {
    id: "sloga-2026-09-19b",
    title: "Patch Notes",
    published_at: "2026-09-19T21:00:00.000Z",
    web_version: "0.60.3",
    markdown_content: `## v0.60.3 — Forum posts can stay open for 90 days, or forever

### 💬 Forums
- **Posts no longer close after a day.** Every forum post used to archive after one day without a reply. You can now pick **1 hour, 1 day, 3 days, 7 days, 30 days, 90 days, or Never** when you start a post.
- **Each forum sets its own default.** In **forum settings → Default auto-archive for new posts**. Forums that never chose one now use 7 days, so new posts stay open a week instead of a day.
- **You can change a post after it starts.** Open the post and use the **Auto-archive** menu in its header. The post's author can change it, and so can anyone with Manage Channel.
- **Busy forums no longer fill up.** Open posts used to count against a limit of 100 open posts per forum. They no longer do.
- **Reopening a post keeps it open.** Unarchiving a quiet post used to archive it again within a minute. Fixed.
`,
  },
  // v0.60.2 (2026-09-19). Copy constraints, load-bearing:
  // - Also covers v0.60.1 (voice auto-rejoin), which shipped with no entry.
  // - The lock bullet claims only what gate (d) witnesses: nothing anyone
  //   sends is FAILING to decrypt on this device. It is receive-side and
  //   measures discards, so never "proves the call is encrypted" or "verified".
  // - The removed-member bullet says "in some cases" on purpose: it needed a
  //   long call (16+ key changes) plus a reconnect or an unmute to trigger.
  // - The speaking/silent bullet is the DTX fix. It costs a little bandwidth
  //   on encrypted calls, which is said rather than discovered.
  // - Account switch: say what the user sees and where the fix is. Never quote
  //   the banner sentences — they are build-gate markers.
  // - The unread-count line names Windows and Linux only: macOS is held at
  //   0.59.0 and does not ship this build.
  // - NONE of these four encryption changes has had a live two-device test.
  //   Nothing here may claim one.
  {
    id: "sloga-2026-09-19",
    title: "Patch Notes",
    published_at: "2026-09-19T12:00:00.000Z",
    web_version: "0.60.2",
    markdown_content: `## v0.60.2 — Encrypted call fixes, and unread counts on your app icon

### 🔒 Encrypted calls
- **The server can no longer tell when you are talking.** When you went quiet, your microphone sent short silence packets that were not encrypted, so anyone watching the connection could see when each person in an encrypted call was speaking and when they were silent. Those packets are encrypted now. Encrypted calls use slightly more data while you are silent as a result.
- **Someone removed from a long encrypted call can no longer read it again.** After many people had joined and left, a reconnect or an unmute could, in some cases, put your device back on an older key that a removed member still held. Fixed.
- **The lock now waits for evidence.** It used to show the call as encrypted by default. It now appears only once your device can see that nothing anyone in the call sends is failing to decrypt, so it may take a moment longer to show up.
- **Switching accounts in the desktop app no longer silently breaks voice.** If encryption on your computer had been set up by a different account, joining a voice channel just failed with no reason given. Sloga now explains what happened and takes you to **Settings → Encryption** to set it up for the account you are signed in as.

### 🎙️ Calls
- **Voice calls reconnect on their own.** If your connection drops during a call, Sloga now rejoins it for you instead of leaving you disconnected. If it cannot get back in, the call card shows a **Rejoin** button.

### 🔔 Unread counts
- **Your unread count now shows on the app icon**: on the taskbar on Windows, and in the launcher on Linux where your desktop supports it. It is the same number the server list shows, and muted servers are left out. When Sloga is hidden to the tray, the tray icon shows a dot.
- In a browser tab, the count shows in the tab title.
`,
  },
  // v0.60.0 (2026-09-16). Copy constraints, load-bearing:
  // - The keybinds platform line is exact and must stay exact: on macOS,
  //   Linux and web there is NO native bridge, so the nine system-wide rows
  //   are DISABLED and cannot be bound at all. Only the three in-app actions
  //   (start screen share, fullscreen, theater) work there. An earlier draft
  //   said bindings "still fire while Sloga is focused", which would send a
  //   Mac user to a grayed-out row to file a bug.
  // - The lone-Ctrl caution is deliberate, not a hedge: a bare Ctrl binding
  //   fires on every Ctrl shortcut system-wide AND on every AltGr, because
  //   Windows synthesizes ControlLeft before AltRight. Users who bind it
  //   without knowing that will report it as a bug.
  // - Disconnect is described as "not a kick" on purpose: the entry sits
  //   next to Kick and Ban in the same menu, and a moderator reading it as
  //   permanent would misuse it.
  // - The rank rule is stated on purpose. A moderator who cannot mute a peer
  //   will otherwise report that as broken.
  // - The encrypted-calls bullet describes the PUBLISH GATE only. Say
  //   "cannot be secured", never the exact banner sentence, and never
  //   "turned off" / "starting capture" wording: those strings are build
  //   gate markers and the notes must not collide with them. Make no claim
  //   about what the chip or the banner says; those waves have not landed.
  // - NOT announced: denying Read Message History on a forum still hides
  //   nothing server-side, so the forum bullet claims only that the rows are
  //   settable, never that they are enforced.
  // - macOS: the first bind locks every system-wide row including its own
  //   clear control. Not claimed here, and it must be fixed before a Mac
  //   build carries this page.
  {
    id: "sloga-2026-09-16",
    title: "Patch Notes",
    published_at: "2026-09-16T12:00:00.000Z",
    web_version: "0.60.0",
    markdown_content: `## v0.60.0 — Keybinds, and moderating a call

### ⌨️ Keybinds
- **Settings → Keybinds is new.** Bind a key to mute, deafen, your camera, stopping a screen share, disconnecting, accepting or dismissing a call, showing and hiding Sloga, and the overlay — and on the Windows app **those keys work while you are in another application.** No more alt-tabbing out of a game to mute.
- **The key still works in whatever you are using.** Sloga acts on it and the game or app in front of you receives it as normal, so binding a key you already use somewhere else will not break it there.
- **A key on its own works, and so does a combination.** Ctrl by itself is a valid binding, and so is Ctrl+H. Bear in mind that a lone Ctrl fires on *every* Ctrl shortcut you press — and on AltGr, which Windows reports as Ctrl — so binding it together with a regular key is usually what you want. Sloga warns you when a binding is a key you are likely to type.
- Starting a screen share, fullscreen and theater mode are bound too, but they need Sloga in front of you.
- Keys that work outside the app are **Windows only for now.** On macOS, Linux and the web the system-wide group is grayed out with a note saying why; the three that need Sloga in front of you — starting a screen share, fullscreen and theater mode — can still be bound, and still work.
- **CapsLock can be bound**, and capturing AltGr reads as "Ctrl + Right Alt", which is the binding that works on those layouts.
- **Keybinds are saved on the device you set them on** and are not carried between your devices.

### 🎙️ Calls
- **Moderators can now mute, deafen and disconnect someone in a call.** Right-click somebody in a voice channel and you will find Server Mute, Server Deafen and Disconnect from call. A server mute stops them transmitting to everyone; a server deafen also stops them hearing. Both stay until a moderator lifts them.
- These need the matching server permission — Mute Members, Deafen Members and Move Members — and you cannot use them on somebody at your own rank or above. Disconnecting somebody removes them from the call; it is not a kick, and it does not stop them rejoining.
- **Somebody muted or deafened by a moderator now carries a badge** beside their name in the call, so it is clear who was silenced by a moderator and who muted themselves.
- **If a moderator mutes you, Sloga now tells you.** Your microphone previously just stopped working, with nothing on screen to explain why.

### 🔒 Encrypted calls
- **Your microphone no longer sends anything at all until an encrypted call is ready for it.** Joining or rejoining could previously let a moment of audio out before the call's encryption was armed.

### 💬 Forums
- **A forum's permission settings now show the posting permissions.** Sending messages, managing messages, managing the channel and managing roles were missing from the list outright, so there was no way to set who may post in a forum.
- **Several permission rows now describe what they actually control** in a forum, instead of repeating the wording written for ordinary text channels.

### 🛡️ Security
- **Lifting a server mute is now checked like applying one.** Somebody who had been server-muted could previously remove it from themselves and start transmitting again.
`,
  },
  // v0.59.0 (2026-09-13). Copy constraints, load-bearing:
  // - The re-securing fix is the one item here seen working on a real call: a
  //   live leg on 2026-09-11 reproduced the stuck chip on the base build and
  //   saw the fixed build recover. Say it recovers; promise nothing wider.
  // - The other encrypted-call changes riding this line (the join-race hold,
  //   the heal-install work, the false-red pause fix, the banner wording) have
  //   no live leg and are NOT announced, not even as "other reliability fixes".
  // - Group calls: this entry CORRECTS the v0.58.1 line saying group owners
  //   can turn calls on. The backend now treats every group as callable until
  //   it is switched off; the client change is copy only, so this item is only
  //   true once the backend deploy has landed. The v0.58.1 entry stays as
  //   published. The switch is gated on ManageChannel, and this entry does not
  //   assume only owners hold it, so the copy says "a group", never "owners".
  // - The group-call, menu and badge items are copy and UI changes; no live
  //   leg is claimed for them.
  // - Forums (ebe459c1, merged in ec00f84e): its commit records a check in a
  //   preview build against production on a test forum (Enter adds lines,
  //   tag emoji pick and remove, a throwaway post retagged). That is a
  //   browser check, not a live leg; nothing here claims more. The tag button
  //   is shown only to the post's author or a forum manager, so the copy says
  //   who can use it. Only server emoji went from text to an image, so the
  //   copy claims that and nothing wider.
  // - Never quote the group-settings sentence, the moderator badge tooltip,
  //   the admin tool's address, or the forum strings (the retag dialog's
  //   title and empty-state line, the tag-emoji button labels): those are
  //   build gate markers. Say "switch off", never "turned off"; say "change a
  //   post's tags" and "tag emoji are chosen", never the button wording.
  // - The eight reported bugs merged in a76b5348 (09-13): six from the
  //   09-11/09-12 reports, the Android back key, and a drawer/side-panel
  //   reset found by that session's audit. None of them has a device leg;
  //   they are source fixes under the existing specs, so each line says what
  //   the fix does and claims nothing about devices it ran on.
  // - 🔴 The landscape-blanking report (edit a profile on Android, rotate,
  //   everything disappears) gets NO line here, by operator decision. A
  //   mechanism is now confirmed, but it does not account for the whole
  //   report, so this is not a closed root cause. The operator's own device
  //   reads 540 CSS px on the short side, with the phone media query false
  //   and the tablet query true: that is inside the 501-600 dead band, so
  //   rotating crosses the phone/tablet boundary, which drops BackAction
  //   (_phone only) and hides CloseAction (_tablet) — both exit controls at
  //   once. That explains controls changing places, not a screen going blank;
  //   the residual is unexplained. 4bb58da9 hardened four other real defects
  //   found while chasing it. The dialog-scrim candidate was reported
  //   disproved by a peer session on 09-13, with a control page that is NOT
  //   in this repo — second-hand, so do not treat it as closed: Dialog.tsx is
  //   still grid + place-items center + overflow-y auto, untouched by this
  //   release, and a76b5348's message describes it as a live source-level
  //   defect affecting every Dialog.
  //   v0.59.0 changes nothing about the boundary — Breakpoint.ts is untouched
  //   — so the entry claims nothing. Note that 92da0bbb does restore a
  //   back-key exit from that state on Android, which may mask the symptom
  //   without addressing the cause: another reason to claim nothing.
  //   Two candidate fixes, neither a release-week change: the boundary in
  //   components/common/Breakpoint.ts (it drives the JS layout signal AND
  //   every Panda _phone/_tablet rule), or narrower local gating in
  //   settings/_layout/Content.tsx so one exit control always survives.
  //   The Device.tsx layout log stays unguarded on purpose until the device
  //   leg has run — the leg reads it — so a76b5348's "remove it once report 5
  //   is root-caused" is deliberately NOT discharged by this comment.
  // - The phone member-list button is now ONE-WAY (it shows the list and no
  //   longer hides it) and this entry says so on purpose. Nobody reported it;
  //   it fell out of the fix. A user who used that button to hide the list
  //   will notice, and an unannounced behavior change reads as a new bug.
  // - No Version section: this entry makes no claim about which platforms
  //   carry v0.59.0.
  {
    id: "sloga-2026-09-13",
    title: "Patch Notes",
    published_at: "2026-09-13T19:00:00.000Z",
    web_version: "0.59.0",
    markdown_content: `## v0.59.0 — Encrypted calls recover from a rejoin

### 🔒 Encrypted calls
- **Leaving and rejoining an encrypted call no longer leaves it stuck re-securing.** When someone left and came back, the call could stay on Re-securing until the app was restarted. It now recovers on its own.

### 👥 Group calls
- **Calls are now on by default in group chats**, so the call button is back. A group that would rather not have calls can switch them off in the group's settings.
- This corrects the v0.58.1 notes, which said group owners had to turn calls on.

### 📱 Android and phones
- **Viewing a photo on Android keeps its buttons on screen.** The zoom, copy, download and close buttons were being pushed off the right edge, so you had to turn the phone sideways to reach them. They stay put in portrait now, and a long file name is shortened instead of shoving them off.
- **The member list button works in text channels on Android.** It previously did nothing at all; it now slides the member list in.
- **The back key closes what is open, instead of closing Sloga.** Pressing back with a profile, a dialog or a search panel open used to quit the app outright. It now closes them one at a time, and only leaves the app when there is nothing left to close.
- **On a phone the member list button is now one way**: it shows the member list, but it no longer hides it. Hiding it that way took the list away from the only place a phone can reach it. Press back, or swipe across, to get back to the conversation — and you can still drag the divider to give the list less room.

### 🧭 Around the app
- **Channels marked 18+ ask you to confirm your age once**, rather than once per channel. Joining a server with thirty of them no longer means thirty prompts.
- **The channel list no longer jumps back to the top** when you click a channel.
- **Long text on your profile no longer cuts off mid-word.** A long status line and the Joined panel used to shear through a letter at the edge of the tile. They now fade out at the cut, and Joined scrolls when there is more than fits.

### 🧹 Menus and badges
- **The Admin Panel shortcut is gone from the right-click menus**, along with the Advanced setting that showed it. It was a leftover that pointed at another project's staff tool and never worked on Sloga.
- **Sloga moderators' names now appear in the multicolor Sloga brand colors** in messages and replies, like the rest of the Sloga team, and their profile badge now names them as a Sloga moderator.

### 💬 Forums
- **Forum posts keep their line breaks.** When you write a new post, Enter now starts a new line in the message box instead of posting it.
- **You can change a post's tags after posting**, from the tag button at the top of the post. It is there for whoever wrote the post and for anyone who manages the forum.
- **Tag emoji are chosen with the emoji picker** in a forum's settings, custom server emoji included. A server emoji on a tag now shows as the emoji itself instead of as text.
- **Channel and server descriptions no longer save when you press Enter.** Enter adds a new line there too.
- **Opening a forum post no longer opens the member list with it.** The post gets the full width, and the member list follows whatever the channel it sits in was set to.
`,
  },
  // v0.58.1 (2026-09-11). Copy constraints, load-bearing:
  // - 🔴 ANNOUNCED WITHOUT A LIVE LEG, deliberately. The standing rule in this
  //   file — announce a fix only once it has been seen working — was WAIVED by
  //   the operator for this entry on 2026-09-10, after the trade was put to
  //   them: ship now and fix on report, rather than hold the release. Nothing
  //   below has run on a real call. Everything below is covered by unit specs
  //   (the mute gate has a negative-control regression test) and the fullscreen
  //   dialog fix was reproduced and re-verified in a real browser, but that is
  //   not the same thing and this comment exists so nobody later mistakes it
  //   for one.
  // - 🔴 If a report comes back on any of these, THIS entry is what to correct
  //   first: an announced fix that does not work is worse than an unannounced
  //   one, because the user has been told to stop looking for the bug.
  // - The voice-activity items only reach users on the Voice Activity input
  //   mode (Settings → Voice). Open Mic and Push to Talk were never affected,
  //   so the copy names the mode rather than implying every muted user was
  //   being broadcast.
  // - This entry CLEARS the held-back list from the 0.58.0 entry: group-chat
  //   calls, the canceled-picker dialog, the shorter join banner, the
  //   immediate pause when a plain browser joins, and the chip after people
  //   churn. Those were held back for want of a live leg they never got; they
  //   ship announced here under the same waiver as the rest of this entry.
  // - Say "cannot be secured", never the exact banner sentence, and never
  //   "turned off" / "starting capture" wording: those strings are build gate
  //   markers and the notes must not collide with them.
  // - NO new encryption claim. Media E2EE is a native-shell capability
  //   (`nativeE2EEAvailable`: Tauri, the Electron shell, Capacitor Android) and
  //   the web app cannot do it; the Android path has never been exercised live,
  //   so it is not announced here. 0.58.0's entry already tells that story.
  // - 0.58.1 is the first build on ONE version across web, Windows, macOS,
  //   Linux and Android since 09-04. That is what resolves the closing lines in
  //   both the 0.58.0 and the 09-05 sidebar-highlight entries, which promised
  //   Windows and Android these changes "with their next update".
  {
    id: "sloga-2026-09-11",
    title: "Patch Notes",
    published_at: "2026-09-11T17:00:00.000Z",
    web_version: "0.58.1",
    markdown_content: `## v0.58.1 — Mute means mute

### 🎙️ Your microphone does what the button says
- **Muting yourself now holds.** On Voice Activity input mode, talking could re-open your microphone a moment after you started — while the button still read muted. If your audio interface has a mute of its own, that one always worked, which is the detail that gave the bug away.
- **Your microphone no longer freezes while Sloga is in the background.** Minimizing the window or alt-tabbing into a game stopped voice detection outright, leaving your microphone stuck however it was last set: unable to open until you came back, or still open when you thought you were quiet.
- **Mute and deafen follow what you pressed.** They used to flip whatever your microphone happened to be doing at that instant, so pressing mute during a pause between words could switch it on.

### 🖥️ Screen sharing
- **The resolution and frame-rate options are visible when the call is full screen.** They were opening behind it, so the share sat paused waiting on a dialog you could not see.
- **Retrying a share no longer stacks up dialogs** behind the first one.
- **Canceling the screen picker counts as canceling**, instead of raising an error about it.

### 💬 Forums
- **A forum can no longer require a tag it does not have.** Turning on "every post needs a tag" without adding any tags left the New Post button dead with nothing on screen explaining why. Settings now says which of the two to change, and the composer says what is missing.

### 👥 Group calls
- **Group owners can turn calls on** for their group.
- A call that **cannot be secured** says so before anything is sent, and the call chip settles correctly after people join and leave.

### 🔢 Version
- Web, Windows, macOS, Linux and Android are all on v0.58.1 — one version across the whole fleet.
`,
  },
  // Linux 0.58.0 (2026-09-07). Copy constraints, load-bearing:
  // - Linux-only release: encrypted calls switched on for the Linux app, proven
  //   on the wire (receiver-side ciphertext tap) and with a deliberate key
  //   failure the same day. Windows and Android still bundle 0.57.0; the
  //   closing line self-resolves at the next shell sweep.
  // - Say "cannot be secured", never the exact banner sentence, and never
  //   "turned off" / "starting capture" wording: those strings are build gate
  //   markers.
  // - EXCLUDED, no live leg on this build: the shorter join banner, the
  //   immediate pause when a plain browser joins, the chip after people churn,
  //   group-chat calls, the canceled-picker dialog. They ride the next sweep's
  //   entry once they have been seen live.
  // - `web_version` is what Settings will print once this entry reaches the web.
  {
    id: "sloga-2026-09-07",
    title: "Patch Notes",
    published_at: "2026-09-07T18:30:00.000Z",
    web_version: "0.58.0",
    markdown_content: `## v0.58.0 — Encrypted calls on Linux

### 🔒 Your calls on Linux are now end-to-end encrypted
- **Voice, camera and screen share from the Linux app are encrypted before they leave your machine**, the same way they already are on Windows. The server relays your frames but cannot read them; only the people in the call hold the keys.
- Nothing to switch on. When everyone in the call is on an app that supports it, the call chip reads Encrypted and stays that way. A call with someone on the web or an older app tells you so before anything is sent.
- We checked this the hard way: a Linux install exactly like yours published a call while the other end recorded every frame as it arrived, before decryption. All of them were unreadable. Breaking the other end's copy of the key on purpose made that side fail loudly rather than show a picture.

### ⏸️ A call that cannot be secured never sends in the clear quietly
- **If the encryption handshake is slow, your microphone and camera wait**: the chip shows the call re-securing and nothing goes out unencrypted in the meantime.
- If it fails, you get a clear choice: leave the call, or stay and continue without encryption. The app will not make that decision for you.

### 🖥️ Screen sharing on X11
- **The screen picker opens on top of the Sloga window** instead of somewhere behind it, lists your screens and windows, and closes with Escape.
- Sloga's own windows are no longer offered as something to share, which also removes a crash that picking one could cause.

### 🔢 Version
- The Linux app moves to v0.58.0 today. Windows and Android get these changes with their next update.
`,
  },
  // Sidebar highlight (web-only at publish, 2026-09-05). Copy constraints,
  // load-bearing:
  // - The setting recolors ONLY what MenuButton paints in its `active` state:
  //   unread channels and threads, online members, the voice channel you are
  //   in, ringing and unread DMs. It does not touch the theme accent, message
  //   text or role colors. Do not widen it.
  // - Presets are the brand orange (default), white and the six other colors
  //   of the O mark; the picker takes anything. Say "colors from the Sloga
  //   logo", never list hex values.
  // - Theme settings are NOT in the synced store list (Sync.ts): the choice
  //   is per device, and the copy says so.
  // - The Windows, Linux and Android apps still bundle 0.57.0 without it; the
  //   closing line self-resolves at the next shell sweep, as on 08-26.
  // - The version string stays 0.57.0 (no bump), so the heading carries no
  //   version number. `web_version` matches what Settings prints.
  // - EXCLUDED: the sign-out-leaves-call fix went out in the same web deploy
  //   with no live leg (the error path is uncovered), so it is not announced.
  {
    id: "sloga-2026-09-05",
    title: "Patch Notes",
    published_at: "2026-09-05T17:00:00.000Z",
    web_version: "0.57.0",
    markdown_content: `## Pick your own sidebar highlight color

### 🎨 The orange is now yours to change
- **Settings → Appearance has a new Sidebar highlight option.** It sets the color that calls things out in the sidebar: unread channels, members who are online, the voice channel you are in, and DMs that are ringing or unread.
- Sloga orange stays the default. Pick white, one of the colors from the Sloga logo, or open the color picker for any color you like.
- It works with both the Sloga theme and Material You, and switching between them keeps your choice. Like the rest of Appearance, it is saved on this device.
- Live on the web today. The Windows, Linux and Android apps get it with their next update.
`,
  },
  // v0.57.0: the voice shaper + the microphone-access sweep. Copy constraints,
  // load-bearing:
  // - The shaper is EQ/compression presets on the LOCAL mic only. It is not a
  //   voice changer: no pitch shifting, no formant work, no AI. Never call it
  //   a voice changer or imply it hides who you are.
  // - Exactly one preset at a time, by construction (the mic has ONE
  //   processor and the shaper is a stage inside it).
  // - The mic-pipeline change is real for EVERYONE, not just preset users:
  //   the enhanced noise filter and the input-gain slider used to be mutually
  //   exclusive and only applied at join. Say so plainly.
  // - The presets were designed on paper, not tuned by ear on a live call.
  //   Promise nothing beyond each one-line description.
  // - The rejoin-after-reload fix shipped to Windows + web on 09-01 with NO
  //   entry (0.56.0 had none); Linux gets it HERE. Android's shell lacks the
  //   native half and degrades to an explicit error, so the copy says
  //   "Windows, Linux and the web" and nothing about Android.
  // - Blocked microphone on Windows: one Deny on the first prompt used to be
  //   remembered forever with no way back. Describe the symptom, never the
  //   WebView2 internals.
  // - EXCLUDED as dark or unproven: Linux media E2EE (flag branch unmerged),
  //   Linux native screen-share audio, Android screen share, RC couch co-op,
  //   server boosts, the public directory, slash-command bot docs, Kick.
  {
    id: "sloga-2026-09-04",
    title: "Patch Notes",
    published_at: "2026-09-04T03:00:00.000Z",
    web_version: "0.57.0",
    markdown_content: `## v0.57.0 — Voice shaper, and microphone fixes

### 🎚️ Voice shaper
- **Shape how your microphone sounds to everyone else.** Settings → Voice has a new Voice Shaper section with six presets: Off, Warm, Bright, Deep, Radio and Podcast. Warm rounds off a thin headset mic, Bright lifts a muffled one, Deep adds chest, Radio is the walkie-talkie sound, and Podcast evens out your level with a broadcast-style polish.
- One preset at a time, and switching applies live while you are in a call, so you can try them on your friends.
- This is tone shaping, not a voice changer. It does not alter your pitch or disguise your voice.

### 🎙️ Noise suppression and input gain now work together
- **The enhanced noise filter used to switch off your input-gain setting**, and both only took effect when you joined a call. They now run together, alongside the shaper, and every change applies immediately mid-call.

### 🔇 When your microphone is blocked, the app says so
- **On Windows, clicking Deny on the very first microphone prompt used to be remembered forever.** After that the microphone never worked again and no device even appeared in Settings. The desktop app now handles that prompt itself, so a denied microphone or camera can be allowed again.
- Everywhere, an empty device list now explains why it is empty, and a blocked microphone is reported when you join a call instead of silently joining muted.

### 🔁 Reloading mid-call no longer strands you
- **Reloading the app, or having it crash, during an encrypted call used to leave you stuck at the securing step**, unable to be heard until everyone hung up. You now rejoin cleanly. Windows and the web got this at the start of the month; the Linux app gets it with this update.

### 🗣️ Voice activity detection
- Speaking softly no longer opens your microphone while the level meter shows you below the threshold. The meter and the gate now listen to the same signal, and the gate waits for a brief sustain before opening, so a single click or breath does not trigger it. Windows and the web have had this since v0.56.0; Linux and Android get it here.

### 📺 Screen sharing
- While you share your screen with system audio, the automatic lowering of other apps is paused, and the app now tells you so instead of leaving you to wonder why it stopped working.
- The ask-for-a-turn control on a shared screen moved to the top-right corner of the tile, out from under the theater and fullscreen buttons.

### 🔢 Version
- Every platform moves to v0.57.0 together.
`,
  },
  // v0.55.0: the call-audio sweep — the silent-peer fix, the outgoing ring,
  // the encrypted-call roster contrast fix, and the version renumber. Copy
  // constraints, load-bearing:
  // - The silent-peer fix was proven live Windows<->Windows and
  //   Windows<->Linux. Describe the SYMPTOM (you could not hear them, they
  //   could hear you) — never claim every silent-call report is this bug.
  //   Audio-device and mixer problems look identical to a user.
  // - The outgoing ring stops on ANSWER or when the caller hangs up. It does
  //   NOT stop on a decline — the callee's decline is local-only by design and
  //   nothing reaches the caller, so the ring runs to its natural stop. Do not
  //   write "stops when they decline"; it would be a false promise.
  // - The fail-safe item is call reliability, worded plainly. Do not name MLS,
  //   epochs or negotiation states — users cannot act on any of it.
  // - The shell-sounds item: VERIFIED against Sounds.tsx, do not widen it. Only
  //   the nine `new Audio(...)` cases were CSP-blocked — mute/unmute,
  //   deafen/undeafen, streamStart/End, streamViewerJoin/Leave, userMoved.
  //   ringtoneIncoming, ringtoneOutgoing, message, messageSent, userJoinVoice
  //   and userLeaveVoice all go through `#playRingtone`/`#playTone` (Web Audio)
  //   and were NEVER affected. The cherry-picked commit message says "no
  //   ringtone in or out" — that part of it is wrong; do not copy it.
  // - Thirteen of the fourteen bundled .ogg files are BYTE-IDENTICAL
  //   (sha256 5135e1ab…), so un-blocking them makes those nine cases play the
  //   same placeholder tone. Say so; announcing "your sounds are back" without
  //   it would oversell a set of identical blips.
  // - The version line is here because desktop jumps 0.50.0 -> 0.55.0 while
  //   Android's NAME drops 1.46.4 -> 0.55.0. Unexplained that reads as a
  //   downgrade. Say it once, plainly, and move on.
  // - EXCLUDED as dark or unproven, unchanged from v0.54.0: Android screen
  //   share (flag never lit), remote-control couch co-op, server boosts, the
  //   public directory, slash-command bot docs, Windows/Linux native
  //   screen-share audio (built but flag-dark, no live legs).
  {
    id: "sloga-2026-08-31",
    title: "Patch Notes",
    published_at: "2026-08-31T21:00:00.000Z",
    web_version: "0.55.0",
    markdown_content: `## v0.55.0 — Call audio fixes

### 🔇 The silent-peer fix
- **Some people could join a call and simply never be heard.** They could hear everyone else perfectly, and everyone else saw them connected and talking — there was just no sound. It hit hardest between different apps, most often when someone on the Linux app talked to someone on Windows.
- The cause was on the listening end, not the speaker's: incoming audio was arriving intact and then being discarded by the call encryption layer before it ever reached the speakers. It now recognizes an unencrypted caller correctly and lets their audio through.
- If you have been the person nobody could hear, this is the update that fixes it. Both sides need it, so give it a moment for everyone in your group to update.

### 📞 Outgoing calls ring again
- **Starting a call used to be completely silent for the caller.** The person you were calling heard their ringtone, but you got nothing — no way to tell whether the call had actually gone out.
- You now hear a ring while you wait. It stops the moment they answer, or when you hang up.
- Prefer the quiet? It follows the outgoing ringtone switch in your notification sound settings, same as every other sound.

### 🔈 Desktop and Linux: the interface sounds that never played
- **Mute, deafen, stream start and stop, and being moved between channels made no sound at all in the desktop and Linux apps.** The app shell was rejecting the bundled sound files outright and saying nothing about it, which looked exactly like having those sounds switched off. Both apps allow them now.
- Ringtones, message tones and the voice join and leave chimes were never affected — those are generated as you go rather than loaded from a file, which is why some sounds worked and others were simply absent.
- Worth setting expectations: the bundled effects are still placeholders and currently all share one tone. Real ones are on the list.
- The web app was never affected by this.

### 🔒 Encrypted-call panel is readable again
- The panel listing who is on an encrypted call had dark text on a dark background, so the title and the names were nearly invisible. They are properly contrasted now.

### 🤝 Steadier call setup
- A safety net meant for calls whose encryption genuinely fails to come together was firing on perfectly healthy calls as they connected. It now stays out of the way unless something has really gone wrong.

### 🔢 One version number everywhere
- Desktop, Linux, Android and the web each carried their own unrelated version number, none of which matched these patch notes. **They are all v0.55.0 from here on** — so the number in Settings is the number at the top of this page. Nothing was rolled back; the counters were merged into one.
`,
  },
  // v0.54.0: the shell sweep — screen-share audio fixes + the v0.53.0 profile
  // release reaching desktop/Linux/Android. Copy constraints, load-bearing:
  // - Users are shown only the NEWEST entry automatically, so shell users
  //   jumping from the v0.52.0 bundle would otherwise never see the profile
  //   release at all — that is why it is restated here, not assumed read.
  // - The echo fix is `restrictOwnAudio`, honored by Chromium/WebView2 141+.
  //   It is best-effort per spec and has NOT had a live two-account leg yet —
  //   describe the intent, never promise it is impossible to hear an echo.
  // - Window shares still carry NO audio on Windows, and Linux has no
  //   screen-share audio at all. Both are platform limits we cannot fix from
  //   the client; the dialog now says so per-OS. Do not imply either is fixed.
  // - Upload errors: we now SHOW the reason. We did not add HEIC support —
  //   never imply iPhone photos will work.
  // - EXCLUDED as dark or unproven: Android screen share (flag never lit),
  //   remote-control couch co-op, server boosts, the public directory,
  //   slash-command bot docs, PipeWire audio capture (not built).
  {
    id: "sloga-2026-08-27",
    title: "Patch Notes",
    published_at: "2026-08-27T21:00:00.000Z",
    markdown_content: `## v0.54.0 — Screen share audio, and the profile update lands everywhere

### 🔊 Screen sharing
- **Sharing system audio no longer feeds the call back into your stream.** Sharing your whole screen with sound used to capture everything your machine was playing — including the voices of the people in the call with you — so everyone heard themselves echoed back. Your own call audio is now filtered out of the capture.
- **When a share has no sound, we finally say why.** The old message just read "audio disabled by browser" no matter the reason. Now it tells you what actually happened: on Windows, that you shared a window or left the system-audio box unticked (and how to redo it); on macOS, that only tab audio can be captured; on Linux, that system audio capture isn't available there yet.
- Sharing a single window still carries no audio on Windows, and Linux screen shares have no audio path at all — those are limits of the underlying browser engines, not settings you've missed. We're looking at what we can do natively on Linux.

### 🖼️ Uploads that fail now tell you why
- **A rejected avatar, banner, server icon or role icon used to fail silently.** The Save button appeared to do nothing and the old picture stayed. Now you get the actual reason — the file is too large, or that file type isn't supported.
- If your photo came straight off a phone camera, it may be in a format we can't read yet. Re-save or export it as a JPG or PNG and it'll go through.

### 💙 The profile update is now on every platform
Everything from v0.53.0 — which landed on the web last week — arrives here for desktop, Linux and Android:
- **Friends can write on your profile.** A short note, one per friend, theirs to rewrite. Plain text only, and your wall is yours to curate.
- **Put your player IDs on your profile.** Steam, Epic, Battle.net, PlayStation, Xbox, Riot, Ubisoft, Rockstar, Activision, Nintendo, EA, GOG and GGG. One click copies a handle.
- **Pronouns on your profile**, if you want them there.

### 🌍 Translations
- A large batch of interface text that had never been sent for translation is now in the catalogs, so far more of the app can appear in your language.
`,
  },
  // v0.53.0: the profile update — respect wall + game IDs + pronouns. Copy
  // constraints, load-bearing:
  // - Do NOT quote these UI strings (they are this release's grep markers):
  //   "Give respect", "Write something nice", "Player ID or handle".
  //   Paraphrase — "give someone respect" lowercase in prose is fine.
  // - One entry per friend per wall, edit-in-place — say it, it's the
  //   anti-spam design. The owner can delete anything on their own wall.
  // - Walls are plain text ON PURPOSE (no pings, no links) — safe to state.
  // - Blocking someone removes your words from each other's walls — safe to
  //   state. A plain unfriend does NOT (deliberate); don't promise it does.
  // - The wall honors the friends-only profile visibility setting.
  // - Game IDs are self-typed handles, NOT verified accounts — never imply
  //   linking/verification. Click copies the handle.
  // - Web-only at publish time: desktop/Linux/Android still carry the
  //   v0.52.0 bundle — keep the "with their next update" close.
  // - EXCLUDED as dark or unproven: Android screen share (flag never lit),
  //   remote-control couch co-op, server boosts, the public directory,
  //   slash-command bot docs.
  {
    id: "sloga-2026-08-26",
    title: "Patch Notes",
    published_at: "2026-08-26T04:30:00.000Z",
    markdown_content: `## v0.53.0 — Your profile, with people in it

### 💙 Respect
- **Friends can now write on your profile.** Open someone's profile and leave them a short note — a compliment, an inside joke, a thank-you for carrying the raid. It shows up on their profile for anyone who can see it.
- **One note per friend, and it's yours to rewrite.** Writing again edits what you said before, so a wall reads like a guestbook, not a comment feed.
- **Your wall, your rules.** Remove anything from your own wall whenever you like. Blocking someone clears their words from your wall and yours from theirs, both at once.
- **Plain text only, on purpose.** Nothing on a wall can ping you, embed anything, or link anywhere.
- If your profile is set to friends-only, your wall is too.

### 🎮 Game IDs
- **Put your player IDs on your profile.** Steam, Epic, Battle.net, PlayStation, Xbox, Riot, Ubisoft, Rockstar, Activision, Nintendo, EA, GOG — and GGG for the Path of Exile crowd. Add them in Settings → Profile.
- **One click copies the handle.** No more typing your friend code into chat for the fifth time — it's on your profile, and anyone who can see it can copy it straight into a friend search.
- These are handles you type in yourself, shown as text on your profile — add the ones you want people to find you by.

### 🏷️ Pronouns
- **Profiles can now carry your pronouns.** Set them in Settings → Profile and they appear under your name wherever your profile shows.

On the web now; the desktop and mobile apps pick these up with their next update.`,
  },
  // v0.51.0: regional voice servers reach every platform + the per-server
  // voice region control. Copy constraints, load-bearing:
  // - The South American server is REAL and live (Sao Paulo). Routing to it
  //   already shipped to every platform in the previous update, so it is
  //   correct to describe it as working everywhere TODAY. The new thing in
  //   this release is the per-server CONTROL.
  // - The control is web-first at publish time; the shells pick it up with
  //   this sweep. Keep the closing line honest about that.
  // - Do NOT quote these UI strings (they are this release's grep markers):
  //   "Voice region", "US East", "South America (Sao Paulo)". Paraphrase —
  //   lowercase "voice region", "Sao Paulo", "US east coast" are all fine and
  //   deliberately differ from the marker strings.
  // - Never imply Sloga stores or records call media on any node: the nodes
  //   are stateless relays and calls stay end-to-end encrypted. Do not
  //   promise specific millisecond numbers.
  // - EXCLUDED as dark or unproven: remote-control couch co-op (no UI, not
  //   shipped), Android screen share (flag never lit), slash-command bots
  //   (no live smoke, docs unpublished), server boosts, the public server
  //   directory (empty in production).
  {
    id: "sloga-2026-08-23",
    title: "Patch Notes",
    published_at: "2026-08-23T22:30:00.000Z",
    markdown_content: `## v0.51.0 — Calls closer to home

### 🌎 A voice server in South America
- **Calls can now run out of Sao Paulo.** Sloga runs voice servers in more than one place, and your app quietly checks which one answers fastest a moment before you join. If you're in Brazil or nearby, that's a machine in Sao Paulo instead of one on the US east coast — less delay, and a steadier call on a busy connection.
- **Nothing to switch on.** It happens by itself, on web, desktop and Android.
- **Same privacy either way.** These servers only pass your call along — they don't record it, and calls stay end-to-end encrypted whichever one you land on.

### 🎛️ Pick a region for your community
- **Server owners can now pin where their calls run.** In Server Settings → Overview there's a new voice region choice: leave it on Auto, or fix the server to South America or the US east coast. Handy when most of your members are in one place, because otherwise whoever starts a call decides for everyone in it.
- **Auto is still the smart default.** It measures rather than guesses, and it's the right answer for most communities — a fixed region is for when you already know where your people are.
- **Nobody gets moved mid-call.** Changing the setting applies to the next call that starts, never one that's already running.
- Requires the Manage Server permission.

Direct messages and group calls always pick the fastest server automatically — there's nothing to set there.

On the web now; desktop and Android pick the region control up with their next update.`,
  },
  // v0.48.0: watch together + the tidied call bar + pt-BR. Copy constraints,
  // load-bearing:
  // - Sloga never uploads, hosts, proxies or relays the video — settled
  //   operator constraint AND the pitch; state it as a feature.
  // - Jellyfin privacy rule: a viewer's app contacts the host's server ONLY
  //   after that viewer signs in themselves. Keep that line.
  // - Web only at publish time: desktop/Linux/Android still carry the old
  //   bundle — keep the "pick this up with their next update" close.
  // - YouTube runs through YouTube's own embedded player. Never imply
  //   downloading, ad behavior, or DRM'd services (don't name Netflix).
  // - Do NOT quote these UI strings (release grep markers): "More call
  //   controls" (say "a More button"), "Selecione seu idioma", and the
  //   watch-refinement markers "Make host", "Show cameras beside the video",
  //   "Lower the movie while people talk", "Playing a playlist" —
  //   paraphrase every one of them.
  // - Never mention: server boosts, streaming connections, captions, remote
  //   control (Windows desktop only), the debug stats line, or moderator
  //   overrides.
  // - AMENDED 2026-08-20, same `id` on purpose (so no re-pop for anyone who
  //   already saw it): the web dist that carried these notes ALSO carried
  //   the watch refinements — handoff, playlists, the camera strip, opt-in
  //   ducking, the channel-list marker — so the entry had to describe them
  //   or it under-reported what users actually received.
  // - EXCLUDED as dark: per-server certificate trust for self-signed
  //   Jellyfin servers. That only exists on desktop/Android, and those
  //   shells still ship the OLD bundle, so nobody can reach it. It belongs
  //   in whichever entry ships the shell sweep, not this one.
  {
    id: "sloga-2026-08-20",
    title: "Patch Notes",
    published_at: "2026-08-20T18:30:00.000Z",
    markdown_content: `## v0.48.0 — Watch together

### 🎬 Watch videos together in voice channels
- **Synced playback, everyone's own stream.** Start a video in a voice channel and everyone in the call watches the same moment together — play, pause and seeking stay in sync. Each person's app plays its own buffered copy, so it looks the way video should: no re-encoded screenshare blur, no dropped frames when the network hiccups.
- **YouTube, or your own Jellyfin server.** Paste a YouTube link, or browse a Jellyfin media server you have access to and pick something from it. YouTube plays through YouTube's own embedded player.
- **Your media server stays yours.** Sloga never uploads, hosts or relays the video — the only thing that touches a Sloga server is the sync state (what's playing and where). For Jellyfin, nobody's app contacts your server until they sign into it themselves; people without access simply see what's playing and an invitation to sign in.
- **The host drives — and can hand it over.** Whoever starts the session controls playback for the room, and can pass that to anyone else in the call: handy when the person who started it has to drop, or when someone else has the next thing lined up. In server channels, starting a session is a channel permission moderators can assign.
- **Queues carry across.** Paste a YouTube link that belongs to a playlist and the rest of it comes along: when one video ends, the whole room moves to the next together.
- **Faces stay on screen.** Cameras and shared screens in the call now sit in a strip beside the video instead of disappearing behind it, so you can still see who you're watching with.
- **Optional: dip the video while people talk.** There's a toggle in the player's volume controls that quietly lowers the video whenever someone in the call is speaking and lifts it again when they stop. It's off unless you turn it on.
- **See a watch party from the channel list.** People already watching get a small marker next to their name in the sidebar, so you can tell what a voice channel is up to before you join it.

### 📞 A tidier call bar
- The controls you use constantly — mute, camera, share, leave — stay front and center; everything else now sits behind a More button instead of crowding the bar. Open it once and the bar stops feeling like a cockpit.

### 🌎 Português (Brasil)
- The full interface is now translated into Brazilian Portuguese — pick it in Settings → Language. More languages are on the way.

On the web now; desktop and Android pick these up with their next update.
`,
  },
  // v0.47.0: the screen-share audio fixes. Copy constraints, load-bearing:
  // - The listener-side default flipped from muted to audible. Say plainly
  //   that nothing needs unmuting any more AND that the per-person mute is
  //   still there — a reader who muted someone on purpose must not think
  //   their choice was discarded (it was not; stored mutes are kept).
  // - The attenuation fix is WINDOWS DESKTOP ONLY (the feature itself is).
  //   Describe it as the sharer's own stream no longer being lowered; do not
  //   claim anything about how the feature sounds otherwise, it is still
  //   untested against a real game.
  // - Do NOT quote these UI strings — they are this release's grep markers:
  //   "Mute Screen Share", "Attenuation Strength". Calling it "the mute
  //   option in their menu" is fine.
  // - Never mention: server boosts, streaming connections, captions, remote
  //   control (lit on Windows desktop only, dark everywhere else).
  {
    id: "sloga-2026-08-19",
    title: "Patch Notes",
    published_at: "2026-08-19T16:00:00.000Z",
    markdown_content: `## v0.47.0 — You can hear the stream now

### 🔊 Screen-share audio plays by default
- **No more silent streams.** When someone shares a tab or their screen with audio, you hear it straight away. Until now every share arrived muted on your end and stayed that way until you found the mute option in that person's right-click menu and switched it off — which is why so many shares seemed to have no sound at all.
- **Your per-person choice still stands.** If you muted a particular person's shares on purpose, they stay muted; the option is right where it was. This only changes what happens before you have said anything.
- **Windows desktop: sharing with attenuation on no longer quiets your own stream.** The option that lowers other applications while people talk was also lowering the application you were sharing, so what left your machine dipped — or went silent — every time someone spoke. It now steps aside for as long as you are sharing audio and picks back up when you stop.

Reading this in the desktop, Linux or Android app? Your version already has both fixes.
`,
  },
  // v0.46.0: the layout designer + the in-app community directory. Copy
  // constraints, all load-bearing:
  // - The layout applies to THE DEVICE IT IS SET ON. The settings store is
  //   local-only (it is not in Sync's STORE_KEYS), so a user who arranges
  //   their desktop and then opens the app on a laptop will find it
  //   unchanged. Say so, or it reads as sync being broken.
  // - It is NOT offered at phone widths — the slide-out drawer owns the
  //   layout there. State the limit; a phone reader will go looking.
  // - The member list's Auto choice is what everyone already has, and it is
  //   what the ultrawide layout drives. Never imply the ultrawide option was
  //   removed or is overridden by default; choosing a side explicitly is what
  //   overrides it.
  // - The Discord preset is named after the arrangement it reproduces.
  //   Describe it as an arrangement, never as compatibility, import, or any
  //   kind of interoperability with them.
  // - The directory has been reachable on the web since 08-18 but was never
  //   announced; this is its first entry, and it is now in every shell. Do
  //   not call it brand new to a web reader who has already seen it.
  // - Never mention the listing-request queue: it renders for platform
  //   admins only, and describing a button nobody else has is noise.
  // - Do NOT quote these UI strings — they are this release's grep markers:
  //   "Arrangement", "Server list and channels", "Mirrored",
  //   "No communities match your search." Naming the Layout section and the
  //   Discover page is fine; the markers above are what the sweep greps for.
  // - Never mention: server boosts, streaming connections, captions, remote
  //   control (lit on Windows desktop only, dark everywhere else).
  {
    id: "sloga-2026-08-18",
    title: "Patch Notes",
    published_at: "2026-08-18T21:00:00.000Z",
    markdown_content: `## v0.46.0 — Move the sidebars where you want them

### 🧩 The app rearranges to suit you
- **Settings → Appearance → Layout.** Drag your server list and channels, or your member list, to whichever side of the window you want them on, and drop them there. Buttons and arrow keys do the same job if dragging is not your style.
- **Three ready-made arrangements.** Sloga is the one you have now. The Discord one puts the member list in a full-height column on the right and shrinks the server list down to icons, for anyone whose muscle memory came from there. The third flips the whole app to the other side of the window, which is the point if you sit left-handed or your monitor is off to one side.
- **The member list starts on Auto,** exactly where it has always been — tucked under your channel list, and moved out to its own column by the ultrawide option on very wide displays. Pick a side for it yourself and your choice wins from then on.
- **This applies to the device you set it on.** Arrange your desktop however you like and your laptop stays as it was; the two do not have to agree. Phones keep their slide-out drawer and are unaffected.

### 🧭 Find communities without leaving the app
- **Discover, from your server list or from Home.** Browse the public communities on Sloga, search them, and open a join card straight from the results — no trip to the website. It has been on the web for a few days; now it is in the desktop, Linux and Android apps too.
- Server owners ask to be listed from their own server settings, and every listing is reviewed by hand before it appears.
`,
  },
  // v0.45.0: the settings reorganization, global attenuation, the input
  // sensitivity meter, entrance sounds, RNNoise as the default filter, and
  // the new appearance knobs. Copy constraints, all load-bearing:
  // - Attenuation is WINDOWS DESKTOP ONLY and ships OFF (strength 0). Both
  //   facts must stay in the bullet: a web reader who goes looking for it
  //   will not find it, and nobody should think their game volume changed on
  //   its own. Claim only what is true by construction — it restores each app
  //   to the level it had, and never touches Sloga's own audio.
  // - Automatic input sensitivity ships OFF, so no existing voice-activity
  //   user's hand-tuned threshold moves on upgrade, and the bullet says so.
  //   If that default is ever flipped to ON, this copy MUST become a warning:
  //   a stored blob predating the key reads the default, so ON silently
  //   overrides the thing that decides whether their microphone opens.
  // - Entrance sounds ride the ordinary soundboard route, so they only play
  //   where the user may already use the soundboard. State the limit rather
  //   than letting it read as a bug in servers that forbid it.
  // - The noise-suppression default changes for NEW installs only; anyone
  //   with a stored choice keeps it. Never imply we changed a setting of
  //   theirs.
  // - Do NOT quote these UI strings — they are this release's grep markers:
  //   "Two-Factor Recovery Codes", "Automatically adjust input sensitivity",
  //   "Show usernames", "When others speak", "Same as all servers". Naming
  //   the sidebar sections (Account, Privacy & Safety, Voice, Video) is fine;
  //   the markers above are what the sweep greps for.
  // - Never mention: server boosts, streaming connections, captions.
  {
    id: "sloga-2026-08-17-2",
    title: "Patch Notes",
    published_at: "2026-08-17T14:00:00.000Z",
    markdown_content: `## v0.45.0 — Everything where you'd look for it

### 🗂️ Settings you can actually navigate
- **Your account details have a row of their own.** The page holding your username, email, password and two-factor codes used to be reachable only by clicking your name at the top of the list — easy to miss entirely, while the Profile page told you to go there. It sits in the Account group now, where it should have been all along.
- **A new Privacy & Safety group.** Who can see your profile, whether friends see the game you are playing, your encryption keys, who may drive your computer during a call, and Streamer Mode — the "who can see or do what" switches now live together instead of in four different places.
- **Voice and Video are two pages.** The combined one had grown to a dozen sections, and the camera controls sat below a long scroll of microphone ones. The in-game overlay got its own page as well.
- **Bots and the developer switches moved into their own group,** and two rows that never did anything have been removed.

### 🔉 Turn the game down when someone talks *(Windows desktop)*
- **Off until you switch it on, in Settings → Voice.** Give it a percentage and Sloga lowers your other applications — the game, the music, the browser — while someone in the call is speaking, then puts each one back exactly where you had it. You choose whether it reacts to other people, to your own voice, or to both.
- It adjusts other apps the same way the Windows volume mixer does, and Sloga's own audio is never lowered. Windows desktop only for now.

### 🎤 Watch your microphone while you set it up
- **Voice activity mode now shows a live meter.** Red is the part that would not be transmitted, green is the part that would. Drag the handle to the point where your voice clears the line and the room does not.
- **Or let it find the line for you.** Switch on the automatic option and Sloga follows your room's background noise and moves the line itself. It is off unless you ask for it, so a threshold you had already set by hand stays exactly where you put it.

### 🔔 Announce yourself
- **Pick a soundboard sound that plays when you join a voice channel.** One for everywhere, a different one per server, or none in the servers where that would be obnoxious. It goes out through the soundboard, so it plays only where you are allowed to use the soundboard in the first place.

### 🎧 Better noise suppression out of the box
- **New installs now start on the enhanced filter** — RNNoise, the open-source one Sloga serves itself and runs on your own device — instead of the browser's basic one. **If you had already chosen a setting, it is untouched.**

### 🎨 A few things to fiddle with
- **Avatars have a size slider** in Appearance, alongside message size, and the sample messages above it change as you drag.
- **You can hide names in the message list** and go by avatar alone.
- **Compact mode moved to Appearance**, next to the preview that shows what it does, instead of sitting in Advanced.

*Sloga — Hop on.*`,
  },
  // v0.44.0: the in-app image editor with on-device auto-redact, plus the
  // enable-audio banner no longer firing on reconnects/joins. Copy
  // constraints, all load-bearing:
  // - Auto-redact is ADVISORY. It proposes, the user reviews. Never say it
  //   "removes" or "catches" sensitive info as a guarantee — say it finds
  //   things and offers to cover them, and that the user should look. Small,
  //   stylized, or non-English text can be missed and the copy says so.
  // - Everything runs on the device. Say it plainly and mean it: the OCR
  //   engine and its language data are served from Sloga's own origin and
  //   the picture is never uploaded until you press send. This is the whole
  //   privacy point of the feature; it must be stated, not implied.
  // - Black bars, not blur, are what the auto pass draws — pixelated text
  //   can sometimes be recovered. Mention that blur exists as a manual tool
  //   without recommending it for text.
  // - Edited images are re-encoded, which strips EXIF/GPS. Claim it, but
  //   only for images that were EDITED — untouched uploads follow the
  //   server's rules (JPEG/PNG/AVIF strip server-side; see v0.43.0).
  // - GIFs can't be edited (it would flatten the animation). Say so; a
  //   missing button otherwise reads as a bug.
  // - The banner fix bullet claims fewer false alarms, not that audio issues
  //   are gone. Do NOT quote the banner's copy (marker rule, 08-12b).
  // - Do not name the editor's tool labels verbatim ("Black bar", "Pixelate",
  //   "Auto-redact") — they are Trans-sourced release markers.
  // - Voice leveling (audio normalization) is OFF by default and listener-
  //   side only. Say where the toggle lives, that it's opt-in, and that music
  //   / screen-share audio and silence are untouched. Don't quote the settings
  //   labels verbatim ("Level Incoming Voices", "Leveling Strength") — markers.
  {
    id: "sloga-2026-08-17-1",
    title: "Patch Notes",
    published_at: "2026-08-17T04:00:00.000Z",
    markdown_content: `## v0.44.0 — Mark it up before you send it

### ✏️ Edit screenshots and pictures right in Sloga
- **No more round trip through Paint.** Attach an image, tap the pencil on its thumbnail, and you get a small editor: crop, draw, highlight, boxes and circles, arrows, and two ways to hide things — a solid bar, or a pixelated patch. Undo and redo the lot. When you apply, the edited picture replaces the original in your message, at full resolution.
- **A one-tap pass that spots sensitive text for you.** Press the auto-redact button and Sloga reads the text in the picture and offers to cover anything that looks like an email address, phone number, card number, social security number, password or key after a label like "Password:", an IP address, or your own username. Each find shows up as a chip you can keep or skip, and you can add anything it missed with the bar tool. Have a look before you send — small, stylized, or non-English text can slip past it.
- **All of it happens on your device.** The text recognition runs in your browser or app, from files Sloga serves itself; the picture is never uploaded until you actually press send. Nothing you're about to redact goes anywhere first.
- **The auto pass draws solid black bars on purpose.** Pixelated text can sometimes be reconstructed; solid bars can't. The pixelate tool is still there for faces and backgrounds.
- **A quiet bonus:** any image you edit is re-saved on the way out, which removes hidden location and camera data from it.
- **One thing it won't do:** GIFs can't be edited yet, because flattening one would lose the animation — so the pencil doesn't appear on them.

### 🎚️ Even out loud and quiet people in calls
- **Off by default — turn it on in Settings → Voice & Video, under the incoming-voices section.** Once on, Sloga gently raises the friend who's always too quiet and reins in the one who's always too loud, per person, on your end only. There's a strength slider for how far a quiet voice may be lifted; loud voices are always tamed no matter where you set it. Both apply live in whatever call you're in.
- **Only voices are leveled.** Music and screen-share audio are never touched, and it doesn't turn silence into hiss — when nobody's talking it holds still rather than cranking the gain.
- **Your right-click per-person volume still works on top of it**, and setting someone to 0% is now truly silent.

### 🔊 The "your browser blocked audio" notice is quieter
- **It was popping up when it shouldn't.** Reconnecting after a network blip, or someone joining or leaving, could make the notice appear even though audio was playing fine. It now waits out the reconnect and checks the call's actual audio state before showing, so you should only see it when there's really something to click.

*Sloga — Hop on.*`,
  },
  // v0.43.0: ultrawide layout + message width, the boosted-audio reconnect
  // fix reaching the apps, the audio-blocked banner, and LFG/LFM statuses.
  // Copy constraints, all load-bearing:
  // - Message width defaults to Full and ultrawide layout to OFF — nothing
  //   moves for anyone on upgrade. Say so; a layout feature that might have
  //   silently reflowed people's screens needs the "only if you pick it" line.
  // - The ultrawide toggle is offered on 21:9-and-wider SCREENS and takes
  //   effect when the WINDOW is wide enough. Those are two different gates
  //   (hardware vs. current window) — keep both, vaguely ("roughly half of a
  //   49-inch super-ultrawide" style precision is not needed, "wide enough"
  //   is honest).
  // - The boosted-audio bullet claims recovery after reconnects, NOT better
  //   audio quality. Web has had it since 2026-08-15; the apps get it in
  //   this update — the "Reading this in the apps?" line is the v0.41.0
  //   pattern and stays.
  // - The blocked-audio bullet must not promise the browser will never
  //   block audio — it promises a visible button instead of silence.
  //   Don't quote the banner's exact copy (it doubles as a release marker;
  //   quoting UI strings in notes broke marker greps before — 08-12b).
  // - LFG/LFM: friends on OLDER clients see these statuses as a plain
  //   "Offline" dot. State it — hiding it invites "my friend shows offline
  //   but is in a call" reports.
  // - AVIF (added post-release, server-side — backend 79530632/b7404af7/
  //   1f6fe599, live 08-15 21:19): claim upload/preview/thumbnails and that
  //   animation + EXIF-stripping work. Do NOT claim it renders on every
  //   platform — the Linux shell is WebKitGTK, where AVIF is distro-dependent
  //   — and do not promise speed: a real-world phone photo has not been
  //   through the path end to end.
  // - Never mention: server boosts, streaming connections, captions (all
  //   dark), couch co-op (unbuilt).
  {
    id: "sloga-2026-08-16-1",
    title: "Patch Notes",
    published_at: "2026-08-16T05:00:00.000Z",
    markdown_content: `## v0.43.0 — Room to stretch out

### 🖥️ New in Appearance: message width, and a layout for ultrawide monitors
- **Choose how wide messages run.** Full, Wide, Comfortable or Narrow — and whether the column hugs the left or sits centered. On a big monitor, chat no longer has to stretch the whole way across. The default is Full, exactly as before: nothing moves unless you pick something.
- **Ultrawide layout.** On a 21:9 or wider screen, a new switch moves the member list out into the spare room on the right, so channels, chat and members each get their own column instead of everything crowding the middle. It takes effect when the window is actually wide enough to afford it, and it's off until you turn it on.

### 🔊 Friends you turned up stay audible
- **Anyone you'd set above 100% volume could go permanently silent after a connection hiccup** — theirs or yours. A Wi-Fi blip, a VPN switch, a laptop waking up: after the call reconnected, their audio was gone until you left and rejoined. Fixed — boosted volume now survives reconnects, and follows you when you switch output devices mid-call.
- **If your browser refuses to play call audio, Sloga now says so.** Browsers sometimes hold audio back until you've interacted with the page. That used to mean a silent call and no clue why; now a notice appears on the call with a button that turns the sound on.

### 👋 Tell people you're looking
- **Two new statuses: Looking For Group and Looking For More.** Set them from your status menu, and people can see at a glance that you've got room — or that you're after one. Friends still on an older version of Sloga will see these as a plain offline dot until they update.

### 🖼️ AVIF images now work
- **Post AVIF pictures like any other image.** Sloga could store AVIF files but not actually read them, so uploading one just failed with an error. Now they upload properly, get previews and thumbnails, and animated AVIFs keep their animation. Location data hidden in the file is removed on upload, the same as for JPEG and PNG. This happened on the server, so it works from every app without an update.

### Also arriving in the apps
- Reading this in the desktop, Android or Linux app? The audio fixes above reached the web last week — this is the update that brings them to you.

*Sloga — Hop on.*`,
  },
  // Cropped screen-share fix, reported on a 21:9 ultrawide and reproduced live
  // on one (2026-08-14): the tile's grid track grew to the video's max-content
  // height, so the `<video>` rendered taller than its box and `overflow:
  // hidden` clipped the bottom. Copy constraints, all load-bearing:
  // - This is a DISPLAY fix, not a stream fix. The frames were always arriving
  //   complete. Never imply the share got sharper, faster, or higher quality —
  //   nothing about encoding, bitrate or resolution changed.
  // - The "it may look smaller now" line is REQUIRED, not hedging. The old
  //   behavior filled the width precisely because the overflow was cut away;
  //   fitting the whole frame into a short wide space means side bars. Without
  //   this line the fix reads as a regression to anyone who got used to the
  //   cropped-but-full-bleed picture.
  // - The 32:9 figure is ARITHMETIC (width / ratio - height on a default card
  //   height), not a measurement — no 32:9 was ever tested. Hence "could".
  // - Say the resize divider is dragged DOWN: it sits under the call area and
  //   growing the call shrinks the message list.
  // - Portrait phone cameras hit the same defect on any monitor; it ships in
  //   the same one-line change, so it is claimed but not headlined.
  {
    id: "sloga-2026-08-15-1",
    title: "Patch Notes",
    published_at: "2026-08-15T04:00:00.000Z",
    markdown_content: `## v0.42.0 — The whole shared screen, whatever shape your window is

### 🖥️ Screen shares are no longer cut off at the bottom
- **The bottom of a shared screen was being clipped off.** The picture was drawn taller than the space it was given, and whatever hung over the edge was simply cut away — so the bottom of whatever your friend was sharing, taskbar and all, was missing. The wider your window, the more disappeared. Maximizing made it worse; full screen and theater mode made it worse still.
- **Ultrawide monitors had it worst.** How much vanished grew with the width of the window, so a 21:9 display lost a strip along the bottom and a 32:9 could lose most of the picture. Nothing was ever wrong with the share itself — it was arriving complete the whole time, and only the display was cutting it short.
- **On a very wide window the picture may now look smaller, and that is the fix.** Fitting all of a 16:9 screen into a short, wide space leaves bars down the sides. It used to fill the width only because the parts that didn't fit were being thrown away. Drag the divider under the call downward to give it more height if you'd rather have it bigger.
- **A phone camera held upright is fixed by the same change**, on any size of screen.

*Sloga — Hop on.*`,
  },
  // Screen-share quality ladder fix + the Game tier (couch-co-op plan slice
  // G0), published after the two-account getStats leg passed (2026-08-13).
  // Copy constraints, all load-bearing:
  // - Claim the SETTING now lands where it was meant to, never that shares
  //   are faster or lower-latency. Glass-to-glass has never been measured;
  //   the fix is configuration reaching the right encoding, nothing more.
  // - The CPU caveat is not hedging, it is the measured behavior: software
  //   VP8 at 1080p60 gets scaled down mid-share under load, before and after
  //   this change. Dropping that line would promise a framerate we cannot
  //   deliver on the user's hardware.
  // - The Game tier's cost is stated, not buried: one encoding means no
  //   smaller rung for a viewer on a weak connection to fall back to.
  // - The server-mute line says an unusual SHAPE or a full call, because
  //   those are the paths that mute. An over-large share is still removed
  //   from the call outright, which is not what this notice covers.
  // - Never mention gamepads or couch co-op: unbuilt, gated on a hardware
  //   latency test that has not run.
  {
    id: "sloga-2026-08-13-5",
    title: "Patch Notes",
    published_at: "2026-08-13T16:00:00.000Z",
    markdown_content: `## v0.41.0 — Screen sharing at the quality you actually picked

### 📺 The setting you choose now reaches the people watching
- **"1080p 60FPS" now means 1080p at 60FPS.** A share goes out as two copies of your screen — a full-size one and a half-size one — and the quality you picked was landing on the *half-size* copy, or being skipped altogether, leaving the full-size picture on a 15FPS default. The sharpest option was quietly delivering full size at 15FPS or half size at 60FPS, never both. This fixes every quality option, not just that one.
- **New option: "Game 1080p 60FPS".** One full-size 60FPS stream instead of splitting the budget across two — the one to pick when a friend is watching you play. The trade is real: with a single stream there's no smaller version to drop to, so a viewer on a weak connection has further to fall. For a room full of people, the regular options still adapt better.
- **Your computer still has the last word.** Encoding a 1080p60 screen is genuinely hard work, and if yours can't keep up the picture still gets scaled down mid-share, exactly as before. What changed is that your setting now lands where it was always meant to.
- **If Sloga switches your screen video off, it now says so.** An unusually shaped share — or a call that has already hit its video limit — gets switched off at the server. Until now your own preview kept playing as though all was well, while nobody was receiving anything.

### Also arriving in the apps
- **Drawing on a shared screen** (v0.40.0) was web-only last week. Reading this in the desktop, Android or Linux app? This is the update that brings it to you.

*Sloga — Hop on.*`,
  },
  // Screen-share annotation (tech-support-mode plan §2), published only AFTER
  // the two-account live leg passed (2026-08-13). Copy constraints, all
  // load-bearing (reviewed 2026-08-13):
  // - The ink transits the SERVER in plaintext, like captions. Sitting under
  //   the v0.39.0 E2EE headline, this entry must SAY so — silence inherits an
  //   encryption halo drawing is not entitled to. Never private/E2EE/verified.
  // - The banner names "who the server says is drawing" — server-ASSERTED
  //   attribution, never presented as proven.
  // - Consent enforcement is attributed to the SERVER ("checks every stroke"),
  //   not worded as an unattributed absolute.
  // - The escalation step (remote control) stays desktop-to-desktop and the
  //   copy says so wherever it points at it; drawing itself is cross-platform.
  // - A stroke is a picture, never input — "can't click, type, or touch" is
  //   the honest capability statement, not a protection claim.
  {
    id: "sloga-2026-08-13-4",
    title: "Patch Notes",
    published_at: "2026-08-13T07:30:00.000Z",
    markdown_content: `## v0.40.0 — Draw on their screen

### ✏️ Point at things instead of taking the mouse
- **When someone shares their screen, they can now let you draw on it.** Circle the button, cross out the wrong menu, sketch an arrow — everyone in the call sees the ink right on the share, and it fades away after a few seconds.
- **It's the step before Tech support mode hands over the mouse.** Most of the time you don't need someone's keyboard — you need "no — **that** one." Drawing points; it can't click, type, or touch anything on their computer. The ink itself travels through Sloga to reach everyone, like live captions do — it's the mouse-and-keyboard channel that's end-to-end encrypted, not the drawing.
- **Nobody draws uninvited.** Drawing is off by default. The person sharing picks each helper by name — the server checks every stroke against that list — and a banner on their screen always names who the server says is drawing.
- **One button stops everything.** "Stop all drawing" instantly clears the ink and revokes everyone at once — and permission ends by itself when the share ends, so the next share always starts from zero.
- **On the web today.** The desktop and mobile apps pick it up with their next update — drawing works wherever the call does, while handing over the mouse itself stays desktop-to-desktop.

*Sloga — Hop on.*`,
  },
  // Positioning entry: names the ALREADY-SHIPPED remote control (public since
  // desktop 0.23.0) as the flagship "tech support mode". No feature ships with
  // this entry. Copy constraints, all load-bearing (reviewed 2026-08-13):
  // - The E2EE claim stays scoped to MOUSE/KEYBOARD INPUT (the sealed pairwise
  //   channel). Never "we can't see your screen" / "protected from Sloga" —
  //   the SFU relays the screen media and the server introduces the parties.
  // - The world-first claim keeps its qualifier: "end-to-end-encrypted remote
  //   control" — bare "remote control" is contestable (Teams/Zoom give-control).
  // - No unattended-access or IT-admin framing; every session starts with the
  //   person being helped and costs a confirmation on their own computer.
  // - Scam warning stays Sloga-scoped, per the shipped v0.27.0 precedent.
  // - Never mention drawing/annotation (dark until it ships) or any
  //   per-app/per-window claim (does not exist).
  {
    id: "sloga-2026-08-13-3",
    title: "Patch Notes",
    published_at: "2026-08-13T04:00:00.000Z",
    markdown_content: `## v0.39.0 — Tech support mode

### 🛠️ Call a friend, hand them your mouse
- **This is the feature we'd tell your family about.** When someone you trust gets stuck, call them on Sloga: they share their screen, hand you their mouse and keyboard, and you fix it — instead of talking them through it button by button.
- **It's built in, and your mouse and keyboard input is end-to-end encrypted.** It travels encrypted between the two computers; Sloga relays it and can't read it. No other mainstream chat app has end-to-end-encrypted remote control built in.
- **The person being helped stays in charge, always.** It only ever starts with them: they pick the helper by name and confirm on their own computer before anything is handed over, a bar with a Stop button stays pinned to their screen the whole time, and **Ctrl+Shift+Alt+Q** ends it instantly from anywhere.
- **It's for people you already trust — never for strangers.** ⚠️ Nobody from Sloga support will ever ask for control of your computer. If anyone asks for control while claiming to be staff or support, it's a scam — refuse, and tell us at report@sloga.gg.
- **Windows desktop to Windows desktop**, whole-screen shares only — sharing a single window won't offer it, because control would reach the whole screen behind that window.

*Sloga — Hop on.*`,
  },
  // Pass-the-controller slice 2 ("ask for a turn" + the capability beacon).
  // DESKTOP-ONLY for the same reason as slice 1 — every surface it adds sits
  // inside the ENABLE_REMOTE_CONTROL gate, lit only in the desktop build.
  // Copy constraints, all load-bearing:
  // - ASKING GRANTS NOTHING. It is a request the streamer chooses to act on;
  //   never word it as joining the rotation, or as if it takes a turn itself.
  // - Every turn still costs the native confirmation on the streamer's own
  //   machine. That dialog is the point, not friction, and must never read as
  //   something the feature can skip.
  // - The "on desktop" marker is a SELF-REPORT each client makes about itself
  //   and the server relays unverified. Never say verified/confirmed/checked;
  //   its absence means "hasn't said", never "can't". Saying that plainly is
  //   also what keeps the copy honest that the server is not a trust anchor.
  // - Real input on a real machine — never dressed up as a game abstraction.
  {
    id: "sloga-2026-08-13-2",
    title: "Patch Notes",
    published_at: "2026-08-13T02:00:00.000Z",
    markdown_content: `## v0.38.0 — Ask for a turn

### 🙋 Ask for the controller instead of waiting to be offered
- **When someone is sharing their screen on the desktop app, you can now ask them for a turn.** Your request appears next to their rotation queue, and they decide whether to add you — asking never takes control on its own.
- **The person sharing is still asked on their own computer before anyone can type or click.** That happens on every single turn and there is no way around it. It is the point of the feature, not a formality.
- **The rotation now marks who is on desktop**, so the streamer can see at a glance who is able to take a turn at all. That marker is what each person's app says about itself — Sloga passes it along rather than checking it.
- Taking a turn stays desktop-to-desktop; people on the web or their phone are in the call as normal, they just can't drive.

*Sloga — Hop on.*`,
  },
  // Pass-the-controller slice 1 (the rotation queue). DESKTOP-ONLY: the panel
  // is gated on ENABLE_REMOTE_CONTROL, which is lit only in the desktop
  // build, so this ships in the desktop installer and NOT to web/android/
  // linux (where it would be dark). Copy constraints, all load-bearing:
  // - It is REAL input on a REAL machine — never dress it up as a game
  //   abstraction that hides that (plan §3). Say "type and click on your
  //   computer".
  // - Every turn costs a native OS confirmation on the sharer's machine, and
  //   that dialog IS the safety — the copy must present it as the point, not
  //   a nuisance, and must not imply it can be skipped.
  // - The queue is the streamer's own local order; never imply it is
  //   server-verified, and never imply remote control is protected from the
  //   server (a compromised sharer renderer is equivalent to it).
  // - The control gap is real and is stated, not hidden.
  {
    id: "sloga-2026-08-13",
    title: "Patch Notes",
    published_at: "2026-08-13T00:30:00.000Z",
    markdown_content: `## v0.37.0 — Pass the controller

### 🎮 Hand the controller around your screen share
- **On the desktop app, when you share your whole screen you can now pass control of your keyboard and mouse around the group like a physical controller.** Build a rotation from the people in the call and press Next to hand over; everyone can see whose turn it is.
- **Every turn asks you on your own computer first.** Handing someone the controller means letting them really type and click on your machine — so Sloga puts a confirmation on your screen before anyone can, and there is no way around that. That prompt is the point, not a nuisance.
- **Set an optional turn timer** and control passes to the next person on its own when the time is up.
- During each handoff there's a brief moment where nobody is driving — that's the controller being passed from one person to the next, not a glitch.
- Remote control is desktop-to-desktop: people on the web or their phone show up in the call, but can't take a turn.

*Sloga — Hop on.*`,
  },
  // Pass-the-controller slice 0 (controller VISIBILITY only). Copy
  // constraints that are load-bearing: this is a display, never a
  // protection — it must not be worded as if it stops or limits anyone,
  // and it must never imply the server is kept out of anything (a
  // compromised sharer renderer is equivalent to the server). Remote
  // control itself is still Windows-desktop-to-desktop; the BADGE is
  // cross-platform because it rides plain channel events, so the copy
  // says "see", never "take". The last row is the honest limit: the map
  // is event-sourced and resets when you leave a call, so a mid-session
  // join can miss it until the next handoff — a reconnect backfills.
  {
    id: "sloga-2026-08-12-2",
    title: "Patch Notes",
    published_at: "2026-08-12T19:30:00.000Z",
    markdown_content: `## v0.36.0 — Everyone can see who's driving

### 🖱️ You can see who holds the controller
- **When someone is controlling a shared screen, the tile says so.** A "Controlled by …" badge sits on the screen-share for as long as the session lasts — always visible, no hovering required, so nobody has to wonder who just moved that mouse.
- **The call roster now lists every control session in the channel**, naming who is driving whose screen.
- **You don't have to be in the call to see it.** Anyone who can view the channel sees the same thing, so a moderator can tell who is driving without joining first.
- The badge is hidden from the person doing the driving — their own capture bar already says so.
- If you join a call that already has a session running, the badge may not appear until control next changes hands. Reopening Sloga always shows the current state.

*Sloga — Hop on.*`,
  },
  // All four rows shipped unit-proven but without a live leg (user's call:
  // they bug-check in prod). Copy constraints that are load-bearing: the
  // whisper row must never claim the server can't hear it — its privacy is
  // SFU-enforced, not cryptographic. The timelock row MAY claim nobody
  // including us can open early; that one is a real cryptographic gate
  // (drand round in the age header). The banner caveat for whispering to
  // older clients is deliberate: old builds hear the track but have no
  // banner UI.
  {
    id: "sloga-2026-08-12",
    title: "Patch Notes",
    published_at: "2026-08-12T03:30:00.000Z",
    markdown_content: `## v0.35.0 — A whisper, a seal, a subtitle, a shield

### ⏳ Messages that refuse to open early
- **Seal a message until a time you choose.** The composer tray has a new lock-clock button: write your message, pick the moment, and until then nobody can read it — not the recipient, not Sloga, not even you. That's not a policy, it's cryptography: the message is locked to a public randomness beacon that only produces the key when the time arrives. Recipients see a countdown that opens on its own.

### 🤫 Whisper to one person in a call
- **Pick someone in a voice call and whisper — only they hear you.** While you whisper, your normal mic goes quiet for everyone else (push-to-talk and captions included), and the person you're whispering to sees a banner naming you. When you stop, your mic comes back exactly as it was.
- If the person you whisper to hasn't updated yet, they're still the only one who hears you — they just won't see the banner until they update.

### 💬 Captions keep the original line
- **Translated captions now show what was actually said** in the speaker's language underneath the translation, so you can check the machine's work.
- **A closed-captions button now lives in the call controls**, so you can turn captions on or off mid-call. On end-to-end encrypted calls it stays off and says why, instead of pretending.

### 🛡️ Screenshare privacy shield
- **Sudden pop-ups on a shared screen get pixelated before your viewers read them.** Turn on the shield in the screen-share dialog when sharing a whole monitor: it watches the corner where notifications appear, and anything that shows up abruptly is mosaicked until it's gone. A corner that's always busy is left alone — it only reacts to surprises.

*Sloga — Hop on.*`,
  },
  // All three rows shipped without a live two-account leg (user's call: they
  // bug-check in prod). Server side is test-proven under both DB drivers;
  // the note row, private-profile card and spoiler gate have never been
  // watched rendered. Copy promises behavior, not appearance.
  {
    id: "sloga-2026-08-11-2",
    title: "Patch Notes",
    published_at: "2026-08-11T19:00:00.000Z",
    markdown_content: `## v0.34.0 — A note, a curtain, a warning

### 🤝 Friend requests can say why
- **Attach a note when sending a friend request** so your future friend isn't left asking "who is this?". The note shows on the incoming request and on the profile card, and it disappears once the request is accepted or declined.

### 🔒 Profiles can go friends-only
- **A new Profile visibility setting** (Settings → Profile) limits your bio, banner and linked channels to friends. People in your servers still see your name and avatar; everyone else is told the profile is private — enforced by the server, not just hidden in the app.

### 🙈 Spoiler channels
- **Mark a text channel as a spoiler** (Channel settings → Overview) and members must choose to reveal it before anything is shown — no more marking a channel as mature just to hide episode discussion. Each device remembers what you've revealed.

*Sloga — Hop on.*`,
  },
  // Both rows are unit-proven and, for translation, live-proven against the
  // real endpoint — but neither has been watched in a live call. The
  // transcription row deliberately promises only that impossible lines are
  // dropped: a hallucination short enough to be sayable in the time available
  // is indistinguishable from speech and still gets through, so the copy does
  // not claim the invented lines are gone.
  {
    id: "sloga-2026-08-11",
    title: "Patch Notes",
    published_at: "2026-08-11T09:00:00.000Z",
    markdown_content: `## v0.33.0 — Fewer words nobody said

### 🎙️ Transcription stops inventing sentences
- **Lines that could not physically have been spoken are now thrown away.** The speech model fills silence with fluent, confident sentences — people testing a call alone were seeing replies they never said, attributed to them by name. The transcript now checks whether there was actually enough speech in the audio to fit the words that came back, and drops what does not add up.
- Short interjections are still taken at their word, because a real "oh, no" and an invented one look exactly the same to a clock.

### 🌍 Live translation gets out of its own way
- **Translation that is going to fail now fails instantly**, showing the original text, instead of stalling for seconds first. When the translation service starts refusing requests, the app backs off for a moment rather than queueing into the wall — which is what made captions crawl.
- Requests that hang are given up on, a few are allowed at a time instead of all at once, and a genuine hiccup is retried once.

*Sloga — Hop on.*`,
  },
  // The worker move is live-verified against the built bundle (model loaded,
  // inference completed in the worker, main thread serviced work mid-inference,
  // all model/runtime fetches same-origin) — but not yet in a real multi-party
  // call. The freeze it fixes was reported from the field on 2026-08-10. The
  // Give control label row below still describes code, not observed UI.
  {
    id: "sloga-2026-08-10-4",
    title: "Patch Notes",
    published_at: "2026-08-10T22:00:00.000Z",
    markdown_content: `## v0.32.0 — Transcription minds its manners

### 🎙️ Transcribing a call no longer freezes the app
- **The speech-to-text model now runs on its own thread.** On computers where transcription ran slower than the conversation, turning it on could freeze the whole app and eventually crash it. The app now stays responsive no matter how hard the model is working — worst case the transcript falls behind, and it tells you when it does.
- **If transcription breaks, it breaks alone.** A failure in the transcriber now ends transcription, not your call — and turning it on again starts clean.

### 🖱️ Give control says so
- **The Give control button now carries its label** instead of being one more blue circle that read exactly like an unmuted mic. *(Windows desktop only, while sharing your whole screen.)*

*Sloga — Hop on.*`,
  },
  // The share-icon repair was observed directly (the wrong glyph was read out
  // of a live call's DOM before the fix). The other two rows were NOT seen
  // rendered: Give control needs a live whole-screen share plus the native
  // probe, and the encryption message only appears on an install whose keys
  // belong to another account. Both are described as what the code does, and
  // neither promises an appearance. The reset itself IS proven — an operator
  // ran the same underlying flow from Settings on a mismatched install and
  // came back encrypted; only the in-call entry point to it is unobserved.
  {
    id: "sloga-2026-08-10-3",
    title: "Patch Notes",
    published_at: "2026-08-10T09:00:00.000Z",
    markdown_content: `## v0.31.0 — Buttons that tell the truth

### 🖱️ Give control moved next to Share screen
- **It now sits directly beside the share button**, instead of further along the call bar away from the thing it acts on.
- **It looks like an action instead of another toggle** — a filled pill with a cursor on it, replacing the monitor icon that disappeared into a row of identical circles. It still only shows up while you're sharing your whole screen. *(Windows desktop only.)*

### 🔧 Two repairs
- **The share-screen button was wearing the wrong icon.** It showed the crossed-out "stop sharing" symbol when you weren't sharing, and the plain one while you were — exactly backwards. The tooltip was right the whole time, which is probably why it survived this long.
- **One encrypted-call failure now explains itself.** If this device's encryption keys were set up under a *different* account, calls here can never be encrypted. That used to show up as a red "Not encrypted" badge and nothing else — no reason, no way forward. The call now tells you what happened and offers to reset this device's encryption so it can be set up again under the account you're signed in as. *(Resetting erases encrypted messages stored on this device — it asks twice before doing anything.)*

*Sloga — Hop on.*`,
  },
  // Meadow and Space are code-verified (rendered in a bundled harness; the
  // Space frames were checked frame-against-frame), but the animation has not
  // been exercised against a live camera track, so the copy describes the
  // scene, not call behavior. The retired Arcade/Gamepad ids fall back to
  // "no background" by design.
  {
    id: "sloga-2026-08-10-2",
    title: "Patch Notes",
    published_at: "2026-08-10T08:30:00.000Z",
    markdown_content: `## v0.30.0 — Fresh scenery

### 🌄 A meadow and the night sky
- **Meadow** — a rolling green hill under a summer sky, hand-drawn in the style of a certain classic desktop wallpaper.
- **Space** — our first *animated* background: a deep-space scene where the stars genuinely twinkle behind you while you talk.
- These replace the Arcade and Gamepad backgrounds. If you had one of those selected, your camera quietly falls back to no background — pick a new favorite in Settings → Voice & Video.

### 🖼️ Bring your own background
- **The upload button under the background picker works now.** It opens a real file picker instead of doing nothing. Your image stays on your device — backgrounds are composited locally before your video is encrypted and sent.
- Also fixed: the camera preview's Stop button wore a gradient that belonged to no theme. It dresses like the rest of the app now.

*Sloga — Hop on.*`,
  },
  // The four camera presets are code-verified (all render in a bundled
  // harness) but nobody has applied one to a live camera track in the real
  // settings screen yet, so the copy describes what they look like, not how
  // they behave on a call.
  {
    id: "sloga-2026-08-10",
    title: "Patch Notes",
    published_at: "2026-08-10T04:30:00.000Z",
    markdown_content: `## v0.29.0 — Dress up your camera

### 🎨 Four new camera backgrounds
- **A Sloga wallpaper and three game themes join the background picker**: the Sloga "O" tiled on black, a synthwave sun over a grid, a spread of pixel hearts and stars, and tone-on-tone controller silhouettes.
- **They render on your machine, like every background.** Your real room never leaves your computer — the replacement happens before the video is encrypted and sent.

### 🕹️ Slogaball, tightened up
- **A run is now 5 balls instead of 10.** Rounds were outlasting the wait they were built to fill; a shorter rack keeps every shot worth lining up, and the bucket still pays a free ball.

*Sloga — Hop on.*`,
  },
  // The voice-awareness and Slogatron sections ship lit in this build, but
  // neither has been seen in a real call -- the badge needs a second account
  // screensharing, the picker needs a logged-in session. Claims here are
  // written from the code that ships, and nothing is promised that a reader
  // could not check on their own screen. The multi-instance row is Windows
  // only because the Electron shell has no such command; the client hides it
  // on a shell that does not report it, so no note is needed for Linux.
  {
    id: "sloga-2026-08-09",
    title: "Patch Notes",
    published_at: "2026-08-09T22:00:00.000Z",
    markdown_content: `## v0.28.0 — See who's already talking

### 👀 Know before you join
- **A red LIVE badge marks anyone sharing their screen** in a voice channel, so you can tell there is something worth joining before you join it.
- **The badge no longer disappears the moment you join.** It used to show only to people standing outside the channel, so the sidebar said one thing before you joined and another after.
- **The share icon now means a screen is actually on.** Stopping your video but leaving screen audio running used to keep the icon lit with nothing behind it.
- **Friends and DMs show "Voice" when someone is already in a call**, so you can see not to ring somebody mid-conversation. It covers the channels you can see — a friend sitting in a server you are not in still reads as free, because that roster never reaches you.
- **There is deliberately no hover preview.** Call video is end-to-end encrypted: the server holds no picture to show you, and watching would mean joining. The tooltip tells you video is live instead of pretending to show it.

### 🕹️ Slogatron
- **A second game for waiting out a call.** Ride the rim of a segmented web, shoot down your own lane at whatever climbs it, then dive through to the next web past whatever is left standing. Three lives, one superzapper per web, eight web shapes.
- **The game chip opens a picker now**, since it can no longer mean one game. Slogaball is still there, and each game keeps its own paused field per channel — switching games never drops you back into the wrong one.

### 🪟 Run two Slogas at once (Windows desktop)
- **A checkbox in desktop settings lets a second copy of Sloga start**, so you can be signed into two accounts on one PC at the same time.
- **Each copy gets its own login, its own encryption store and its own window layout.** The first one keeps everything exactly where it already was, so turning this back off puts you where you were.
- **It takes effect at next launch**, because the shell has to decide which copy it is before the window exists.

### 🔐 A clearer encryption failure
- **If this device's encryption store belongs to a different account, Sloga now says so.** It used to show the call as "Not encrypted" and a screen share that connected and then sent nothing, with no reason given anywhere.
- **That message carries a Reset encryption button.** Staying unencrypted for the call you are in is still a legitimate choice; the reset is the thing that fixes the next one. It asks you to prove the account is yours first, and it warns you that encrypted messages stored on this device go with it.

*Sloga — Hop on.*`,
  },
  // The remote-control section below is the v0.21.0 draft (c9d2f53a) that was
  // held back under "never announce a dark feature". It is no longer dark:
  // desktop 0.23.0 is the first installer built with
  // VITE_CFG_ENABLE_REMOTE_CONTROL=true, and the instance flag has been on
  // since 2026-08-07. Restored near-verbatim, but every claim was re-checked
  // against the shipping build rather than trusted from the draft. The
  // UseRemoteControl permission bit is deliberately NOT mentioned: it is
  // code-verified for server channels and has never run a live leg.
  {
    id: "sloga-2026-08-08-4",
    title: "Patch Notes",
    published_at: "2026-08-08T18:30:00.000Z",
    markdown_content: `## v0.27.0 — Hand someone your keyboard

### 🖥️ Give control of your screen
- **While you're sharing your whole screen, you can hand someone your mouse and keyboard.** Click the monitor icon in the call bar, pick the person, and they can help you directly instead of talking you through it.
- **It only ever starts with you.** Nobody can request or take control — you choose the person, and Windows itself asks you to confirm before anything is handed over.
- **Stop instantly, any time.** A bar stays pinned to the top of your screen for the whole session with a Stop button, and **Ctrl+Shift+Alt+Q** ends it from anywhere — even mid-click.
- **Your mouse and keyboard input is encrypted between the two computers.** We relay it and can't read it. The confirmation you'll see spells out exactly what that does and doesn't cover.
- **Whole-screen shares only.** If you're sharing a single window we won't offer it, because control reaches the whole screen behind that window — including what you didn't share.
- ⚠️ **Nobody from Sloga support will ever ask you for control of your computer.** If someone claiming to be staff or support asks, it's a scam — refuse, and tell us at report@sloga.gg.
- **Windows desktop only** for now — it needs the native app.

*Sloga — Hop on.*`,
  },
  {
    id: "sloga-2026-08-08-3",
    title: "Patch Notes",
    published_at: "2026-08-08T16:10:00.000Z",
    markdown_content: `## v0.26.0 — Settings you can find, and a button you could not see

### ⚙️ Settings, rearranged
- **The pages you actually change are at the top now.** Account holds your profile, sessions and connections — and My Bots, which used to sit off on its own.
- **App Settings opens with Appearance and Notifications.** It was called Client Settings, it sat below a block of links, and Advanced used to share a row with Sign out.
- **Everything that leaves Sloga is grouped under About at the bottom**, and those entries tell you they open outside the app *before* you click rather than after.

### 🎨 The colors behind two small things
- **The button on a success message is visible again.** It had been drawing completely transparent, with near-black text on a near-black background — present, but impossible to read. Success and warning now use real colors, matched to the same green as an online dot.
- **Text boxes show their focus and error outlines again.** They pointed at the same missing colors.

### ⬇️ Updates that turn up on their own (Windows desktop)
- **The update arrow appears while Sloga is open.** It only looked for updates at launch and then once an hour, so unless you quit and reopened, you could sit next to a released update for a long time without seeing it.
- **Sloga also checks the moment you come back to the window** — usually the moment you would want to know.

*Sloga — Hop on.*`,
  },
  {
    id: "sloga-2026-08-08-2",
    title: "Patch Notes",
    published_at: "2026-08-08T13:20:00.000Z",
    markdown_content: `## v0.25.0 — Light mode, and colors that do something

### 🎨 The appearance menu works
- **Light mode is actually light.** It used to turn the text dark but leave the background dark too, which made most of the app unreadable. The colors were being overwritten right after the theme worked them out, so only half the switch ever happened.
- **Pick a palette.** *Sloga* is the look you already know, and it is still the default. *Material You* builds every color in the app out of one accent you choose.
- **The accent swatches, contrast levels and color styles all do something now.** They were being calculated and then thrown away. They live under Material You, and they are hidden under Sloga, where they had nothing to change.
- **Labels on buttons are readable.** White text on the Sloga blue was well under the contrast a small label needs, so text on bright buttons is dark now instead of white. You will notice this on the sign-up button and anywhere a channel is selected.

*Sloga — Hop on.*`,
  },
  {
    id: "sloga-2026-08-08",
    title: "Patch Notes",
    published_at: "2026-08-08T06:30:00.000Z",
    markdown_content: `## v0.24.0 — Screen share you can actually read

### 🖥️ Sharper screen sharing
- **Shared screens go up to 4K now.** Every quality tier was quietly capped at 720p before, whichever one you picked.
- **Roughly double the bitrate at every tier**, so fine detail survives instead of dissolving.
- **The encoder protects detail instead of framerate** at 1080p and above. Small text stays readable while the picture moves, rather than smearing.
- Sharing at 60FPS, or on the 720p fallback, still favors smoothness — those are the settings where you asked for motion.

### ⬇️ One-click updates on Windows desktop
- **A green arrow appears next to your name when an update is ready.** Click it and Sloga installs the update and restarts itself — no installer to click through.
- **The arrow stays until you use it**, so "later" no longer means "ask me again next launch".

### 👥 Friends and profiles
- **Add Friend moved to the left**, next to the tabs, with a smaller search box beside it.
- **A refused display name now tells you why** instead of quietly doing nothing, and the message clears the moment you edit the name again.

*Sloga — Hop on.*`,
  },
  {
    id: "sloga-2026-08-07-2",
    title: "Patch Notes",
    published_at: "2026-08-07T22:15:00.000Z",
    markdown_content: `## v0.23.0 — Unread counts, not just dots

### 🔢 How much did you actually miss?
- **Servers, DMs and channels now show how many messages are waiting**, instead of a plain dot. It counts everything since you last read and stops at 99+.
- **The badge turns pink when there's an attachment in what you missed** — a file or an image landed while you were away.
- **It turns red when someone mentioned you**, so a ping never hides inside a big number.
- **Muted channels stay out of a server's total**, the same way they already stay out of its unread mark.
- Read a channel somewhere else? The number clears itself the next time this app reconnects.

*Sloga — Hop on.*`,
  },
  {
    id: "sloga-2026-08-07",
    title: "Patch Notes",
    published_at: "2026-08-07T20:00:00.000Z",
    markdown_content: `## v0.22.0 — A plus sign where you'd expect one

### ➕ Making channels without the guesswork
- **Every category header now has a + button.** Hover it and click — the new channel lands in that category, where you asked for it.
- **The server name has a + too**, next to the calendar and settings icons. It opens a little menu: **Create channel** or **Create category**. No more right-clicking around to find them.
- **The create-channel box lets you pick the category** on the way in. Leave it on **No category** and the channel sits at the top level, same as before.

### 🎚️ A sidebar that stays where you put it
- **Drag the divider between your channels and the member list** to give either one more room. Double-click it to snap back.
- **Your name and mic controls stay put when you collapse the channel list** — the bar shrinks onto the server rail instead of disappearing.

### 🎤 Calls
- **The microphone you picked in Settings is the one that gets used** when you join a call. If it's unavailable, we say so instead of quietly connecting you muted.
- **Hanging up while a call is still connecting actually cancels it** now, rather than dropping you into the call a second later.

### ⚽ Slogaball
- **Bomb pegs.** Hit one and it takes its neighbors with it, in full color.

### 📥 Import from Discord
- **A finished import stops announcing itself** every time you reload, and the notice has an X on it.

*Sloga — Hop on.*`,
  },
  {
    id: "sloga-2026-08-06",
    title: "Patch Notes",
    published_at: "2026-08-06T16:00:00.000Z",
    markdown_content: `## v0.21.0 — Your stickers can come too

### 📥 Import your Discord server's stickers
- **Importing a server from Discord? Your custom stickers can now come across with it.** When an import finishes, we'll offer the extra step: add our importer bot to your Discord server, press **Import stickers**, and they land here — ready to send.
- **The bot only reads stickers.** It asks for zero permissions, and you can kick it the moment the import finishes — it doesn't need to stay.
- Anything we can't bring over (too large, or in a format we can't use) is listed plainly at the end, so the numbers always add up.

### 🎞️ The GIF picker works now
- **Search and send GIFs from the picker in the message bar** — browse the categories or find exactly the right reaction. Powered by GIPHY.

### ⚽ Slogaball
- **Sound effects**, with a mute toggle that remembers what you picked.

### ✍️ A tidier message bar
- **Extra composer actions now tuck behind a chevron** — the dice roller lives in the slide-out tray, and disappearing messages sits next to the emoji button.

### 🖥️ Desktop
- **Start with Windows** is now a proper toggle in Settings, not just the tray menu.

*Sloga — Hop on.*`,
  },
  {
    id: "sloga-2026-08-03",
    title: "Patch Notes",
    published_at: "2026-08-03T20:00:00.000Z",
    markdown_content: `## v0.20.0 — Call transcripts, on your device

### 📝 Transcribe a call
- **A transcribe button in DM, group and voice-channel calls.** A live panel shows who said what as they say it, and when you're done you can copy the text or save it as **.txt** or **.vtt** subtitles.
- **Everything runs on your own device.** The speech model is fetched once and the audio never goes anywhere — it can't: calls are end-to-end encrypted, so there is no server copy to transcribe. Only someone in the call can transcribe it.
- **Everyone in the call is told**, the same way as recording — a banner while it runs, a message in the channel, and a warning for anyone joining mid-way.
- The transcript sticks around after the call ends, so you can still copy or export it once everyone's hung up.
- On the web, Windows desktop and Android. Not on the Linux app just yet.

### 🚪 Sign out, properly
- **Sign out lives in your user menu now** as well as Settings — and both ask you first, so a stray click can't dump you back to the login screen.

### 📅 Events
- **Events with a voice channel show a Join button** — one click puts you in the right channel when it's time, no hunting through the sidebar.

### 📞 Calls
- **Camera tiles fill their card** instead of floating in a letterbox — faces, not bars.
- **Starting a screen share now focuses it for you too**, not just for everyone else watching.
- Fixed a case where an **encrypted call could refuse to connect** for a device that had never messaged the other side — it now sorts itself out instead of failing until a restart.

### 📱 Phones
- **Sideways works now.** Landscape on a phone had been getting a cramped desktop layout — and on iPhones a white strip down the side. Both fixed.

*Sloga — Hop on.*`,
  },
  {
    id: "sloga-2026-08-02",
    title: "Patch Notes",
    published_at: "2026-08-02T23:45:00.000Z",
    markdown_content: `## v0.19.0 — Slogaball

### 🎮 Play while you wait
- **Alone in a call?** Waiting for the rest of the group to hop on, or for someone to pick up? A little pill appears: **Play while you wait?** Click it.
- **Slogaball** — aim from the top, drop the ball, watch it bounce. Clear the amber pegs to win, and catch the ball in the sweeping bucket for a free shot. Ten balls a round.
- **Your best score sticks around** — kept on your device and nowhere else. The whole game runs locally; nothing about it ever touches the server.
- **The instant someone joins, it gets out of the way** — it pauses and tucks itself away on its own, no fumbling to close anything mid-hello. Left waiting again? It resumes right where you parked it.
- Mute, deafen and leave stay visible and clickable the whole time — the game never sits over your call controls.
- A nod to a certain peg-and-ball classic people played in raid groups while the last stragglers logged on. If you know, you know.

- On the web now. Reading this in the desktop or Android app? Your version already has it.

*Sloga — Hop on.*`,
  },
  {
    id: "sloga-2026-07-30",
    title: "Patch Notes",
    published_at: "2026-07-30T16:00:00.000Z",
    markdown_content: `## v0.18.0 — Record a call, and give the screen share the whole room

### ⏺️ Record a call
- **A record button in DM, group and voice-channel calls.** Everyone's audio — their mics, their shared screen's sound, and your own — mixed into a single file on your machine.
- **Everyone in the call is told.** A banner runs the whole time, a message lands in the channel, and anyone joining a call already being recorded is warned before they connect. Hide the banner and it collapses to a ⏺ marker that stays put.
- **You choose where the file goes before recording starts**, and it's written as you speak. A crash or a closed laptop leaves a playable file of everything up to that moment instead of nothing.
- **Saved as .m4a**, so it opens in Windows Media Player, VLC, Apple Music, Audacity — anything, without conversion.
- Recording happens on your own machine because it's the only place it can: calls are end-to-end encrypted, so the server never has the audio to record. Only someone in the call can capture it.
- **Server owners get a new "Record Call" permission**, off by default — nobody can record in your voice channels until you say so.
- To be straight with you: this tells you when someone uses **this button**. It can't know about a screen recorder or a phone sitting on the desk — no app can.

### 🖥️ Screen sharing
- **A shared screen now takes the whole call** — everyone else moves into a column down the left instead of a strip across the bottom, so the picture fills the frame properly.
- Shares focus themselves when they start, but only once, and never by dragging you off a share you're already watching.
- Narrow windows, phones and the floating call window keep the layout they had.
- With nobody sharing, the participant grid centers and wraps again instead of running down one edge.

### 💬 Messaging
- **Every message shows its time**, not just the first of a run — and a new **Appearance** setting turns them all off if you'd rather have the clean look.
- **Type \`:D\` and get an emoji.** The usual set — \`:)\` \`:(\` \`:P\` \`;)\` \`<3\` and friends — expands as you type. Times, file paths and code are left alone, ctrl-Z brings back what you typed, and there's a setting to switch it off.
- **\`:D\` used to insert a dice.** The emoji suggestion list was opening on a single letter and Enter picked \`:die:\` instead of sending your message. Fixed.
- **Copy an image**, not just its link — from the attachment menu or the fullscreen viewer, ready to paste straight into another app.

### ✨ Polish
- **Right-clicking Sloga's own chrome** — sidebar padding, the space under the member list, call surfaces — no longer opens your browser's menu over the top. Text boxes keep theirs, and shift+right-click still gets you the browser's.
- **The member list uses the space it's given** instead of being squeezed into the bottom of the channel column.
- **Fixed: a single visit at phone width could hide a server's member list for good**, on desktop too, until you found the button again.
- On phones, the user bar no longer covers the message box, the last row of forum posts, or the bottom of the events calendar.
- Naming an emoji something invalid now says what a valid name looks like, instead of showing you the validator's raw output.

- On the web now; desktop and Android pick these up with their next update.

*Sloga — Hop on.*`,
  },
  {
    id: "sloga-2026-07-29",
    title: "Patch Notes",
    published_at: "2026-07-29T18:00:00.000Z",
    markdown_content: `## v0.17.0 — Encrypted images, and desktop downloads fixed

### 🖥️ Desktop
- **The attachment download button works again** — on the desktop app it had been doing nothing at all. The same fix brings back every link that opens outside Sloga, including **Continue** on a link warning.
- **The new user bar has landed here too** — your avatar and status plus mute, deafen and settings at the bottom of the sidebar, on desktop and Android now as well as the web.

### 🖼️ Encrypted images
- **Encrypted image attachments open in the full image viewer**, the same as any other image — pinch, zoom, and step through them properly instead of squinting at a thumbnail.
- **Save an encrypted image straight from the viewer** when you want to keep it.

### 💬 Messaging
- **Share a server or a group with someone? You can DM them.** No friend request first.
- When a DM can't be opened, Sloga now says why instead of quietly doing nothing.
- On phones, opening a DM slides the drawer out of your way.

### ✨ Polish
- A fresh look for the login screen.
- Horizontal strips — emoji rows, category pickers — keep your swipe instead of handing it to the navigation drawer.
- Server discovery requests tick when you click anywhere on the row, not just on the checkbox itself.

*Sloga — Hop on.*`,
  },
  {
    id: "sloga-2026-07-28",
    title: "Patch Notes",
    published_at: "2026-07-28T16:30:00.000Z",
    markdown_content: `## v0.16.0 — Your voice controls, always at hand

### 🎛️ New user bar
- **A quick-access bar at the bottom of the sidebar** — your avatar and status, plus mute, deafen and settings, always one click away. No more digging into a call to reach them.
- **Mute or deafen before you even join** — the bar works outside calls too, and whatever you set is exactly how you'll enter the next call. No more hot-mic surprises.
- **Switch your microphone or speakers on the fly** — the little arrows next to each toggle open a device picker, with a shortcut straight into Voice Settings.
- Click your avatar in the bar to change your presence or status message.

- On the web now; desktop and Android pick it up with their next update.

*Sloga — Hop on.*`,
  },
  {
    id: "sloga-2026-07-27",
    title: "Patch Notes",
    published_at: "2026-07-27T18:00:00.000Z",
    markdown_content: `## v0.15.0 — Import from Discord & raid loot sheets

### 📦 Import from Discord
- **Recreate your Discord server on Sloga by pasting a server template link** — no bots to add, no logins, no permissions to grant.
- Brings over the **server name, categories, channels, and roles with their permissions** — private channels stay private.
- When it finishes you get an **invite link** ready to share with your community.
- Imports keep running even if you close the app — you'll be notified when it's done.
- Find it under **Add a server → Import from Discord**.

### 🛡️ Soft-reserve raid loot sheets
- **Built-in soft-res for World of Warcraft raids** — post a loot sheet in any channel with the shield button in the message bar (or \`/softres\`) and let raiders reserve their items.
- **Covers 40 raids across Classic, The Burning Crusade and Wrath** with era-accurate loot tables — pick up to four raids per sheet.
- Per-raider and per-item reserve caps, **hard reserves**, and **hidden sheets** where only the raid leader sees who reserved what.
- **Lock a sheet** to freeze reserves — manually, or automatically when a linked server event starts.
- **Attach a sheet to a server event** straight from the Events page.
- **Export to Gargul, RollFor or CSV** for in-game loot rolls.

### ✨ Polish
- Polls in busy channels now load their results reliably.

*Sloga — Hop on.*`,
  },
  {
    id: "sloga-2026-07-26",
    title: "Patch Notes",
    published_at: "2026-07-26T22:30:00.000Z",
    markdown_content: `## v0.14.0 — Attachments up to 5 GB

### 💾 Big file sharing
- **Upload files up to 5 GB** — the old ~95 MB ceiling is gone. Installers, videos, modpacks: if it fits, it ships.
- **Uploads are chunked and resumable** — a dropped connection picks up where it stopped instead of starting over, and the progress bar now shows real progress instead of jumping to 100% and hanging.
- **Re-sending a big file is instant** — the server recognizes files it already has.
- Files over 20 MB are still kept for 24 hours — think transfer, not storage.
- Encrypted DMs keep their 20 MB attachment limit for now — big encrypted files are coming later.

*Sloga — Hop on.*`,
  },
  {
    id: "sloga-2026-07-20",
    title: "Patch Notes",
    published_at: "2026-07-20T20:00:00.000Z",
    markdown_content: `## v0.13.0 — Friends popout, stickers & a tidier mic

### 🪟 Pop out your friends list
- **Detach the friends list into its own window**, Steam-style, so you can keep an eye on who's online while you're playing or working in another app.
- Available on the desktop app — pop it out from the Friends rail entry.

### 🖼️ Sticker fixes
- **Stickers now render inline in chat** instead of showing up as a plain attachment.
- The sticker picker got a **scrollable grid**, so larger packs are actually browsable.

### 🎙️ Cleaner voice settings
- **Mic modes are now mutually exclusive** — Voice Activity, Open Mic and Push-to-Talk behave like proper radio buttons, so you can't end up in two modes at once.

### ✨ Polish
- Removed leftover upstream links from the server and bot creation screens — everything points at Sloga now.

*Sloga — Hop on.*`,
  },
  {
    id: "sloga-2026-07-19",
    title: "Patch Notes",
    published_at: "2026-07-19T20:00:00.000Z",
    markdown_content: `## v0.12.0 — Face filters, server discovery & Sloga Helper

### 🎭 Webcam face filters
- **14 AR face filters** for your camera — classic, viking, gaming and D&D packs.
- Plus a **beautify** slider and a set of **color looks** to grade your video.
- Everything runs on your own device, so it works in encrypted calls too.

### 🧭 Public server discovery
- **Browse a directory of public communities** and join with one click.
- Server owners can **opt their server in** from server settings; listings are admin-approved.

### 🤖 Sloga Helper
- A **first-party bot** you can add from **Server Settings → Apps**, with a curated catalog of official bots.
- First command: **\`/giveaway\`** — run a giveaway in a channel with a button people click to enter, and Sloga Helper picks the winner.

### 📞 Better incoming calls
- **A global Accept / Decline popup** now appears wherever you are in the app.
- Calls **ring from the moment they start**, and desktop notifications are **clickable** — click the toast to jump straight into the call.

### 🔊 Soundboard & GIFs
- **"Sloga Sounds"** — 35 built-in sound clips available in every server, no upload needed.
- The soundboard picker is now a **compact scrollable popover**.
- The GIF picker now runs through **our own proxy**, so no third party sees what you search for.

### 💛 Support Sloga
- Added a **Donate** entry on Home and in Settings, if you'd like to help keep the lights on.

*Sloga — Hop on.*`,
  },
  {
    id: "sloga-2026-07-18",
    title: "Patch Notes",
    published_at: "2026-07-18T20:00:00.000Z",
    markdown_content: `## v0.11.1 — Encryption reliability

### 🔐 Fewer surprises with encrypted DMs
- **Fixed messages going missing** after you re-enabled encryption on a device — Sloga now fetches what it needs up front and reconciles when you open a DM.
- **Clear markers** when a message couldn't be decrypted, instead of a silent gap.
- **Re-enabling encryption now sticks** — sending an encrypted message no longer leaves the conversation showing as plaintext.
- Revoking a device **retries loudly** instead of failing quietly.

### 💾 Save encrypted attachments
- Encrypted images and files now have a **Save button** on desktop that decrypts and writes straight to disk.

### ⏳ No more frozen recovery window
- Creating, rotating or restoring your **recovery key** no longer freezes the app while it works.

*Sloga — Hop on.*`,
  },
  {
    id: "sloga-2026-07-17",
    title: "Patch Notes",
    published_at: "2026-07-17T20:00:00.000Z",
    markdown_content: `## v0.11.0 — Push-to-talk, profiles & a warmer welcome

### 🎙️ Global push-to-talk
- **Push-to-talk now works even when Sloga isn't focused** on desktop — hold your key while you're in a game and talk.

### 👋 A warmer start
- New members are **automatically added to the Sloga welcome server**, so nobody lands in an empty app.
- **Sloga-branded emails** for verification, password reset and account notices.
- An **animated Sloga logo** now plays on the login screen.

### 👤 Profiles & friends
- **Message or call someone you're not friends with** straight from their profile card or context menu — including a video call button.
- **Double-click a friend** in the friends list to open the DM instead of the profile.
- **Friend requests appear instantly** instead of needing a refresh.
- **Staff usernames** render in Sloga's brand colors.

### 🖼️ Animated server icons
- Servers with animated icons now **play them in the server rail**.

### 📱 Floating call card
- Call controls **stay on-screen** in the floating picture-in-picture card, and it now **docks to edge midpoints** as well as corners.

*Sloga — Hop on.*`,
  },
  {
    id: "sloga-2026-07-15",
    title: "Patch Notes",
    published_at: "2026-07-15T20:00:00.000Z",
    markdown_content: `## v0.10.1 — Mobile composer & event attachments

### ⌨️ Two-bar composer on mobile
- The message box on **phones and tablets** is now a two-bar layout — more room to type, and the actions you actually use within thumb reach.
- New **Sloga-styled send button**, and a tidier attachment card.
- Start a **video call or screen share from a DM** via the composer menu.

### 🎲 Dice rolls in calls
- Roll results now **flash over the call video**, so everyone sees the roll without leaving the call.

### 📅 Event attachments
- **Attach files to a calendar event** — maps, rosters, rules, whatever the event needs.

### 🐛 Fixes
- Captions only advertise **broadcast** where it actually works.
- The last row of the member list is no longer flush against the window edge.

*Sloga — Hop on.*`,
  },
  {
    id: "sloga-2026-07-14",
    title: "Patch Notes",
    published_at: "2026-07-14T20:00:00.000Z",
    markdown_content: `## v0.10.0 — Encrypted calls, announcements & soundboard

### 🔐 End-to-end encrypted calls
- **Your voice, video and screen share can now be end-to-end encrypted.** Media is encrypted on your device — the server only ever relays scrambled data it can't read.
- Turn it on with **"Encrypt my calls"** in call settings. Everyone in the call needs a compatible app (desktop or Android); if someone can't encrypt, you'll see a clear notice before anything is sent in the clear.
- A lock indicator on the call shows when a call is fully encrypted.

### 📣 Announcement channels
- **Mark a channel as an announcement channel** — other servers can *follow* it, and every post you make is published to their followed channel automatically.
- Great for release notes, patch notes, and community-wide updates that should reach more than one server.

### 🔊 Server soundboard
- **Play sound clips in a voice channel** for everyone to hear — Discord-style.
- Upload and manage your server's clips in **Server Settings → Soundboard**, then trigger them from the in-call soundboard picker.

*Sloga — Hop on.*`,
  },
  {
    id: "sloga-2026-07-13",
    title: "Patch Notes",
    published_at: "2026-07-13T20:00:00.000Z",
    markdown_content: `## v0.9.0 — Bots, polls, captions & more ways to share

### 🤖 Slash-command bots
- **Interactive bots** are here — type \`/\` in the composer to run a bot command.
- Bots can reply with **buttons, dropdown menus, and pop-up forms**, and can respond **just to you** (ephemeral) when it makes sense.

### 📊 Polls
- **Create a poll right from the composer** — add your options and let people vote.
- Live results update as votes come in.

### ↪️ Forwarding & ⏰ scheduled messages
- **Forward a message** to another channel or DM, keeping its attachments intact.
- **Schedule a message** to send later — write it now, pick a time, and Sloga delivers it for you.

### 💬 Live call captions
- **Real-time subtitles in calls**, translated into your chosen language, appearing under each person's video tile.
- Optional **spoken translation** reads the translated text aloud.
- Encrypted calls are respected — captions are generated on your own device.

### 🎙️ Noise suppression
- **Background noise removal for your mic** (keyboard, fans, room noise) — on by default, with a toggle in **Settings → Voice**.

### 📺 Inline video playback
- Uploaded videos now **play directly in chat** instead of only downloading.

### 🎬 Streamer mode
- **Hide sensitive info while you stream** — your email, invite links, and notification content are tucked away.
- On desktop, Sloga can **auto-detect when OBS or other streaming apps are running** and switch it on for you.

### 🎨 A fresh look
- New **multicolor Sloga logo** across the app.

*Sloga — Hop on.*`,
  },
  {
    id: "sloga-2026-07-12",
    title: "Patch Notes",
    published_at: "2026-07-12T20:00:00.000Z",
    markdown_content: `## v0.8.0 — Threads & Forums

### 🧵 Threads
- **Branch a side conversation off any message** without cluttering the main channel.
- Threads keep focused discussions together and notify only the people taking part.

### 🗂️ Forum channels
- **A new channel type built for topics** — every post is its own thread that people can reply to.
- Perfect for questions, guides, and long-running discussions that deserve their own space.

*Sloga — Hop on.*`,
  },
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

### 📞 Voice & video calls
- **Switch devices mid-call** — a new button in the call bar lets you swap your microphone, speaker, or camera without leaving the call.
- **Theater mode** — go fullscreen and hit ⤢ to hide everything but the camera or screen-share you're watching; press Escape to come back.
- **Resize the call** — drag the divider on the bottom edge of the call card to balance the video and the chat below it.
- **Calls now work across different networks** — video and screen-share no longer drop after a second when you and a friend aren't on the same network.
- More reliable **screen-sharing** at high resolutions, including for people connecting from outside your network.

### 🖥️ Interface
- The **left sidebar can now expand** — click the arrow to see server and DM names at a glance.
- Dark theme is now the default for new users.

### 🛠️ Fixes & stability
- Fixed a **reconnect loop** after network drops — the app now recovers cleanly when your connection blips.
- Images, videos and downloads now load reliably behind the new sloga.gg address.
- **Large attachments are now cleared automatically** — files over 20MB are removed a day after they're sent to keep things fast and save space. The message text stays; only the big attachment is freed up.

*Sloga — Hop on.*`,
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

*Sloga — Hop on.*`,
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

*Sloga — Hop on.*`,
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
