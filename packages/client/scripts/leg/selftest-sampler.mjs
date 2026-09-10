#!/usr/bin/env node
/*
 * selftest-sampler.mjs — drives observer-sampler.js against synthetic
 * getStats() reports, asserts its REFUSALS, checks the reducer's payload-key
 * contract AGAINST THE EMITTERS, and generates every trace fixture FROM the
 * key sets it extracted from those emitters.
 *
 *   node selftest-sampler.mjs <outdir>
 *
 * ---------------------------------------------------------------------------
 * 🔴 THE DEFECT THIS FILE EXISTS TO PREVENT (wave 0, lane W0-C).
 *
 * Wave 0's fixtures were HAND-WRITTEN using key names the lane had GUESSED
 * (`size`, `censusSize`, `subjectSidPresent`, `publications: [{...}]`), and
 * the reducer read those same guesses through an alias list. The emitters
 * emitted `gateSize`, `publicationCount`, `subjectInPublications` and
 * `publications: [ "..." ]` — STRINGS. The selftest was green. Decision-table
 * case G2 passed on a fixture that could not occur; measured against the real
 * key sets, the same capture read `DECISION (§2.5) : no row`.
 *
 * Fixing the aliases would not have fixed that. The METHOD was the defect:
 * a harness that validates a re-typed copy of the needle instead of the
 * artifact. So:
 *
 *   - there are no aliases in the reducer any more;
 *   - the `at` literals and payload key sets are EXTRACTED from
 *     `components/rtc/state.tsx` and `components/rtc/mlsCallSession.ts`
 *     (read-only — this lane does not own them);
 *   - the check runs BOTH WAYS: the reducer may not read a key no emitter
 *     emits, and an emitter may not emit a key the reducer does not know;
 *   - every trace fixture is GENERATED from the extracted key set, and a key
 *     with no declared fixture value is a hard failure, not a blank;
 *   - and the whole extraction is itself proved against a deliberately
 *     CORRUPTED COPY of an emitter before any of it is believed.
 *
 * The controls asserted here (each must FAIL first, then the good case pass):
 *   S1  start() with NO RTCPeerConnection captured  -> throws
 *   S2  start() with no carrier pinned              -> throws
 *   S3  start() with no shape                       -> throws
 *   S4  a run whose carrier byte series stalls      -> "discarded"
 *   S5  the same run with a live carrier            -> "continuous"
 *   S6  the dead-carrier dump DIFFERS from the good one
 *   E*  the emitter <-> reducer key contract, both directions
 *   X*  the emitter check itself, against a corrupted emitter copy
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractEmitters } from "./emitter-extract.mjs";
import {
  COMMON_KEYS,
  GATE_CONTEXT_KEYS,
  PUB_ENTRY_KEYS,
  PUB_ENTRY_READS,
  READS,
  SEAMS,
  SEAM_KEYS,
  seriesByRole,
  ssrcChanges,
  subjectFlowWindows,
  pinLeakWindow,
} from "./gate-trace-reduce.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, "observer-sampler.js"), "utf8");
// The emitters. SLOGA_EMITTERS (colon separated) overrides the default pair
// so this harness can be run from a COPY of the leg directory; the paths
// actually used are PRINTED, because a check pointed at the wrong file is a
// check that proves nothing.
const EMITTER_FILES = process.env.SLOGA_EMITTERS
  ? process.env.SLOGA_EMITTERS.split(":").filter((x) => x !== "")
  : [
      path.resolve(HERE, "../../components/rtc/state.tsx"),
      path.resolve(HERE, "../../components/rtc/mlsCallSession.ts"),
    ];

const outdir = process.argv[2];
if (!outdir) {
  process.stderr.write("usage: node selftest-sampler.mjs <outdir>\n");
  process.exit(2);
}
fs.mkdirSync(outdir, { recursive: true });

let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    process.stdout.write(`  CONTROL PASS  ${name}\n`);
  } else {
    failures += 1;
    process.stdout.write(`  CONTROL FAIL  ${name}${detail ? " — " + detail : ""}\n`);
  }
}
function expectThrow(name, fn, needle) {
  let threw = null;
  try {
    fn();
  } catch (e) {
    threw = e;
  }
  if (!threw) {
    check(name, false, "it did NOT throw — the refusal is missing, so a bad run would look green");
    return;
  }
  if (needle && !String(threw.message).includes(needle)) {
    check(name, false, `threw, but without ${JSON.stringify(needle)}: ${threw.message}`);
    return;
  }
  check(name, true);
}

function writeAtomic(file, text) {
  const buf = Buffer.from(text, "utf8");
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "wx");
  try {
    fs.writeSync(fd, buf, 0, buf.length, 0);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

// --------------------------------------------------------------------------
// A minimal browser surface: only what observer-sampler.js actually touches.
// --------------------------------------------------------------------------

class FakeTrack {
  constructor(id) {
    this.id = id;
    this.kind = "audio";
    this.muted = false;
    this.enabled = false; // a gate-held pause reads exactly this
    this.readyState = "live";
  }
}

function makeSampler({ scenario }) {
  const win = {};
  const nav = { userAgent: "selftest/1 (node)" };
  let intervalCb = null;

  class FakePC {
    constructor() {
      this._listeners = [];
      this._rows = [];
    }
    addEventListener(type, fn) {
      if (type === "track") this._listeners.push(fn);
    }
    emitTrack(ev) {
      for (const fn of this._listeners) fn(ev);
    }
    getStats() {
      const rows = this._rows;
      return Promise.resolve({
        forEach(cb) {
          for (const r of rows) cb(r);
        },
      });
    }
  }

  win.RTCPeerConnection = FakePC;
  const fn = new Function("window", "navigator", "performance", "console", "setInterval", "clearInterval", SRC);
  fn(
    win,
    nav,
    performance,
    { info() {}, warn() {}, error() {}, log() {}, table() {} },
    (cb) => {
      intervalCb = cb;
      return 1;
    },
    () => {
      intervalCb = null;
    },
  );

  return { win, FakePC, api: win.SLOGA_LEG, tick: () => intervalCb && intervalCb(), scenario };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

// --------------------------------------------------------------------------
// S1 / S2 / S3 — the refusals
// --------------------------------------------------------------------------

process.stdout.write("=== sampler refusals (known-bad controls) ===\n");
{
  const s = makeSampler({ scenario: "refusals" });
  expectThrow("S1 start() with no RTCPeerConnection captured", () => s.api.start({ shape: "b", label: "x" }), "no RTCPeerConnection was captured");
  const pc = new s.win.RTCPeerConnection();
  expectThrow("S2 start() with no carrier pinned", () => s.api.start({ shape: "b", label: "x" }), "no carrier pinned");
  s.api.carrier("PA_CARRIER");
  expectThrow("S3 start() with no shape", () => s.api.start({ label: "x" }), "shape");
  check("S1b the peer connection WAS captured through the constructor hook", s.api._state.pcs.length === 1, `pcs=${s.api._state.pcs.length}`);
  void pc;
}

// --------------------------------------------------------------------------
// Scenario runner
// --------------------------------------------------------------------------

// 🔴 The cadence is REAL wall-clock time, not a fast loop. The dead-carrier
// control has to produce a stall that exceeds the tools' REAL 500 ms default
// threshold; on a fast loop that control PASSED AS CONTINUOUS — exactly the
// vacuous control this harness exists to prevent. Found by this harness.
const TICK_MS = 60;
const TICKS = 40;
const SSRC_CARRIER = 111111;
const SSRC_SUBJECT_PRE = 222222;
const SSRC_SUBJECT_POST = 333333; // the fresh SSRC on rejoin — the fiducial
const CALL1_START_TICK = 2; // `plaintextcall1` only: the operator speaking in call 1
const CALL1_END_TICK = 6;
const REJOIN_TICK = 18;
const LEAK_END_TICK = 30;
const CARRIER_DEATH_TICK = 20;
const STALL_THRESHOLD_MS = 500; // the reducer's real default

/**
 * @param {"plaintext"|"plaintextcall1"|"ciphertext"|"bytesonly"|"deadcarrier"|"nocontrol"} scenario
 */
async function runScenario(scenario) {
  const s = makeSampler({ scenario });
  const pc = new s.win.RTCPeerConnection();

  const carrierTrack = new FakeTrack("carrier-track");
  const subjPreTrack = new FakeTrack("subject-track-pre");
  const subjPostTrack = new FakeTrack("subject-track-post");

  const emit = (track, participantSid, trackSid, lkFlag) => {
    const receiver = { track };
    if (lkFlag) receiver.lk_e2ee = true;
    pc.emitTrack({ track, streams: [{ id: `${participantSid}|${trackSid}` }], receiver, transceiver: { mid: "0" } });
  };
  emit(carrierTrack, "PA_CARRIER", "TR_carrier", false);
  emit(subjPreTrack, "PA_SUBJECT1", "TR_subject_pre", false);

  s.api.carrier("PA_CARRIER");
  s.api.start({ shape: "b", label: `selftest-${scenario}`, intervalMs: 100 });

  let cBytes = 10000;
  let cEnergy = 1.0;
  let sBytes = 5000;
  let sEnergy = 0.5;
  let sConceal = 100;

  for (let i = 0; i < TICKS; i++) {
    if (i === REJOIN_TICK) emit(subjPostTrack, "PA_SUBJECT2", "TR_subject_post", false);

    const carrierAlive = scenario === "deadcarrier" ? i < CARRIER_DEATH_TICK : true;
    if (carrierAlive) {
      cBytes += 200;
      cEnergy += 0.01;
    }
    const carrierRow = {
      type: "inbound-rtp",
      kind: "audio",
      ssrc: SSRC_CARRIER,
      trackIdentifier: carrierTrack.id,
      timestamp: 1000 + i,
      bytesReceived: cBytes,
      packetsReceived: 100 + i * 5,
      audioLevel: carrierAlive ? 0.2 : 0,
      totalAudioEnergy: cEnergy,
      concealedSamples: 10,
      totalSamplesReceived: 48000 + i * 480,
    };
    if (scenario === "nocontrol") carrierRow.totalAudioEnergy = 1.0; // carrier flat: NO positive control

    // 🔴 `plaintextcall1` reproduces §2.4's actual protocol: the operator is
    // already speaking BEFORE the rejoin and the sampler was started BEFORE
    // joining, so there is a FLOW WINDOW IN CALL 1, on the OLD ssrc. Wave 0's
    // reducer read `flow[0].from` as the leak instant and measured M3 against
    // that window.
    const call1 = scenario === "plaintextcall1" && i >= CALL1_START_TICK && i < CALL1_END_TICK;
    const leaking = i >= REJOIN_TICK && i < LEAK_END_TICK;
    if (call1) {
      sBytes += 1000;
      sEnergy += 0.02;
    }
    if (leaking) {
      sBytes += 1000;
      if (scenario === "plaintext" || scenario === "plaintextcall1") sEnergy += 0.02;
      if (scenario !== "plaintext" && scenario !== "plaintextcall1") sConceal += 480;
    }
    const subjectRow = {
      type: "inbound-rtp",
      kind: "audio",
      ssrc: i < REJOIN_TICK ? SSRC_SUBJECT_PRE : SSRC_SUBJECT_POST,
      trackIdentifier: i < REJOIN_TICK ? subjPreTrack.id : subjPostTrack.id,
      timestamp: 1000 + i,
      bytesReceived: sBytes,
      packetsReceived: 50 + (leaking || call1 ? i * 5 : 0),
      audioLevel: (scenario === "plaintext" || scenario === "plaintextcall1") && (leaking || call1) ? 0.3 : 0,
      totalAudioEnergy: sEnergy,
      concealedSamples: sConceal,
      totalSamplesReceived: 48000 + i * 480,
    };
    if (scenario === "bytesonly") {
      // 🔴 The control for "bytesReceived alone can NEVER establish plaintext":
      // bytes flow exactly as in the plaintext run, but the energy fields are
      // ABSENT from the stats report. A missing field is not flatness.
      delete subjectRow.audioLevel;
      delete subjectRow.totalAudioEnergy;
      delete subjectRow.concealedSamples;
    }

    pc._rows = [carrierRow, subjectRow];
    s.tick();
    await flush();
    await new Promise((r) => setTimeout(r, TICK_MS));
  }

  s.api.stop();
  return { dump: s.api.dump(), s };
}

process.stdout.write("=== sampler scenarios ===\n");

const results = {};
for (const scenario of ["plaintext", "plaintextcall1", "ciphertext", "bytesonly", "deadcarrier", "nocontrol"]) {
  const { dump } = await runScenario(scenario);
  results[scenario] = dump;
  const file = path.join(outdir, `sampler-${scenario}.json`);
  writeAtomic(file, JSON.stringify(dump));
  process.stdout.write(`  wrote ${file}  ticks=${dump.ticks.length} carrier=${dump.carrierContinuity.verdict}\n`);
}

check("S4 dead carrier => carrierContinuity DISCARDED", results.deadcarrier.carrierContinuity.verdict === "discarded", `got ${results.deadcarrier.carrierContinuity.verdict}`);
check("S5 live carrier => carrierContinuity CONTINUOUS", results.plaintext.carrierContinuity.verdict === "continuous", `got ${results.plaintext.carrierContinuity.verdict}`);
check("S6 the dead-carrier control DIFFERS from the good input", JSON.stringify(results.deadcarrier.ticks) !== JSON.stringify(results.plaintext.ticks), "the control is byte-identical to the real input and therefore proves nothing");

// 🔴 A control has to CROSS the threshold it targets. Wave 0's dead-carrier
// fixture ticked ~2 ms apart, so its ~80 ms stall never crossed the real
// 500 ms threshold and read as CONTINUOUS. Assert the crossing itself.
{
  const stalls = results.deadcarrier.carrierContinuity.stalls ?? [];
  const worst = stalls.reduce((m, s) => Math.max(m, s.ms ?? 0), 0);
  check(
    "S4b the dead-carrier control's stall actually CROSSES the 500 ms threshold it targets",
    worst > STALL_THRESHOLD_MS,
    `the longest carrier stall in the control is ${worst} ms, which does NOT exceed ${STALL_THRESHOLD_MS} ms — the control is VACUOUS`,
  );
  const span = results.plaintext.ticks.length ? results.plaintext.ticks[results.plaintext.ticks.length - 1].t - results.plaintext.ticks[0].t : 0;
  check("S4c the good run spans real wall-clock time (not a fast loop)", span > STALL_THRESHOLD_MS * 2, `the good capture spans only ${span} ms`);
}

check(
  "S7 the subject's fresh SSRC on rejoin is recorded",
  results.plaintext.ticks.some((tk) => tk.samples.some((x) => x.role === "subject" && x.ssrc === SSRC_SUBJECT_POST)) &&
    results.plaintext.ticks.some((tk) => tk.samples.some((x) => x.role === "subject" && x.ssrc === SSRC_SUBJECT_PRE)),
  "the fiducial is missing from the series",
);
check("S8 role-by-elimination survives the subject's participant-sid change", results.plaintext.publications.filter((p) => p.role === "subject").length === 2, `subject publications = ${results.plaintext.publications.filter((p) => p.role === "subject").length}`);
check("S9 muted/enabled are recorded ONLY under annotationOnly", results.plaintext.ticks[0].samples.every((x) => x.annotationOnly && !("muted" in x) && !("enabled" in x)), "a mute flag escaped into the top level of a sample, where it could reach a verdict");

// The B4 control's own precondition: the call-1 dump must really carry a flow
// window BEFORE the fiducial, or the control proves nothing.
{
  const rows = seriesByRole(results.plaintextcall1, "subject", 0);
  const flow = subjectFlowWindows(rows, 500);
  const changes = ssrcChanges(rows);
  const pre = changes.length ? flow.filter((w) => w.from < changes[0].t - results.plaintextcall1.intervalMs) : [];
  check(
    "S10 the call-1 control really has a flow window BEFORE the ssrc-change fiducial",
    pre.length > 0 && flow.length > pre.length,
    `flow windows=${flow.length} pre-fiducial=${pre.length} ssrcChanges=${changes.length} — without a pre-fiducial window the B4 control is vacuous`,
  );
}

// --------------------------------------------------------------------------
// The emitter <-> reducer key contract, BOTH DIRECTIONS
// --------------------------------------------------------------------------

process.stdout.write("=== emitter <-> reducer payload-key contract ===\n");

function checkEmitterContract(extracted) {
  const problems = [];
  for (const at of SEAMS) {
    if (!extracted.seams.has(at)) problems.push(`E3 the reducer knows seam ${at} but NO emitter emits it`);
  }
  for (const at of extracted.seams.keys()) {
    if (!SEAMS.includes(at)) problems.push(`E4 an emitter emits seam ${at} but the reducer's SEAMS list lacks it`);
  }
  for (const [at, v] of extracted.seams) {
    const known = new Set([...COMMON_KEYS, ...GATE_CONTEXT_KEYS, ...(SEAM_KEYS[at] ?? [])]);
    for (const k of v.keys) {
      if (!known.has(k)) problems.push(`E2 ${at}.${k} is EMITTED but the reducer does not know it (it would be silently IGNORED)`);
    }
    for (const k of READS[at] ?? []) {
      if (!v.keys.has(k)) problems.push(`E1 the reducer READS ${at}.${k} but no emitter emits it`);
    }
  }
  if (!extracted.pubEntryKeys) {
    problems.push("E5 the publications[] entry key set could not be extracted from the emitters, so nothing about it is verified");
  } else {
    for (const k of extracted.pubEntryKeys) {
      if (!PUB_ENTRY_KEYS.includes(k)) problems.push(`E2 publications[].${k} is EMITTED but the reducer does not know it`);
    }
    for (const k of PUB_ENTRY_READS) {
      if (!extracted.pubEntryKeys.has(k)) problems.push(`E1 the reducer READS publications[].${k} but no emitter emits it`);
    }
  }
  for (const p of extracted.problems) {
    problems.push(`E6 ${p.kind} ${path.basename(p.file ?? "?")}:${p.line ?? "?"} — ${p.detail}`);
  }
  return problems;
}

// 🔴 THE CONTROL COMES FIRST. Corrupt a COPY of an emitter (never the real
// file — this lane does not own it) and prove the check goes RED, before any
// green from it is believed.
const corruptDir = path.join(outdir, "emitters-corrupt");
fs.mkdirSync(corruptDir, { recursive: true });
{
  const real = fs.readFileSync(EMITTER_FILES[0], "utf8");
  const renamed = real.replaceAll("subjectSidPresent:", "subjectPresentXX:");
  const fileA = path.join(corruptDir, "state.renamed.tsx");
  writeAtomic(fileA, renamed);
  check("X0 the corrupted emitter copy DIFFERS from the real file", renamed !== real, "the replacement matched nothing, so the control is byte-identical and proves nothing");

  const probs = checkEmitterContract(extractEmitters([fileA, EMITTER_FILES[1]]));
  check(
    "X1 a RENAMED emitter key is caught in BOTH directions (E1 reads-but-unemitted, E2 emitted-but-unknown)",
    probs.some((p) => p.startsWith("E1") && p.includes("subjectSidPresent")) && probs.some((p) => p.startsWith("E2") && p.includes("subjectPresentXX")),
    `problems were: ${probs.join(" | ") || "(none — the check is VACUOUS)"}`,
  );

  // The `[object Object]` landmine at its source: an object ARGUMENT instead of
  // a pre-serialized string.
  const twoArg = real.replace(/"\[gate-trace\] "\s*\+\s*\n?\s*JSON\.stringify\(/, '"[gate-trace]", ');
  const fileB = path.join(corruptDir, "state.twoarg.tsx");
  writeAtomic(fileB, twoArg);
  check("X2a the two-argument control DIFFERS from the real file", twoArg !== real, "the replacement matched nothing");
  const probs2 = checkEmitterContract(extractEmitters([fileB, EMITTER_FILES[1]]));
  check(
    "X2 an emit site that passes an OBJECT ARGUMENT is caught (it renders as [object Object] in the packaged log)",
    probs2.some((p) => p.includes("not-pre-serialized")),
    `problems were: ${probs2.join(" | ") || "(none — the check is VACUOUS)"}`,
  );

  // A seam the reducer knows but nobody emits.
  const dropped = real.replaceAll('at: "localSenderCreated"', 'at: "localSenderCreatedXX"');
  const fileC = path.join(corruptDir, "state.dropseam.tsx");
  writeAtomic(fileC, dropped);
  const probs3 = checkEmitterContract(extractEmitters([fileC, EMITTER_FILES[1]]));
  check(
    "X3 a RENAMED seam literal is caught in both directions (E3 known-but-unemitted, E4 emitted-but-unknown)",
    probs3.some((p) => p.startsWith("E3") && p.includes("localSenderCreated")) && probs3.some((p) => p.startsWith("E4") && p.includes("localSenderCreatedXX")),
    `problems were: ${probs3.join(" | ") || "(none — the check is VACUOUS)"}`,
  );
}

const extracted = extractEmitters(EMITTER_FILES);
const contractProblems = checkEmitterContract(extracted);
process.stdout.write(`  emitters: ${EMITTER_FILES.join(', ')}\n  sites=${extracted.sites.length} seams=${extracted.seams.size}\n`);
for (const [at, v] of [...extracted.seams].sort((a, b) => a[0].localeCompare(b[0]))) {
  process.stdout.write(`    ${at.padEnd(28)} ${[...v.keys].join(",")}\n`);
}
process.stdout.write(`    ${"publications[]".padEnd(28)} ${extracted.pubEntryKeys ? [...extracted.pubEntryKeys].join(",") : "NOT EXTRACTABLE"}\n`);
check("E0 the emitter <-> reducer key contract holds in BOTH directions", contractProblems.length === 0, `\n      ${contractProblems.join("\n      ")}`);

// Keys the reducer knows but no emitter emits are reported, not failed: the
// reducer is allowed to know about a field it never sees, but nobody may be
// left guessing which.
{
  const info = [];
  for (const [at, v] of extracted.seams) {
    for (const k of SEAM_KEYS[at] ?? []) if (!v.keys.has(k)) info.push(`${at}.${k}`);
  }
  if (extracted.pubEntryKeys) for (const k of PUB_ENTRY_KEYS) if (!extracted.pubEntryKeys.has(k)) info.push(`publications[].${k}`);
  process.stdout.write(`  NOTE keys the reducer knows but no emitter currently emits (not read, so not a failure): ${info.join(", ") || "(none)"}\n`);
}

// --------------------------------------------------------------------------
// Fixture generation FROM the extracted key sets
// --------------------------------------------------------------------------

/** Fixture values for the gate context, shared by every seam that carries it. */
const GATE_BASE = {
  gate: ["negotiating"],
  gateSize: 1,
  gateHeld: true,
  gateGen: 4,
  connectGen: 2,
  passes: 5,
  currentRoom: true,
};

const SEAM_BASE = {
  "connect.add": { e2eeCapable: true },
  "disconnect.preclear": { via: "user" },
  pauseGate: { reason: "negotiating", edge: "add", staleRoom: false },
  "pauseGate.staleRoom": { reason: "negotiating", staleRoom: true },
  resumeGate: { reason: "negotiating", emptied: true, staleRoom: false, gate: [], gateSize: 0, gateHeld: false },
  "localTrackPublished.entry": {
    subject: "microphone/TR_subject_post",
    subjectSidPresent: true,
    publicationCount: 1,
    publications: null, // filled from the extracted publications[] key set
  },
  localSenderCreated: {
    subject: "microphone/TR_subject_post",
    subjectSidPresent: false,
    publicationCount: 0,
    upstreamPaused: false,
    hasSender: true,
    senderHasTrack: true,
    transportState: "connected",
  },
  "sweeper.dropped": { stillCurrent: true, sweeperGen: 4 },
  "track.upstreamResumed": { subject: "microphone/TR_subject_post" },
  "track.processorUpdate": { subject: "microphone/TR_subject_post" },
  setMode: { branch: "lockstep", wasNegotiating: true, incoming: "e2ee", mode: "e2ee", latched: false, localConfirmed: null, hasMedia: true },
  "applyMode.effect": { event: "local_confirm", next: "interlude", do: "keep", enabled: false, reason: "local_confirm" },
  rejoinFresh: { phase: "enter", seq: 1, reason: "poisoned-successor", modeBefore: "e2ee", modeAfter: "negotiating", reestablishes: 0, state: "resecuring" },
  dropModeToNegotiating: { confirmedInterlude: true, modeBefore: "e2ee", modeAfter: "negotiating", state: "resecuring", ran: true },
};

const PUB_ENTRY_BASE = {
  name: "microphone/TR_subject_post",
  source: "microphone",
  trackSid: "TR_subject_post",
  upstreamPaused: false,
  hasSender: true,
  senderHasTrack: true,
  transportState: "connected",
  upstream: "live",
  op: "pause",
  text: "microphone/TR_subject_post paused=false sender=true senderTrack=true transport=connected upstream=live op=pause",
};

function makePubEntry(overrides = {}) {
  if (!extracted.pubEntryKeys) throw new Error("cannot generate a publications[] entry: its key set was NOT EXTRACTABLE from the emitters");
  for (const k of Object.keys(overrides)) {
    if (!extracted.pubEntryKeys.has(k)) {
      throw new Error(`fixture override publications[].${k} names a key NO EMITTER EMITS — that is precisely the wave-0 defect`);
    }
  }
  const e = {};
  for (const k of extracted.pubEntryKeys) {
    if (k in overrides) e[k] = overrides[k];
    else if (k in PUB_ENTRY_BASE) e[k] = PUB_ENTRY_BASE[k];
    else throw new Error(`no fixture value declared for publications[].${k} — declare one rather than emitting a blank`);
  }
  return e;
}

/**
 * Build ONE record with EXACTLY the key set the emitter emits for that seam.
 * An override naming a key the emitter does not emit is a hard error: a
 * fixture that carries a field the real seam cannot carry is how wave 0's
 * decision-table case passed on an impossible capture.
 */
function makeRec(at, t, overrides = {}) {
  const seam = extracted.seams.get(at);
  if (!seam) throw new Error(`cannot generate a fixture for seam ${at}: no emitter emits it`);
  for (const k of Object.keys(overrides)) {
    if (!seam.keys.has(k)) {
      throw new Error(`fixture override ${at}.${k} names a key NO EMITTER EMITS — that is precisely the wave-0 defect`);
    }
  }
  const rec = { t, p: Math.round((t % 100000) * 1.0), at };
  for (const k of seam.keys) {
    if (COMMON_KEYS.includes(k)) continue;
    let v;
    if (k in overrides) v = overrides[k];
    else if (k in (SEAM_BASE[at] ?? {})) v = SEAM_BASE[at][k];
    else if (k in GATE_BASE) v = GATE_BASE[k];
    else throw new Error(`no fixture value declared for ${at}.${k} — declare one rather than emitting a blank`);
    if (k === "publications" && v === null) v = [makePubEntry()];
    rec[k] = v;
  }
  return rec;
}

function chromiumLine(t, payload) {
  const d = new Date(t);
  const p2 = (n) => String(n).padStart(2, "0");
  const stamp = `${p2(d.getMonth() + 1)}${p2(d.getDate())}/${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}000`;
  // The PINNED emit form: ONE pre-serialized string.
  return `[4242:4242:${stamp}:INFO:CONSOLE(1)] "[gate-trace] ${JSON.stringify(payload)}", source: app://bundle/assets/index-abc.js (1)`;
}

function writeTrace(name, records) {
  writeAtomic(path.join(outdir, name), [...records].sort((a, b) => a.t - b.t).map((r) => chromiumLine(r.t, r)).join("\n") + "\n");
}

/** The wall-clock landmarks of a dump, computed with the reducer's own maths. */
function landmarks(dump) {
  const rows = seriesByRole(dump, "subject", 0);
  const changes = ssrcChanges(rows);
  const flow = subjectFlowWindows(rows, 500);
  const leak = pinLeakWindow(flow, changes, null, dump.intervalMs);
  if (!leak.window) throw new Error(`the ${dump.label} dump has no post-fiducial flow window; the fixtures cannot be placed`);
  return { fiducial: changes[0].t, from: leak.window.from, to: leak.window.to };
}

process.stdout.write("=== trace fixtures (generated from the EXTRACTED key sets) ===\n");

let generated = 0;
try {
  for (const [scenario, tag] of [["plaintext", ""], ["bytesonly", ".bytesonly"], ["plaintextcall1", ".call1"]]) {
    const L = landmarks(results[scenario]);

    const base = () => [
      makeRec("disconnect.preclear", L.fiducial - 400, { via: "user" }),
      makeRec("connect.add", L.fiducial - 300),
      makeRec("resumeGate", L.fiducial),
      makeRec("localSenderCreated", L.from - 20, { subjectSidPresent: false, publicationCount: 0 }),
      makeRec("localTrackPublished.entry", L.to + 200, { subjectSidPresent: true, publicationCount: 1 }),
    ];

    // C0 — ABSENT at the leak (localSenderCreated), PRESENT at the mute.
    writeTrace(`trace-c0${tag}.log`, base());
    generated += 1;

    // C1 — the in-place arm, EMPTY set, and a `connect-leading` pre-clear that
    // is NOT a leave (B6).
    writeTrace(`trace-c1${tag}.log`, [
      makeRec("disconnect.preclear", L.fiducial - 420, { via: "connect-leading" }),
      makeRec("rejoinFresh", L.fiducial - 400, { phase: "enter", seq: 7 }),
      makeRec("rejoinFresh", L.fiducial - 380, { phase: "afterDrop", seq: 7 }),
      makeRec("dropModeToNegotiating", L.fiducial - 360),
      makeRec("resumeGate", L.fiducial),
      makeRec("localSenderCreated", L.from - 20, { gate: [], gateSize: 0, gateHeld: false, subjectSidPresent: true, publicationCount: 1 }),
      makeRec("localTrackPublished.entry", L.to + 200, { gate: [], gateSize: 0, gateHeld: false }),
    ]);
    generated += 1;
  }

  const L = landmarks(results.plaintext);

  // 🔴 B3's control: ONE stale, guard-DISCARDED drop from a previous call,
  // 5 s before the leak, with a different sweeper generation. The row must
  // stay C0. Measured on wave 0's reducer, exactly this flipped `no row`
  // to C3 for the whole run.
  writeTrace("trace-c0-staledrop.log", [
    ...[
      makeRec("disconnect.preclear", L.fiducial - 400, { via: "user" }),
      makeRec("connect.add", L.fiducial - 300),
      makeRec("resumeGate", L.fiducial),
      makeRec("localSenderCreated", L.from - 20, { subjectSidPresent: false, publicationCount: 0 }),
      makeRec("localTrackPublished.entry", L.to + 200, { subjectSidPresent: true, publicationCount: 1 }),
    ],
    makeRec("sweeper.dropped", L.from - 5000, { stillCurrent: false, sweeperGen: 3 }),
  ]);
  generated += 1;

  // C3 — a drop that LANDED, in the leak's own drive, same generation.
  writeTrace("trace-c3.log", [
    makeRec("disconnect.preclear", L.fiducial - 400, { via: "user" }),
    makeRec("resumeGate", L.fiducial),
    makeRec("localSenderCreated", L.from - 20, { subjectSidPresent: false, publicationCount: 0 }),
    makeRec("sweeper.dropped", L.from - 10, { stillCurrent: true, sweeperGen: 4 }),
    makeRec("localTrackPublished.entry", L.to + 200, { subjectSidPresent: true, publicationCount: 1 }),
  ]);
  generated += 1;

  // C6 — publication PRESENT at the leak, livekit's pause flag stale-true over
  // a live sender track.
  const c6 = [
    makeRec("disconnect.preclear", L.fiducial - 400, { via: "user" }),
    makeRec("resumeGate", L.fiducial),
    makeRec("localSenderCreated", L.from - 20, { subjectSidPresent: true, publicationCount: 1, upstreamPaused: true, senderHasTrack: true }),
    makeRec("localTrackPublished.entry", L.to + 200, { subjectSidPresent: true, publicationCount: 1, publications: [makePubEntry({ upstreamPaused: true, upstream: "live", op: "repause" })] }),
  ];
  writeTrace("trace-c6.log", c6);
  generated += 1;

  // C4 — flag false, UpstreamResumed INSIDE the bounded window before the mute.
  const c4Base = [
    makeRec("disconnect.preclear", L.fiducial - 400, { via: "user" }),
    makeRec("resumeGate", L.fiducial),
    makeRec("localSenderCreated", L.from - 20, { subjectSidPresent: true, publicationCount: 1, upstreamPaused: false }),
    makeRec("localTrackPublished.entry", L.to + 200, { subjectSidPresent: true, publicationCount: 1, publications: [makePubEntry({ upstreamPaused: false })] }),
  ];
  writeTrace("trace-c4.log", [...c4Base, makeRec("track.upstreamResumed", L.to - 200)]);
  generated += 1;
  // 🔴 H3's control: the SAME run with the resume 30 s earlier. "Immediately
  // before the mute" is a bounded window, and wave 0's `resumedNear` was the
  // WHOLE CAPTURE, so this run also read C4.
  writeTrace("trace-c4-farresumed.log", [...c4Base, makeRec("track.upstreamResumed", L.to - 30000)]);
  generated += 1;

  // 🔴 H1's control: a resumeGate at exactly the fiducial that does NOT
  // qualify (the stale-room drop), plus the real edge 900 ms off. Wave 0 took
  // ANY resumeGate, so this stale record rescued a genuinely unaligned run.
  writeTrace("trace-h1-stale-resume.log", [
    makeRec("disconnect.preclear", L.fiducial - 400, { via: "user" }),
    makeRec("resumeGate", L.fiducial, { staleRoom: true, emptied: false, reason: "mixed" }),
    makeRec("resumeGate", L.fiducial + 900),
    makeRec("localSenderCreated", L.from - 20, { subjectSidPresent: false, publicationCount: 0 }),
    makeRec("localTrackPublished.entry", L.to + 200, { subjectSidPresent: true, publicationCount: 1 }),
  ]);
  generated += 1;

  // 🔴 H2's control: the C0 shape, but every record belongs to an ABANDONED
  // Room. None of it may reach a verdict.
  writeTrace("trace-h2-abandoned.log", [
    makeRec("disconnect.preclear", L.fiducial - 400, { via: "user" }),
    makeRec("resumeGate", L.fiducial, { currentRoom: false }),
    makeRec("localSenderCreated", L.from - 20, { subjectSidPresent: false, publicationCount: 0, currentRoom: false }),
    makeRec("localTrackPublished.entry", L.to + 200, { subjectSidPresent: true, publicationCount: 1, currentRoom: false }),
  ]);
  generated += 1;

  // M4's control: TWO re-establishes with DIFFERENT seq must count as two.
  writeTrace("trace-m4-twoseq.log", [
    makeRec("rejoinFresh", L.fiducial - 400, { phase: "enter", seq: 7 }),
    makeRec("rejoinFresh", L.fiducial - 380, { phase: "enter", seq: 8 }),
    makeRec("resumeGate", L.fiducial),
    makeRec("localSenderCreated", L.from - 20, { gate: [], gateSize: 0, gateHeld: false, subjectSidPresent: true, publicationCount: 1 }),
  ]);
  generated += 1;

  // The fiducial moved off the ssrc change: the run must be UNALIGNED.
  writeTrace("trace-unaligned.log", [
    makeRec("disconnect.preclear", L.fiducial - 400, { via: "user" }),
    makeRec("resumeGate", L.fiducial + 900),
    makeRec("localSenderCreated", L.from - 20, { subjectSidPresent: false, publicationCount: 0 }),
    makeRec("localTrackPublished.entry", L.to + 200, { subjectSidPresent: true, publicationCount: 1 }),
  ]);
  generated += 1;

  // 🔴 The DEGRADED control: an object ARGUMENT reached Chromium's serializer.
  // The lines ARE there; the fields are not.
  {
    const recs = [
      makeRec("disconnect.preclear", L.fiducial - 400, { via: "user" }),
      makeRec("localSenderCreated", L.from - 20, { subjectSidPresent: false, publicationCount: 0 }),
    ];
    writeAtomic(path.join(outdir, "trace-objectobject.log"), recs.map((r) => chromiumLine(r.t, r).replace(/\{.*\}/, "[object Object]")).join("\n") + "\n");
    generated += 1;
  }

  // A TRUNCATED capture: the last record's payload is cut mid-object.
  {
    const full = [makeRec("disconnect.preclear", L.fiducial - 400, { via: "user" }), makeRec("localSenderCreated", L.from - 20)].map((r) => chromiumLine(r.t, r)).join("\n");
    writeAtomic(path.join(outdir, "trace-truncated.log"), full.slice(0, full.length - 120) + "\n");
    generated += 1;
  }

  // A log with no [gate-trace] lines at all.
  writeAtomic(path.join(outdir, "trace-empty-of-records.log"), '[4242:4242:0910/120000.000000:INFO:CONSOLE(1)] "hello"\n');
  generated += 1;

  // A CDP capture whose object argument came back as a LOSSY 5-property
  // PREVIEW (L1). Only reachable from the OLD two-argument form; the counter
  // exists so a truncated CDP capture is never read as an unexplained gap.
  {
    const rec = makeRec("localSenderCreated", L.from - 20, { subjectSidPresent: false, publicationCount: 0 });
    const props = Object.entries(rec).slice(0, 5).map(([name, value]) => ({ name, type: typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "string", value: String(value) }));
    const ev = { method: "Runtime.consoleAPICalled", params: { type: "error", args: [{ type: "string", value: "[gate-trace]" }, { type: "object", preview: { properties: props } }] } };
    writeAtomic(path.join(outdir, "trace-cdp-lossy.jsonl"), JSON.stringify(ev) + "\n");
    generated += 1;
  }

  // Pre-flight fixtures for launch-seats.sh's serialization check.
  writeAtomic(path.join(outdir, "preflight-good.log"), chromiumLine(L.fiducial, makeRec("connect.add", L.fiducial)) + "\n");
  writeAtomic(path.join(outdir, "preflight-objectobject.log"), chromiumLine(L.fiducial, makeRec("connect.add", L.fiducial)).replace(/\{.*\}/, "[object Object]") + "\n");
  generated += 2;
} catch (e) {
  check("F0 every trace fixture was generated from the extracted key sets", false, e.message);
}
if (generated) process.stdout.write(`  generated ${generated} trace fixture(s)\n`);

// Corrupted sampler inputs.
const good = fs.readFileSync(path.join(outdir, "sampler-plaintext.json"), "utf8");
writeAtomic(path.join(outdir, "sampler-truncated.json"), good.slice(0, Math.floor(good.length * 0.6)));
writeAtomic(path.join(outdir, "sampler-empty.json"), "");
writeAtomic(path.join(outdir, "sampler-wrongschema.json"), JSON.stringify({ ...JSON.parse(good), schema: "something-else/9" }));
writeAtomic(path.join(outdir, "sampler-zeroticks.json"), JSON.stringify({ ...JSON.parse(good), ticks: [] }));
writeAtomic(path.join(outdir, "sampler-shapea.json"), JSON.stringify({ ...JSON.parse(good), shape: "a", e2eeManagerPresent: true }));

process.stdout.write(`=== sampler self-test: ${failures} failing control(s) ===\n`);
process.exit(failures === 0 ? 0 : 1);
