#!/usr/bin/env node
/*
 * gate-trace-reduce.mjs — the [gate-trace] log reducer for the consent-rejoin
 * media leak leg (rejoin-leak-plan.md §2.2 / §2.4 / §2.5, wave 0b, lane W0b-C).
 *
 *   node packages/client/scripts/leg/gate-trace-reduce.mjs \
 *     --sampler run5.json --log subject.log --shape b --consent yes|no \
 *     --audible-subject yes|no|unknown [--out run5.reduced.json]
 *
 *   node .../gate-trace-reduce.mjs --aggregate r1.json r2.json ...   (§2.5 H3)
 *   node .../gate-trace-reduce.mjs --check-log subject.log           (B7)
 *
 * It reads the OBSERVER's sampler dump and the SUBJECT seat's Chromium log
 * (and/or a CDP console capture), extracts the [gate-trace] records, joins the
 * two on WALL CLOCK, prints the timeline, and answers M1/M2/M3.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE REFUSES TO DO. Every one of these is a way this slice has
 * already produced a confident wrong answer.
 *
 *  - It NEVER outputs an M1 verdict from byte counts. An observer counts bytes
 *    for GCM frames too. `bytesReceived` appears in the M1 logic only as a
 *    co-requirement of an energy reading, never as evidence on its own.
 *  - It NEVER reads `muted` / `enabled`. Those live under `annotationOnly` in
 *    the sampler dump and this file does not look at that key at all. A held
 *    gate pauses via pauseUpstream() and the remote track then reads
 *    muted:false, enabled:false with ZERO RTP.
 *  - A MISSING field is `unknown`, never a zero and never a "flat".
 *  - shape (a) ALWAYS yields M1 = unknown, and never selects a row.
 *  - `ciphertext` is an ABSENCE and is admissible ONLY with a same-tick
 *    POSITIVE CONTROL on the carrier's ssrc.
 *  - A run whose carrier byte series is not continuous is DISCARDED, NOT
 *    INTERPRETED, and selects no row of §2.5.
 *  - It NEVER GUESSES A PAYLOAD KEY NAME. See "PINNED KEYS" below.
 *
 * Exit status:
 *   0  a report was produced (reduce), or the aggregate confirmed a row with
 *      its polarity EXPLAINED, or --check-log found parseable records
 *   3  an input was missing, unreadable, truncated or of the wrong schema —
 *      no report, because a partial parse is how a truncated capture becomes a
 *      confident verdict
 *   4  the run is DISCARDED (carrier not continuous / unaligned)
 *   5  --require-verdict was passed and M1 has no value
 *   6  AGGREGATE ONLY: "<row> confirmed as the WINDOW — POLARITY UNEXPLAINED".
 *      An INCOMPLETE result. §4.1 stays OPEN; the banked 2/2-vs-0/2 entry is
 *      untouched; the slice re-enters Investigate for the consent-dependent
 *      term. It is a separate exit status precisely so no script can read it
 *      as "done".
 *   7  AGGREGATE ONLY: nothing is selected at all.
 *
 * ---------------------------------------------------------------------------
 * 🔴 PINNED KEYS — READ THIS BEFORE ADDING A FIELD.
 *
 * Wave 0's reducer read payload fields through an ALIAS list of guessed names
 * (`size`, `censusSize`, `subjectSidPresent`, `publications: [{...}]`) and its
 * selftest proved it against fixtures the same lane had HAND-WRITTEN using
 * those same guesses. The emitters emitted different names. Case G2 passed on
 * a fixture that could not occur; measured against the real key sets the same
 * capture read `DECISION (§2.5) : no row`.
 *
 * So: there are NO ALIASES here. The key names below are the cross-lane
 * contract. Anything not named here is ABSENT, and `selftest-sampler.mjs`
 * EXTRACTS the emitted `at` literals and key sets from `state.tsx` and
 * `mlsCallSession.ts` themselves and fails BOTH ways — if this file reads a
 * key no emitter emits, and if an emitter emits a key this file does not
 * know. The fixtures are generated from that extraction, not typed by hand.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SAMPLER_SCHEMA = "sloga-leg-sampler/1";
export const REDUCTION_SCHEMA = "sloga-leg-reduction/2";

/** On every record. */
export const COMMON_KEYS = ["t", "p", "at"];

/** The gate context carried by the `state.tsx` gate seams. */
export const GATE_CONTEXT_KEYS = [
  "gate",
  "gateSize",
  "gateHeld",
  "gateGen",
  "connectGen",
  "passes",
  "currentRoom",
];

/** Per-seam keys BEYOND common + gate context. The pinned contract. */
export const SEAM_KEYS = {
  "connect.add": ["e2eeCapable"],
  "disconnect.preclear": ["via"],
  pauseGate: ["reason", "edge", "staleRoom"],
  "pauseGate.staleRoom": ["reason", "staleRoom"],
  resumeGate: ["reason", "emptied", "staleRoom"],
  "localTrackPublished.entry": [
    "subject",
    "subjectSidPresent",
    "publicationCount",
    "publications",
  ],
  localSenderCreated: [
    "subject",
    "subjectSidPresent",
    "publicationCount",
    "upstreamPaused",
    "hasSender",
    "senderHasTrack",
    "transportState",
  ],
  "sweeper.dropped": ["stillCurrent", "sweeperGen"],
  "track.upstreamResumed": ["subject"],
  "track.processorUpdate": ["subject"],
  setMode: [
    "branch",
    "wasNegotiating",
    "incoming",
    "mode",
    "latched",
    "localConfirmed",
    "hasMedia",
  ],
  "applyMode.effect": ["event", "next", "do", "enabled", "reason"],
  rejoinFresh: [
    "phase",
    "seq",
    "reason",
    "modeBefore",
    "modeAfter",
    "reestablishes",
    "state",
  ],
  dropModeToNegotiating: [
    "confirmedInterlude",
    "modeBefore",
    "modeAfter",
    "state",
    "ran",
  ],
};

export const SEAMS = Object.keys(SEAM_KEYS);

/** A `publications[]` entry on `localTrackPublished.entry` — OBJECTS, not strings. */
export const PUB_ENTRY_KEYS = [
  "name",
  "source",
  "trackSid",
  "upstreamPaused",
  "hasSender",
  "senderHasTrack",
  "transportState",
  "upstream",
  "op",
  "text",
];

/**
 * Every key this file may read, per seam. `readField` THROWS on a key that is
 * not listed here, so this table can never drift from the code below it; and
 * `selftest-sampler.mjs` checks this table against what the emitters actually
 * emit, so it can never drift from the source either.
 */
export const READS = {
  "connect.add": [],
  "disconnect.preclear": ["via"],
  pauseGate: [],
  "pauseGate.staleRoom": [],
  resumeGate: ["reason", "emptied", "staleRoom"],
  "localTrackPublished.entry": [
    "gate",
    "gateSize",
    "gateGen",
    "passes",
    "currentRoom",
    "subject",
    "subjectSidPresent",
    "publicationCount",
    "publications",
  ],
  localSenderCreated: [
    "gate",
    "gateSize",
    "gateGen",
    "passes",
    "currentRoom",
    "subject",
    "subjectSidPresent",
    "publicationCount",
    "upstreamPaused",
    "hasSender",
    "senderHasTrack",
    "transportState",
  ],
  "sweeper.dropped": ["stillCurrent", "sweeperGen"],
  "track.upstreamResumed": ["subject"],
  "track.processorUpdate": ["subject"],
  setMode: [],
  "applyMode.effect": [],
  rejoinFresh: ["seq", "phase"],
  dropModeToNegotiating: [],
};

/** Keys of a publications[] entry this file reads. */
export const PUB_ENTRY_READS = [
  "trackSid",
  "upstreamPaused",
  "hasSender",
  "senderHasTrack",
  "transportState",
  "upstream",
  "op",
];

/**
 * `currentRoom` is read DEFENSIVELY on every seam that carries it (H2), not
 * only on the two it is pinned for, so a record from an ABANDONED Room cannot
 * reach a verdict. A record that does not carry it is kept and COUNTED — an
 * unfilterable record is a reported gap, never a silent pass.
 */
const SOFT_KEY_CURRENT_ROOM = "currentRoom";

// --------------------------------------------------------------------------
// field access
// --------------------------------------------------------------------------

const MISSING = { found: false, value: undefined };

function readField(rec, key, coverage) {
  const allowed = READS[rec.at];
  if (!allowed) {
    throw new Error(
      `internal: reducer read a field of the unpinned seam ${JSON.stringify(rec.at)}`,
    );
  }
  if (!allowed.includes(key)) {
    throw new Error(
      `internal: reducer read ${rec.at}.${key}, which is NOT declared in READS. Declare it (and let the emitter check verify the emitter emits it) rather than reading it behind the table's back.`,
    );
  }
  const found = Object.prototype.hasOwnProperty.call(rec.payload, key);
  if (coverage) note(coverage, rec.at, key, found);
  return found ? { found: true, value: rec.payload[key] } : MISSING;
}

function readPubField(entry, key, coverage) {
  if (!PUB_ENTRY_READS.includes(key)) {
    throw new Error(
      `internal: reducer read publications[].${key}, which is NOT declared in PUB_ENTRY_READS`,
    );
  }
  const found =
    !!entry &&
    typeof entry === "object" &&
    Object.prototype.hasOwnProperty.call(entry, key);
  if (coverage) note(coverage, "publications[]", key, found);
  return found ? { found: true, value: entry[key] } : MISSING;
}

function note(coverage, at, key, found) {
  const k = `${at}.${key}`;
  coverage[k] = coverage[k] ?? { found: 0, missing: 0 };
  if (found) coverage[k].found += 1;
  else coverage[k].missing += 1;
}

/** A field's value for display: `unknown` when ABSENT, never a default. */
function show(r) {
  return r.found ? r.value : "unknown";
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

function die(code, msg) {
  process.stderr.write(`gate-trace-reduce: ${msg}\n`);
  process.exit(code);
}

const HELP = `gate-trace-reduce.mjs — reduce a leg capture to M1/M2/M3 (rejoin-leak-plan.md wave 0)

REDUCE one run:
  --sampler <file>            REQUIRED. observer-sampler.js dump (JSON).
  --log <file>                Chromium log and/or CDP console capture. Repeatable.
  --shape a|b                 REQUIRED. shape (a) => M1 is always unknown.
  --consent yes|no            REQUIRED. Which arm this run belongs to. §2.5's
                              H3 rule makes polarity a required OUTPUT, and it
                              cannot be computed from runs that do not say
                              which arm they are.
  --audible-subject yes|no|unknown
                              The operator's ear on the shape-(b) manager-free
                              observer. Plaintext is a POSITIVE finding.
  --clock-skew-ms <n>         Added to sampler wall clock before joining. Using
                              it WAIVES the fiducial alignment check and says so.
  --max-stall-ms <n>          Carrier continuity threshold (default 500).
  --leak-after <t>            Pin the leak window to the first flow window at or
                              after this wall clock, instead of the SSRC-change
                              fiducial. Use when the fiducial is missing.
  --drive-window-ms <n>       How far BEFORE the leak instant a sweeper drive /
                              sender seam may lie and still belong to it
                              (default 2000).
  --mute-grace-ms <n>         How far AFTER the flow window's end the mute's
                              localTrackPublished.entry may lie (default 1500).
  --resumed-window-ms <n>     §2.5 C4's "immediately before the mute" (default
                              1000, measured back from the flow window's end).
  --out <file>                Write the reduction as JSON (temp + fsync + rename).
  --require-verdict           Exit 5 if M1 has no value.
  --quiet                     Suppress the human timeline; still writes --out.

AGGREGATE the arms (§2.5's H3 polarity rule):
  --aggregate <r1.json> <r2.json> ...
                              Reduction reports written by --out. Prints the
                              per-arm verdict and the POLARITY outcome.

PRE-FLIGHT a log:
  --check-log <file>          Does a [gate-trace] record reach this log
                              PARSEABLE (not "[object Object]")? Exit 0/3.

Exit: 0 report, 3 bad input, 4 discarded, 5 no verdict, 6 POLARITY UNEXPLAINED
(INCOMPLETE), 7 the aggregate selects nothing.
`;

function parseArgs(argv) {
  const out = {
    logs: [],
    shape: null,
    audible: "unknown",
    consent: null,
    skewMs: 0,
    out: null,
    requireVerdict: false,
    maxStallMs: 500,
    driveWindowMs: 2000,
    muteGraceMs: 1500,
    resumedWindowMs: 1000,
    leakAfter: null,
    quiet: false,
    aggregate: [],
    checkLog: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) die(3, `${a} needs a value`);
      return v;
    };
    const num = () => {
      const v = Number(next());
      if (!Number.isFinite(v)) die(3, `${a} must be a number`);
      return v;
    };
    switch (a) {
      case "--sampler": out.sampler = next(); break;
      case "--log": out.logs.push(next()); break;
      case "--shape": out.shape = next(); break;
      case "--consent": out.consent = next(); break;
      case "--audible-subject": out.audible = next(); break;
      case "--clock-skew-ms": out.skewMs = num(); break;
      case "--max-stall-ms": out.maxStallMs = num(); break;
      case "--leak-after": out.leakAfter = num(); break;
      case "--drive-window-ms": out.driveWindowMs = num(); break;
      case "--mute-grace-ms": out.muteGraceMs = num(); break;
      case "--resumed-window-ms": out.resumedWindowMs = num(); break;
      case "--out": out.out = next(); break;
      case "--require-verdict": out.requireVerdict = true; break;
      case "--quiet": out.quiet = true; break;
      case "--check-log": out.checkLog = next(); break;
      case "--aggregate":
        while (argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith("--")) {
          out.aggregate.push(argv[++i]);
        }
        if (out.aggregate.length === 0) die(3, "--aggregate needs at least one reduction report");
        break;
      case "-h":
      case "--help":
        process.stdout.write(HELP);
        process.exit(0);
        break;
      default:
        die(3, `unknown argument ${a}`);
    }
  }
  if (out.checkLog) return out;
  if (out.aggregate.length) return out;
  if (!out.sampler) die(3, "--sampler <file> is required; there is no reduction without the observer series");
  if (out.shape !== "a" && out.shape !== "b") {
    die(3, '--shape a|b is required. Shape decides whether M1 has a value at all: on shape (a) it never does.');
  }
  if (out.consent !== "yes" && out.consent !== "no") {
    die(3, "--consent yes|no is required. §2.5's H3 rule makes POLARITY a required OUTPUT: a run that does not name its arm cannot contribute to it, and a 'row confirmed' reading with no polarity closes a consent-triggered defect with a fix for a window that is open on every call.");
  }
  if (!["yes", "no", "unknown"].includes(out.audible)) {
    die(3, "--audible-subject must be yes|no|unknown (the operator's ear, recorded honestly)");
  }
  return out;
}

// --------------------------------------------------------------------------
// Sampler input
// --------------------------------------------------------------------------

function readJsonStrict(file, what) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    die(3, `cannot read ${what} ${file}: ${e.message}`);
  }
  if (raw.trim() === "") die(3, `${what} ${file} is EMPTY (0 useful bytes) — refusing to reduce nothing`);
  try {
    return JSON.parse(raw);
  } catch (e) {
    die(3, `${what} ${file} is not valid JSON (truncated capture?): ${e.message}`);
  }
}

function loadSampler(file) {
  const d = readJsonStrict(file, "sampler dump");
  if (d.schema !== SAMPLER_SCHEMA) {
    die(3, `sampler dump ${file} has schema ${JSON.stringify(d.schema)}, expected ${SAMPLER_SCHEMA}`);
  }
  if (!Array.isArray(d.ticks)) die(3, `sampler dump ${file} has no ticks array`);
  if (d.ticks.length === 0) die(3, `sampler dump ${file} has ZERO ticks — an empty capture is not a clean run`);
  for (const tk of d.ticks) {
    if (typeof tk.t !== "number" || !Array.isArray(tk.samples)) {
      die(3, `sampler dump ${file} has a malformed tick (missing t or samples)`);
    }
  }
  if (d.truncated) {
    process.stderr.write("gate-trace-reduce: WARNING the sampler hit its tick cap and the series is TRUNCATED\n");
  }
  return d;
}

// --------------------------------------------------------------------------
// [gate-trace] extraction
// --------------------------------------------------------------------------

const TAG = "[gate-trace]";

/** Balanced-brace scan from the first `{`; tolerant of nested objects. */
function sliceObject(s) {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null; // unbalanced => truncated line
}

/**
 * The emitters now produce ONE pre-serialized string:
 *   console.error("[gate-trace] " + JSON.stringify(payload))
 * so the payload is strict JSON. `looseParse` survives from wave 0 only as a
 * fallback for a capture taken from an older bundle; it never invents a field.
 */
function looseParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    /* fall through */
  }
  const t = text
    .replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g, '$1"$2":')
    .replace(/'([^'\\]*)'/g, '"$1"')
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/\bundefined\b/g, "null");
  try {
    return { ok: true, value: JSON.parse(t) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Chromium's own line prefix, e.g. `[123:456:0910/143012.123456:INFO:CONSOLE(1)]`. */
const CHROMIUM_PREFIX = /\[\d+:\d+:(\d{2})(\d{2})\/(\d{2})(\d{2})(\d{2})\.(\d{6}):/;

function extractFromText(raw, file, acc) {
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const tagAt = line.indexOf(TAG);
    if (tagAt < 0) continue;
    acc.seen += 1;
    const rest = line.slice(tagAt + TAG.length);
    const prefix = CHROMIUM_PREFIX.exec(line);
    const prefixClock = prefix ? `${prefix[1]}-${prefix[2]} ${prefix[3]}:${prefix[4]}:${prefix[5]}.${prefix[6]}` : null;

    if (/\[object Object\]/.test(rest)) {
      acc.degraded.push({
        source: `${file}:${i + 1}`,
        why: "the payload was stringified to [object Object] — an object ARGUMENT reached Chromium's log serializer instead of a pre-serialized string, so the record carries no fields at all. The line is present; the data is not.",
        prefixClock,
      });
      continue;
    }
    const objText = sliceObject(rest);
    if (!objText) {
      acc.degraded.push({
        source: `${file}:${i + 1}`,
        why: "no balanced { } payload on the line (truncated capture, or the record was split across lines)",
        prefixClock,
        raw: rest.slice(0, 200),
      });
      continue;
    }
    const parsed = looseParse(objText);
    if (!parsed.ok) {
      acc.degraded.push({
        source: `${file}:${i + 1}`,
        why: `payload did not parse: ${parsed.error}`,
        prefixClock,
        raw: objText.slice(0, 200),
      });
      continue;
    }
    pushRecord(acc, parsed.value, `${file}:${i + 1}`, prefixClock);
  }
}

function cdpArgToValue(arg) {
  if (!arg || typeof arg !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(arg, "value")) return arg.value;
  if (arg.preview && Array.isArray(arg.preview.properties)) {
    const o = {};
    for (const p of arg.preview.properties) {
      if (p.type === "number") o[p.name] = Number(p.value);
      else if (p.type === "boolean") o[p.name] = p.value === "true";
      else o[p.name] = p.value;
    }
    // A CDP preview is LOSSY: V8 caps it at 5 properties and truncates nested
    // objects. Mark it so the report can SAY so (L1) instead of leaving a
    // truncated capture looking like an unexplained coverage table.
    Object.defineProperty(o, "__fromLossyPreview", { value: true, enumerable: false });
    return o;
  }
  return undefined;
}

function extractFromJsonl(raw, file, acc) {
  const lines = raw.split(/\r?\n/);
  let any = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line[0] !== "{") continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const params = ev.params && ev.params.args ? ev.params : ev;
    if (!Array.isArray(params.args)) continue;
    const first = cdpArgToValue(params.args[0]);
    if (typeof first !== "string" || !first.startsWith(TAG)) continue;
    any = true;
    acc.seen += 1;

    // The pinned form is ONE string argument. The record is the JSON that
    // follows the tag in that same string; a second argument is the OLD
    // two-argument form and is read only if the string carried no payload, so
    // one record can never be counted twice.
    const inline = first.slice(TAG.length);
    if (inline.trim() !== "") {
      const objText = sliceObject(inline);
      const parsed = objText ? looseParse(objText) : { ok: false, error: "no balanced { } payload in the tagged string" };
      if (!parsed.ok) {
        acc.degraded.push({ source: `${file}:${i + 1}`, why: `CDP record's tagged string did not parse: ${parsed.error}`, prefixClock: null });
        continue;
      }
      pushRecord(acc, parsed.value, `${file}:${i + 1}`, null);
      continue;
    }
    const payload = cdpArgToValue(params.args[1]);
    if (!payload || typeof payload !== "object") {
      acc.degraded.push({ source: `${file}:${i + 1}`, why: "CDP record carried no readable object argument", prefixClock: null });
      continue;
    }
    if (payload.__fromLossyPreview) acc.lossyPreview += 1;
    pushRecord(acc, payload, `${file}:${i + 1}`, null);
  }
  return any;
}

function pushRecord(acc, payload, source, prefixClock) {
  const at = typeof payload.at === "string" ? payload.at : null;
  const t = typeof payload.t === "number" ? payload.t : null;
  if (at === null) {
    acc.degraded.push({ source, why: "record has no `at` — the seam literal is the pinned contract; without it the record cannot be placed", prefixClock });
    return;
  }
  if (t === null) {
    acc.degraded.push({ source, why: "record has no numeric `t` (Date.now()) — it cannot be joined to the observer series on wall clock", prefixClock, at });
    return;
  }
  if (!SEAMS.includes(at)) acc.unknownSeams.add(at);
  acc.records.push({ at, t, p: typeof payload.p === "number" ? payload.p : null, payload, source, prefixClock });
}

function loadTraces(files) {
  const acc = { records: [], degraded: [], seen: 0, unknownSeams: new Set(), lossyPreview: 0, files: [] };
  for (const f of files) {
    let raw;
    try {
      raw = fs.readFileSync(f, "utf8");
    } catch (e) {
      die(3, `cannot read log ${f}: ${e.message}`);
    }
    if (raw.trim() === "") die(3, `log ${f} is EMPTY — refusing to report "no gate-trace records" for a file that was never written`);
    acc.files.push(f);
    const before = acc.seen;
    const jsonlHit = extractFromJsonl(raw, f, acc);
    if (!jsonlHit) extractFromText(raw, f, acc);
    if (acc.seen === before) {
      process.stderr.write(`gate-trace-reduce: WARNING ${f} contains NO [gate-trace] lines\n`);
    }
  }
  acc.records.sort((a, b) => a.t - b.t);
  return acc;
}

// --------------------------------------------------------------------------
// H2 — a record from an ABANDONED Room may not reach a verdict
// --------------------------------------------------------------------------

function partitionByRoom(records) {
  const kept = [];
  const abandoned = [];
  let noKey = 0;
  for (const r of records) {
    if (!Object.prototype.hasOwnProperty.call(r.payload, SOFT_KEY_CURRENT_ROOM)) {
      kept.push(r);
      noKey += 1;
      continue;
    }
    if (r.payload[SOFT_KEY_CURRENT_ROOM] === true) kept.push(r);
    else abandoned.push(r);
  }
  return { kept, abandoned, noKey };
}

// --------------------------------------------------------------------------
// Series helpers (bytes are for pausedness ONLY; energy is the discriminator)
// --------------------------------------------------------------------------

export function seriesByRole(dump, role, skewMs) {
  const out = [];
  for (const tk of dump.ticks) {
    for (const s of tk.samples) {
      if (s.role !== role) continue;
      out.push({
        t: tk.t + skewMs,
        rawT: tk.t,
        sameReport: tk.sameReport !== false,
        ssrc: s.ssrc,
        trackIdentity: s.trackIdentity ?? null,
        trackSid: s.trackSid ?? null,
        bytes: typeof s.bytesReceived === "number" ? s.bytesReceived : null,
        packets: typeof s.packetsReceived === "number" ? s.packetsReceived : null,
        audioLevel: typeof s.audioLevel === "number" ? s.audioLevel : null,
        energy: typeof s.totalAudioEnergy === "number" ? s.totalAudioEnergy : null,
        concealed: typeof s.concealedSamples === "number" ? s.concealedSamples : null,
        lkE2ee: s.lkE2ee === true ? true : s.lkE2ee === false ? false : null,
      });
    }
  }
  return out;
}

function groupBySsrc(rows) {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.ssrc)) m.set(r.ssrc, []);
    m.get(r.ssrc).push(r);
  }
  return m;
}

function carrierContinuity(dump, skewMs, maxStallMs) {
  if (!dump.carrierSelector) {
    return { verdict: "discarded", reason: "no carrier was pinned in the capture", stalls: [] };
  }
  const rows = seriesByRole(dump, "carrier", skewMs);
  if (rows.length === 0) {
    return { verdict: "discarded", reason: "the carrier produced NO inbound-rtp samples across the window", stalls: [] };
  }
  const stalls = [];
  for (const [ssrc, arr] of groupBySsrc(rows)) {
    let stallStart = null;
    for (let i = 1; i < arr.length; i++) {
      const d = (arr[i].bytes ?? 0) - (arr[i - 1].bytes ?? 0);
      if (d <= 0) {
        if (stallStart === null) stallStart = arr[i - 1].t;
      } else {
        if (stallStart !== null && arr[i].t - stallStart > maxStallMs) {
          stalls.push({ ssrc, from: stallStart, to: arr[i].t, ms: arr[i].t - stallStart });
        }
        stallStart = null;
      }
    }
    if (stallStart !== null) {
      const last = arr[arr.length - 1];
      if (last.t - stallStart > maxStallMs) {
        stalls.push({ ssrc, from: stallStart, to: last.t, ms: last.t - stallStart, openEnded: true });
      }
    }
  }
  if (stalls.length) {
    return {
      verdict: "discarded",
      reason: `the carrier byte series is NOT continuous across the measurement window (${stalls.length} stall(s) longer than ${maxStallMs} ms)`,
      stalls,
    };
  }
  return { verdict: "continuous", reason: null, stalls: [] };
}

/** Ticks where the subject's ssrc carried NEW bytes. Pausedness, nothing else. */
export function subjectFlowWindows(rows, maxStallMs) {
  const wins = [];
  for (const [ssrc, arr] of groupBySsrc(rows)) {
    let open = null;
    let lastFlow = null;
    for (let i = 1; i < arr.length; i++) {
      const d = (arr[i].bytes ?? 0) - (arr[i - 1].bytes ?? 0);
      if (d > 0) {
        if (open === null) open = arr[i - 1];
        lastFlow = arr[i];
      } else if (open !== null && lastFlow && arr[i].t - lastFlow.t > maxStallMs) {
        wins.push({ ssrc, from: open.t, to: lastFlow.t, bytes: (lastFlow.bytes ?? 0) - (open.bytes ?? 0) });
        open = null;
        lastFlow = null;
      }
    }
    if (open !== null && lastFlow) {
      wins.push({ ssrc, from: open.t, to: lastFlow.t, bytes: (lastFlow.bytes ?? 0) - (open.bytes ?? 0), openEnded: true });
    }
  }
  wins.sort((a, b) => a.from - b.from);
  return wins;
}

export function ssrcChanges(rows) {
  const out = [];
  let last = null;
  for (const r of rows) {
    if (last !== null && r.ssrc !== last) out.push({ t: r.t, from: last, to: r.ssrc });
    last = r.ssrc;
  }
  return out;
}

/**
 * B4 — the leak window is the first flow window AT OR AFTER the SSRC-change
 * fiducial, never `flow[0]`.
 *
 * §2.4 has the operator speaking BEFORE the rejoin is pressed and the sampler
 * started BEFORE joining, so `flow[0]` is call 1 — a window on the OLD ssrc,
 * before the leave, that no rejoin evidence can possibly explain. Wave 0 read
 * M3 against it.
 */
export function pinLeakWindow(flow, changes, leakAfter, toleranceMs) {
  // A flow window OPENS at the sample BEFORE its first byte delta, and the
  // fiducial is itself only known to within one sampling interval, so
  // "at or after" is applied with exactly one interval of tolerance — stated,
  // never silent. A call-1 window sits many intervals earlier and is still
  // rejected.
  const tol = Number.isFinite(toleranceMs) ? toleranceMs : 0;
  if (flow.length === 0) {
    return { window: null, basis: "the subject's ssrc never carried new bytes in this capture", fiducial: null, rejected: [], toleranceMs: tol };
  }
  const pick = (fid, how) => {
    const qualifies = (w) => w.from >= fid - tol;
    return {
      window: flow.find(qualifies) ?? null,
      basis: `${how} (with one ${tol} ms sampling interval of tolerance, because a flow window opens at the sample BEFORE its first byte delta)`,
      fiducial: fid,
      rejected: flow.filter((w) => !qualifies(w)),
      toleranceMs: tol,
    };
  };
  if (leakAfter !== null) return pick(leakAfter, `--leak-after ${leakAfter} (operator override of the SSRC-change fiducial)`);
  if (changes.length === 0) {
    return {
      window: null,
      basis: "no SSRC-change fiducial in this capture, and no --leak-after override. flow[0] is NOT assumed to be the rejoin: §2.4 has the operator speaking before the rejoin and the sampler started before joining, so the first flow window is call 1.",
      fiducial: null,
      rejected: flow,
      toleranceMs: tol,
    };
  }
  return pick(
    changes[0].t,
    `the first flow window at or after the SSRC-change fiducial ${changes[0].t}${changes.length > 1 ? ` (the FIRST of ${changes.length} ssrc changes; use --leak-after to pick another)` : ""}`,
  );
}

// --------------------------------------------------------------------------
// M1
// --------------------------------------------------------------------------

function measureM1(dump, shape, audible, subjRows, carrRows, leak) {
  const notes = [];
  if (shape === "a") {
    return {
      verdict: "unknown",
      reason:
        "shape (a): this observer HAS an e2eeManager, so livekit installed a decode transform on every subscribed remote track. An armed cryptor fed PLAINTEXT destroys every frame silently — bytes arrive, nothing decodes, concealedSamples climbs — which is indistinguishable from ciphertext. Shape-(a) audio energy is evidence in NEITHER direction, and byte counts never were.",
      notes,
    };
  }

  const managerHere = dump.e2eeManagerPresent;
  const lkFlags = new Set(subjRows.map((r) => r.lkE2ee).filter((v) => v !== null));
  if (managerHere === true || lkFlags.has(true)) {
    return {
      verdict: "unknown",
      reason:
        "the capture declares shape (b) but the seat is NOT manager-free: " +
        (managerHere === true ? "room.e2eeManager is present" : 'the subject receiver carries livekit\'s "lk_e2ee" decode-transform flag') +
        ". F3's objection reaches this seat, so its audio energy is evidence in neither direction.",
      notes,
    };
  }
  if (managerHere === null && !lkFlags.has(false)) {
    notes.push(
      "manager-free status UNCONFIRMED: no Room was registered and no receiver carried a readable lk_e2ee flag. The shape-(b) claim rests on the operator's seat choice alone.",
    );
  }

  const w = leak.window;
  if (!w) {
    return {
      verdict: "unknown",
      reason: `no leak window could be pinned — ${leak.basis}. An absence with an unexplained cause is not a result.`,
      notes,
    };
  }
  if (leak.rejected.length) {
    notes.push(
      `${leak.rejected.length} EARLIER flow window(s) were rejected as pre-fiducial (call 1): ${leak.rejected.map((x) => `${x.from}..${x.to} ssrc=${x.ssrc}`).join("; ")}. Wave 0 read M3 against the first of these.`,
    );
  }

  const inWindow = (r) => r.ssrc === w.ssrc && r.t >= w.from && r.t <= w.to;

  // Energy must be PRESENT. A missing field is unknown, never flat.
  const energyKnown = subjRows.some((r) => inWindow(r) && r.energy !== null);
  const concealKnown = subjRows.some((r) => inWindow(r) && r.concealed !== null);

  const positives = [];
  const inWin = subjRows.filter((r) => inWindow(r) && r.energy !== null);
  for (let i = 1; i < inWin.length; i++) {
    const dE = inWin[i].energy - inWin[i - 1].energy;
    const dB = (inWin[i].bytes ?? 0) - (inWin[i - 1].bytes ?? 0);
    if (dE > 0 && dB > 0) {
      positives.push({ t: inWin[i].t, ssrc: w.ssrc, dEnergy: dE, dBytes: dB, audioLevel: inWin[i].audioLevel });
    }
  }

  if (audible === "yes") {
    return {
      verdict: "plaintext",
      reason:
        "the operator reported INTELLIGIBLE SPEECH from the subject on the manager-free observer. A keyless peer that decodes is receiving plaintext." +
        (positives.length ? ` Corroborated by ${positives.length} tick(s) of rising totalAudioEnergy in the leak window.` : " NOT corroborated by rising totalAudioEnergy in the sampled series — record that disagreement."),
      notes,
      positives,
    };
  }

  if (positives.length > 0) {
    return {
      verdict: "plaintext",
      reason: `${positives.length} tick(s) on the subject's ssrc show RISING totalAudioEnergy in the same tick as arriving bytes, on a manager-free observer. A decode is plaintext.`,
      notes,
      positives,
    };
  }

  if (!energyKnown) {
    return {
      verdict: "unknown",
      reason: "totalAudioEnergy was ABSENT from every subject sample in the leak window. A missing field is not flatness; bytes alone can never answer M1.",
      notes,
    };
  }
  if (!concealKnown) {
    return {
      verdict: "unknown",
      reason: "the subject's energy is flat, but concealedSamples was ABSENT — the ciphertext signature is flat energy AND climbing concealment, and half of it is unmeasured.",
      notes,
    };
  }

  const controlled = [];
  const subs = subjRows.filter(inWindow);
  for (let i = 1; i < subs.length; i++) {
    const a = subs[i - 1];
    const b = subs[i];
    if (a.energy === null || b.energy === null || a.concealed === null || b.concealed === null) continue;
    if (!b.sameReport) continue; // carrier + subject must be ONE sample
    const flat = b.energy - a.energy <= 0;
    const climbing = b.concealed - a.concealed > 0;
    const bytesMoving = (b.bytes ?? 0) - (a.bytes ?? 0) > 0;
    if (!(flat && climbing && bytesMoving)) continue;
    const cA = carrRows.filter((r) => r.rawT === a.rawT);
    const cB = carrRows.filter((r) => r.rawT === b.rawT);
    let carrierRising = false;
    for (const x of cB) {
      const y = cA.find((z) => z.ssrc === x.ssrc);
      if (y && y.energy !== null && x.energy !== null && x.energy - y.energy > 0) carrierRising = true;
    }
    if (carrierRising) controlled.push({ t: b.t, ssrc: w.ssrc, dConcealed: b.concealed - a.concealed });
  }
  if (controlled.length > 0) {
    return {
      verdict: "ciphertext",
      reason: `${controlled.length} tick(s) where the subject's ssrc carried bytes with FLAT totalAudioEnergy and CLIMBING concealedSamples while, IN THE SAME SAMPLE, the carrier's ssrc energy was rising. The positive control rules out a dead output path.`,
      notes,
      controlledTicks: controlled,
    };
  }
  return {
    verdict: "unknown",
    reason:
      "the subject's energy did not rise, and the ciphertext reading has NO same-tick positive control (the carrier's energy was not rising in those samples, or subject and carrier did not come from one stats report). An absence with an unexplained cause is not a result: this run selects no row.",
    notes,
  };
}

// --------------------------------------------------------------------------
// M2 — B6: only a `via:"user"` pre-clear is a real leave; M4: dedupe by `seq`
// --------------------------------------------------------------------------

function measureM2(records, coverage) {
  if (records.length === 0) {
    return { verdict: "unknown", reason: "no [gate-trace] records were recovered — neither arm is positively witnessed, and silence is not evidence for either", evidence: [], userLeaves: 0, connectLeading: 0, viaUnknown: 0, reestablishEvents: 0 };
  }
  const pre = records.filter((r) => r.at === "disconnect.preclear");
  const userLeaves = [];
  let connectLeading = 0;
  let viaUnknown = 0;
  for (const r of pre) {
    const via = readField(r, "via", coverage);
    if (!via.found) {
      viaUnknown += 1;
      continue;
    }
    if (via.value === "user") userLeaves.push(r);
    else if (via.value === "connect-leading") connectLeading += 1;
    else viaUnknown += 1;
  }

  // M4 — the two rejoinFresh records of ONE #rejoinFresh call share a `seq`.
  const fresh = records.filter((r) => r.at === "rejoinFresh");
  const seqs = new Set();
  let seqless = 0;
  for (const r of fresh) {
    const s = readField(r, "seq", coverage);
    if (s.found) seqs.add(s.value);
    else seqless += 1;
  }
  const drops = records.filter((r) => r.at === "dropModeToNegotiating");
  const reestablishEvents = seqs.size + seqless + drops.length;

  const ev = [...userLeaves, ...fresh, ...drops].map((r) => ({ at: r.at, t: r.t, source: r.source }));
  const tail =
    ` [disconnect.preclear: ${userLeaves.length} via="user", ${connectLeading} via="connect-leading" (fires on EVERY rejoin press and is NOT evidence of a leave), ${viaUnknown} with no readable via;` +
    ` rejoinFresh records ${fresh.length} => ${seqs.size} distinct seq${seqless ? ` + ${seqless} seq-less` : ""}, dropModeToNegotiating ${drops.length}]`;

  if (userLeaves.length && (seqs.size || seqless || drops.length)) {
    return { verdict: "both", reason: "BOTH arms are witnessed in this window (a real user disconnect AND an in-place re-establish). Attribute per-instant on the timeline before using this; the run is a mixed observation." + tail, evidence: ev, userLeaves: userLeaves.length, connectLeading, viaUnknown, reestablishEvents };
  }
  if (userLeaves.length) {
    return { verdict: "disconnect-ran", reason: `Voice.disconnect ran on the USER's leave: ${userLeaves.length} disconnect.preclear record(s) with via="user".` + tail, evidence: ev, userLeaves: userLeaves.length, connectLeading, viaUnknown, reestablishEvents };
  }
  if (seqs.size || seqless || drops.length) {
    return { verdict: "no-disconnect", reason: `no via="user" pre-clear; the in-place arm is positively witnessed by ${reestablishEvents} re-establish EVENT(s).` + tail, evidence: ev, userLeaves: 0, connectLeading, viaUnknown, reestablishEvents };
  }
  if (viaUnknown) {
    return { verdict: "unknown", reason: `${viaUnknown} disconnect.preclear record(s) carried no readable \`via\`. Without it a leave cannot be told from the connect-leading pre-clear that fires on every rejoin press, so NEITHER arm is witnessed.` + tail, evidence: ev, userLeaves: 0, connectLeading, viaUnknown, reestablishEvents };
  }
  return { verdict: "unknown", reason: "gate-trace records were recovered but NEITHER arm's seam appeared. Neither arm is positively witnessed." + tail, evidence: [], userLeaves: 0, connectLeading, viaUnknown, reestablishEvents };
}

// --------------------------------------------------------------------------
// M3
// --------------------------------------------------------------------------

function readPublication(entry, coverage) {
  const g = (k) => show(readPubField(entry, k, coverage));
  return {
    trackSid: g("trackSid"),
    upstreamPaused: g("upstreamPaused"),
    hasSender: g("hasSender"),
    senderHasTrack: g("senderHasTrack"),
    transportState: g("transportState"),
    upstream: g("upstream"),
    op: g("op"),
  };
}

function readSeam(rec, coverage) {
  if (!rec) return null;
  const f = (k) => readField(rec, k, coverage);
  const gate = f("gate");
  const gateSize = f("gateSize");
  // `publications` is emitted by localTrackPublished.entry ONLY. readField
  // THROWS on a key that is not in READS for THIS seam, which is how the table
  // stays honest: it cannot be read past.
  const pubsRaw = rec.at === "localTrackPublished.entry" ? f("publications") : MISSING;
  const reasons = gate.found ? (Array.isArray(gate.value) ? gate.value : [gate.value]) : "unknown";
  const publications = !pubsRaw.found
    ? "unknown"
    : !Array.isArray(pubsRaw.value)
      ? "unknown"
      : pubsRaw.value.map((e) => readPublication(e, coverage));
  const stringEntries = Array.isArray(pubsRaw.value) ? pubsRaw.value.filter((e) => typeof e === "string").length : 0;
  return {
    at: rec.at,
    t: rec.t,
    source: rec.source,
    subject: show(f("subject")),
    reasons,
    // 🔴 gateSize is read, never DERIVED from `gate.length`: a payload that
    // carries one and not the other is a contract break, and inventing the
    // number would hide it.
    gateSize: show(gateSize),
    gateGen: show(f("gateGen")),
    passes: show(f("passes")),
    publicationCount: show(f("publicationCount")),
    subjectSidPresent: show(f("subjectSidPresent")),
    publications,
    publicationsWereStrings: stringEntries,
    ...(rec.at === "localSenderCreated"
      ? {
          upstreamPaused: show(f("upstreamPaused")),
          hasSender: show(f("hasSender")),
          senderHasTrack: show(f("senderHasTrack")),
          transportState: show(f("transportState")),
        }
      : {}),
  };
}

/**
 * B5 — C0's row is "ABSENT at the leak, PRESENT at the mute", so the two
 * halves come from DIFFERENT seams and the pair is reported.
 *
 * In pinned livekit-client 2.15.13 `addTrackPublication(publication)` runs
 * BEFORE `emit(LocalTrackPublished, publication)`, so `subjectSidPresent` on
 * `localTrackPublished.entry` is `true` BY CONSTRUCTION and can only ever
 * supply the PRESENT half. Wave 0 preferred that seam for both halves, which
 * made the absent half unobservable.
 */
function measureM3(records, leak, opts, coverage) {
  const w = leak.window;
  const scopeFrom = w.from - opts.driveWindowMs;
  const muteScopeTo = w.to + opts.muteGraceMs;

  const senderSeams = records.filter((r) => r.at === "localSenderCreated" && r.t >= scopeFrom && r.t <= w.from);
  const leakSeam = senderSeams.length ? readSeam(senderSeams[senderSeams.length - 1], coverage) : null;

  const publishedBefore = records.filter((r) => r.at === "localTrackPublished.entry" && r.t >= scopeFrom && r.t <= w.from);
  const beforeSeam = publishedBefore.length ? readSeam(publishedBefore[publishedBefore.length - 1], coverage) : null;

  const publishedAfter = records.filter((r) => r.at === "localTrackPublished.entry" && r.t >= w.from && r.t <= muteScopeTo);
  const muteSeam = publishedAfter.length ? readSeam(publishedAfter[0], coverage) : null;

  // gen equality where available (H2): the leak seam and the mute seam must
  // belong to the SAME gate generation, or they are not a pair.
  let genPair = "unknown";
  if (leakSeam && muteSeam && leakSeam.gateGen !== "unknown" && muteSeam.gateGen !== "unknown") {
    genPair = leakSeam.gateGen === muteSeam.gateGen ? "same" : "different";
  }

  // B3 — drops are scoped to the drive containing the leak instant, and a drop
  // must have LANDED (`stillCurrent === true`) and belong to the same sweeper
  // generation as the gate at the leak.
  const gateGenAtLeak = leakSeam?.gateGen ?? beforeSeam?.gateGen ?? "unknown";
  const dropWindow = { from: scopeFrom, to: muteScopeTo };
  const allDrops = records.filter((r) => r.at === "sweeper.dropped");
  const dropsKept = [];
  const dropsDiscarded = [];
  for (const r of allDrops) {
    const sc = readField(r, "stillCurrent", coverage);
    const sg = readField(r, "sweeperGen", coverage);
    const why = [];
    if (r.t < dropWindow.from || r.t > dropWindow.to) {
      why.push(`outside the drive window ${dropWindow.from}..${dropWindow.to} (t=${r.t}, ${r.t < dropWindow.from ? r.t - dropWindow.from : r.t - dropWindow.to} ms)`);
    }
    if (!sc.found) why.push("no stillCurrent");
    else if (sc.value !== true) why.push("stillCurrent=false — the stale-writer guard DISCARDED this drop, so it never reached #gateEpisode.noteDropped()");
    if (!sg.found) why.push("no sweeperGen");
    else if (gateGenAtLeak === "unknown") why.push("the gate generation at the leak is unknown, so no sweeperGen can be matched against it");
    else if (sg.value !== gateGenAtLeak) why.push(`sweeperGen=${JSON.stringify(sg.value)} != gateGen=${JSON.stringify(gateGenAtLeak)} at the leak — a drive from a DIFFERENT gate generation`);
    const row = { t: r.t, stillCurrent: show(sc), sweeperGen: show(sg), source: r.source };
    if (why.length) dropsDiscarded.push({ ...row, why: why.join("; ") });
    else dropsKept.push(row);
  }

  // H3 — "immediately before the mute" is a BOUNDED window, printed.
  const resumedWindow = { from: w.to - opts.resumedWindowMs, to: w.to };
  const inResumed = (r) => r.t >= resumedWindow.from && r.t <= resumedWindow.to;
  const allResumed = records.filter((r) => r.at === "track.upstreamResumed");
  const allProcessor = records.filter((r) => r.at === "track.processorUpdate");
  const pick = (arr) =>
    arr.filter(inResumed).map((r) => ({ t: r.t, subject: show(readField(r, "subject", coverage)), source: r.source }));
  const outside = (arr) =>
    arr.filter((r) => !inResumed(r)).map((r) => ({ t: r.t, offsetMs: r.t - w.to, source: r.source }));

  return {
    leakWindow: { from: w.from, to: w.to, ssrc: w.ssrc, bytes: w.bytes },
    leakBasis: leak.basis,
    rejectedFlowWindows: leak.rejected,
    scope: { from: scopeFrom, muteTo: muteScopeTo, driveWindowMs: opts.driveWindowMs, muteGraceMs: opts.muteGraceMs },
    leakSeam,
    beforeSeam,
    muteSeam,
    genPair,
    gateGenAtLeak,
    dropWindow,
    drops: dropsKept,
    dropsDiscarded,
    resumedWindow,
    resumedWindowMs: opts.resumedWindowMs,
    upstreamResumed: pick(allResumed),
    upstreamResumedOutside: outside(allResumed),
    processorUpdate: pick(allProcessor),
    processorUpdateOutside: outside(allProcessor),
  };
}

// --------------------------------------------------------------------------
// §2.5 — first match wins, per publication, mixed goes to Investigate
// --------------------------------------------------------------------------

const ROW_TEXT = {
  C0: { c: "C0: set non-empty, the subject's publication ABSENT from trackPublications at the leak and PRESENT at the mute", w: "D0 primary" },
  C1: { c: "C1: the leave was an in-place re-establish and the gate was EMPTY at publish", w: "D2 primary, SEQUENCED WITH OR AFTER WAVE 2 (its escape half lands in mlsCallModePolicy.ts / VoiceCallCardStatus.tsx). Wave 1 may take D1/D4/D5 as hardening only." },
  C3: { c: "C3: set non-empty and a sweep drive dropped a trailing pass IN the leak's drive", w: "D4 primary" },
  C4: { c: "C4: set non-empty, no drop, publication present, flag false, UpstreamResumed inside the bounded window before the mute", w: "D6" },
  C6: { c: "C6: set non-empty, publication present, isUpstreamPaused true over a live sender track", w: "D0 primary, including the repauseSpent / repausePending interaction" },
};

/**
 * The M1-INDEPENDENT half of §2.5: which row the M2/M3 evidence describes.
 * It is called the WINDOW because C0 (and C3, and C6) predict a window that
 * may be open on EVERY call — the polarity is a separate question and is
 * answered only by --aggregate. This value can NEVER, on its own, select a
 * row: `selectRow` gates it on M1.
 */
function evaluateWindow(m2, m3) {
  const leakSeam = m3.leakSeam;
  const seam = leakSeam ?? m3.beforeSeam;
  if (!seam) {
    return { row: null, conclusion: "no localSenderCreated (and no localTrackPublished.entry) record lies inside the leak's drive window — M3 is unfillable and no row can be described", wave1: null, perPub: [] };
  }
  if (seam.gateSize === "unknown") {
    return { row: null, conclusion: `the reason-set size at the leak is unknown (${seam.at} carried no gateSize) — no row can be described`, wave1: null, perPub: [] };
  }
  const empty = Number(seam.gateSize) === 0;
  if (empty) {
    if (m2.verdict === "no-disconnect") return { row: "C1", conclusion: ROW_TEXT.C1.c, wave1: ROW_TEXT.C1.w, perPub: [] };
    if (m2.verdict === "disconnect-ran") return { row: null, conclusion: "a real user disconnect + an EMPTY set is a new carrier this plan does not account for — re-enter Investigate, do not guess", wave1: "hardening only (D1, D4, D5)", perPub: [] };
    return { row: null, conclusion: `an EMPTY set but M2 is ${m2.verdict} — the C1 row and the unaccounted row differ ONLY on M2, so no row can be described`, wave1: null, perPub: [] };
  }

  // Non-empty. §2.5 order, FIRST MATCH WINS.
  if (m3.drops.length > 0) {
    return { row: "C3", conclusion: `${ROW_TEXT.C3.c} (${m3.drops.length} kept, ${m3.dropsDiscarded.length} discarded as out-of-scope / guard-discarded / wrong generation)`, wave1: ROW_TEXT.C3.w, perPub: [] };
  }

  // C0: the pair. ABSENT at the leak (localSenderCreated) and PRESENT at the
  // mute (localTrackPublished.entry).
  const absentHalf = leakSeam ? leakSeam.subjectSidPresent : "unknown";
  const presentHalf = m3.muteSeam ? m3.muteSeam.subjectSidPresent : "unknown";
  const pair = `absent-half(localSenderCreated)=${absentHalf} present-half(localTrackPublished.entry)=${presentHalf}`;
  if (absentHalf === false) {
    if (presentHalf === true) {
      if (m3.genPair === "different") {
        return { row: null, conclusion: `the C0 pair spans TWO gate generations (${m3.leakSeam.gateGen} vs ${m3.muteSeam.gateGen}) — they are not a pair and C0 is not established. ${pair}`, wave1: null, perPub: [] };
      }
      return { row: "C0", conclusion: `${ROW_TEXT.C0.c}. ${pair}`, wave1: ROW_TEXT.C0.w, perPub: [] };
    }
    return { row: null, conclusion: `the subject's publication was ABSENT at the leak, but C0's PRESENT half is ${presentHalf === "unknown" ? "UNMEASURED (no localTrackPublished.entry inside the mute window)" : "false"} — half a row is not a row. ${pair}`, wave1: null, perPub: [] };
  }

  // Per publication, from the mute seam's census when it carries one; else the
  // subject's own flat fields at the sender seam.
  const perPub = [];
  const pubs = m3.muteSeam && Array.isArray(m3.muteSeam.publications) ? m3.muteSeam.publications : [];
  for (const p of pubs) {
    if (p.upstreamPaused === true && (p.op === "repause" || p.upstream === "live")) {
      perPub.push({ trackSid: p.trackSid, row: "C6" });
      continue;
    }
    if (p.upstreamPaused === false && m3.upstreamResumed.length > 0) {
      perPub.push({ trackSid: p.trackSid, row: "C4" });
      continue;
    }
    perPub.push({ trackSid: p.trackSid, row: null });
  }
  if (pubs.length === 0 && leakSeam) {
    const lp = leakSeam.upstreamPaused;
    if (lp === true && leakSeam.senderHasTrack === true) perPub.push({ trackSid: leakSeam.subject, row: "C6", via: "localSenderCreated flat fields" });
    else if (lp === false && m3.upstreamResumed.length > 0) perPub.push({ trackSid: leakSeam.subject, row: "C4", via: "localSenderCreated flat fields" });
  }

  const distinct = [...new Set(perPub.map((p) => p.row))].filter((r) => r !== null);
  if (distinct.length > 1) {
    return { row: "MIXED", conclusion: `two or more rows genuinely hold across publications (${distinct.join(", ")}) — this is a MIXED observation and goes to "re-enter Investigate", never to whichever row was read first`, wave1: null, perPub };
  }
  if (distinct.length === 1) {
    const row = distinct[0];
    return { row, conclusion: ROW_TEXT[row].c, wave1: ROW_TEXT[row].w, perPub };
  }
  if (pubs.length === 0 && perPub.length === 0) {
    return { row: null, conclusion: `the set was non-empty but no seam carried per-publication detail — C6 and C4 are unseparable here. Do NOT default to C4; that is the exact defect F4 corrects. ${pair}`, wave1: null, perPub };
  }
  return { row: null, conclusion: `set non-empty, no in-scope drop, and none of C0/C6/C4 matched — unaccounted, re-enter Investigate. Do NOT default to C4. ${pair}`, wave1: "hardening only (D0, D1, D4, D5)", perPub };
}

function selectRow(m1, windowEval, shape) {
  const windowRow = windowEval.row;
  if (shape === "a") {
    return { row: null, windowRow, conclusion: "shape (a) runs contribute M2/M3 and the clean negotiating window and may CORROBORATE a row, never SELECT one — their M1 cell is unknown, which matches no row", wave1: null, perPub: windowEval.perPub };
  }
  if (m1.verdict === "ciphertext") {
    return {
      row: "C2",
      windowRow,
      conclusion: "there was no plaintext leak in this run; the user-facing defect is then the banner/chip being silent through the window, which is waves 2-3",
      wave1: "re-scope into waves 2-3 and record the new measurement ALONGSIDE the banked entry. No row may edit or delete the banked 2/2 defect.",
      perPub: windowEval.perPub,
    };
  }
  if (m1.verdict !== "plaintext") {
    return { row: null, windowRow, conclusion: "M1 has no value; this run selects NO row of the decision table", wave1: null, perPub: windowEval.perPub };
  }
  return { row: windowRow, windowRow, conclusion: windowEval.conclusion, wave1: windowEval.wave1, perPub: windowEval.perPub };
}

// --------------------------------------------------------------------------
// output
// --------------------------------------------------------------------------

function writeAtomic(file, text) {
  // Encode FIRST, then temp + fsync + rename. A truncating open that then hits
  // an encode error leaves a ZERO-BYTE file that reads like a clean empty run.
  const buf = Buffer.from(text, "utf8");
  const dir = path.dirname(path.resolve(file));
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  const fd = fs.openSync(tmp, "wx");
  try {
    fs.writeSync(fd, buf, 0, buf.length, 0);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function fmt(t) {
  return `${new Date(t).toISOString().slice(11, 23)} (${t})`;
}

// --------------------------------------------------------------------------
// --check-log (B7's pre-flight instrument)
// --------------------------------------------------------------------------

function runCheckLog(file) {
  const traces = loadTraces([file]);
  const out = [];
  out.push("=========== [gate-trace] log pre-flight ===========");
  out.push(`log      : ${file}`);
  out.push(`tagged lines : ${traces.seen}`);
  out.push(`parsed records: ${traces.records.length}`);
  out.push(`degraded      : ${traces.degraded.length}`);
  for (const d of traces.degraded.slice(0, 10)) out.push(`   ${d.source}: ${d.why}`);
  if (traces.unknownSeams.size) out.push(`unrecognised seams: ${[...traces.unknownSeams].join(", ")}`);
  const bySeam = {};
  for (const r of traces.records) bySeam[r.at] = (bySeam[r.at] ?? 0) + 1;
  out.push(`seams seen    : ${Object.keys(bySeam).length ? Object.entries(bySeam).map(([k, v]) => `${k}=${v}`).join(" ") : "(none)"}`);
  if (traces.seen === 0) {
    out.push("PRE-FLIGHT: FAIL — the log carries NO [gate-trace] lines at all. Either the bundle is not the instrumented one, or Chromium is not forwarding renderer console.error at this verbosity.");
    process.stdout.write(out.join("\n") + "\n");
    process.exit(3);
  }
  if (traces.degraded.length > 0 || traces.records.length === 0) {
    out.push("PRE-FLIGHT: FAIL — tagged lines reached the log but the payloads did NOT survive. THE LINES BEING PRESENT IS NOT THE TELL: an object argument renders as [object Object] and the record then carries no fields at all.");
    process.stdout.write(out.join("\n") + "\n");
    process.exit(3);
  }
  out.push("PRE-FLIGHT: PASS — at least one [gate-trace] record reached this log PARSEABLE, with every tagged line parsed.");
  process.stdout.write(out.join("\n") + "\n");
  process.exit(0);
}

// --------------------------------------------------------------------------
// --aggregate (§2.5's H3 polarity rule — M1 of this lane's contract)
// --------------------------------------------------------------------------

function runAggregate(files) {
  const reports = [];
  for (const f of files) {
    const r = readJsonStrict(f, "reduction report");
    if (r.schema !== REDUCTION_SCHEMA) {
      die(3, `reduction report ${f} has schema ${JSON.stringify(r.schema)}, expected ${REDUCTION_SCHEMA}`);
    }
    if (r.inputs?.consent !== "yes" && r.inputs?.consent !== "no") {
      die(3, `reduction report ${f} does not name its consent arm — polarity cannot be computed from it`);
    }
    reports.push({ file: f, r });
  }

  const arms = { yes: [], no: [] };
  for (const x of reports) arms[x.r.inputs.consent].push(x);

  const out = [];
  out.push("============ §2.5 H3 — POLARITY ACROSS THE ARMS ============");
  for (const arm of ["yes", "no"]) {
    out.push(`consent=${arm}: ${arms[arm].length} run(s)`);
    for (const x of arms[arm]) {
      out.push(`    ${path.basename(x.file)}  shape=${x.r.inputs.shape} discarded=${x.r.discarded} M1=${x.r.M1.verdict} row=${x.r.decision.row ?? "-"} windowRow=${x.r.decision.windowRow ?? "-"}`);
    }
  }
  out.push("");

  const usable = (arm) => arms[arm].filter((x) => !x.r.discarded && x.r.inputs.shape === "b");
  const leakIn = (arm) => usable(arm).some((x) => x.r.M1.verdict === "plaintext");
  const windowRows = (arm) => new Set(usable(arm).map((x) => x.r.decision.windowRow).filter((v) => v && v !== "MIXED"));

  const finish = (code, verdict, lines) => {
    out.push(`POLARITY OUTCOME  : ${verdict}`);
    for (const l of lines) out.push(`    ${l}`);
    out.push("============================================================");
    process.stdout.write(out.join("\n") + "\n");
    process.exit(code);
  };

  out.push(`shape-(b), non-discarded runs: consent=yes ${usable("yes").length}, consent=no ${usable("no").length}`);
  out.push(`leak (M1=plaintext) present  : consent=yes ${leakIn("yes")}, consent=no ${leakIn("no")}`);
  out.push(`window rows (M1-INDEPENDENT) : consent=yes {${[...windowRows("yes")].join(",") || "-"}}, consent=no {${[...windowRows("no")].join(",") || "-"}}`);
  out.push("");

  if (usable("yes").length === 0) {
    finish(7, "NOTHING SELECTED", ["there are no usable shape-(b) consent runs. §2.5 is evaluated on shape (b); shape (a) may corroborate, never select."]);
  }
  if (!leakIn("yes")) {
    finish(7, "NOTHING SELECTED", [
      "the CONSENT arm never reproduced the leak. §2.5: a series that never reproduces the leak in the consent arm is an absence with an unexplained cause and selects NOTHING at all.",
      "The banked 2/2-vs-0/2 entry is untouched. §4.1 stays OPEN.",
    ]);
  }
  const cRows = windowRows("yes");
  if (cRows.size === 0) {
    finish(7, "NOTHING SELECTED", ["the consent arm reproduced the leak but describes NO window row — re-enter Investigate."]);
  }
  if (cRows.size > 1) {
    finish(7, "NOTHING SELECTED", [`the consent arm describes MORE THAN ONE window row (${[...cRows].join(", ")}) — a mixed observation goes to "re-enter Investigate", never to whichever row was read first.`]);
  }
  const R = [...cRows][0];

  if (leakIn("no")) {
    finish(7, "NOTHING SELECTED", [
      `the leak (M1 = plaintext) appears in BOTH arms, so this series does not reproduce the banked 2-for-2-with-consent / 0-for-2-without polarity at all.`,
      "Record the new measurement ALONGSIDE the banked entry; do not edit or delete it. §4.1 stays OPEN.",
    ]);
  }

  if (windowRows("no").has(R)) {
    finish(6, `${R} confirmed as the WINDOW — POLARITY UNEXPLAINED`, [
      `${R} fires in BOTH arms while the leak appears ONLY in the consent arm, so ${R} predicts the WINDOW and not the polarity.`,
      "This result is INCOMPLETE. §4.1 is NOT closed, the banked 2/2-vs-0/2 entry stands untouched, and the slice re-enters Investigate for the consent-dependent term.",
      "The two carriers this plan has named are C1's `localConfirmed` exemptions and D3's native per-channel grant (§1.4, G5).",
      `The wave-1 fix for ${R} may be taken as HARDENING only. Without this rule a "${R} confirmed" reading closes a consent-triggered defect with a fix for a window that was open on every call.`,
    ]);
  }

  finish(0, `${R} confirmed`, [
    `${R} fires in the consent arm and NOT in the no-consent arm, and the leak appears only in the consent arm — the row accounts for the polarity as well as the window.`,
    ROW_TEXT[R] ? `wave 1: ${ROW_TEXT[R].w}` : "wave 1: see §2.5",
    `no-consent arm window rows: {${[...windowRows("no")].join(",") || "-"}}`,
  ]);
}

// --------------------------------------------------------------------------

function runReduce(args) {
  const dump = loadSampler(args.sampler);
  const traces = args.logs.length ? loadTraces(args.logs) : { records: [], degraded: [], seen: 0, unknownSeams: new Set(), lossyPreview: 0, files: [] };

  if (dump.shape && dump.shape !== args.shape) {
    die(3, `the capture declares shape ${JSON.stringify(dump.shape)} but --shape ${args.shape} was passed — refusing to reduce a run under the wrong shape`);
  }
  if (dump.consent && dump.consent !== args.consent) {
    die(3, `the capture declares consent ${JSON.stringify(dump.consent)} but --consent ${args.consent} was passed — refusing to file a run into the wrong arm`);
  }

  const skew = args.skewMs;
  const subjRows = seriesByRole(dump, "subject", skew);
  const carrRows = seriesByRole(dump, "carrier", skew);
  const cc = carrierContinuity(dump, skew, args.maxStallMs);
  const changes = ssrcChanges(subjRows);

  // H2 — records from an ABANDONED Room may not reach a verdict.
  const rooms = partitionByRoom(traces.records);
  const records = rooms.kept;

  // H1 — the fiducial is the MINUS-negotiating edge that EMPTIED the gate on
  // the CURRENT room, not any resumeGate at all. A release of "mixed" or
  // "enable-window", a non-emptying release, or the stale-room drop is a
  // different event, and letting one stand in rescues a genuinely unaligned
  // run.
  const coverage = {};
  const allResume = records.filter((r) => r.at === "resumeGate");
  const negEdges = [];
  const negRejected = [];
  for (const r of allResume) {
    const staleRoom = readField(r, "staleRoom", coverage);
    const reason = readField(r, "reason", coverage);
    const emptied = readField(r, "emptied", coverage);
    const why = [];
    if (!staleRoom.found) why.push("no staleRoom");
    else if (staleRoom.value !== false) why.push("staleRoom=true (the stale-room drop, not a release on this room)");
    if (!reason.found) why.push("no reason");
    else if (reason.value !== "negotiating") why.push(`reason=${JSON.stringify(reason.value)} (only the negotiating release is the fiducial)`);
    if (!emptied.found) why.push("no emptied");
    else if (emptied.value !== true) why.push("emptied=false (the set did not reach size 0, so this is not the -negotiating EDGE)");
    if (why.length) negRejected.push({ t: r.t, why: why.join("; "), source: r.source });
    else negEdges.push(r);
  }

  let alignment;
  if (skew !== 0) {
    alignment = { status: "waived", reason: `--clock-skew-ms ${skew} was applied, which WAIVES the fiducial check; the run's alignment is asserted by the operator, not measured` };
  } else if (changes.length === 0 || negEdges.length === 0) {
    alignment = { status: "unknown", reason: `no fiducial pair available (subject ssrc changes: ${changes.length}, qualifying resumeGate edges: ${negEdges.length} of ${allResume.length} resumeGate records) — alignment is UNVERIFIED, which is not the same as unaligned: the run is not discarded on this account` };
  } else {
    let best = null;
    for (const c of changes) {
      for (const e of negEdges) {
        const d = Math.abs(c.t - e.t);
        if (best === null || d < best.ms) best = { ms: d, ssrcChangeAt: c.t, edgeAt: e.t, edge: e.at };
      }
    }
    alignment =
      best.ms > dump.intervalMs
        ? { status: "unaligned", reason: `the nearest ssrc-change / qualifying-resumeGate fiducial pair disagree by ${best.ms} ms, beyond one ${dump.intervalMs} ms sampling interval — the run is unaligned and is discarded`, ...best }
        : { status: "aligned", reason: `fiducials agree within ${best.ms} ms (ssrc change vs the emptying -negotiating release)`, ...best };
  }

  const discarded = cc.verdict === "discarded" || alignment.status === "unaligned";

  const flow = subjectFlowWindows(subjRows, args.maxStallMs);
  const leak = pinLeakWindow(flow, changes, args.leakAfter, dump.intervalMs);

  const m1 = discarded
    ? { verdict: "unknown", reason: `the run is DISCARDED, NOT INTERPRETED (${cc.verdict === "discarded" ? cc.reason : alignment.reason})`, notes: [] }
    : measureM1(dump, args.shape, args.audible, subjRows, carrRows, leak);
  const m2 = discarded ? { verdict: "unknown", reason: "the run is discarded", evidence: [], userLeaves: 0, connectLeading: 0, viaUnknown: 0, reestablishEvents: 0 } : measureM2(records, coverage);
  const m3 =
    discarded || leak.window === null
      ? { unfillable: true, leakWindow: null, leakBasis: leak.basis, rejectedFlowWindows: leak.rejected, leakSeam: null, beforeSeam: null, muteSeam: null, genPair: "unknown", drops: [], dropsDiscarded: [], upstreamResumed: [], upstreamResumedOutside: [], processorUpdate: [], processorUpdateOutside: [] }
      : measureM3(records, leak, args, coverage);

  const windowEval = discarded || m3.unfillable
    ? { row: null, conclusion: discarded ? "DISCARDED, NOT INTERPRETED" : `no leak window could be pinned — ${leak.basis}`, wave1: null, perPub: [] }
    : evaluateWindow(m2, m3);

  const decision = discarded
    ? { row: null, windowRow: null, conclusion: "DISCARDED, NOT INTERPRETED — this run selects no row", wave1: null, perPub: [] }
    : selectRow(m1, windowEval, args.shape);

  const report = {
    schema: REDUCTION_SCHEMA,
    inputs: { sampler: args.sampler, logs: traces.files, shape: args.shape, consent: args.consent, audibleSubject: args.audible, clockSkewMs: skew, maxStallMs: args.maxStallMs, driveWindowMs: args.driveWindowMs, muteGraceMs: args.muteGraceMs, resumedWindowMs: args.resumedWindowMs, leakAfter: args.leakAfter },
    capture: { label: dump.label, seat: dump.seat, intervalMs: dump.intervalMs, ticks: dump.ticks.length, truncated: !!dump.truncated, lateTicks: dump.lateTicks, statsErrors: dump.statsErrors, e2eeManagerPresent: dump.e2eeManagerPresent, roomRegistered: dump.roomRegistered },
    publications: dump.publications,
    carrierContinuity: cc,
    fiducialEdges: { qualifying: negEdges.map((r) => ({ t: r.t, source: r.source })), rejected: negRejected },
    alignment,
    discarded,
    subjectSsrcChanges: changes,
    subjectFlowWindows: flow,
    leakPin: { basis: leak.basis, fiducial: leak.fiducial, window: leak.window, rejected: leak.rejected },
    traceRecords: records.length,
    traceRecordsFromAbandonedRoom: rooms.abandoned.map((r) => ({ at: r.at, t: r.t, source: r.source })),
    traceRecordsWithoutCurrentRoom: rooms.noKey,
    traceDegraded: traces.degraded,
    traceUnknownSeams: [...traces.unknownSeams],
    traceLossyPreviewRecords: traces.lossyPreview,
    M1: m1,
    M2: m2,
    M3: m3,
    windowEval,
    decision,
    coverage,
  };

  if (!args.quiet) {
    const out = [];
    out.push("================ leg reduction ================");
    out.push(`sampler : ${args.sampler}  (label=${dump.label} seat=${dump.seat} shape=${args.shape} consent=${args.consent} ticks=${dump.ticks.length})`);
    out.push(`logs    : ${traces.files.length ? traces.files.join(", ") : "(none)"}  records=${records.length} degraded=${traces.degraded.length}`);
    out.push("");
    out.push("--- inputs this reduction NEVER reads: muted / enabled (annotationOnly). Pausedness is bytes only.");
    out.push("");
    out.push(`carrier continuity : ${cc.verdict}${cc.reason ? " — " + cc.reason : ""}`);
    for (const s of cc.stalls) out.push(`    stall ssrc=${s.ssrc} ${fmt(s.from)} .. ${fmt(s.to)} (${s.ms} ms)${s.openEnded ? " [open-ended]" : ""}`);
    out.push(`alignment          : ${alignment.status} — ${alignment.reason}`);
    if (negRejected.length) {
      out.push(`    resumeGate records REJECTED as the fiducial (${negRejected.length}):`);
      for (const r of negRejected.slice(0, 10)) out.push(`      t=${r.t}: ${r.why}`);
    }
    out.push(`DISCARDED          : ${discarded ? "YES — not interpreted" : "no"}`);
    out.push("");
    out.push(`ABANDONED-ROOM records EXCLUDED (currentRoom === false): ${rooms.abandoned.length}`);
    out.push(`records carrying NO currentRoom (kept, unfilterable, COUNTED)  : ${rooms.noKey}`);
    out.push(`CDP LOSSY-PREVIEW records (V8's 5-property cap truncated them) : ${traces.lossyPreview}`);
    if (traces.lossyPreview > 0) {
      out.push("    🔴 a lossy preview drops fields silently — an unexplained gap in the coverage table below is EXPLAINED by this number, and the capture should be retaken from the Chromium log rather than CDP.");
    }
    out.push("");
    out.push("--- leak window (B4: the first flow window at or AFTER the fiducial, never flow[0]) ---");
    out.push(`    basis  : ${leak.basis}`);
    out.push(`    window : ${leak.window ? `${fmt(leak.window.from)} .. ${fmt(leak.window.to)} ssrc=${leak.window.ssrc} (+${leak.window.bytes} B)` : "NONE"}`);
    for (const r of leak.rejected) out.push(`    REJECTED as pre-fiducial (call 1): ${fmt(r.from)} .. ${fmt(r.to)} ssrc=${r.ssrc} (+${r.bytes} B)`);
    out.push("");
    out.push("--- timeline (wall clock) ---");
    const events = [];
    for (const c of changes) events.push({ t: c.t, what: `SSRC CHANGE on subject: ${c.from} -> ${c.to}   [the fiducial]` });
    for (const w of flow) events.push({ t: w.from, what: `subject bytes START ssrc=${w.ssrc}` }, { t: w.to, what: `subject bytes STOP  ssrc=${w.ssrc} (+${w.bytes} B over ${w.to - w.from} ms)` });
    for (const r of traces.records) events.push({ t: r.t, what: `[gate-trace] ${r.at}  ${JSON.stringify(r.payload)}` });
    events.sort((a, b) => a.t - b.t);
    if (events.length === 0) out.push("    (no events)");
    for (const e of events) out.push(`  ${fmt(e.t)}  ${e.what}`);
    out.push("");
    if (traces.degraded.length) {
      out.push("--- DEGRADED [gate-trace] lines (payload unrecoverable) ---");
      for (const d of traces.degraded.slice(0, 20)) out.push(`  ${d.source}: ${d.why}`);
      if (traces.degraded.length > 20) out.push(`  ... ${traces.degraded.length - 20} more`);
      out.push("");
    }
    if (traces.unknownSeams.size) out.push(`--- UNRECOGNISED seam literals: ${[...traces.unknownSeams].join(", ")}`);
    out.push("--- payload coverage (a missing field makes its row unfillable, never a default) ---");
    const keys = Object.keys(coverage).sort();
    if (keys.length === 0) out.push("    (no seam payloads were read)");
    for (const k of keys) out.push(`    ${k.padEnd(44)} found=${coverage[k].found} missing=${coverage[k].missing}`);
    out.push("");
    out.push(`M1 (plaintext?)   : ${m1.verdict}`);
    out.push(`    ${m1.reason}`);
    for (const n of m1.notes ?? []) out.push(`    NOTE: ${n}`);
    out.push(`M2 (real leave?)  : ${m2.verdict}`);
    out.push(`    ${m2.reason}`);
    out.push(`M3 (reason set + census at the leak) :`);
    if (m3.unfillable) out.push(`    unknown — ${discarded ? "the run is discarded" : `no leak instant (${leak.basis})`}`);
    else {
      out.push(`    drive scope: ${m3.scope.from} .. ${m3.scope.muteTo}  (drive-window ${m3.scope.driveWindowMs} ms before the leak, mute-grace ${m3.scope.muteGraceMs} ms after the flow window)`);
      for (const [label, s] of [["leak   (localSenderCreated)", m3.leakSeam], ["before (localTrackPublished.entry)", m3.beforeSeam], ["mute   (localTrackPublished.entry)", m3.muteSeam]]) {
        out.push(`    ${label}: ${s ? `t=${s.t} subject=${s.subject} reasons=${JSON.stringify(s.reasons)} gateSize=${s.gateSize} gateGen=${s.gateGen} publicationCount=${s.publicationCount} subjectSidPresent=${s.subjectSidPresent} passes=${s.passes}` : "unknown (no such record in scope)"}`);
        if (s && Array.isArray(s.publications)) {
          for (const p of s.publications) out.push(`        pub ${p.trackSid}: paused=${p.upstreamPaused} sender=${p.hasSender} senderTrack=${p.senderHasTrack} transport=${p.transportState} upstream=${p.upstream} op=${p.op}`);
        } else if (s && s.publications === "unknown" && s.at === "localTrackPublished.entry") {
          out.push(`        publications: unknown${s.publicationsWereStrings ? ` (${s.publicationsWereStrings} entries were STRINGS, not objects — the pinned contract is objects)` : ""}`);
        }
      }
      out.push(`    C0 pair (B5): absent-half from localSenderCreated = ${m3.leakSeam ? m3.leakSeam.subjectSidPresent : "unknown"}, present-half from localTrackPublished.entry = ${m3.muteSeam ? m3.muteSeam.subjectSidPresent : "unknown"}, gate generations ${m3.genPair}`);
      out.push(`    sweeper.dropped: ${m3.drops.length} in the leak's drive, ${m3.dropsDiscarded.length} discarded`);
      for (const d of m3.dropsDiscarded) out.push(`        DISCARDED drop t=${d.t} stillCurrent=${d.stillCurrent} sweeperGen=${d.sweeperGen}: ${d.why}`);
      out.push(`    upstreamResumed: ${m3.upstreamResumed.length} inside ${m3.resumedWindow.from}..${m3.resumedWindow.to} (the ${m3.resumedWindowMs} ms window before the mute), ${m3.upstreamResumedOutside.length} outside`);
      for (const r of m3.upstreamResumedOutside) out.push(`        OUTSIDE upstreamResumed t=${r.t} (${r.offsetMs} ms relative to the flow window's end)`);
      out.push(`    processorUpdate: ${m3.processorUpdate.length} inside the same window, ${m3.processorUpdateOutside.length} outside`);
    }
    out.push("");
    out.push(`WINDOW (M1-independent) : ${windowEval.row ?? "no row"}`);
    out.push(`    ${windowEval.conclusion}`);
    out.push("    🔴 the window row can NEVER select a §2.5 row on its own — see --aggregate for the polarity rule.");
    for (const p of decision.perPub ?? []) out.push(`    per publication ${p.trackSid}: ${p.row ?? "no row"}${p.via ? ` (via ${p.via})` : ""}`);
    out.push(`DECISION (§2.5)   : ${decision.row ?? "no row"}`);
    out.push(`    ${decision.conclusion}`);
    if (decision.wave1) out.push(`    wave 1: ${decision.wave1}`);
    out.push("===============================================");
    process.stdout.write(out.join("\n") + "\n");
  }

  if (args.out) writeAtomic(args.out, JSON.stringify(report, null, 2) + "\n");

  if (discarded) process.exit(4);
  if (args.requireVerdict && m1.verdict === "unknown") process.exit(5);
  process.exit(0);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.checkLog) return runCheckLog(args.checkLog);
  if (args.aggregate.length) return runAggregate(args.aggregate);
  return runReduce(args);
}

// Importable by selftest-sampler.mjs (which checks READS/SEAM_KEYS against the
// EMITTERS) without running the CLI.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
