// Unit spec for the notification preview policy — run with Node's built-in
// runner:
//   node --conditions=browser --test components/client/notificationPreviewPolicy.test.ts
// Declared test count: 25 (compare against the runner's pass count, since the
// runner also exits 0 when it finds no tests at all).
// Focus: the per-conversation override beats the global mode, "Off" beats
// everything, anyone watching the screen strips the content and the reply but
// still announces the message, an E2EE message never puts its content on a
// toast the OS draws, nor its content or a reply box on our own toast where a
// capture can see it, the browser never offers a reply, and server channels
// ignore the DM setting entirely. The sweeps at the end hold invariants over
// every input combination, so a rule that re-enables what an earlier one
// withheld fails there even if no single case above names it.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type ConversationE2EEMode,
  type DmPreviewMode,
  type NotificationSurface,
  type PreviewDecision,
  type PreviewPolicyInput,
  DM_PREVIEW_DEFAULT,
  DM_PREVIEW_MODES,
  decidePreview,
  e2eeNotificationGate,
  isDmPreviewMode,
} from "./notificationPreviewPolicy.ts";

const SURFACES: readonly NotificationSurface[] = [
  "sloga_toast",
  "sloga_toast_unprotected",
  "os_toast",
  "web",
];
const OVERRIDES: readonly (DmPreviewMode | undefined)[] = [
  undefined,
  ...DM_PREVIEW_MODES,
];
const BOOLS = [false, true] as const;
const DM_TYPES = ["DirectMessage", "Group"] as const;
const NON_DM_TYPES = ["TextChannel", "SavedMessages", "VoiceChannel"] as const;

/** A DM in full_reply on our own toast, nothing watching: everything allowed. */
function input(
  overrides: Partial<PreviewPolicyInput> = {},
): PreviewPolicyInput {
  return {
    mode: "full_reply",
    override: undefined,
    isE2EE: false,
    surface: "sloga_toast",
    screensharing: false,
    streamerMode: false,
    rcActive: false,
    channelType: "DirectMessage",
    ...overrides,
  };
}

const EVERYTHING: PreviewDecision = {
  show: true,
  playSound: true,
  showBody: true,
  showImage: true,
  allowReply: true,
};

const NOTHING: PreviewDecision = {
  show: false,
  playSound: false,
  showBody: false,
  showImage: false,
  allowReply: false,
};

const SENDER_ONLY: PreviewDecision = {
  show: true,
  playSound: true,
  showBody: false,
  showImage: false,
  allowReply: false,
};

/** Every input combination, for the sweeps. */
function* everyInput(): Generator<PreviewPolicyInput> {
  for (const channelType of [...DM_TYPES, ...NON_DM_TYPES])
    for (const mode of DM_PREVIEW_MODES)
      for (const override of OVERRIDES)
        for (const surface of SURFACES)
          for (const isE2EE of BOOLS)
            for (const screensharing of BOOLS)
              for (const streamerMode of BOOLS)
                for (const rcActive of BOOLS)
                  yield {
                    mode,
                    override,
                    isE2EE,
                    surface,
                    screensharing,
                    streamerMode,
                    rcActive,
                    channelType,
                  };
}

const label = (i: PreviewPolicyInput) => JSON.stringify(i);

test("the modes, the default, and the guard agree", () => {
  assert.deepEqual([...DM_PREVIEW_MODES], ["full_reply", "sender", "off"]);
  assert.equal(DM_PREVIEW_DEFAULT, "full_reply");
  for (const mode of DM_PREVIEW_MODES)
    assert.equal(isDmPreviewMode(mode), true);
  for (const bad of [
    undefined,
    null,
    "",
    "Off",
    "full",
    "none",
    0,
    true,
    {},
    ["off"],
  ])
    assert.equal(isDmPreviewMode(bad), false, String(bad));
});

test("full_reply on our own toast allows everything, in a DM and a group", () => {
  for (const channelType of DM_TYPES)
    assert.deepEqual(decidePreview(input({ channelType })), EVERYTHING);
});

test("full_reply offers a reply only on our own toast", () => {
  assert.deepEqual(
    decidePreview(input({ surface: "sloga_toast_unprotected" })),
    EVERYTHING,
  );
  assert.deepEqual(decidePreview(input({ surface: "os_toast" })), {
    ...EVERYTHING,
    allowReply: false,
  });
  assert.deepEqual(decidePreview(input({ surface: "web" })), {
    ...EVERYTHING,
    allowReply: false,
  });
});

test("sender announces who wrote and nothing else, on every surface", () => {
  for (const channelType of DM_TYPES)
    for (const surface of SURFACES)
      assert.deepEqual(
        decidePreview(input({ mode: "sender", channelType, surface })),
        SENDER_ONLY,
        `${channelType} ${surface}`,
      );
});

test("off shows nothing and plays nothing", () => {
  for (const channelType of DM_TYPES)
    for (const surface of SURFACES)
      assert.deepEqual(
        decidePreview(input({ mode: "off", channelType, surface })),
        NOTHING,
        `${channelType} ${surface}`,
      );
});

test("the override beats the global mode, in both directions", () => {
  // Looser than the global setting: the conversation is opted back in.
  assert.deepEqual(
    decidePreview(input({ mode: "off", override: "full_reply" })),
    EVERYTHING,
  );
  assert.deepEqual(
    decidePreview(input({ mode: "off", override: "sender" })),
    SENDER_ONLY,
  );
  // Stricter than the global setting: the conversation is muted or hidden.
  assert.deepEqual(
    decidePreview(input({ mode: "full_reply", override: "off" })),
    NOTHING,
  );
  assert.deepEqual(
    decidePreview(input({ mode: "full_reply", override: "sender" })),
    SENDER_ONLY,
  );
  assert.deepEqual(
    decidePreview(input({ mode: "sender", override: "off" })),
    NOTHING,
  );
});

test("with no override the global mode applies", () => {
  for (const mode of DM_PREVIEW_MODES)
    assert.deepEqual(
      decidePreview(input({ mode, override: undefined })),
      decidePreview(input({ mode: "sender", override: mode })),
      mode,
    );
});

test("remote control, screen share and streamer mode each strip the content and the reply, but still announce", () => {
  for (const flag of ["rcActive", "screensharing", "streamerMode"] as const)
    for (const channelType of DM_TYPES)
      assert.deepEqual(
        decidePreview(input({ [flag]: true, channelType })),
        SENDER_ONLY,
        `${flag} ${channelType}`,
      );
});

test("off beats everything: no watcher, surface or encryption state brings a toast back", () => {
  for (const i of everyInput()) {
    if (!(DM_TYPES as readonly string[]).includes(i.channelType)) continue;
    if ((i.override ?? i.mode) !== "off") continue;
    assert.deepEqual(decidePreview(i), NOTHING, label(i));
  }
});

test("an E2EE message never puts its content on a toast the OS draws", () => {
  assert.deepEqual(
    decidePreview(input({ isE2EE: true, surface: "os_toast" })),
    SENDER_ONLY,
  );
  // The browser's Notification is OS-drawn as well.
  assert.deepEqual(
    decidePreview(input({ isE2EE: true, surface: "web" })),
    SENDER_ONLY,
  );
  // Same rule in a group, and it is not a DM-only setting: it holds outside
  // DM scope too, where the mode is otherwise ignored.
  assert.deepEqual(
    decidePreview(
      input({ isE2EE: true, surface: "os_toast", channelType: "Group" }),
    ),
    SENDER_ONLY,
  );
  assert.deepEqual(
    decidePreview(
      input({
        isE2EE: true,
        surface: "os_toast",
        channelType: "TextChannel",
        mode: "off",
      }),
    ),
    SENDER_ONLY,
  );
});

test("an E2EE message keeps its content and reply on our own toast", () => {
  assert.deepEqual(
    decidePreview(input({ isE2EE: true, surface: "sloga_toast" })),
    EVERYTHING,
  );
});

test("an E2EE message on our toast where a capture can see it announces the sender only, with no reply", () => {
  for (const channelType of DM_TYPES)
    for (const mode of DM_PREVIEW_MODES)
      if (mode !== "off")
        assert.deepEqual(
          decidePreview(
            input({
              isE2EE: true,
              surface: "sloga_toast_unprotected",
              channelType,
              mode,
            }),
          ),
          SENDER_ONLY,
          `${channelType} ${mode}`,
        );
});

test("a plaintext message on our toast where a capture can see it keeps its content and reply", () => {
  for (const channelType of DM_TYPES)
    assert.deepEqual(
      decidePreview(input({ surface: "sloga_toast_unprotected", channelType })),
      EVERYTHING,
      channelType,
    );
  // Watchers still take the content and the reply away there.
  for (const flag of ["rcActive", "screensharing", "streamerMode"] as const)
    assert.deepEqual(
      decidePreview(
        input({ [flag]: true, surface: "sloga_toast_unprotected" }),
      ),
      SENDER_ONLY,
      flag,
    );
});

test("the browser never offers a reply, whatever else is true", () => {
  for (const i of everyInput())
    if (i.surface === "web")
      assert.equal(decidePreview(i).allowReply, false, label(i));
});

test("server channels ignore the DM mode and the override, and never offer a reply", () => {
  for (const channelType of NON_DM_TYPES)
    for (const mode of DM_PREVIEW_MODES)
      for (const override of OVERRIDES)
        for (const surface of SURFACES)
          assert.deepEqual(
            decidePreview(input({ channelType, mode, override, surface })),
            { ...EVERYTHING, allowReply: false },
            `${channelType} ${mode} ${override} ${surface}`,
          );
});

test("server channels are not stripped by watchers here (contract C-1: unchanged)", () => {
  // Pinned so a change to server-channel behavior is a decision, not a drift.
  // Streamer mode is still handled for every channel by the worker's own
  // early return, ahead of this policy.
  for (const flag of ["rcActive", "screensharing", "streamerMode"] as const)
    assert.deepEqual(
      decidePreview(input({ [flag]: true, channelType: "TextChannel" })),
      { ...EVERYTHING, allowReply: false },
      flag,
    );
});

test("an unrecognized mode or override fails closed to sender-only", () => {
  const bad = "everything" as unknown as DmPreviewMode;
  assert.deepEqual(decidePreview(input({ mode: bad })), SENDER_ONLY);
  assert.deepEqual(
    decidePreview(input({ mode: "full_reply", override: bad })),
    SENDER_ONLY,
  );
});

test("each call returns a fresh decision", () => {
  const first = decidePreview(input());
  first.showBody = false;
  first.allowReply = false;
  assert.deepEqual(decidePreview(input()), EVERYTHING);
  const off = decidePreview(input({ mode: "off" }));
  off.show = true;
  assert.deepEqual(decidePreview(input({ mode: "off" })), NOTHING);
});

test("sweep: a reply needs everything else, and nothing outlives show", () => {
  const replies = new Map<NotificationSurface, number>();
  for (const i of everyInput()) {
    const d = decidePreview(i);
    const where = label(i);
    assert.equal(d.playSound, d.show, `sound follows show: ${where}`);
    if (!d.show) assert.deepEqual(d, NOTHING, where);
    if (d.showBody || d.showImage) assert.equal(d.show, true, where);
    if (d.allowReply) {
      replies.set(i.surface, (replies.get(i.surface) ?? 0) + 1);
      assert.equal(d.showBody, true, where);
      assert.ok(
        i.surface === "sloga_toast" ||
          (i.surface === "sloga_toast_unprotected" && !i.isE2EE),
        where,
      );
      assert.ok((DM_TYPES as readonly string[]).includes(i.channelType), where);
      assert.equal(i.override ?? i.mode, "full_reply", where);
      assert.equal(
        i.rcActive || i.screensharing || i.streamerMode,
        false,
        where,
      );
    }
    if (i.isE2EE && i.surface !== "sloga_toast") {
      assert.equal(d.showBody, false, where);
      assert.equal(d.showImage, false, where);
      assert.equal(d.allowReply, false, where);
    }
  }
  // The sweep must reach each corner where a reply is allowed, or the block
  // above checked nothing there.
  assert.deepEqual([...replies.keys()].sort(), [
    "sloga_toast",
    "sloga_toast_unprotected",
  ]);
});

const LOCKED_MODES: readonly ConversationE2EEMode[] = [
  "encrypt",
  "blocked",
  "peer_downgraded",
];
const ALL_E2EE_MODES: readonly ConversationE2EEMode[] = [
  ...LOCKED_MODES,
  "plaintext",
  "unknown",
  null,
];

test("e2ee gate: no engine or a channel that cannot be encrypted notifies as before", () => {
  assert.equal(e2eeNotificationGate(null, false), "normal");
  assert.equal(e2eeNotificationGate(null, true), "normal");
});

test("e2ee gate: a message this device decrypted notifies, whatever the mode", () => {
  for (const mode of ALL_E2EE_MODES)
    assert.equal(e2eeNotificationGate(mode, true), "normal", String(mode));
});

test("e2ee gate: anything else in an encrypted conversation never notifies", () => {
  for (const mode of LOCKED_MODES)
    assert.equal(e2eeNotificationGate(mode, false), "suppress", String(mode));
});

test("e2ee gate: a conversation whose state could not be read announces the sender only", () => {
  assert.equal(e2eeNotificationGate("unknown", false), "sender_only");
});

test("e2ee gate: a plaintext conversation notifies as before", () => {
  assert.equal(e2eeNotificationGate("plaintext", false), "normal");
});

test("e2ee gate: an unrecognized mode fails closed to sender-only", () => {
  const bad = "everything" as unknown as ConversationE2EEMode;
  assert.equal(e2eeNotificationGate(bad, false), "sender_only");
  assert.equal(
    e2eeNotificationGate(undefined as unknown as ConversationE2EEMode, false),
    "sender_only",
  );
});
