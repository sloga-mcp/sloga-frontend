/**
 * Run with:
 *
 *     node --conditions=browser --test components/ui/components/features/messaging/elements/inviteCardModel.test.ts
 *
 * The decisions behind the in-chat invite card (`./Invite.tsx`), which is a
 * `.tsx` reaching `solid-js`, lingui and `@revolt/ui` and so is loadable by no
 * unit runner. Each `describe` names the decision and what goes wrong without
 * it:
 *
 * - state: a failed fetch or a non-server invite is "invalid", never a server
 *   card with an empty avatar and a Join button that throws on `join()`;
 * - badge: official beats verified, unknown flag bits draw nothing;
 * - established date: read from the server ULID, a bad id draws no line;
 * - retry: an API answer (a dead code) is final and shows at once, only a
 *   network failure is retried;
 * - source level: the card never hard-codes "members" and never wraps a
 *   component in `styled()` (blank page).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { decodeTime, ulid } from "ulid";

import {
  type InviteSource,
  formatEstablished,
  inviteBadge,
  inviteCardView,
  retryInviteFetch,
  ulidTime,
} from "./inviteCardModel.ts";

// 2024-10-15T12:00:00Z
const CREATED = Date.UTC(2024, 9, 15, 12);
const SERVER_ID = ulid(CREATED);

function serverInvite(overrides: Partial<InviteSource> = {}): InviteSource {
  return {
    type: "Server",
    serverId: SERVER_ID,
    serverName: "Sloga HQ",
    serverFlags: 0,
    memberCount: 1234,
    serverIcon: { previewUrl: "https://cdn.example/icon" },
    serverBanner: { originalUrl: "https://cdn.example/banner" },
    ...overrides,
  };
}

const notMember = () => false;

describe("state", () => {
  it("is loading while the fetch is pending", () => {
    assert.deepEqual(inviteCardView("pending", undefined, notMember), {
      kind: "loading",
    });
  });

  it("is invalid when the fetch failed (expired or unknown code)", () => {
    assert.deepEqual(inviteCardView("error", undefined, notMember), {
      kind: "invalid",
    });
  });

  it("is invalid for an error even if stale data is still cached", () => {
    assert.equal(
      inviteCardView("error", serverInvite(), notMember).kind,
      "invalid",
    );
  });

  it("is invalid for an invite that is not a server invite", () => {
    assert.equal(
      inviteCardView("success", { type: "None" }, notMember).kind,
      "invalid",
    );
    // even one that carries server fields: `type` alone decides
    assert.equal(
      inviteCardView("success", serverInvite({ type: "Group" }), notMember)
        .kind,
      "invalid",
    );
  });

  it("is invalid for a success with no data or no server id", () => {
    assert.equal(
      inviteCardView("success", undefined, notMember).kind,
      "invalid",
    );
    assert.equal(
      inviteCardView(
        "success",
        serverInvite({ serverId: undefined }),
        notMember,
      ).kind,
      "invalid",
    );
  });

  it("maps a server invite onto the card", () => {
    assert.deepEqual(inviteCardView("success", serverInvite(), notMember), {
      kind: "server",
      serverId: SERVER_ID,
      name: "Sloga HQ",
      iconUrl: "https://cdn.example/icon",
      bannerUrl: "https://cdn.example/banner",
      badge: undefined,
      memberCount: 1234,
      establishedAt: CREATED,
      joined: false,
    });
  });

  it("has no banner when the server has none", () => {
    const view = inviteCardView(
      "success",
      serverInvite({ serverBanner: undefined, serverIcon: undefined }),
      notMember,
    );
    assert.equal(view.kind, "server");
    if (view.kind !== "server") return;
    assert.equal(view.bannerUrl, undefined);
    assert.equal(view.iconUrl, undefined);
  });

  it("is joined when the user is already in that server, and only that one", () => {
    const asked: string[] = [];
    const view = inviteCardView("success", serverInvite(), (id) => {
      asked.push(id);
      return id === SERVER_ID;
    });
    assert.equal(view.kind === "server" && view.joined, true);
    assert.deepEqual(asked, [SERVER_ID]);

    const other = inviteCardView("success", serverInvite(), (id) => id === "X");
    assert.equal(other.kind === "server" && other.joined, false);
  });
});

describe("badge", () => {
  it("draws nothing for no flags", () => {
    assert.equal(inviteBadge(0), undefined);
    assert.equal(inviteBadge(undefined), undefined);
  });

  it("reads bit 1 as official and bit 2 as verified", () => {
    assert.equal(inviteBadge(1), "official");
    assert.equal(inviteBadge(2), "verified");
  });

  it("prefers official when both bits are set", () => {
    assert.equal(inviteBadge(3), "official");
  });

  it("draws nothing for unknown bits", () => {
    assert.equal(inviteBadge(4), undefined);
  });

  it("reaches the card", () => {
    const view = inviteCardView(
      "success",
      serverInvite({ serverFlags: 2 }),
      notMember,
    );
    assert.equal(view.kind === "server" && view.badge, "verified");
  });
});

describe("established date", () => {
  it("reads the server ULID's timestamp", () => {
    assert.equal(ulidTime(SERVER_ID), CREATED);
    assert.equal(ulidTime(SERVER_ID), decodeTime(SERVER_ID));
  });

  it("is undefined for an id that is not a ULID", () => {
    assert.equal(ulidTime("not-a-ulid"), undefined);
    assert.equal(ulidTime(""), undefined);
    const view = inviteCardView(
      "success",
      serverInvite({ serverId: "legacy" }),
      notMember,
    );
    assert.equal(view.kind === "server" && view.establishedAt, undefined);
  });

  it("formats month and year in the app locale", () => {
    assert.equal(formatEstablished(CREATED, "en"), "Oct 2024");
    assert.match(formatEstablished(CREATED, "de"), /Okt\.? 2024/);
  });

  it("accepts lingui's underscore locales and falls back to en", () => {
    assert.match(formatEstablished(CREATED, "pt_BR"), /out\.? de 2024/);
    assert.equal(formatEstablished(CREATED, undefined), "Oct 2024");
    assert.equal(formatEstablished(CREATED, "!!"), "Oct 2024");
  });
});

describe("retry", () => {
  it("never retries an API answer such as NotFound", () => {
    assert.equal(retryInviteFetch(0, '{"type":"NotFound"}'), false);
    assert.equal(retryInviteFetch(0, { type: "Banned" }), false);
  });

  it("retries a network failure twice", () => {
    const offline = new TypeError("Failed to fetch");
    assert.equal(retryInviteFetch(0, offline), true);
    assert.equal(retryInviteFetch(1, offline), true);
    assert.equal(retryInviteFetch(2, offline), false);
  });

  it("retries a non-JSON proxy page like a network failure", () => {
    assert.equal(retryInviteFetch(0, "<html>502</html>"), true);
  });
});

describe("source level", () => {
  const source = readFileSync(new URL("./Invite.tsx", import.meta.url), "utf8");

  it("uses the model, not its own instanceof checks", () => {
    assert.match(source, /inviteCardView\(/);
    assert.match(source, /retry: retryInviteFetch/);
    assert.doesNotMatch(source, /instanceof ServerPublicInvite/);
  });

  it("pluralises the member count instead of hard-coding the word", () => {
    assert.match(
      source,
      /<Plural[\s\S]*?one="# member"[\s\S]*?other="# members"/,
    );
    assert.doesNotMatch(source, /^\s*members\s*$/m);
  });

  it("wraps only string tags in styled()", () => {
    // `= styled(`, so the warning comment in the card is not a call
    const calls = [...source.matchAll(/=\s*styled\(\s*([^,\s)]+)/g)].map(
      (match) => match[1],
    );
    assert.ok(calls.length > 0);
    for (const tag of calls) assert.match(tag, /^"[a-z]+"$/);
  });
});
