// Unit spec for the Encrypted-only write policy. Run with Node's built-in
// runner from packages/client:
//   node --test --conditions=browser components/client/encryptedOnlyPolicy.test.ts
// Declared test count: 17 (the runner also exits 0 when it finds no tests at
// all, so compare this against its pass count).
//
// Focus: the whole input space (3456 combinations) against an expectation
// written separately from the module, as a lookup and not as the module's
// chain of ifs; named cases with literal expectations; how many inputs get
// each decision; the advert decides nothing; the reasons; every kind other
// than a send is refused wherever an unencrypted send would be; and the
// group cap is 24 here and in groupInclude.ts.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type Advert,
  type BlockReason,
  type ChannelKind,
  type Decision,
  type DeviceState,
  type PeerFlag,
  type PlainWriteInput,
  decideForKind,
  decidePlainWrite,
  E2EE_GROUP_MAX,
  guardReason,
  NON_SEND_KINDS,
  reasonFor,
} from "./encryptedOnlyPolicy.ts";
import {
  INCLUDE_MEMBER_REFUSE_AT,
  MAX_E2EE_GROUP_MEMBERS,
} from "./groupInclude.ts";

const CHANNELS: ChannelKind[] = ["dm", "group", "saved", "server"];
const PEER_FLAGS: PeerFlag[] = ["on", "off", "absent"];
const DEVICES: DeviceState[] = ["ready", "not-set-up", "web"];
const ADVERTS: Advert[] = ["absent", "enforced", "not-enforced"];
const BOOLS = [false, true];

/** Every combination of the nine inputs. */
function everyInput(): PlainWriteInput[] {
  const out: PlainWriteInput[] = [];
  for (const latched of BOOLS)
    for (const channel of CHANNELS)
      for (const peerFlag of PEER_FLAGS)
        for (const peerRemembered of BOOLS)
          for (const groupMarked of BOOLS)
            for (const groupRemembered of BOOLS)
              for (const device of DEVICES)
                for (const encrypted of BOOLS)
                  for (const advert of ADVERTS)
                    out.push({
                      latched,
                      channel,
                      peerFlag,
                      peerRemembered,
                      groupMarked,
                      groupRemembered,
                      device,
                      encrypted,
                      advert,
                    });
  return out;
}

const ALL = everyInput();

/** An ordinary account in the app, writing to an ordinary peer. */
const BASE: PlainWriteInput = {
  latched: false,
  channel: "dm",
  peerFlag: "absent",
  peerRemembered: false,
  groupMarked: false,
  groupRemembered: false,
  device: "ready",
  encrypted: false,
  advert: "enforced",
};

// The expectation, written out as lookups. Keys:
//   own side:  L latch on, - latch off
//   device:    R ready, N not set up, W website
//   verdict:   E the adapter says encrypted, P it says plain
//   peer:      on / off / absent, then + when remembered
//   group:     M marked, R remembered, - neither
const DEVICE_LETTER: Record<DeviceState, string> = {
  ready: "R",
  "not-set-up": "N",
  web: "W",
};

/** What this device can do about its own side, before the peer matters. */
const OWN_SIDE: Record<string, Decision | "ask-other-side"> = {
  // Latch on
  LRE: "send-encrypted",
  LRP: "ask-other-side",
  LNE: "block-setup",
  LNP: "block-setup",
  LWE: "block-open-app",
  LWP: "block-open-app",
  // Latch off
  "-RE": "send-encrypted",
  "-RP": "ask-other-side",
  "-NE": "ask-other-side",
  "-NP": "ask-other-side",
  "-WE": "ask-other-side",
  "-WP": "ask-other-side",
};

/** A direct message that goes out unencrypted, by latch and peer. */
const DM_PLAIN: Record<string, Decision> = {
  "L on": "block-peer",
  "L on+": "block-peer",
  "L off": "block-peer",
  "L off+": "block-peer",
  "L absent": "block-peer",
  "L absent+": "block-peer",
  "- on": "block-peer",
  "- on+": "block-peer",
  "- off": "allow-plain",
  "- off+": "confirm-peer-changed",
  "- absent": "allow-plain",
  "- absent+": "confirm-peer-changed",
};

/** A group message that goes out unencrypted, by latch and group. */
const GROUP_PLAIN: Record<string, Decision> = {
  "L M": "block-group",
  "L R": "block-group",
  "L MR": "block-group",
  "L -": "block-group",
  "- M": "block-group",
  "- R": "block-group",
  "- MR": "block-group",
  "- -": "allow-plain",
};

function expected(input: PlainWriteInput): Decision {
  if (input.channel === "saved" || input.channel === "server") {
    return "allow-plain";
  }

  const latch = input.latched ? "L" : "-";
  const own =
    OWN_SIDE[
      latch + DEVICE_LETTER[input.device] + (input.encrypted ? "E" : "P")
    ];
  assert.ok(own, "own side row");
  if (own !== "ask-other-side") return own;

  if (input.channel === "dm") {
    const row =
      DM_PLAIN[`${latch} ${input.peerFlag}${input.peerRemembered ? "+" : ""}`];
    assert.ok(row, "dm row");
    return row;
  }

  const group =
    (input.groupMarked ? "M" : "") + (input.groupRemembered ? "R" : "");
  const row = GROUP_PLAIN[`${latch} ${group || "-"}`];
  assert.ok(row, "group row");
  return row;
}

// ---------------------------------------------------------------------------
// The whole table
// ---------------------------------------------------------------------------

test("every one of the 3456 inputs gets the expected decision", () => {
  assert.equal(ALL.length, 3456);
  for (const input of ALL) {
    assert.equal(
      decidePlainWrite(input),
      expected(input),
      JSON.stringify(input),
    );
  }
});

test("how many inputs get each decision", () => {
  const counts: Record<string, number> = {};
  for (const input of ALL) {
    const decision = decidePlainWrite(input);
    counts[decision] = (counts[decision] ?? 0) + 1;
  }

  // Worked out by hand from the table, not from the module
  assert.deepEqual(counts, {
    "allow-plain": 1938,
    "send-encrypted": 288,
    "block-open-app": 288,
    "block-setup": 288,
    "block-peer": 192,
    "block-group": 342,
    "confirm-peer-changed": 120,
  });
});

// ---------------------------------------------------------------------------
// Named cases, each with the rule it pins
// ---------------------------------------------------------------------------

type Named = {
  name: string;
  input: Partial<PlainWriteInput>;
  decision: Decision;
  reason: BlockReason | null;
};

const NAMED: Named[] = [
  // Baseline: nobody asked for Encrypted-only, today's behaviour
  {
    name: "ordinary plain direct message",
    input: {},
    decision: "allow-plain",
    reason: null,
  },
  {
    name: "ordinary encrypted direct message",
    input: { encrypted: true },
    decision: "send-encrypted",
    reason: null,
  },
  // D4: Saved Notes are exempt, whatever else is on
  {
    name: "Saved Notes under the latch on the website",
    input: {
      latched: true,
      channel: "saved",
      device: "web",
      peerFlag: "on",
      peerRemembered: true,
      groupMarked: true,
      groupRemembered: true,
    },
    decision: "allow-plain",
    reason: null,
  },
  // Summary "Servers work as before"; S2 exempts every server channel
  {
    name: "server channel under the latch without encryption set up",
    input: {
      latched: true,
      channel: "server",
      device: "not-set-up",
      groupMarked: true,
    },
    decision: "allow-plain",
    reason: null,
  },
  // D2: an Encrypted-only account on the website
  {
    name: "latch on, website, direct message",
    input: { latched: true, device: "web" },
    decision: "block-open-app",
    reason: "open-app",
  },
  {
    name: "latch on, website, group",
    input: { latched: true, device: "web", channel: "group" },
    decision: "block-open-app",
    reason: "open-app",
  },
  // D2: the website cannot encrypt, so a claimed verdict changes nothing
  {
    name: "latch on, website, verdict claims encrypted",
    input: { latched: true, device: "web", encrypted: true },
    decision: "block-open-app",
    reason: "open-app",
  },
  // D11 / S4: an app where encryption is not set up (lost last device)
  {
    name: "latch on, encryption not set up, direct message",
    input: { latched: true, device: "not-set-up" },
    decision: "block-setup",
    reason: "setup",
  },
  {
    name: "latch on, encryption not set up, marked group",
    input: {
      latched: true,
      device: "not-set-up",
      channel: "group",
      groupMarked: true,
    },
    decision: "block-setup",
    reason: "setup",
  },
  // D1 / E3: strict mode, no plain fallback when the peer cannot encrypt
  {
    name: "latch on, ready, peer cannot encrypt",
    input: { latched: true },
    decision: "block-peer",
    reason: "sender",
  },
  // E3: the latch also outranks a peer who explicitly turned it off
  {
    name: "latch on, remembered peer now explicitly off",
    input: { latched: true, peerFlag: "off", peerRemembered: true },
    decision: "block-peer",
    reason: "sender",
  },
  // P3: sender before recipient when both are Encrypted-only
  {
    name: "latch on and peer flag on, not encrypted yet",
    input: { latched: true, peerFlag: "on" },
    decision: "block-peer",
    reason: "sender",
  },
  // S4: the conversation goes out encrypted
  {
    name: "latch on, encrypted direct message",
    input: { latched: true, encrypted: true, peerFlag: "on" },
    decision: "send-encrypted",
    reason: null,
  },
  // S1 / P3 "recipient": the peer only accepts encrypted messages
  {
    name: "latch off, peer flag on",
    input: { peerFlag: "on" },
    decision: "block-peer",
    reason: "recipient",
  },
  // S4: the same from the website, where the hint cannot help either
  {
    name: "latch off, website, peer flag on",
    input: { peerFlag: "on", device: "web" },
    decision: "block-peer",
    reason: "recipient",
  },
  {
    name: "latch off, peer flag on, encrypted",
    input: { peerFlag: "on", encrypted: true },
    decision: "send-encrypted",
    reason: null,
  },
  // E15: a missing field never lifts a remembered peer; the user confirms
  // one send
  {
    name: "latch off, remembered peer, flag absent",
    input: { peerRemembered: true, peerFlag: "absent" },
    decision: "confirm-peer-changed",
    reason: "peer-changed",
  },
  // E15 / D3: an explicit off asks the same way
  {
    name: "latch off, remembered peer, flag explicitly off",
    input: { peerRemembered: true, peerFlag: "off" },
    decision: "confirm-peer-changed",
    reason: "peer-changed",
  },
  // The confirmation needs no encryption, so the website gets it too
  {
    name: "latch off, website, remembered peer, flag absent",
    input: { peerRemembered: true, peerFlag: "absent", device: "web" },
    decision: "confirm-peer-changed",
    reason: "peer-changed",
  },
  // A remembered peer whose flag is still on is a plain recipient refusal
  {
    name: "latch off, remembered peer, flag on",
    input: { peerRemembered: true, peerFlag: "on" },
    decision: "block-peer",
    reason: "recipient",
  },
  // D3: chats that are already encrypted stay encrypted, nothing to confirm
  {
    name: "remembered peer explicitly off, conversation encrypted",
    input: { peerRemembered: true, peerFlag: "off", encrypted: true },
    decision: "send-encrypted",
    reason: null,
  },
  // E15: an explicit off for a peer never remembered is just a plain chat
  {
    name: "latch off, peer explicitly off, never remembered",
    input: { peerFlag: "off" },
    decision: "allow-plain",
    reason: null,
  },
  // D7 / S2: a marked group refuses plain writes from everyone
  {
    name: "latch off, marked group not encrypted for this device",
    input: { channel: "group", groupMarked: true },
    decision: "block-group",
    reason: "group",
  },
  // Residual risk 1: a marked group never established, on the website
  {
    name: "latch off, website, marked group",
    input: { channel: "group", groupMarked: true, device: "web" },
    decision: "block-group",
    reason: "group",
  },
  // E15 / E6: a remembered group holds without the mark
  {
    name: "latch off, remembered group, mark missing",
    input: { channel: "group", groupRemembered: true },
    decision: "block-group",
    reason: "group",
  },
  // P3: the group mark before the sender's own setting
  {
    name: "latch on, marked group not encrypted",
    input: { latched: true, channel: "group", groupMarked: true },
    decision: "block-group",
    reason: "group",
  },
  // D6: an existing unmarked plain group is read-only under the latch
  {
    name: "latch on, unmarked plain group",
    input: { latched: true, channel: "group" },
    decision: "block-group",
    reason: "sender",
  },
  {
    name: "latch on, encrypted group",
    input: { latched: true, channel: "group", encrypted: true },
    decision: "send-encrypted",
    reason: null,
  },
  {
    name: "marked group, encrypted for this device",
    input: { channel: "group", groupMarked: true, encrypted: true },
    decision: "send-encrypted",
    reason: null,
  },
  // Today's behaviour: an ordinary plain group, peer fields do not leak in
  {
    name: "ordinary plain group, peer fields set",
    input: { channel: "group", peerFlag: "on", peerRemembered: true },
    decision: "allow-plain",
    reason: null,
  },
  // The reverse: group fields do not leak into a direct message
  {
    name: "ordinary direct message, group fields set",
    input: { groupMarked: true, groupRemembered: true },
    decision: "allow-plain",
    reason: null,
  },
  // S4: no advert, latch already set, still enforced
  {
    name: "latch on, advert absent",
    input: { latched: true, advert: "absent" },
    decision: "block-peer",
    reason: "sender",
  },
  // Residual risk 4: enforcement switched off, the app still refuses
  {
    name: "latch on, enforcement off",
    input: { latched: true, advert: "not-enforced" },
    decision: "block-peer",
    reason: "sender",
  },
  // E2: the peer's wish holds without the server's enforcement too
  {
    name: "latch off, peer flag on, enforcement off",
    input: { peerFlag: "on", advert: "not-enforced" },
    decision: "block-peer",
    reason: "recipient",
  },
  // A device without encryption and no latch keeps today's plain chat
  {
    name: "latch off, encryption not set up, ordinary peer",
    input: { device: "not-set-up" },
    decision: "allow-plain",
    reason: null,
  },
];

test("the named cases", () => {
  assert.equal(NAMED.length, 35);
  for (const row of NAMED) {
    const input = { ...BASE, ...row.input };
    const decision = decidePlainWrite(input);
    assert.equal(decision, row.decision, row.name);
    assert.equal(reasonFor(decision, input), row.reason, row.name);
  }
});

// ---------------------------------------------------------------------------
// Properties over the whole table
// ---------------------------------------------------------------------------

// D4 and "servers work as before"
test("Saved Notes and server channels are always allow-plain", () => {
  const exempt = ALL.filter(
    (input) => input.channel === "saved" || input.channel === "server",
  );
  assert.equal(exempt.length, 1728);
  for (const input of exempt) {
    assert.equal(decidePlainWrite(input), "allow-plain", JSON.stringify(input));
    for (const kind of NON_SEND_KINDS) {
      assert.equal(decideForKind(kind, input), "allow-plain");
      assert.equal(guardReason(kind, input), null);
    }
  }
});

// E3: under the latch nothing in a direct message or group goes out plain
test("under the latch a direct message or group is never allow-plain or a confirmation", () => {
  const latched = ALL.filter(
    (input) =>
      input.latched && (input.channel === "dm" || input.channel === "group"),
  );
  assert.equal(latched.length, 864);
  for (const input of latched) {
    const decision = decidePlainWrite(input);
    assert.notEqual(decision, "allow-plain", JSON.stringify(input));
    assert.notEqual(decision, "confirm-peer-changed", JSON.stringify(input));
  }
});

// S4: an absent advert, or enforcement off, never lifts anything
test("the advert never changes a decision or a reason", () => {
  for (const input of ALL) {
    if (input.advert !== "enforced") continue;
    const decision = decidePlainWrite(input);
    for (const advert of ADVERTS) {
      const other = { ...input, advert };
      assert.equal(decidePlainWrite(other), decision, JSON.stringify(other));
      assert.equal(reasonFor(decision, other), reasonFor(decision, input));
      assert.equal(guardReason("send", other), guardReason("send", input));
    }
  }
});

// D2: only a ready device ever sends encrypted
test("send-encrypted needs a ready device and the adapter's verdict", () => {
  for (const input of ALL) {
    if (decidePlainWrite(input) !== "send-encrypted") continue;
    assert.equal(input.device, "ready");
    assert.equal(input.encrypted, true);
  }
});

// E15: the confirmation exists for exactly one situation
test("confirm-peer-changed is only a remembered peer whose flag is no longer on", () => {
  let seen = 0;
  for (const input of ALL) {
    const confirm = decidePlainWrite(input) === "confirm-peer-changed";
    const situation =
      input.channel === "dm" &&
      !input.latched &&
      input.peerRemembered &&
      input.peerFlag !== "on" &&
      !(input.encrypted && input.device === "ready");
    assert.equal(confirm, situation, JSON.stringify(input));
    if (confirm) seen += 1;
  }
  assert.equal(seen, 120);
});

test("an unknown channel or device is held to the strict side", () => {
  const odd = { ...BASE, latched: true, channel: "thread" as ChannelKind };
  assert.equal(decidePlainWrite(odd), "block-peer");

  const device = { ...BASE, latched: true, device: "tablet" as DeviceState };
  assert.equal(decidePlainWrite(device), "block-setup");
  assert.equal(decidePlainWrite({ ...device, encrypted: true }), "block-setup");
});

// ---------------------------------------------------------------------------
// Reasons
// ---------------------------------------------------------------------------

// P8: the reasons the blocked error carries
test("every blocking decision has a reason and the others have none", () => {
  const byDecision: Record<string, Set<string>> = {};
  for (const input of ALL) {
    const decision = decidePlainWrite(input);
    const reason = reasonFor(decision, input);
    (byDecision[decision] ??= new Set()).add(String(reason));
  }

  const sorted = (decision: Decision) => [...byDecision[decision]].sort();
  assert.deepEqual(sorted("allow-plain"), ["null"]);
  assert.deepEqual(sorted("send-encrypted"), ["null"]);
  assert.deepEqual(sorted("block-setup"), ["setup"]);
  assert.deepEqual(sorted("block-open-app"), ["open-app"]);
  assert.deepEqual(sorted("block-peer"), ["recipient", "sender"]);
  assert.deepEqual(sorted("block-group"), ["group", "sender"]);
  assert.deepEqual(sorted("confirm-peer-changed"), ["peer-changed"]);
});

// P3: the same order the server refuses in
test("block reasons follow the server's order", () => {
  for (const input of ALL) {
    const decision = decidePlainWrite(input);
    const reason = reasonFor(decision, input);
    if (decision === "block-peer") {
      assert.equal(reason, input.latched ? "sender" : "recipient");
    }
    if (decision === "block-group") {
      assert.equal(
        reason,
        input.groupMarked || input.groupRemembered ? "group" : "sender",
      );
    }
    if (decision === "confirm-peer-changed") {
      assert.equal(reason, "peer-changed");
    }
  }
});

// D-a: a changed peer is never reported as a recipient refusal, whatever the
// kind of write
test("a changed peer is refused with peer-changed for every kind, never recipient", () => {
  let seen = 0;
  for (const input of ALL) {
    const changed =
      input.channel === "dm" &&
      !input.latched &&
      input.peerRemembered &&
      input.peerFlag !== "on";
    for (const kind of ["send", ...NON_SEND_KINDS] as const) {
      const reason = guardReason(kind, input);
      const where = `${kind} ${JSON.stringify(input)}`;
      if (changed) {
        assert.equal(reason, "peer-changed", where);
        seen += 1;
      } else {
        assert.notEqual(reason, "peer-changed", where);
      }
    }
  }
  // 144 such inputs (the verdict ignored), times eleven kinds
  assert.equal(seen, 144 * 11);
});

// ---------------------------------------------------------------------------
// Kinds other than a send
// ---------------------------------------------------------------------------

// P8: the kinds of the plain write guard
test("the kinds other than send are the ten pinned ones", () => {
  assert.deepEqual([...NON_SEND_KINDS].sort(), [
    "captions",
    "edit",
    "forward",
    "interaction",
    "poll",
    "roll",
    "schedule",
    "softres",
    "upload",
    "watch",
  ]);
});

// D17, D18, E3: no encrypted form, so refused wherever a plain send would be
test("a kind other than send is allowed exactly where a plain send is", () => {
  for (const input of ALL) {
    const plainSend = decidePlainWrite({ ...input, encrypted: false });
    for (const kind of NON_SEND_KINDS) {
      const decision = decideForKind(kind, input);
      const where = `${kind} ${JSON.stringify(input)}`;

      assert.equal(
        decision === "allow-plain",
        plainSend === "allow-plain",
        where,
      );
      assert.notEqual(decision, "send-encrypted", where);
      assert.notEqual(decision, "confirm-peer-changed", where);
      assert.equal(
        guardReason(kind, input) === null,
        plainSend === "allow-plain",
        where,
      );
    }
  }
});

test("named cases for kinds other than send", () => {
  // D18: under the latch an old unencrypted message can no longer be edited,
  // even when the conversation is encrypted now
  const latchedEncrypted = { ...BASE, latched: true, encrypted: true };
  assert.equal(decidePlainWrite(latchedEncrypted), "send-encrypted");
  assert.equal(decideForKind("edit", latchedEncrypted), "block-peer");
  assert.equal(guardReason("edit", latchedEncrypted), "sender");

  // D17: captions and watch links in an Encrypted-only account's group call
  const latchedGroup = { ...latchedEncrypted, channel: "group" as const };
  assert.equal(decideForKind("captions", latchedGroup), "block-group");
  assert.equal(guardReason("watch", latchedGroup), "sender");

  // E11: no plain upload towards a peer who only accepts encrypted messages
  const toPeer = { ...BASE, peerFlag: "on" as const, encrypted: true };
  assert.equal(decideForKind("upload", toPeer), "block-peer");
  assert.equal(guardReason("upload", toPeer), "recipient");

  // S2: a marked group takes no poll, roll or interaction
  const marked = { ...BASE, channel: "group" as const, groupMarked: true };
  for (const kind of ["poll", "roll", "interaction", "softres"] as const) {
    assert.equal(decideForKind(kind, marked), "block-group", kind);
    assert.equal(guardReason(kind, marked), "group", kind);
  }

  // E15: nothing but a send can ask for the confirmation, and the reason
  // stays peer-changed
  const changed = { ...BASE, peerRemembered: true, peerFlag: "off" as const };
  assert.equal(decideForKind("send", changed), "confirm-peer-changed");
  assert.equal(decideForKind("forward", changed), "block-peer");
  assert.equal(reasonFor("block-peer", changed), "peer-changed");
  assert.equal(guardReason("schedule", changed), "peer-changed");
  const absent = { ...changed, peerFlag: "absent" as const };
  assert.equal(decideForKind("edit", absent), "block-peer");
  assert.equal(guardReason("edit", absent), "peer-changed");

  // D17 applies to Encrypted-only conversations only: an ordinary encrypted
  // chat keeps its plain extras
  const ordinary = { ...BASE, encrypted: true };
  assert.equal(decidePlainWrite(ordinary), "send-encrypted");
  for (const kind of NON_SEND_KINDS) {
    assert.equal(decideForKind(kind, ordinary), "allow-plain", kind);
    assert.equal(guardReason(kind, ordinary), null, kind);
  }

  // D4: Saved Notes take every kind
  const saved = { ...BASE, latched: true, channel: "saved" as const };
  for (const kind of NON_SEND_KINDS) {
    assert.equal(guardReason(kind, saved), null, kind);
  }
});

// The guard runs only for a write that is about to go out unencrypted
test("the guard refuses an unencrypted send whatever the verdict said", () => {
  for (const input of ALL) {
    const plain = { ...input, encrypted: false };
    const decision = decidePlainWrite(plain);
    const reason = guardReason("send", input);

    assert.equal(reason, reasonFor(decision, plain), JSON.stringify(input));
    assert.equal(reason === null, decision === "allow-plain");
  }

  // A send still waiting for the confirmation is refused
  assert.equal(
    guardReason("send", { ...BASE, peerRemembered: true, peerFlag: "off" }),
    "peer-changed",
  );
  assert.equal(
    guardReason("send", { ...BASE, peerRemembered: true, peerFlag: "absent" }),
    "peer-changed",
  );
  // An unencrypted send that slipped past an encrypted verdict is refused
  assert.equal(
    guardReason("send", { ...BASE, latched: true, encrypted: true }),
    "sender",
  );
});

// ---------------------------------------------------------------------------
// Group cap
// ---------------------------------------------------------------------------

// P6: one number for the server, the native core and both modules here
test("the encrypted group cap is 24 here and in groupInclude.ts", () => {
  assert.equal(E2EE_GROUP_MAX, 24);
  assert.equal(MAX_E2EE_GROUP_MEMBERS, 24);
  assert.equal(E2EE_GROUP_MAX, MAX_E2EE_GROUP_MEMBERS);
  assert.equal(INCLUDE_MEMBER_REFUSE_AT, E2EE_GROUP_MAX - 1);
});
