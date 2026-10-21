// Unit spec for conversation link recognition. Run with Node's built-in
// runner from packages/client:
//   node --test --conditions=browser components/chatWindows/dmLinks.test.ts
// Declared test count: 6 (the runner also exits 0 when it finds no tests at
// all, so compare this against its pass count).
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CONVERSATION_PATH_RE,
  bareConversationIdFromHref as conversationIdFromHref,
  conversationIdFromPath,
} from "./dmLinks.ts";

const CH = "01KWFKG47HBFTEEN6XPPS8H3HN";
const MSG = "01KWFKG47HBFTEEN6XPPS8H3HP";
const BASE = "https://app.sloga.gg/server/01KWFKG47HBFTEEN6XPPS8H3HQ";

test("conversation paths: the channel id, with or without a message id", () => {
  assert.equal(conversationIdFromPath(`/channel/${CH}`), CH);
  assert.equal(conversationIdFromPath(`/channel/${CH}/${MSG}`), CH);
});

test("anything else is not a conversation path", () => {
  for (const path of [
    `/server/${MSG}/channel/${CH}`,
    `/channel/${CH}/`,
    `/channel/${CH.toLowerCase()}`,
    `/channel/${CH}/${MSG}/extra`,
    `/channel/${CH}x`,
    `/friends`,
    ``,
    `channel/${CH}`,
  ]) {
    assert.equal(conversationIdFromPath(path), undefined, path);
  }
  // Stateless: no `g` flag
  assert.equal(CONVERSATION_PATH_RE.global, false);
});

test("same-origin links resolve, relative or absolute, query and hash ignored", () => {
  assert.equal(conversationIdFromHref(`/channel/${CH}`, BASE), CH);
  assert.equal(
    conversationIdFromHref(`https://app.sloga.gg/channel/${CH}`, BASE),
    CH,
  );
  assert.equal(conversationIdFromHref(`/channel/${CH}?a=1#b`, BASE), CH);
  assert.equal(conversationIdFromHref(`../../channel/${CH}`, BASE), CH);
});

test("a link to a message in a conversation is not a conversation link", () => {
  // Reply quotes, forwarded-from, pins and search results: a tab can't jump
  assert.equal(
    conversationIdFromHref(`/channel/${CH}/${MSG}`, BASE),
    undefined,
  );
  assert.equal(
    conversationIdFromHref(`https://app.sloga.gg/channel/${CH}/${MSG}`, BASE),
    undefined,
  );
  assert.equal(
    conversationIdFromHref(`/channel/${CH}/${MSG}?a=1#b`, BASE),
    undefined,
  );
  // The notification path parser still accepts both (it routes by channel)
  assert.equal(conversationIdFromPath(`/channel/${CH}/${MSG}`), CH);
});

test("other origins and protocol-relative links never match", () => {
  for (const href of [
    `https://evil.example/channel/${CH}`,
    `//evil.example/channel/${CH}`,
    `http://app.sloga.gg/channel/${CH}`,
    `https://app.sloga.gg:8443/channel/${CH}`,
    `javascript:alert(1)//channel/${CH}`,
  ]) {
    assert.equal(conversationIdFromHref(href, BASE), undefined, href);
  }
});

test("malformed input is not a link", () => {
  assert.equal(conversationIdFromHref("http://[", BASE), undefined);
  assert.equal(
    conversationIdFromHref(`/channel/${CH}`, "not a url"),
    undefined,
  );
  assert.equal(conversationIdFromHref("", BASE), undefined);
});
