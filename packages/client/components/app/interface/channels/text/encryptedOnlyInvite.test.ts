// Spec for "Encrypt this group" and "Share invite" under Encrypted-only
// chats (`encryptedOnlyInvite.ts`), plus source pins for their wiring in
// `Messages.tsx`, `Composition.tsx` and `Encryption.tsx`, which cannot load
// under Node. Run from packages/client:
//   node --test --conditions=browser \
//     components/app/interface/channels/text/encryptedOnlyInvite.test.ts
// Declared test count: 16 (the runner also exits 0 when it finds no tests at
// all, so compare this against its pass count).
//
// `ENCRYPTED_ONLY_INVITE_UNDER_TEST=<path>` loads another copy of the module,
// and `ENCRYPTED_ONLY_INVITE_MESSAGES_TSX` / `ENCRYPTED_ONLY_INVITE_COMPOSITION_TSX`
// / `ENCRYPTED_ONLY_INVITE_ENCRYPTION_TSX` scan other copies of those files
// (for failing controls).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { composerBlockFor } from "../../../../../src/interface/channels/text/encryptedOnlyComposer.ts";
import {
  type Advert,
  type BlockReason,
  type ChannelKind,
  type DeviceState,
  type PeerFlag,
  type PlainWriteInput,
  E2EE_GROUP_MAX,
} from "../../../../client/encryptedOnlyPolicy.ts";
import type {
  OnlyAdvert,
  OnlyCardState,
} from "../../../../modal/modals/encryptedOnlySetup.ts";

type Invite = typeof import("./encryptedOnlyInvite.ts");
type Member = { encrypted: boolean; bot: boolean };

const override = process.env.ENCRYPTED_ONLY_INVITE_UNDER_TEST;
const {
  cardOffersInvite,
  composerOffersInvite,
  desktopShell,
  inviteOutcomeShown,
  inviteShareIn,
  offersEncryptGroup,
  shareInviteText,
  windowShareDeps,
} = (await import(
  override
    ? pathToFileURL(resolve(override)).href
    : new URL("./encryptedOnlyInvite.ts", import.meta.url).href
)) as Invite;

/** A source file without comments, so a comment cannot satisfy a pin. */
function source(envKey: string, relative: string): string {
  const path = process.env[envKey];
  return readFileSync(
    path ? resolve(path) : new URL(relative, import.meta.url),
    "utf8",
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

const CHANNELS: ChannelKind[] = ["dm", "group", "saved", "server"];
const PEER_FLAGS: PeerFlag[] = ["on", "off", "absent"];
const DEVICES: DeviceState[] = ["ready", "not-set-up", "web"];
const REASONS: BlockReason[] = [
  "sender",
  "recipient",
  "group",
  "setup",
  "open-app",
  "peer-changed",
];
const ACTIONS = [null, "enable-device", "enable-group", "send-anyway"];
const BOOLS = [false, true];
const ADVERTS: Advert[] = ["absent", "enforced", "not-enforced"];

function* inputs(): Generator<PlainWriteInput> {
  for (const latched of BOOLS)
    for (const channel of CHANNELS)
      for (const peerFlag of PEER_FLAGS)
        for (const peerRemembered of BOOLS)
          for (const groupMarked of BOOLS)
            for (const groupRemembered of BOOLS)
              for (const device of DEVICES)
                for (const encrypted of BOOLS)
                  for (const advert of ADVERTS)
                    yield {
                      latched,
                      channel,
                      peerFlag,
                      peerRemembered,
                      groupMarked,
                      groupRemembered,
                      device,
                      encrypted,
                      advert,
                    };
}

const group: PlainWriteInput = {
  latched: true,
  channel: "group",
  peerFlag: "absent",
  peerRemembered: false,
  groupMarked: false,
  groupRemembered: false,
  device: "ready",
  encrypted: false,
  advert: "enforced",
};
const dm: PlainWriteInput = { ...group, channel: "dm" };

const ok: Member = { encrypted: true, bot: false };
const others = (count: number, member: Member = ok): Member[] =>
  Array.from({ length: count }, () => ({ ...member }));
// No webhook known
const none = () => false;

test("encrypt group: only a plain group that is read-only for the latch, on a ready device", () => {
  let offered = 0;
  for (const input of inputs()) {
    const expected =
      input.latched &&
      input.channel === "group" &&
      input.device === "ready" &&
      !input.encrypted &&
      !input.groupMarked &&
      !input.groupRemembered;
    assert.equal(
      offersEncryptGroup(input, others(3), none),
      expected,
      JSON.stringify(input),
    );
    if (expected) offered++;
  }
  // peerFlag x peerRemembered x advert vary freely
  assert.equal(offered, 3 * 2 * 3);
});

test("encrypt group: 24 members counting you, every other member with encryption, no bots", () => {
  assert.equal(E2EE_GROUP_MAX, 24);
  assert.equal(
    offersEncryptGroup(group, others(E2EE_GROUP_MAX - 1), none),
    true,
  );
  assert.equal(offersEncryptGroup(group, others(E2EE_GROUP_MAX), none), false);
  assert.equal(offersEncryptGroup(group, others(1), none), true);
  // Alone in the group: nobody to encrypt to
  assert.equal(offersEncryptGroup(group, [], none), false);

  const one = (member: Member) => [...others(4), member, ...others(2)];
  const noKeys = { encrypted: false, bot: false };
  const bot = { encrypted: true, bot: true };
  const botNoKeys = { encrypted: false, bot: true };
  assert.equal(offersEncryptGroup(group, one(noKeys), none), false);
  assert.equal(offersEncryptGroup(group, one(bot), none), false);
  assert.equal(offersEncryptGroup(group, one(botNoKeys), none), false);

  // A marked group has its own path; a group that already encrypts is writable
  const variants: Partial<PlainWriteInput>[] = [
    { groupMarked: true },
    { encrypted: true },
    { latched: false },
    { device: "not-set-up" },
  ];
  for (const change of variants) {
    assert.equal(
      offersEncryptGroup({ ...group, ...change }, others(2), none),
      false,
      JSON.stringify(change),
    );
  }
});

test("encrypt group: a known webhook hides it, asked only when it matters", () => {
  let asked = 0;
  const known = () => {
    asked++;
    return true;
  };
  assert.equal(offersEncryptGroup(group, others(3), known), false);
  assert.equal(asked, 1);

  // Every other failing condition answers first
  asked = 0;
  assert.equal(offersEncryptGroup({ ...dm }, others(3), known), false);
  assert.equal(offersEncryptGroup(group, [], known), false);
  const noKeys = others(2, { encrypted: false, bot: false });
  assert.equal(offersEncryptGroup(group, noKeys, known), false);
  assert.equal(asked, 0);
});

test("composer invite: only your own refused message in a DM, to a peer without encryption who is not a bot, while the server flag is on and enforced", () => {
  let offered = 0;
  for (const input of inputs())
    for (const reason of REASONS)
      for (const action of ACTIONS)
        for (const peerOptedIn of BOOLS)
          for (const peerIsBot of BOOLS)
            for (const serverOn of BOOLS) {
              const expected =
                reason === "sender" &&
                action === null &&
                input.latched &&
                input.channel === "dm" &&
                input.device === "ready" &&
                input.advert === "enforced" &&
                serverOn &&
                !peerOptedIn &&
                !peerIsBot;
              const actual = composerOffersInvite(
                { reason, action },
                input,
                peerOptedIn,
                peerIsBot,
                serverOn,
              );
              // The message is built only on a failure: the grid is large
              if (actual !== expected) {
                assert.fail(
                  JSON.stringify({
                    input,
                    reason,
                    action,
                    peerOptedIn,
                    peerIsBot,
                    serverOn,
                    actual,
                  }),
                );
              }
              if (expected) offered++;
            }
  // 3 x 2 x 2 x 2 x 2 free facts
  assert.equal(offered, 3 * 2 * 2 * 2 * 2);
  assert.equal(composerOffersInvite(null, dm, false, false, true), false);
  assert.equal(composerOffersInvite(undefined, dm, false, false, true), false);
});

test("composer invite: the device latch alone, or a server that does not enforce, offers nothing", () => {
  const block = { reason: "sender" as BlockReason, action: null };
  assert.equal(composerOffersInvite(block, dm, false, false, true), true);
  // Latched here, but the server's flag is off (or not loaded)
  assert.equal(composerOffersInvite(block, dm, false, false, false), false);
  // The server does not refuse, or does not say
  for (const advert of ["absent", "not-enforced"] as Advert[]) {
    assert.equal(
      composerOffersInvite(block, { ...dm, advert }, false, false, true),
      false,
      advert,
    );
  }
  // Only a literal true counts as the flag
  for (const odd of [1, "true", null, undefined]) {
    assert.equal(
      composerOffersInvite(block, dm, false, false, odd as unknown as boolean),
      false,
      String(odd),
    );
  }
});

test("composer invite: through the real composer block", () => {
  const view = (
    peerOptedIn: boolean,
    mode: "plaintext" | "peer_downgraded",
  ) => ({ mode, statusLoaded: true, peerOptedIn });

  // A latched account, a peer without encryption: refused with no button
  const refused = composerBlockFor(dm, view(false, "plaintext"));
  assert.equal(refused?.reason, "sender");
  assert.equal(refused?.action, null);
  assert.equal(composerOffersInvite(refused, dm, false, false, true), true);
  // A bot cannot turn encryption on: no invite to it
  assert.equal(composerOffersInvite(refused, dm, false, true, true), false);

  // A peer with encryption: the next message encrypts, nothing is blocked
  assert.equal(composerBlockFor(dm, view(true, "plaintext")), null);

  // A peer who turned the conversation's encryption off but has it on
  const downgraded = composerBlockFor(dm, view(true, "peer_downgraded"));
  assert.equal(downgraded?.reason, "sender");
  assert.equal(composerOffersInvite(downgraded, dm, true, false, true), false);

  // The person writing to an Encrypted-only account gets setup, not an invite
  const writer: PlainWriteInput = {
    ...dm,
    latched: false,
    peerFlag: "on",
    device: "not-set-up",
  };
  const recipient = composerBlockFor(writer, view(false, "plaintext"));
  assert.equal(recipient?.reason, "recipient");
  assert.equal(
    composerOffersInvite(recipient, writer, false, false, true),
    false,
  );
});

test("card invite: only while the account has the setting on and the server enforces it", () => {
  const states: OnlyCardState[] = [
    "hidden",
    "unavailable",
    "off",
    "on",
    "turned-off-elsewhere",
  ];
  const adverts: (OnlyAdvert | null | undefined)[] = [
    null,
    undefined,
    { available: false, enforced: false },
    { available: true, enforced: false },
    { available: false, enforced: true },
    { available: true, enforced: true },
  ];
  const offered: string[] = [];
  for (const state of states)
    for (const advert of adverts) {
      if (cardOffersInvite(state, advert)) {
        offered.push(`${state} ${JSON.stringify(advert)}`);
      }
    }
  // Turning it on is closed (available false) but those already on keep it
  assert.deepEqual(offered, [
    'on {"available":false,"enforced":true}',
    'on {"available":true,"enforced":true}',
  ]);
});

test("share: the sheet first, opened before anything is awaited", async () => {
  const calls: string[] = [];
  const pending = shareInviteText("hi", {
    share: async (data) => {
      calls.push(`share:${data.text}`);
    },
    copy: async (text) => {
      calls.push(`copy:${text}`);
    },
  });
  // The sheet only opens straight from a tap
  assert.deepEqual(calls, ["share:hi"]);
  assert.equal(await pending, "shared");
  assert.deepEqual(calls, ["share:hi"]);
});

test("share: closing the sheet copies nothing; a sheet that refused copies", async () => {
  const copied: string[] = [];
  const copy = async (text: string) => {
    copied.push(text);
  };
  const reject = (name: string) => async () => {
    throw Object.assign(new Error(name), { name });
  };

  const closed = await shareInviteText("a", {
    share: reject("AbortError"),
    copy,
  });
  assert.equal(closed, "dismissed");
  assert.deepEqual(copied, []);

  const refused = await shareInviteText("b", {
    share: reject("NotAllowedError"),
    copy,
  });
  assert.equal(refused, "copied");
  assert.equal(await shareInviteText("c", { copy }), "copied");
  assert.deepEqual(copied, ["b", "c"]);
});

test("share: an AbortError that says Internal error is a sheet that could not open, so it copies", async () => {
  const copied: string[] = [];
  const copy = async (text: string) => {
    copied.push(text);
  };
  const abort = (message: unknown) => async () => {
    throw Object.assign(new Error("x"), { name: "AbortError", message });
  };

  // What Chromium says when the platform sheet is missing
  const internal = await shareInviteText("a", {
    share: abort("Internal error: could not connect to Web Share interface."),
    copy,
  });
  assert.equal(internal, "copied");
  assert.equal(
    await shareInviteText("b", { share: abort("Internal error"), copy }),
    "copied",
  );

  // Any other AbortError is the user closing it
  for (const message of ["Share canceled", "", " Internal error", 7]) {
    assert.equal(
      await shareInviteText("c", { share: abort(message), copy }),
      "dismissed",
      String(message),
    );
  }
  assert.deepEqual(copied, ["a", "b"]);
});

test("share: a desktop shell copies straight away and never opens the sheet", async () => {
  const main = fakeWindow("main", true);
  const desktop = inviteShareIn(main, main, true);
  assert.equal(desktop.deps.desktopShell, true);
  assert.equal(await shareInviteText("x", desktop.deps), "copied");
  assert.deepEqual(main.calls, ["main copy:x"]);

  // The same window outside a desktop shell uses its sheet
  const web = inviteShareIn(main, main, false);
  assert.equal(web.deps.desktopShell, false);
  assert.equal(await shareInviteText("y", web.deps), "shared");
  assert.deepEqual(main.calls, ["main copy:x", "main share:y"]);

  // A desktop shell with no clipboard fails rather than opening the sheet
  let opened = 0;
  const noCopy = await shareInviteText("z", {
    share: async () => {
      opened++;
    },
    desktopShell: true,
  });
  assert.equal(noCopy, "failed");
  assert.equal(opened, 0);
});

test("share: desktopShell reads the settings pages' check (Electron's window.native, Tauri's invoke)", () => {
  const g = globalThis as { window?: unknown };
  const saved = Object.getOwnPropertyDescriptor(g, "window");
  const as = (win: unknown) => {
    Object.defineProperty(g, "window", {
      value: win,
      configurable: true,
      writable: true,
    });
    return desktopShell();
  };
  try {
    assert.equal(as({ native: { versions: {} } }), true);
    assert.equal(as({ __TAURI__: { core: { invoke: () => {} } } }), true);
    // Tauri without a command bridge is not a shell this window can use
    assert.equal(as({ __TAURI__: {} }), false);
    assert.equal(as({}), false);
    assert.equal(as({ navigator: { share: () => {} } }), false);
    delete g.window;
    assert.equal(desktopShell(), false);
  } finally {
    if (saved) Object.defineProperty(g, "window", saved);
    else delete g.window;
  }
});

test("share: a copy that throws or rejects, or no way at all, fails", async () => {
  const throws = () => {
    throw new Error("insecure context");
  };
  const rejects = () => Promise.reject(new Error("denied"));
  assert.equal(await shareInviteText("x", { copy: throws }), "failed");
  assert.equal(await shareInviteText("x", { copy: rejects }), "failed");
  assert.equal(await shareInviteText("x", {}), "failed");
  assert.equal(await shareInviteText("x", { share: rejects }), "failed");
});

test("share: a copy or a failure is always shown, as a toast or else inline", () => {
  for (const kind of ["copied", "failed"] as const) {
    assert.deepEqual(inviteOutcomeShown(kind, true), { place: "toast", kind });
    // A chat window has no snackbar: the composer block says it
    assert.deepEqual(inviteOutcomeShown(kind, false), {
      place: "inline",
      kind,
    });
  }
  for (const toastHere of BOOLS) {
    assert.equal(inviteOutcomeShown("shared", toastHere), null);
    assert.equal(inviteOutcomeShown("dismissed", toastHere), null);
  }
});

/** A window with its own share sheet and clipboard, recording each use. */
function fakeWindow(name: string, withSheet: boolean) {
  const calls: string[] = [];
  const clipboard = {
    async writeText(this: unknown, text: string) {
      // A real clipboard throws when called off itself
      assert.equal(this, clipboard, `${name}: clipboard this`);
      calls.push(`${name} copy:${text}`);
    },
  };
  const navigator = {
    clipboard,
    share: withSheet
      ? async function (this: unknown, data: { text: string }) {
          assert.equal(this, navigator, `${name}: share this`);
          calls.push(`${name} share:${data.text}`);
        }
      : undefined,
  };
  return { calls, navigator };
}

test("share: from the window the tap came from, a toast only where the snackbar is", async () => {
  const main = fakeWindow("main", true);
  const chat = fakeWindow("chat", false);

  // A chat window copies with its own clipboard; the snackbar is behind it
  const fromChat = inviteShareIn(chat, main, false);
  assert.equal(fromChat.toast, false);
  assert.equal(await shareInviteText("x", fromChat.deps), "copied");
  assert.deepEqual(chat.calls, ["chat copy:x"]);
  assert.deepEqual(main.calls, []);

  // The main window uses its own sheet, and may show the toast
  const fromMain = inviteShareIn(main, main, false);
  assert.equal(fromMain.toast, true);
  assert.equal(await shareInviteText("y", fromMain.deps), "shared");
  assert.deepEqual(main.calls, ["main share:y"]);
  assert.deepEqual(chat.calls, ["chat copy:x"]);

  // No snackbar at all: no toast anywhere
  assert.equal(inviteShareIn(main, undefined, false).toast, false);
  assert.equal(inviteShareIn(chat, undefined, true).toast, false);

  // A window with no navigator has no way to share
  assert.deepEqual(windowShareDeps({}, false), {});
  assert.deepEqual(windowShareDeps(undefined, true), {});
  assert.equal(
    await shareInviteText("z", inviteShareIn({}, {}, false).deps),
    "failed",
  );
});

/** One function or memo of a source, from its declaration to its end. */
function body(text: string, start: string, end = "\n  };"): string {
  const from = text.indexOf(start);
  assert.notEqual(from, -1, start);
  const to = text.indexOf(end, from);
  assert.notEqual(to, -1, `${start} ... ${end}`);
  return text.slice(from, to);
}

const INVITE =
  "t`Sloga's servers refuse unencrypted direct messages to me. To message " +
  "me, turn on encryption in the Sloga app: Settings > Encryption.`";

test("wiring: each site asks the helper and acts on it", () => {
  const messages = source(
    "ENCRYPTED_ONLY_INVITE_MESSAGES_TSX",
    "./Messages.tsx",
  );
  assert.match(
    messages,
    /offersEncryptGroup\(\s*buildPlainWriteInput\(c, props\.channel\),\s*others,\s*groupWebhooksKnown,?\s*\)/,
  );
  assert.match(
    messages,
    /<Show when=\{encryptGroupOffered\(\)\}>[\s\S]{0,400}type: "e2ee_enable_group"/,
  );
  // The memo runs at once, so it is declared after the list it reads
  assert.ok(
    messages.indexOf("const [messages, setMessages]") <
      messages.indexOf("const encryptGroupOffered = createMemo("),
  );
  const webhooks = body(messages, "const groupWebhooksKnown = () =>", ";\n");
  assert.match(webhooks, /messages\(\)\.some\(/);
  assert.match(webhooks, /\.channelWebhooks\.toList\(\)/);
  // Listing webhooks is a privileged fetch: never made for this
  assert.doesNotMatch(messages, /fetchWebhooks\(|\/webhooks`/);

  const composition = source(
    "ENCRYPTED_ONLY_INVITE_COMPOSITION_TSX",
    "../../../../../src/interface/channels/text/Composition.tsx",
  );
  // The blocked action offers the invite only when the helper says so
  const action = body(
    composition,
    "const encryptedOnlyBlockedAction = () => {",
  );
  assert.match(
    action,
    /encryptedOnlyInviteOffered\(\)\s*\?\s*\{\s*label: t`Share invite`,\s*onClick: \(\) => void shareEncryptionInvite\(\),\s*\}\s*:\s*undefined/,
  );
  const offered = body(
    composition,
    "const encryptedOnlyInviteOffered = createMemo(",
    "\n  });",
  );
  assert.match(
    offered,
    /composerOffersInvite\(\s*encryptedOnlyBlock\(\),\s*encryptedOnlyInput\(\),\s*encryptedOnlyViewFor\(props\.channel\)\.peerOptedIn,\s*!!\(peerId && client\(\)\.users\.get\(peerId\)\?\.bot\),\s*client\(\)\.user\?\.e2eeOnly === true,?\s*\)/,
  );
  const share = body(
    composition,
    "async function shareEncryptionInvite() {",
    "\n  }",
  );
  assert.match(
    share,
    /inviteShareIn\(\s*windowCtx\.win,\s*snackbar \? MAIN_CTX\.win : undefined,\s*desktopShell\(\),?\s*\)/,
  );
  assert.ok(share.includes(`shareInviteText(\n      ${INVITE},\n      deps,`));
  assert.match(
    share,
    /const shown = inviteOutcomeShown\(outcome, toastHere\);\s*if \(!shown\) return;\s*if \(shown\.place === "toast"\) \{\s*snackbar\?\.show\(/,
  );
  // Without a toast the outcome goes to the composer block, never nowhere
  assert.match(share, /setInviteInline\(\{ channelId, kind: shown\.kind \}\);/);
  assert.doesNotMatch(composition, /browserShareDeps\(/);

  // The block's words carry the outcome, for this channel only
  const blocked = body(composition, "const blockedText = () => {");
  assert.match(
    blocked,
    /const block = encryptedOnlyBlock\(\);\s*if \(block\) \{\s*const invite = inviteInlineText\(\);\s*if \(invite\) return `\$\{encryptedOnlyText\(block\.notice\)\} \$\{invite\}`;/,
  );
  const inline = body(composition, "const inviteInlineText = () => {");
  assert.match(
    inline,
    /if \(!shown \|\| shown\.channelId !== props\.channel\.id\) return undefined;/,
  );
  assert.match(
    inline,
    /shown\.kind === "copied"\s*\? t`Invite copied to the clipboard\.`\s*: t`Could not copy to the clipboard\.`/,
  );

  const encryption = source(
    "ENCRYPTED_ONLY_INVITE_ENCRYPTION_TSX",
    "../../settings/user/Encryption.tsx",
  );
  assert.match(
    encryption,
    /<Show when=\{cardOffersInvite\(state\(\), advert\(\)\)\}>/,
  );
  assert.ok(encryption.includes(`shareInviteText(\n      ${INVITE},`));
  assert.match(encryption, /browserShareDeps\(desktopShell\(\)\)/);

  for (const text of [composition, encryption]) {
    assert.doesNotMatch(text, /I only accept encrypted messages/);
    // The old wording claimed delivery, not the servers' refusal
    assert.doesNotMatch(text, /Sloga only delivers encrypted/);
  }
});
