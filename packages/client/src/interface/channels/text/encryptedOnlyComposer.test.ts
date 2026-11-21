// Spec for the Encrypted-only composer block (`encryptedOnlyComposer.ts`)
// and source pins for its wiring in `Composition.tsx` and `MessageBox.tsx`,
// which cannot load under Node. Run from packages/client:
//   node --test --conditions=browser \
//     src/interface/channels/text/encryptedOnlyComposer.test.ts
// Declared test count: 19 (the runner also exits 0 when it finds no tests at
// all, so compare this against its pass count).
//
// `ENCRYPTED_ONLY_COMPOSER_TS=<path>` loads another copy of the module, and
// `ENCRYPTED_ONLY_COMPOSITION_TSX` / `ENCRYPTED_ONLY_MESSAGEBOX_TSX` /
// `ENCRYPTED_ONLY_MENU_TSX` / `ENCRYPTED_ONLY_TIMELOCK_TSX` /
// `ENCRYPTED_ONLY_ADDFRIEND_TSX` / `ENCRYPTED_ONLY_HEADER_TSX` scan other
// copies of those files (for failing controls).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  type BlockReason,
  type ChannelKind,
  type DeviceState,
  type PeerFlag,
  type PlainWriteInput,
  decideForKind,
  reasonFor,
} from "../../../../components/client/encryptedOnlyPolicy.ts";

import type * as Module from "./encryptedOnlyComposer.ts";

const mod: typeof Module = await import(
  process.env.ENCRYPTED_ONLY_COMPOSER_TS
    ? pathToFileURL(process.env.ENCRYPTED_ONLY_COMPOSER_TS).href
    : "./encryptedOnlyComposer.ts"
);
const { composerBlockFor, kindBlockFor, noticeFor, refusalBlock } = mod;
const { sendMayEncrypt, composerViewFor, failedRowSend, peerChangedKeys } = mod;

type View = Module.ComposerView;
type Mode = View["mode"];

const COMPOSITION = readFileSync(
  process.env.ENCRYPTED_ONLY_COMPOSITION_TSX ||
    new URL("./Composition.tsx", import.meta.url),
  "utf8",
);
const MESSAGE_BOX = readFileSync(
  process.env.ENCRYPTED_ONLY_MESSAGEBOX_TSX ||
    new URL(
      "../../../../components/ui/components/features/messaging/composition/MessageBox.tsx",
      import.meta.url,
    ),
  "utf8",
);
/** Another of the files this module's decisions are wired into. */
function source(env: string, rel: string): string {
  return readFileSync(
    process.env[env] || new URL(rel, import.meta.url),
    "utf8",
  );
}
const MENU = source(
  "ENCRYPTED_ONLY_MENU_TSX",
  "../../../../components/app/menus/DraftMessageContextMenu.tsx",
);
const TIMELOCK = source(
  "ENCRYPTED_ONLY_TIMELOCK_TSX",
  "../../../../components/modal/modals/TimelockCompose.tsx",
);
const ADD_FRIEND = source(
  "ENCRYPTED_ONLY_ADDFRIEND_TSX",
  "../../../../components/modal/modals/AddFriendToGroup.tsx",
);
const HEADER = source("ENCRYPTED_ONLY_HEADER_TSX", "../ChannelHeader.tsx");

const PEER_CHANGED = "EncryptionRequired:peer-changed";

const CHANNELS: ChannelKind[] = ["dm", "group", "saved", "server"];
const PEER_FLAGS: PeerFlag[] = ["on", "off", "absent"];
const DEVICES: DeviceState[] = ["ready", "not-set-up", "web"];
const MODES: Mode[] = [
  undefined,
  "encrypt",
  "blocked",
  "plaintext",
  "peer_downgraded",
  "unconfirmed",
];
const BOOLS = [false, true];

function input(over: Partial<PlainWriteInput> = {}): PlainWriteInput {
  return {
    latched: false,
    channel: "dm",
    peerFlag: "absent",
    peerRemembered: false,
    groupMarked: false,
    groupRemembered: false,
    device: "web",
    encrypted: false,
    advert: "enforced",
    ...over,
  };
}

function view(over: Partial<View> = {}): View {
  return { mode: undefined, statusLoaded: true, peerOptedIn: false, ...over };
}

/** Every input and view, with `encrypted` as the guard module builds it. */
function* everything(): Generator<[PlainWriteInput, View]> {
  for (const channel of CHANNELS)
    for (const latched of BOOLS)
      for (const peerFlag of PEER_FLAGS)
        for (const peerRemembered of BOOLS)
          for (const groupMarked of BOOLS)
            for (const groupRemembered of BOOLS)
              for (const device of DEVICES)
                for (const mode of MODES)
                  for (const statusLoaded of BOOLS)
                    for (const peerOptedIn of BOOLS)
                      yield [
                        input({
                          channel,
                          latched,
                          peerFlag,
                          peerRemembered,
                          groupMarked,
                          groupRemembered,
                          device,
                          encrypted: mode === "encrypt",
                        }),
                        view({ mode, statusLoaded, peerOptedIn }),
                      ];
}

/** Body (between the braces) of the function whose header is given. */
function functionBody(src: string, header: string): string {
  const at = src.indexOf(header);
  assert.ok(at >= 0, `missing ${header}`);
  const open = src.indexOf("{", at + header.length - 1);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    if (src[i] === "}" && --depth === 0) return src.slice(open + 1, i);
  }
  assert.fail(`unbalanced ${header}`);
}

/** Drop comments and collapse whitespace. */
function code(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---- The block ---------------------------------------------------------------

test("sendMayEncrypt: only a ready device, and only modes the send path decides", () => {
  for (const device of DEVICES) {
    for (const mode of MODES) {
      for (const channel of ["dm", "group"] as const) {
        for (const peerOptedIn of BOOLS) {
          const got = sendMayEncrypt(
            input({ device, channel }),
            view({ mode, peerOptedIn }),
          );
          const expected =
            device === "ready" &&
            (mode === undefined ||
              mode === "encrypt" ||
              mode === "blocked" ||
              mode === "unconfirmed" ||
              (mode === "plaintext" && channel === "dm" && peerOptedIn));
          assert.equal(
            got,
            expected,
            JSON.stringify({ device, mode, channel, peerOptedIn }),
          );
        }
      }
    }
  }
  // A peer with the flag on, or remembered, counts like the hint
  const ready = { device: "ready" as const, channel: "dm" as const };
  const plaintext = view({ mode: "plaintext" });
  assert.equal(
    sendMayEncrypt(input({ ...ready, peerFlag: "on" }), plaintext),
    true,
  );
  assert.equal(
    sendMayEncrypt(input({ ...ready, peerRemembered: true }), plaintext),
    true,
  );
  assert.equal(sendMayEncrypt(input(ready), plaintext), false);
});

test("named cases", () => {
  const cases: [string, PlainWriteInput, View, unknown][] = [
    [
      "server channel",
      input({ channel: "server", latched: true }),
      view(),
      null,
    ],
    ["saved notes", input({ channel: "saved", latched: true }), view(), null],
    [
      "status not loaded",
      input({ latched: true, device: "not-set-up" }),
      view({ statusLoaded: false }),
      null,
    ],
    [
      "latched, website",
      input({ latched: true, device: "web" }),
      view(),
      { reason: "open-app", notice: "open-app", action: null },
    ],
    [
      "latched, app not set up",
      input({ latched: true, device: "not-set-up" }),
      view(),
      { reason: "setup", notice: "setup", action: "enable-device" },
    ],
    [
      "latched, peer without encryption",
      input({ latched: true, device: "ready" }),
      view({ mode: "plaintext" }),
      { reason: "sender", notice: "sender-dm", action: null },
    ],
    [
      "latched, first text message encrypts",
      input({ latched: true, device: "ready" }),
      view({ mode: "plaintext", peerOptedIn: true }),
      null,
    ],
    [
      "latched, mode not primed yet",
      input({ latched: true, device: "ready" }),
      view({ mode: undefined }),
      null,
    ],
    [
      "latched, encrypted",
      input({ latched: true, device: "ready", encrypted: true }),
      view({ mode: "encrypt" }),
      null,
    ],
    [
      "latched, identity change (the send path asks)",
      input({ latched: true, device: "ready" }),
      view({ mode: "blocked" }),
      null,
    ],
    [
      "latched, peer turned encryption off",
      input({ latched: true, device: "ready" }),
      view({ mode: "peer_downgraded", peerOptedIn: true }),
      { reason: "sender", notice: "sender-dm", action: null },
    ],
    [
      "latched, existing unmarked group",
      input({ latched: true, device: "ready", channel: "group" }),
      view({ mode: "plaintext" }),
      { reason: "sender", notice: "group-not-encrypted", action: null },
    ],
    [
      "latched, marked group never encrypted",
      input({
        latched: true,
        device: "ready",
        channel: "group",
        groupMarked: true,
      }),
      view({ mode: "plaintext" }),
      { reason: "group", notice: "group-enable", action: "enable-group" },
    ],
    [
      "latched, unconfirmed group (the send path asks)",
      input({ latched: true, device: "ready", channel: "group" }),
      view({ mode: "unconfirmed" }),
      null,
    ],
    [
      "to an Encrypted-only peer, website",
      input({ peerFlag: "on", device: "web" }),
      view(),
      { reason: "recipient", notice: "recipient", action: null },
    ],
    [
      "to an Encrypted-only peer, app not set up",
      input({ peerFlag: "on", device: "not-set-up" }),
      view(),
      { reason: "recipient", notice: "recipient", action: "enable-device" },
    ],
    [
      "to an Encrypted-only peer, ready (the first message encrypts)",
      input({ peerFlag: "on", device: "ready" }),
      view({ mode: "plaintext" }),
      null,
    ],
    [
      "remembered peer, flag missing",
      input({ peerRemembered: true }),
      view(),
      { reason: "peer-changed", notice: "peer-changed", action: "send-anyway" },
    ],
    [
      "remembered peer, flag off",
      input({ peerRemembered: true, peerFlag: "off" }),
      view(),
      { reason: "peer-changed", notice: "peer-changed", action: "send-anyway" },
    ],
    [
      "marked group, website",
      input({ channel: "group", groupMarked: true }),
      view(),
      { reason: "group", notice: "group", action: null },
    ],
    [
      "marked group, app not set up",
      input({ channel: "group", groupMarked: true, device: "not-set-up" }),
      view(),
      { reason: "group", notice: "group", action: "enable-device" },
    ],
    ["nobody asked for it", input(), view(), null],
    [
      "unmarked group, not latched",
      input({ channel: "group" }),
      view({ mode: "plaintext" }),
      null,
    ],
  ];

  for (const [name, facts, cached, expected] of cases) {
    assert.deepEqual(composerBlockFor(facts, cached), expected, name);
  }
});

test("over every input, the block is the policy's refusal or nothing", () => {
  let blocks = 0;
  let deferred = 0;
  for (const [facts, cached] of everything()) {
    const block = composerBlockFor(facts, cached);
    const decision = decideForKind("send", facts);
    const reason = reasonFor(decision, facts);
    const where = JSON.stringify({ facts, cached });

    if (block) {
      blocks++;
      // Never more than the policy refuses, and for the same reason
      assert.equal(block.reason, reason, where);
      assert.equal(
        block.notice,
        noticeFor(block.reason, facts.channel, block.action),
        where,
      );
    } else if (reason) {
      deferred++;
      // Left to the send path only where the cache cannot tell
      assert.ok(
        !cached.statusLoaded || sendMayEncrypt(facts, cached),
        `refusal dropped: ${where}`,
      );
    }
  }
  // Both sides of the rule are exercised
  assert.ok(blocks > 1000, `blocks ${blocks}`);
  assert.ok(deferred > 1000, `deferred ${deferred}`);
});

test("over every input, the action fits the device and the reason", () => {
  for (const [facts, cached] of everything()) {
    const block = composerBlockFor(facts, cached);
    if (!block) continue;
    const where = JSON.stringify({ facts, cached, block });
    switch (block.action) {
      case "send-anyway":
        assert.equal(block.reason, "peer-changed", where);
        break;
      case "enable-device":
        assert.equal(facts.device, "not-set-up", where);
        break;
      case "enable-group":
        assert.equal(facts.device, "ready", where);
        assert.equal(facts.channel, "group", where);
        assert.equal(block.reason, "group", where);
        break;
      case null:
        break;
      default:
        assert.fail(where);
    }
    if (block.reason === "peer-changed") {
      assert.equal(block.action, "send-anyway", where);
    }
    // The words name the button they come with
    assert.equal(
      block.notice === "group-enable",
      block.action === "enable-group",
      where,
    );
    // Under the latch nothing offers to send unencrypted
    if (facts.latched) assert.notEqual(block.action, "send-anyway", where);
    if (block.reason === "setup") assert.equal(block.action, "enable-device");
    if (block.reason === "open-app") assert.equal(block.action, null);
    if (block.reason === "sender") assert.equal(block.action, null);
  }
});

test("notices: the sender's own setting reads differently in a group", () => {
  const reasons: BlockReason[] = [
    "sender",
    "recipient",
    "group",
    "setup",
    "open-app",
    "peer-changed",
  ];
  for (const reason of reasons) {
    for (const channel of CHANNELS) {
      const expected =
        reason === "sender"
          ? channel === "group"
            ? "group-not-encrypted"
            : "sender-dm"
          : reason;
      assert.equal(
        noticeFor(reason, channel),
        expected,
        `${reason} ${channel}`,
      );
    }
  }
});

test("other kinds: refused wherever a plain send would be, never without a reason", () => {
  for (const [facts, cached] of everything()) {
    const block = kindBlockFor("interaction", facts, cached);
    const plain = decideForKind("interaction", facts);
    const where = JSON.stringify({ facts, cached });
    assert.equal(block === null, plain === "allow-plain", where);
    if (block) assert.ok(block.reason && block.notice, where);
    // Encrypting the group would not let a command through
    if (block) assert.notEqual(block.action, "enable-group", where);
    if (block) assert.notEqual(block.notice, "group-enable", where);
  }
  // In an encrypted direct message under the latch a send goes, a command
  // does not
  const encrypted = input({ latched: true, device: "ready", encrypted: true });
  assert.equal(composerBlockFor(encrypted, view({ mode: "encrypt" })), null);
  assert.deepEqual(
    kindBlockFor("interaction", encrypted, view({ mode: "encrypt" })),
    {
      reason: "sender",
      notice: "sender-dm",
      action: null,
    },
  );
  assert.equal(
    kindBlockFor("roll", input({ channel: "server", latched: true }), view()),
    null,
  );
});

test("refusals that come back from a write", () => {
  const facts = input({ device: "not-set-up" });
  assert.deepEqual(refusalBlock("recipient", facts, view()), {
    reason: "recipient",
    notice: "recipient",
    action: "enable-device",
  });
  assert.deepEqual(refusalBlock("peer-changed", input(), view()), {
    reason: "peer-changed",
    notice: "peer-changed",
    action: "send-anyway",
  });
  assert.deepEqual(
    refusalBlock("sender", input({ channel: "group", latched: true }), view()),
    { reason: "sender", notice: "group-not-encrypted", action: null },
  );
  // No words of its own: the caller shows the general error text
  for (const side of ["member", "unknown", "", "__proto__", "toString"]) {
    assert.equal(refusalBlock(side, facts, view()), null, side);
  }
  // A marked group this device can encrypt: the words name the button
  assert.deepEqual(
    refusalBlock(
      "group",
      input({ channel: "group", groupMarked: true, device: "ready" }),
      view({ mode: "plaintext" }),
    ),
    { reason: "group", notice: "group-enable", action: "enable-group" },
  );
});

// ---- Failed messages ---------------------------------------------------------

test("failed rows: Send anyway replaces Retry for a changed peer, never under the latch", () => {
  const stored: [string | undefined, boolean, unknown][] = [
    [PEER_CHANGED, false, "send-anyway"],
    // Under the latch nothing confirms a peer: retried, and refused for
    // the latch, which the row then says
    [PEER_CHANGED, true, "retry"],
    ["EncryptionRequired:recipient", false, "retry"],
    ["EncryptionRequired:sender", true, "retry"],
    ["EncryptionRequired:group", false, "retry"],
    // A side stored by a newer build reads as another refusal, not a peer
    ["EncryptionRequired:something-new", false, "retry"],
    ["FirstFileNeedsText", false, null],
    ["FirstFileNeedsText", true, null],
    ["DirectMessagesPaused", false, "retry"],
    ["The server rejected the message (Foo)", false, "retry"],
    [undefined, false, "retry"],
    [undefined, true, "retry"],
  ];
  for (const [error, latched, expected] of stored) {
    assert.equal(
      failedRowSend(error, latched),
      expected,
      JSON.stringify({ error, latched }),
    );
  }
});

test("the composer's Send anyway line is built from the failed rows", () => {
  const rows = [
    { idempotencyKey: "a", status: "failed", error: PEER_CHANGED },
    { idempotencyKey: "b", status: "sending", error: PEER_CHANGED },
    {
      idempotencyKey: "c",
      status: "failed",
      error: "EncryptionRequired:recipient",
    },
    { idempotencyKey: "d", status: "unsent" },
    { idempotencyKey: "e", status: "failed", error: PEER_CHANGED },
    { idempotencyKey: "f", status: "failed", error: "FirstFileNeedsText" },
  ];
  // Failed with the marker, in outbox order; not while one is sending
  assert.deepEqual(peerChangedKeys(rows, false), ["a", "e"]);
  // Under the latch there is nothing to confirm
  assert.deepEqual(peerChangedKeys(rows, true), []);
  assert.deepEqual(peerChangedKeys([], false), []);
  // The line and the row menu agree on every row
  for (const row of rows) {
    assert.equal(
      peerChangedKeys([row], false).length === 1,
      row.status === "failed" &&
        failedRowSend(row.error, false) === "send-anyway",
      row.idempotencyKey,
    );
  }
});

test("composerViewFor: the cache the composer and the dialogs read", () => {
  const modes = new Map<string, Mode>([
    ["peer", "plaintext"],
    ["group1", "encrypt"],
  ]);
  const bridge = (loaded: boolean) => ({
    sendModes: { get: (key: string) => modes.get(key) },
    status: { get: (key: "state") => (loaded && key === "state" ? {} : null) },
  });
  assert.deepEqual(
    composerViewFor(
      bridge(true),
      { type: "DirectMessage", id: "dm1" },
      "peer",
      true,
    ),
    { mode: "plaintext", statusLoaded: true, peerOptedIn: true },
  );
  // A group is keyed by its own id, a direct message by the peer
  assert.deepEqual(
    composerViewFor(bridge(false), { type: "Group", id: "group1" }, "x", false),
    { mode: "encrypt", statusLoaded: false, peerOptedIn: false },
  );
  assert.equal(
    composerViewFor(
      bridge(true),
      { type: "DirectMessage", id: "group1" },
      undefined,
      false,
    ).mode,
    undefined,
  );
  assert.equal(
    composerViewFor(
      bridge(true),
      { type: "TextChannel", id: "peer" },
      "peer",
      false,
    ).mode,
    undefined,
  );
  // Without a bridge the status counts as known
  assert.deepEqual(
    composerViewFor(undefined, { type: "DirectMessage", id: "d" }, "p", false),
    { mode: undefined, statusLoaded: true, peerOptedIn: false },
  );
});

// ---- Wiring (source pins) ----------------------------------------------------

test("Composition: the block disables the editor and names the reason", () => {
  const allowed = code(
    COMPOSITION.slice(
      COMPOSITION.indexOf("const sendingAllowed = () => {"),
      COMPOSITION.indexOf("const protectedBlockedText"),
    ),
  );
  assert.ok(allowed.includes("if (encryptedOnlyBlock()) { return false; }"));
  const blocked = code(
    functionBody(COMPOSITION, "const blockedText = () => {"),
  );
  assert.ok(
    blocked.includes("return encryptedOnlyText(block.notice);"),
    blocked,
  );
  // The words: a plain group under the latch is not "not encrypted yet",
  // and the group's "Turn on encryption" button has words that name it.
  // The rest are the app's error words.
  const words = code(
    functionBody(
      COMPOSITION,
      'function encryptedOnlyText(notice: ComposerNotice | "first-file"): string {',
    ),
  );
  assert.ok(
    words.includes(
      'case "group-not-encrypted": return t`You can\'t write in this group while Encrypted-only chats is on.`;',
    ),
    words,
  );
  assert.ok(
    words.includes(
      'case "group-enable": return t`Turn on encryption for this group to send messages.`;',
    ),
  );
  assert.ok(!words.includes("This chat is not encrypted yet"), words);
  assert.ok(
    words.includes(
      'case "peer-changed": return describeError(new EncryptedOnlyBlockedError(notice));',
    ),
  );
  // Reactive: a memo over the one input builder, tracking the latch
  const input = code(
    COMPOSITION.slice(
      COMPOSITION.indexOf("const encryptedOnlyInput = createMemo("),
      COMPOSITION.indexOf("const encryptedOnlyAllows"),
    ),
  );
  assert.ok(input.includes("latchVersion();"));
  assert.ok(input.includes("buildPlainWriteInput(client(), props.channel)"));
  assert.ok(
    code(COMPOSITION).includes("blockedAction={encryptedOnlyBlockedAction()}"),
  );
  // The guard writes signals: never from the composer's computations
  assert.ok(!COMPOSITION.includes("checkPlainWrite"));
  // Declared before the eager memos that read it
  const allows = COMPOSITION.indexOf("const encryptedOnlyAllows = (");
  for (const memo of ["pollAllowed", "softresAllowed", "scheduleAllowed"]) {
    const at = COMPOSITION.indexOf(`const ${memo} = createMemo(`);
    assert.ok(allows > 0 && at > allows, `${memo} before encryptedOnlyAllows`);
  }
});

test("Composition: refusals are caught before the generic E2EESendError branch", () => {
  const send = functionBody(
    COMPOSITION,
    "async function sendMessage(useContent?: unknown) {",
  );
  const catchAt = send.lastIndexOf("} catch (error) {");
  const tail = code(send.slice(catchAt));
  const generic = tail.indexOf("if (error instanceof E2EESendError) {");
  const firstFile = tail.indexOf("isFirstFileNeedsText(error) ||");
  const firstFileKind = tail.indexOf('error.kind === "first_file"');
  const refusal = tail.indexOf("showEncryptedOnlyRefusal(");
  assert.ok(generic > 0, "generic branch missing");
  for (const [name, at] of [
    ["first file", firstFile],
    ["first_file kind", firstFileKind],
    ["refusal", refusal],
  ] as const) {
    assert.ok(at > 0 && at < generic, `${name} not before the generic branch`);
  }
  assert.ok(tail.includes('encryptedOnlyText("first-file")'));
  // A refusal shows words, not the bare reason, and keeps the draft
  const show = code(
    functionBody(COMPOSITION, "function showEncryptedOnlyRefusal("),
  );
  assert.ok(show.includes("const side = sendRefusalSide(error);"));
  assert.ok(
    show.includes("encryptedOnlyText(block.notice) : describeError(error)"),
  );
  assert.ok(!/\.message\b/.test(show), "reads .message");
});

test("Composition: /roll and slash commands check before any request", () => {
  const roll = code(
    functionBody(COMPOSITION, "async function sendRoll(notation: string) {"),
  );
  const guard = roll.indexOf('client().plainWriteGuard?.(channel, "roll");');
  assert.ok(guard > 0, "roll guard missing");
  assert.ok(guard < roll.indexOf("await fetch("), "roll guard after the fetch");
  assert.ok(
    roll.includes(
      "if (showEncryptedOnlyRefusal(data, channel, false)) return;",
    ),
  );

  const command = code(
    functionBody(COMPOSITION, "async function sendInteraction("),
  );
  const check = command.indexOf('kindBlockFor( "interaction",');
  assert.ok(check > 0, "command check missing");
  assert.ok(check < command.indexOf(".createInteraction("));
  assert.ok(
    command.includes(
      "} catch (error) { if (showEncryptedOnlyRefusal(error, commandChannel, false)) return;",
    ),
  );
  // Not offered either
  const resource = code(
    COMPOSITION.slice(
      COMPOSITION.indexOf("const [availableCommands] = createResource("),
      COMPOSITION.indexOf("const searchSpace = createMemo"),
    ),
  );
  assert.ok(resource.includes('encryptedOnlyAllows("interaction"),'));
  assert.ok(resource.includes("!plainAllowed ||"));
  for (const [memo, kind] of [
    ["pollAllowed", "poll"],
    ["softresAllowed", "softres"],
    ["scheduleAllowed", "schedule"],
  ]) {
    const at = COMPOSITION.indexOf(`const ${memo} = createMemo(`);
    const body = COMPOSITION.slice(at, COMPOSITION.indexOf(");\n", at));
    assert.ok(body.includes(`encryptedOnlyAllows("${kind}")`), memo);
  }
});

test("Composition: picker errors reach the dialog as thrown", () => {
  const reporting = code(
    functionBody(COMPOSITION, "function sendReporting(useContent?: unknown) {"),
  );
  assert.ok(
    reporting.includes('openModal({ type: "error2", error }),'),
    reporting,
  );
  assert.ok(!reporting.includes("new Error(String(error))"));
});

test("MessageBox: the blocked notice has an action slot, a native button", () => {
  assert.ok(MESSAGE_BOX.includes("blockedAction?: MessageBoxBlockedAction;"));
  assert.ok(/const BlockedAction = styled\("button", \{/.test(MESSAGE_BOX));
  const blocked = code(
    MESSAGE_BOX.slice(
      MESSAGE_BOX.indexOf("<Match when={!props.sendingAllowed}>"),
      MESSAGE_BOX.indexOf("</Match>"),
    ),
  );
  assert.ok(
    blocked.includes(
      '<Show when={props.blockedAction}> {(action) => ( <BlockedAction type="button" onClick={() => action().onClick()}>',
    ),
    blocked,
  );
});

test("Composition: the Send anyway line comes from the outbox; confirm, then retry", () => {
  const all = code(COMPOSITION);
  const rows = code(
    COMPOSITION.slice(
      COMPOSITION.indexOf("const peerChangedRows = createMemo("),
      COMPOSITION.indexOf("const encryptedOnlyLine = () => {"),
    ),
  );
  assert.ok(rows.includes("latchVersion();"), rows);
  assert.ok(
    rows.includes(
      "peerChangedKeys( state.draft.getPendingMessages(props.channel.id), latchedForClient(client().user?.id), )",
    ),
    rows,
  );
  // Shown from the rows unless the block already offers "Send anyway"
  const line = code(
    functionBody(COMPOSITION, "const encryptedOnlyLine = () => {"),
  );
  assert.ok(
    line.includes("if (notice?.channelId === props.channel.id) return notice;"),
  );
  assert.ok(line.includes('encryptedOnlyBlock()?.action === "send-anyway"'));
  assert.ok(
    line.includes(
      'text: encryptedOnlyText("peer-changed"), action: "send-anyway" as const, draftBack: false,',
    ),
  );
  assert.ok(all.includes("<Show when={encryptedOnlyLine()}>"));
  // The transient-only notice and its resend are gone
  assert.ok(!/\bresend\b/.test(all), "resend still referenced");

  // "Send anyway": confirm the peer, then retry the marked rows
  const run = code(
    functionBody(
      COMPOSITION,
      "function runEncryptedOnlyAction(action: ComposerAction, draftBack: boolean) {",
    ),
  );
  const confirm = run.indexOf("confirmPeerChanged(peerId, client().user?.id);");
  const keys = run.indexOf("for (const key of peerChangedKeys(");
  const retry = run.indexOf(
    "state.draft.retrySend(client(), channel, key, (error) => retryRefused(error, channel), );",
  );
  assert.ok(confirm > 0 && keys > confirm && retry > keys, run);
  assert.ok(run.includes("if (draftBack) void sendReporting();"));
  // A retry refused for the peer again is on its row, not a second line
  const refused = code(
    functionBody(
      COMPOSITION,
      "function retryRefused(error: unknown, channel: Channel) {",
    ),
  );
  assert.equal(
    refused,
    "if (sendRefusalSide(error) === PEER_CHANGED_SIDE) return; void showEncryptedOnlyRefusal(error, channel, false);",
  );

  // A send refused for the peer that left a failed row returns before the
  // transient notice
  const send = code(
    functionBody(
      COMPOSITION,
      "async function sendMessage(useContent?: unknown) {",
    ),
  );
  assert.ok(
    send.includes("const peerChangedBefore = new Set(peerChangedRows());"),
  );
  const rowReturn = send.indexOf(
    "if ( sendRefusalSide(error) === PEER_CHANGED_SIDE && sendChannel.id === props.channel.id && peerChangedRows().some((key) => !peerChangedBefore.has(key)) ) { return; }",
  );
  const shown = send.indexOf("showEncryptedOnlyRefusal( error, sendChannel,");
  assert.ok(rowReturn > 0 && shown > rowReturn, "row return missing or late");
});

test("Composition: a GIF or sticker in a direct message goes through the outbox", () => {
  const send = code(
    functionBody(
      COMPOSITION,
      "async function sendMessage(useContent?: unknown) {",
    ),
  );
  const outbox = send.indexOf(
    'if (sendChannel.type === "DirectMessage") { return await state.draft.sendDraft(client(), sendChannel, { content: useContent, }); }',
  );
  const direct = send.indexOf(
    "return await props.channel.sendMessage(useContent);",
  );
  assert.ok(outbox > 0, "DM string send not through the outbox");
  assert.ok(direct > outbox, "direct send before the outbox branch");
  // Inside the string branch, so the composer's draft is not popped
  const branch = send.indexOf('if (typeof useContent === "string") {');
  assert.ok(branch > 0 && branch < outbox);
});

test("row menu: Send anyway confirms the peer then retries; no Retry for that row", () => {
  const menu = code(MENU);
  assert.ok(
    menu.includes(
      '<Show when={resend() === "send-anyway"}> <ContextMenuButton icon={MdSend} onClick={sendAnyway}> <Trans>Send anyway</Trans>',
    ),
    menu,
  );
  assert.ok(
    menu.includes(
      '<Show when={resend() === "retry"}> <ContextMenuButton icon={MdRefresh} onClick={retrySend}> <Trans>Retry sending</Trans>',
    ),
  );
  // Retry is offered nowhere else
  assert.equal(menu.split("onClick={retrySend}").length, 2);
  const resend = code(functionBody(MENU, "const resend = () => {"));
  assert.equal(
    resend,
    "latchVersion(); return failedRowSend( props.draft.error, latchedForClient(client().user?.id), );",
  );
  const anyway = code(functionBody(MENU, "function sendAnyway() {"));
  const confirm = anyway.indexOf(
    "confirmPeerChanged(peerId, client().user?.id);",
  );
  assert.ok(confirm > 0 && anyway.indexOf("retrySend();") > confirm, anyway);
});

test("Timelock, add to group and the header: same block, rule per group, tooltip", () => {
  const timelock = code(TIMELOCK);
  assert.ok(!timelock.includes("writeRefusal("), "Timelock decides on its own");
  const memo = code(
    TIMELOCK.slice(
      TIMELOCK.indexOf("const refusal = createMemo(() => {"),
      TIMELOCK.indexOf("function refusalText("),
    ),
  );
  assert.ok(memo.includes("latchVersion();"));
  assert.ok(
    memo.includes(
      "return composerBlockFor( buildPlainWriteInput(client(), props.channel), composerViewFor(",
    ),
  );
  const text = code(
    functionBody(
      TIMELOCK,
      "function refusalText(block: ComposerBlock): string {",
    ),
  );
  assert.ok(
    text.includes(
      'case "peer-changed": return t`This person may no longer use Encrypted-only chats. Confirm with Send anyway in the message box first.`;',
    ),
    text,
  );
  assert.ok(
    text.includes(
      'case "group-enable": return t`Turn on encryption for this group to send messages.`;',
    ),
  );
  assert.ok(
    text.includes(
      'case "group-not-encrypted": return t`You can\'t write in this group while Encrypted-only chats is on.`;',
    ),
  );
  // No confirm here: the composer has it
  assert.ok(!timelock.includes("confirmPeerChanged"));

  const add = code(ADD_FRIEND);
  assert.ok(
    !add.includes("groups().some(isMarked)"),
    "rule shown for the list",
  );
  const rowAt = ADD_FRIEND.indexOf("<For each={groups()}>");
  const rowBody = code(
    ADD_FRIEND.slice(rowAt, ADD_FRIEND.indexOf("</For>", rowAt)),
  );
  assert.ok(
    rowBody.includes("const marked = createMemo(() => isMarked(channel));"),
  );
  assert.ok(
    rowBody.includes(
      "<Show when={marked()}> <Rule> <Trans> This group is encrypted. Only people with encryption turned on can be added (up to 24). </Trans> </Rule> </Show>",
    ),
    rowBody,
  );

  const pillAt = HEADER.indexOf(
    "<Show when={props.channel.recipient?.e2eeOnly === true}>",
  );
  assert.ok(pillAt > 0, "pill missing");
  const pill = code(HEADER.slice(pillAt, HEADER.indexOf("</Show>", pillAt)));
  assert.ok(
    pill.includes(
      '<span class={headerLabel} use:floating={{ tooltip: { placement: "bottom", content: t`This person only accepts encrypted messages.`, }, }} > <Trans>Encrypted-only</Trans>',
    ),
    `pill without its tooltip: ${pill}`,
  );
});
