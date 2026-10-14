// Unit spec for the "user is reading this conversation" test that
// NotificationsWorker skips notifications on — run with Node's built-in
// runner from packages/client:
//   node --conditions=browser --test components/client/viewingConversation.test.ts
// Declared test count: 7 (compare against the runner's pass count, since the
// runner also exits 0 when it finds no tests at all).
// Focus: the main window counts only with the conversation routed AND its
// document focused; a focused chat window showing it counts on its own; a
// focused window showing a different conversation, or no window showing it,
// never suppresses.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type ConversationView,
  isViewingConversation,
} from "./viewingConversation.ts";

const CHANNEL = "01HCHANNEL0000000000000000";
const OTHER = "01HOTHER000000000000000000";

const view = (overrides: Partial<ConversationView>): ConversationView => ({
  routeChannelId: undefined,
  mainFocused: false,
  chatWindowConversations: new Set(),
  ...overrides,
});

test("main window with the conversation routed and focused is reading", () => {
  assert.equal(
    isViewingConversation(
      CHANNEL,
      view({ routeChannelId: CHANNEL, mainFocused: true }),
    ),
    true,
  );
});

test("main window routed to it but unfocused is not reading", () => {
  assert.equal(
    isViewingConversation(
      CHANNEL,
      view({ routeChannelId: CHANNEL, mainFocused: false }),
    ),
    false,
  );
});

test("focused main window on another conversation is not reading", () => {
  assert.equal(
    isViewingConversation(
      CHANNEL,
      view({ routeChannelId: OTHER, mainFocused: true }),
    ),
    false,
  );
});

test("a focused chat window showing it is reading, main unfocused", () => {
  assert.equal(
    isViewingConversation(
      CHANNEL,
      view({ chatWindowConversations: new Set([OTHER, CHANNEL]) }),
    ),
    true,
  );
});

test("a focused chat window counts even while main routes elsewhere", () => {
  assert.equal(
    isViewingConversation(
      CHANNEL,
      view({
        routeChannelId: OTHER,
        mainFocused: false,
        chatWindowConversations: new Set([CHANNEL]),
      }),
    ),
    true,
  );
});

test("a focused chat window on another conversation does not suppress", () => {
  assert.equal(
    isViewingConversation(
      CHANNEL,
      view({
        routeChannelId: CHANNEL,
        mainFocused: false,
        chatWindowConversations: new Set([OTHER]),
      }),
    ),
    false,
  );
});

test("nothing open anywhere is not reading", () => {
  assert.equal(isViewingConversation(CHANNEL, view({})), false);
});
