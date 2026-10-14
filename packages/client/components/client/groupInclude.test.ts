// Unit spec for the encrypted-group include decisions, run with Node's
// built-in runner:
//   node --conditions=browser --test components/client/groupInclude.test.ts
// Focus: the member cap sits one below native's (a Retry counts the
// now-active member, so 23 must refuse up front), the envelope estimate
// refuses past 127, only the three native error types a Retry cannot fix are
// terminal, and a POST that queued nothing for the new member (UnknownDevice
// or QueueFull alike) is reported as undelivered so the caller offers a Retry.
// Also the single-flight guard: a second include of the same member into the
// same group is refused before anything is awaited, with an error that is not
// terminal, and the claim is released on every path. e2ee.ts cannot load
// under node, so its use of the guard is checked by scanning the source
// (GROUP_INCLUDE_E2EE_PATH points the scan at another copy, for controls).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import {
  INCLUDE_ENVELOPE_LIMIT,
  INCLUDE_IN_FLIGHT,
  INCLUDE_MEMBER_REFUSE_AT,
  IncludeInFlightError,
  MAX_E2EE_GROUP_MEMBERS,
  MAX_ENVELOPES_PER_REQUEST,
  TERMINAL_INCLUDE_ERROR_TYPES,
  activeDeviceCount,
  claimIncludeFlight,
  classifyBundleFetchError,
  classifyIncludeBundle,
  groupStateIncludable,
  hasIdentityChanged,
  includeActiveCount,
  includeCountedMembers,
  includeEnvelopeEstimate,
  includeOverEnvelopeCap,
  includeOverMemberCap,
  isIncludeInFlightError,
  isTerminalIncludeError,
  newMemberUndelivered,
} from "./groupInclude.ts";

const NEW = "01NEWMEMBER";

/** `n` active rows, the first one standing in for self. */
function roster(n: number, status = "active") {
  return Array.from({ length: n }, (_, i) => ({
    user_id: i === 0 ? "01SELF" : `01MEMBER${i}`,
    status,
  }));
}

describe("constants mirror native", () => {
  test("member cap", () => {
    assert.equal(MAX_E2EE_GROUP_MEMBERS, 24);
    assert.equal(INCLUDE_MEMBER_REFUSE_AT, 23);
  });

  test("envelope cap", () => {
    assert.equal(MAX_ENVELOPES_PER_REQUEST, 128);
    assert.equal(INCLUDE_ENVELOPE_LIMIT, 127);
  });
});

describe("groupStateIncludable", () => {
  const encrypted = {
    encrypted_since: 1_700_000_000,
    downgraded_at: null,
    peer_downgraded_by: null,
    pending_downgrade: false,
  };

  test("an established encrypted group is includable", () => {
    assert.equal(groupStateIncludable(encrypted), true);
  });

  test("encrypted_since 0 is still encrypted", () => {
    assert.equal(
      groupStateIncludable({ ...encrypted, encrypted_since: 0 }),
      true,
    );
  });

  test("never encrypted", () => {
    assert.equal(
      groupStateIncludable({ ...encrypted, encrypted_since: null }),
      false,
    );
  });

  test("own downgrade", () => {
    assert.equal(
      groupStateIncludable({ ...encrypted, downgraded_at: 1_700_000_100 }),
      false,
    );
  });

  test("peer downgrade awaiting confirmation", () => {
    assert.equal(
      groupStateIncludable({ ...encrypted, peer_downgraded_by: "01PEER" }),
      false,
    );
  });

  test("own downgrade awaiting delivery", () => {
    assert.equal(
      groupStateIncludable({ ...encrypted, pending_downgrade: true }),
      false,
    );
  });
});

describe("member cap", () => {
  test("22 active (self included) still fits", () => {
    assert.equal(includeActiveCount(roster(22), NEW), 22);
    assert.equal(includeOverMemberCap(roster(22), NEW), false);
  });

  test("23 active refuses: a Retry would hit native's active + 1 > 24", () => {
    assert.equal(includeOverMemberCap(roster(23), NEW), true);
  });

  test("24 active refuses", () => {
    assert.equal(includeOverMemberCap(roster(24), NEW), true);
  });

  test("a Retry does not count the already-active new member", () => {
    const members = [...roster(22), { user_id: NEW, status: "active" }];
    assert.equal(includeActiveCount(members, NEW), 22);
    assert.equal(includeOverMemberCap(members, NEW), false);
  });

  test("announced and removed rows are not counted", () => {
    const members = [
      ...roster(22),
      ...roster(5, "announced").map((m) => ({
        ...m,
        user_id: `A${m.user_id}`,
      })),
      ...roster(5, "removed").map((m) => ({
        ...m,
        user_id: `R${m.user_id}`,
      })),
    ];
    assert.equal(includeActiveCount(members, NEW), 22);
    assert.equal(includeOverMemberCap(members, NEW), false);
  });

  test("the counted members are the active ones except the new member", () => {
    const members = [
      { user_id: "01SELF", status: "active" },
      { user_id: NEW, status: "active" },
      { user_id: "01GONE", status: "removed" },
      { user_id: "01SEEN", status: "announced" },
      { user_id: "01PEER", status: "active" },
    ];
    assert.deepEqual(includeCountedMembers(members, NEW), ["01SELF", "01PEER"]);
  });

  test("an empty roster fits", () => {
    assert.equal(includeOverMemberCap([], NEW), false);
  });
});

describe("device states", () => {
  test("only active devices count", () => {
    assert.equal(
      activeDeviceCount([
        { status: "active" },
        { status: "active" },
        { status: "revoked" },
        { status: "identity_changed" },
      ]),
      2,
    );
    assert.equal(activeDeviceCount([]), 0);
  });

  test("identity_changed is detected", () => {
    assert.equal(
      hasIdentityChanged([
        { status: "active" },
        { status: "identity_changed" },
      ]),
      true,
    );
  });

  test("active and revoked devices are not an identity change", () => {
    assert.equal(
      hasIdentityChanged([{ status: "active" }, { status: "revoked" }]),
      false,
    );
    assert.equal(hasIdentityChanged([]), false);
  });
});

describe("envelope estimate", () => {
  test("sums every member's devices and the new bundle's", () => {
    assert.equal(includeEnvelopeEstimate([3, 4, 5], 2), 14);
    assert.equal(includeEnvelopeEstimate([], 2), 2);
    assert.equal(includeEnvelopeEstimate([], 0), 0);
  });

  test("127 fits", () => {
    const estimate = includeEnvelopeEstimate([60, 60], 7);
    assert.equal(estimate, 127);
    assert.equal(includeOverEnvelopeCap(estimate), false);
  });

  test("128 refuses", () => {
    const estimate = includeEnvelopeEstimate([60, 60], 8);
    assert.equal(estimate, 128);
    assert.equal(includeOverEnvelopeCap(estimate), true);
  });

  test("126 fits and 200 refuses", () => {
    assert.equal(includeOverEnvelopeCap(126), false);
    assert.equal(includeOverEnvelopeCap(200), true);
  });
});

describe("classifyIncludeBundle", () => {
  test("a bundle with devices for this user is ok", () => {
    assert.equal(
      classifyIncludeBundle({ user_id: NEW, devices: [{}] }, NEW),
      "ok",
    );
  });

  test("no devices means no keys", () => {
    assert.equal(
      classifyIncludeBundle({ user_id: NEW, devices: [] }, NEW),
      "no_keys",
    );
  });

  test("a bundle for another user is unavailable", () => {
    assert.equal(
      classifyIncludeBundle({ user_id: "01SOMEONE", devices: [{}] }, NEW),
      "unavailable",
    );
  });

  test("malformed bundles are unavailable", () => {
    assert.equal(classifyIncludeBundle(null, NEW), "unavailable");
    assert.equal(classifyIncludeBundle(undefined, NEW), "unavailable");
    assert.equal(classifyIncludeBundle("bundle", NEW), "unavailable");
    assert.equal(classifyIncludeBundle({ user_id: NEW }, NEW), "unavailable");
    assert.equal(
      classifyIncludeBundle({ user_id: NEW, devices: {} }, NEW),
      "unavailable",
    );
  });
});

describe("classifyBundleFetchError", () => {
  test("a 404 means no keys", () => {
    assert.equal(
      classifyBundleFetchError(
        new Error(`E2EE API GET /e2ee/keys/${NEW} failed: 404`),
      ),
      "no_keys",
    );
  });

  test("other statuses are unavailable", () => {
    for (const status of [400, 403, 4040, 500, 503]) {
      assert.equal(
        classifyBundleFetchError(
          new Error(`E2EE API GET /e2ee/keys/${NEW} failed: ${status}`),
        ),
        "unavailable",
      );
    }
  });

  test("non-HTTP failures are unavailable", () => {
    assert.equal(
      classifyBundleFetchError(new TypeError("offline")),
      "unavailable",
    );
    assert.equal(classifyBundleFetchError(null), "unavailable");
    assert.equal(classifyBundleFetchError("failed: 404"), "unavailable");
    assert.equal(classifyBundleFetchError({ message: 404 }), "unavailable");
  });

  test("a throwing getter is unavailable, never a throw", () => {
    const hostile = {
      get message(): string {
        throw new Error("boom");
      },
    };
    assert.equal(classifyBundleFetchError(hostile), "unavailable");
  });
});

describe("isTerminalIncludeError", () => {
  test("exactly the three native terminal types", () => {
    assert.deepEqual([...TERMINAL_INCLUDE_ERROR_TYPES].sort(), [
      "fan_out_too_large",
      "no_usable_devices",
      "peer_identity_changed",
    ]);
  });

  test("each native terminal type is terminal", () => {
    for (const type of TERMINAL_INCLUDE_ERROR_TYPES) {
      assert.equal(isTerminalIncludeError({ type, user_id: NEW }), true, type);
    }
  });

  test("a wrapped error keeping the native type is terminal", () => {
    const wrapped = Object.assign(new Error("too large"), {
      type: "fan_out_too_large",
    });
    assert.equal(isTerminalIncludeError(wrapped), true);
  });

  test("retryable native types are not terminal", () => {
    for (const type of [
      "needs_bundle",
      "group_not_established",
      "peer_has_no_devices",
      "peer_downgraded",
      "not_published",
      "storage",
      "FAN_OUT_TOO_LARGE",
      "FanOutTooLarge",
      "fan_out_too_large ",
    ]) {
      assert.equal(isTerminalIncludeError({ type }), false, type);
    }
  });

  test("errors without a native type are not terminal", () => {
    assert.equal(isTerminalIncludeError(new Error("POST failed: 500")), false);
    assert.equal(isTerminalIncludeError(null), false);
    assert.equal(isTerminalIncludeError(undefined), false);
    assert.equal(isTerminalIncludeError("fan_out_too_large"), false);
    assert.equal(isTerminalIncludeError({ type: 1 }), false);
  });

  test("a throwing getter is not terminal, never a throw", () => {
    const hostile = {
      get type(): string {
        throw new Error("boom");
      },
    };
    assert.equal(isTerminalIncludeError(hostile), false);
  });
});

describe("newMemberUndelivered", () => {
  const queued = (user: string, id = "01ENV") => ({
    recipient_user_id: user,
    recipient_device_id: "dev",
    status: "Queued",
    id,
  });
  const unknown = (user: string) => ({
    recipient_user_id: user,
    recipient_device_id: "dev",
    status: "UnknownDevice",
  });
  const full = (user: string) => ({
    recipient_user_id: user,
    recipient_device_id: "dev",
    status: "QueueFull",
  });

  test("every receipt for the new member is UnknownDevice", () => {
    assert.equal(
      newMemberUndelivered(
        [unknown(NEW), unknown(NEW), queued("01MEMBER1")],
        NEW,
      ),
      true,
    );
  });

  test("one queued device of the new member is delivered", () => {
    assert.equal(newMemberUndelivered([unknown(NEW), queued(NEW)], NEW), false);
  });

  test("other members' UnknownDevice receipts do not count", () => {
    assert.equal(
      newMemberUndelivered([queued(NEW), unknown("01MEMBER1")], NEW),
      false,
    );
  });

  test("every receipt for the new member is QueueFull", () => {
    assert.equal(
      newMemberUndelivered([full(NEW), full(NEW), queued("01MEMBER1")], NEW),
      true,
    );
  });

  test("QueueFull and UnknownDevice alone are undelivered", () => {
    assert.equal(newMemberUndelivered([full(NEW), unknown(NEW)], NEW), true);
  });

  test("one Queued and one QueueFull device is delivered", () => {
    assert.equal(newMemberUndelivered([full(NEW), queued(NEW)], NEW), false);
  });

  test("another member's Queued receipt does not count", () => {
    assert.equal(
      newMemberUndelivered([full(NEW), queued("01MEMBER1")], NEW),
      true,
    );
  });

  test("only the exact Queued status counts", () => {
    for (const status of ["queued", "QUEUED", "Queued ", undefined]) {
      assert.equal(
        newMemberUndelivered([{ recipient_user_id: NEW, status }], NEW),
        true,
        String(status),
      );
    }
  });

  test("no receipt addressed to the new member is undelivered", () => {
    assert.equal(newMemberUndelivered([queued("01MEMBER1")], NEW), true);
    assert.equal(newMemberUndelivered([], NEW), true);
  });

  test("receipts that are not an array are undelivered", () => {
    assert.equal(newMemberUndelivered(undefined, NEW), true);
    assert.equal(newMemberUndelivered(null, NEW), true);
    assert.equal(newMemberUndelivered({ receipts: [] }, NEW), true);
  });

  test("null entries are skipped, not thrown on", () => {
    assert.equal(newMemberUndelivered([null, queued(NEW)], NEW), false);
    assert.equal(newMemberUndelivered([null, unknown(NEW)], NEW), true);
  });
});

describe("IncludeInFlightError", () => {
  test("is an Error carrying its own tag, never a native one", () => {
    const error = new IncludeInFlightError();
    assert.ok(error instanceof Error);
    assert.equal(error.name, "IncludeInFlightError");
    assert.equal(error.type, INCLUDE_IN_FLIGHT);
    assert.equal(
      TERMINAL_INCLUDE_ERROR_TYPES.includes(INCLUDE_IN_FLIGHT),
      false,
    );
  });

  test("is not terminal: the running include decides the outcome", () => {
    assert.equal(isTerminalIncludeError(new IncludeInFlightError()), false);
    assert.equal(isTerminalIncludeError({ type: INCLUDE_IN_FLIGHT }), false);
  });

  test("is recognized by instance or by tag, and nothing else is", () => {
    assert.equal(isIncludeInFlightError(new IncludeInFlightError()), true);
    assert.equal(isIncludeInFlightError({ type: INCLUDE_IN_FLIGHT }), true);
    assert.equal(isIncludeInFlightError({ type: "fan_out_too_large" }), false);
    assert.equal(isIncludeInFlightError(new Error("in flight")), false);
    assert.equal(isIncludeInFlightError(null), false);
    assert.equal(isIncludeInFlightError(undefined), false);
    assert.equal(isIncludeInFlightError(INCLUDE_IN_FLIGHT), false);
    const hostile = {
      get type(): string {
        throw new Error("boom");
      },
    };
    assert.equal(isIncludeInFlightError(hostile), false);
  });
});

describe("claimIncludeFlight", () => {
  const GROUP = "01GROUP";

  test("a second claim on the same pair throws at once", () => {
    const inFlight = new Set<string>();
    claimIncludeFlight(inFlight, GROUP, NEW);
    assert.throws(
      () => claimIncludeFlight(inFlight, GROUP, NEW),
      (error) =>
        isIncludeInFlightError(error) && !isTerminalIncludeError(error),
    );
  });

  test("other members and other groups are independent", () => {
    const inFlight = new Set<string>();
    claimIncludeFlight(inFlight, GROUP, NEW);
    assert.doesNotThrow(() => claimIncludeFlight(inFlight, GROUP, "01OTHER"));
    assert.doesNotThrow(() => claimIncludeFlight(inFlight, "01GROUP2", NEW));
  });

  test("release frees the pair for the next claim", () => {
    const inFlight = new Set<string>();
    claimIncludeFlight(inFlight, GROUP, NEW)();
    assert.equal(inFlight.size, 0);
    assert.doesNotThrow(() => claimIncludeFlight(inFlight, GROUP, NEW));
  });

  test("a repeat release never frees a later claim", () => {
    const inFlight = new Set<string>();
    const first = claimIncludeFlight(inFlight, GROUP, NEW);
    first();
    claimIncludeFlight(inFlight, GROUP, NEW);
    first();
    assert.throws(
      () => claimIncludeFlight(inFlight, GROUP, NEW),
      IncludeInFlightError,
    );
  });

  // The shape addGroupMemberEncrypted uses: claim before the first await,
  // then try/finally around everything else.
  async function include(
    inFlight: Set<string>,
    work: () => Promise<void>,
    log: string[],
  ): Promise<void> {
    const release = claimIncludeFlight(inFlight, GROUP, NEW);
    try {
      log.push("work");
      await work();
    } finally {
      release();
    }
  }

  test("a concurrent second include rejects without starting work", async () => {
    const inFlight = new Set<string>();
    const log: string[] = [];
    let finish!: () => void;
    const first = include(
      inFlight,
      () => new Promise<void>((resolve) => (finish = resolve)),
      log,
    );
    await assert.rejects(
      include(inFlight, async () => {}, log),
      IncludeInFlightError,
    );
    assert.deepEqual(log, ["work"]);
    finish();
    await first;
    assert.equal(inFlight.size, 0);
  });

  test("released after a success, a throw and a terminal failure", async () => {
    const terminal = Object.assign(new Error("too large"), {
      type: "fan_out_too_large",
    });
    for (const work of [
      async () => {},
      async () => {
        throw new Error("POST failed: 500");
      },
      async () => {
        throw terminal;
      },
    ]) {
      const inFlight = new Set<string>();
      await include(inFlight, work, []).catch(() => {});
      assert.equal(inFlight.size, 0);
      assert.doesNotThrow(() => claimIncludeFlight(inFlight, GROUP, NEW));
    }
  });
});

describe("addGroupMemberEncrypted single-flight (e2ee.ts source)", () => {
  const SOURCE = readFileSync(
    process.env.GROUP_INCLUDE_E2EE_PATH ??
      new URL("./e2ee.ts", import.meta.url),
    "utf8",
  );

  /**
   * Blank comments (both views) and literal text (`skel` only) to spaces,
   * keeping offsets: the masking groupIncludeOrder.test.ts uses, so prose
   * cannot satisfy a check and a brace in a string cannot end a block.
   */
  function mask(src: string): { code: string; skel: string } {
    const code = src.split("");
    const skel = src.split("");
    const blank = (view: string[], at: number) => {
      if (at < view.length && view[at] !== "\n") view[at] = " ";
    };
    const templates: number[] = [];
    let i = 0;
    while (i < src.length) {
      const c = src[i];
      const top = templates.length ? templates[templates.length - 1] : null;
      if (top === -1) {
        if (c === "`") {
          templates.pop();
        } else if (c === "$" && src[i + 1] === "{") {
          templates[templates.length - 1] = 0;
          i++;
        } else {
          if (c === "\\") blank(skel, i++);
          blank(skel, i);
        }
        i++;
      } else if (c === "/" && src[i + 1] === "/") {
        for (; i < src.length && src[i] !== "\n"; i++) {
          blank(code, i);
          blank(skel, i);
        }
      } else if (c === "/" && src[i + 1] === "*") {
        const end = src.indexOf("*/", i + 2);
        const stop = end < 0 ? src.length : end + 2;
        for (; i < stop; i++) {
          blank(code, i);
          blank(skel, i);
        }
      } else if (c === '"' || c === "'") {
        for (i++; i < src.length && src[i] !== c && src[i] !== "\n"; i++) {
          if (src[i] === "\\") blank(skel, i++);
          blank(skel, i);
        }
        i++;
      } else {
        if (c === "`") templates.push(-1);
        else if (top !== null && c === "{") {
          templates[templates.length - 1] = top + 1;
        } else if (top !== null && c === "}") {
          templates[templates.length - 1] = top === 0 ? -1 : top - 1;
        }
        i++;
      }
    }
    return { code: code.join(""), skel: skel.join("") };
  }

  /** Offset of the bracket closing the one at `open` (masked view only). */
  function closeOf(skel: string, open: number): number {
    const opener = skel[open];
    const closer = opener === "(" ? ")" : opener === "{" ? "}" : undefined;
    assert.ok(closer, `no bracket at offset ${open}`);
    let depth = 0;
    for (let i = open; i < skel.length; i++) {
      if (skel[i] === opener) depth++;
      else if (skel[i] === closer && --depth === 0) return i;
    }
    assert.fail(`unbalanced "${opener}" at offset ${open}`);
  }

  /** The method body, from its opening brace to its closing one. */
  function body(): { code: string; skel: string } {
    const decl = /^[ \t]*async\s+addGroupMemberEncrypted\s*\(/gm;
    const hits = [...SOURCE.matchAll(decl)];
    assert.equal(hits.length, 1, "one addGroupMemberEncrypted declaration");
    const { code, skel } = mask(SOURCE.slice(hits[0].index));
    const open = skel.indexOf("{", closeOf(skel, skel.indexOf("(")));
    assert.ok(open > 0, "addGroupMemberEncrypted has a body");
    const close = closeOf(skel, open);
    return {
      code: code.slice(open, close + 1),
      skel: skel.slice(open, close + 1),
    };
  }

  const CLAIM = new RegExp(
    String.raw`\bconst\s+(\w+)\s*=\s*claimIncludeFlight\s*\(\s*` +
      String.raw`this\.#(\w+)\s*,\s*(conversationId|channel\.id)\s*,\s*` +
      String.raw`userId\s*,?\s*\)\s*;`,
    "g",
  );

  /** The one claim statement in the method, and what it names. */
  function claim() {
    const m = body();
    const hits = [...m.code.matchAll(CLAIM)];
    assert.equal(hits.length, 1, "one claimIncludeFlight on a class field");
    const [statement, release, field, key] = hits[0];
    const at = hits[0].index;
    return { m, at, end: at + statement.length, release, field, key };
  }

  test("claims on one per-instance set, keyed by group and member", () => {
    const { m, field, key } = claim();
    const decl = new RegExp(
      String.raw`^[ \t]*#${field}\s*=\s*new\s+Set\s*<\s*string\s*>\s*\(\s*\)\s*;`,
      "gm",
    );
    assert.equal(
      [...mask(SOURCE).code.matchAll(decl)].length,
      1,
      `#${field} is declared once, as a Set`,
    );
    assert.doesNotMatch(
      mask(SOURCE).code,
      new RegExp(String.raw`\bthis\.#${field}\s*=[^=]`),
      `#${field} is never reassigned`,
    );
    if (key === "conversationId") {
      assert.match(m.code, /\bconst\s+conversationId\s*=\s*channel\.id\s*;/);
    }
  });

  test("the claim comes before any await, native call or API call", () => {
    const { m, at } = claim();
    assert.doesNotMatch(m.skel.slice(0, at), /\bawait\b|\byield\b|\.then\s*\(/);
    assert.doesNotMatch(m.code.slice(0, at), /\bthis\.#(?:invoke|api)\b/);
    assert.doesNotMatch(m.code.slice(0, at), /"e2ee_group_reconcile"/);
  });

  test("everything after the claim runs in a try whose finally releases", () => {
    const { m, end, release } = claim();
    const tryHead = /^\s*try\s*\{/.exec(m.skel.slice(end));
    assert.ok(tryHead, "a try block opens right after the claim");
    const tryClose = closeOf(m.skel, end + tryHead[0].length - 1);
    const fin = /^\s*finally\s*\{/.exec(m.skel.slice(tryClose + 1));
    assert.ok(fin, "the try is followed directly by a finally");
    const finOpen = tryClose + fin[0].length;
    const finClose = closeOf(m.skel, finOpen);
    assert.match(
      m.code.slice(finOpen + 1, finClose),
      new RegExp(String.raw`^\s*${release}\s*\(\s*\)\s*;?\s*$`),
      "the finally runs the release and nothing else",
    );
    assert.match(
      m.skel.slice(finClose + 1),
      /^\s*\}$/,
      "nothing follows the try/finally in the method",
    );
    assert.equal(
      [...m.code.matchAll(new RegExp(String.raw`\b${release}\b`, "g"))].length,
      2,
      "the release is declared once and used only in the finally",
    );
  });
});
