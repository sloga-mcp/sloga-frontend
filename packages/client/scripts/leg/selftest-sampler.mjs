#!/usr/bin/env node
/*
 * selftest-sampler.mjs — drives observer-sampler.js against synthetic
 * getStats() reports, asserts its REFUSALS, and emits the fixtures that
 * selftest.sh feeds to gate-trace-reduce.mjs.
 *
 *   node selftest-sampler.mjs <outdir>
 *
 * Why the fixtures are produced BY the sampler rather than hand-written: it
 * couples deliverable 1's dump schema to deliverable 3's reader, so a silent
 * schema drift between them turns the control red instead of turning a real
 * leg into an unreadable capture.
 *
 * The controls asserted here (each must FAIL the sampler, then the good case
 * must pass):
 *   S1  start() with NO RTCPeerConnection captured  -> throws
 *   S2  start() with no carrier pinned              -> throws
 *   S3  start() with no shape                       -> throws
 *   S4  a run whose carrier byte series stalls      -> carrierContinuity
 *                                                      verdict "discarded"
 *   S5  the same run with a live carrier            -> "continuous"
 *   S6  the dead-carrier dump and the live dump DIFFER (a control that is
 *       byte-identical to the real input proves nothing)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, "observer-sampler.js"), "utf8");

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
  const fn = new Function(
    "window",
    "navigator",
    "performance",
    "console",
    "setInterval",
    "clearInterval",
    SRC,
  );
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
  expectThrow(
    "S1 start() with no RTCPeerConnection captured",
    () => s.api.start({ shape: "b", label: "x" }),
    "no RTCPeerConnection was captured",
  );
  // capture one, still no carrier
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
const TICKS = 32;
const SSRC_CARRIER = 111111;
const SSRC_SUBJECT_PRE = 222222;
const SSRC_SUBJECT_POST = 333333; // the fresh SSRC on rejoin — the fiducial
const REJOIN_TICK = 10;
const LEAK_END_TICK = 22;
const CARRIER_DEATH_TICK = 12;

/**
 * @param {"plaintext"|"ciphertext"|"bytesonly"|"deadcarrier"|"nocontrol"} scenario
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
    pc.emitTrack({
      track,
      streams: [{ id: `${participantSid}|${trackSid}` }],
      receiver,
      transceiver: { mid: "0" },
    });
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
  const wall = [];

  for (let i = 0; i < TICKS; i++) {
    if (i === REJOIN_TICK) emit(subjPostTrack, "PA_SUBJECT2", "TR_subject_post", false);

    // --- carrier: continuous, audible, EXCEPT in the deadcarrier scenario
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
      totalAudioEnergy: scenario === "nocontrol" ? cEnergy - 0.01 * i : cEnergy,
      concealedSamples: 10,
      totalSamplesReceived: 48000 + i * 480,
    };
    if (scenario === "nocontrol") carrierRow.totalAudioEnergy = 1.0; // carrier flat: NO positive control

    // --- subject: silent, then leaking from REJOIN_TICK under a FRESH ssrc
    const leaking = i >= REJOIN_TICK && i < LEAK_END_TICK;
    if (leaking) {
      sBytes += 1000;
      if (scenario === "plaintext") sEnergy += 0.02;
      if (scenario !== "plaintext") sConceal += 480;
    }
    const subjectRow = {
      type: "inbound-rtp",
      kind: "audio",
      ssrc: i < REJOIN_TICK ? SSRC_SUBJECT_PRE : SSRC_SUBJECT_POST,
      trackIdentifier: i < REJOIN_TICK ? subjPreTrack.id : subjPostTrack.id,
      timestamp: 1000 + i,
      bytesReceived: sBytes,
      packetsReceived: 50 + (leaking ? i * 5 : 0),
      audioLevel: scenario === "plaintext" && leaking ? 0.3 : 0,
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
    wall.push(Date.now());
    await new Promise((r) => setTimeout(r, TICK_MS));
  }

  s.api.stop();
  const dump = s.api.dump();
  return { dump, s };
}

process.stdout.write("=== sampler scenarios ===\n");

const results = {};
for (const scenario of ["plaintext", "ciphertext", "bytesonly", "deadcarrier", "nocontrol"]) {
  const { dump } = await runScenario(scenario);
  results[scenario] = dump;
  const file = path.join(outdir, `sampler-${scenario}.json`);
  const buf = Buffer.from(JSON.stringify(dump), "utf8");
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "wx");
  fs.writeSync(fd, buf, 0, buf.length, 0);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, file);
  process.stdout.write(
    `  wrote ${file}  ticks=${dump.ticks.length} carrier=${dump.carrierContinuity.verdict}\n`,
  );
}

check(
  "S4 dead carrier => carrierContinuity DISCARDED",
  results.deadcarrier.carrierContinuity.verdict === "discarded",
  `got ${results.deadcarrier.carrierContinuity.verdict}`,
);
check(
  "S5 live carrier => carrierContinuity CONTINUOUS",
  results.plaintext.carrierContinuity.verdict === "continuous",
  `got ${results.plaintext.carrierContinuity.verdict}`,
);
check(
  "S6 the dead-carrier control DIFFERS from the good input",
  JSON.stringify(results.deadcarrier.ticks) !== JSON.stringify(results.plaintext.ticks),
  "the control is byte-identical to the real input and therefore proves nothing",
);
check(
  "S7 the subject's fresh SSRC on rejoin is recorded",
  results.plaintext.ticks.some((tk) => tk.samples.some((x) => x.role === "subject" && x.ssrc === SSRC_SUBJECT_POST)) &&
    results.plaintext.ticks.some((tk) => tk.samples.some((x) => x.role === "subject" && x.ssrc === SSRC_SUBJECT_PRE)),
  "the fiducial is missing from the series",
);
check(
  "S8 role-by-elimination survives the subject's participant-sid change",
  results.plaintext.publications.filter((p) => p.role === "subject").length === 2,
  `subject publications = ${results.plaintext.publications.filter((p) => p.role === "subject").length}`,
);
check(
  "S9 muted/enabled are recorded ONLY under annotationOnly",
  results.plaintext.ticks[0].samples.every((x) => x.annotationOnly && !("muted" in x) && !("enabled" in x)),
  "a mute flag escaped into the top level of a sample, where it could reach a verdict",
);

// --------------------------------------------------------------------------
// Log fixtures, generated against the SAME wall clock as the dumps.
// --------------------------------------------------------------------------

function ssrcChangeWall(dump) {
  let last = null;
  for (const tk of dump.ticks) {
    for (const s of tk.samples) {
      if (s.role !== "subject") continue;
      if (last !== null && s.ssrc !== last) return tk.t;
      last = s.ssrc;
    }
  }
  return dump.ticks[0].t;
}

function writeAtomic(file, text) {
  const buf = Buffer.from(text, "utf8");
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "wx");
  fs.writeSync(fd, buf, 0, buf.length, 0);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, file);
}

function chromiumLine(t, payload) {
  const d = new Date(t);
  const p2 = (n) => String(n).padStart(2, "0");
  const stamp = `${p2(d.getMonth() + 1)}${p2(d.getDate())}/${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}000`;
  return `[4242:4242:${stamp}:INFO:CONSOLE(1)] "[gate-trace] ${JSON.stringify(payload)}", source: app://bundle/assets/index-abc.js (1)`;
}

const t0 = ssrcChangeWall(results.plaintext);

// C0 shape: the set is NON-EMPTY and the subject's publication is ABSENT from
// trackPublications at the leak, PRESENT at the mute.
const c0Records = [
  { t: t0 - 400, p: 1, at: "disconnect.preclear", gate: ["negotiating"], size: 1 },
  { t: t0 - 300, p: 2, at: "connect.add", gate: ["negotiating"], size: 1, e2eeCapable: true },
  {
    t: t0 - 20,
    p: 3,
    at: "localSenderCreated",
    gate: ["negotiating"],
    size: 1,
    censusSize: 0,
    subjectSidPresent: false,
    passes: 4,
  },
  {
    t: t0 + 900,
    p: 4,
    at: "localTrackPublished.entry",
    gate: ["negotiating"],
    size: 1,
    censusSize: 1,
    subjectSidPresent: true,
    passes: 5,
    publications: [
      {
        trackSid: "TR_subject_post",
        upstreamPaused: false,
        hasSender: true,
        senderHasTrack: true,
        transportState: "connected",
        upstream: "live",
        op: "pause",
      },
    ],
  },
];
// The MINUS-negotiating edge, seam 4 — the fiducial the observer's SSRC change
// is aligned against. Placed exactly at the SSRC change, so a GOOD run reads
// "aligned"; trace-unaligned.log below moves it and must read "unaligned".
const resumeAt = { t: t0, p: 3.5, at: "resumeGate", gate: [], size: 0, reachedZero: true };
writeAtomic(
  path.join(outdir, "trace-c0.log"),
  [...c0Records, resumeAt]
    .sort((a, b) => a.t - b.t)
    .map((r) => chromiumLine(r.t, r))
    .join("\n") + "\n",
);
writeAtomic(
  path.join(outdir, "trace-unaligned.log"),
  [...c0Records, { ...resumeAt, t: t0 + 900 }]
    .sort((a, b) => a.t - b.t)
    .map((r) => chromiumLine(r.t, r))
    .join("\n") + "\n",
);

// The in-place arm (no disconnect.preclear) with an EMPTY set — the C1 shape.
const c1Records = [
  { t: t0 - 250, p: 1, at: "rejoinFresh", reason: "poisoned-successor", callModeBefore: "e2ee", callModeAfter: "negotiating" },
  { t: t0 - 200, p: 2, at: "dropModeToNegotiating", confirmedInterlude: true },
  { t: t0, p: 2.5, at: "resumeGate", gate: [], size: 0, reachedZero: true },
  {
    t: t0 - 10,
    p: 3,
    at: "localTrackPublished.entry",
    gate: [],
    size: 0,
    censusSize: 1,
    subjectSidPresent: true,
    passes: 7,
    publications: [],
  },
];
writeAtomic(path.join(outdir, "trace-c1.log"), c1Records.map((r) => chromiumLine(r.t, r)).join("\n") + "\n");

// 🔴 The DEGRADED control: Chromium's console serializer collapsed the object
// argument. The records exist; their fields do not.
writeAtomic(
  path.join(outdir, "trace-objectobject.log"),
  c0Records.map((r) => chromiumLine(r.t, r).replace(/\{.*\}/, "[object Object]")).join("\n") + "\n",
);

// A TRUNCATED capture: the last record's payload is cut mid-object.
{
  const full = c0Records.map((r) => chromiumLine(r.t, r)).join("\n");
  writeAtomic(path.join(outdir, "trace-truncated.log"), full.slice(0, full.length - 120) + "\n");
}

// A log with no [gate-trace] lines at all.
writeAtomic(path.join(outdir, "trace-empty-of-records.log"), "[4242:4242:0910/120000.000000:INFO:CONSOLE(1)] \"hello\"\n");

// Corrupted sampler inputs.
const good = fs.readFileSync(path.join(outdir, "sampler-plaintext.json"), "utf8");
writeAtomic(path.join(outdir, "sampler-truncated.json"), good.slice(0, Math.floor(good.length * 0.6)));
writeAtomic(path.join(outdir, "sampler-empty.json"), "");
writeAtomic(path.join(outdir, "sampler-wrongschema.json"), JSON.stringify({ ...JSON.parse(good), schema: "something-else/9" }));
writeAtomic(path.join(outdir, "sampler-zeroticks.json"), JSON.stringify({ ...JSON.parse(good), ticks: [] }));
writeAtomic(path.join(outdir, "sampler-shapea.json"), JSON.stringify({ ...JSON.parse(good), shape: "a", e2eeManagerPresent: true }));

process.stdout.write(`=== sampler self-test: ${failures} failing control(s) ===\n`);
process.exit(failures === 0 ? 0 : 1);
