#!/usr/bin/env node
/*
 * gate-trace-reduce.mjs — the [gate-trace] log reducer for the consent-rejoin
 * media leak leg (rejoin-leak-plan.md §2.2 / §2.4 / §2.5, wave 0, lane W0-C).
 *
 *   node packages/client/scripts/leg/gate-trace-reduce.mjs \
 *     --sampler run5.json --log subject.log --shape b \
 *     --audible-subject yes|no|unknown [--out run5.reduced.json]
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
 *  - A MISSING field is `unknown`, never a zero and never a "flat". If
 *    totalAudioEnergy is absent from the stats, M1 is `unknown`, not
 *    "ciphertext".
 *  - shape (a) ALWAYS yields M1 = unknown. On a seat that has an e2eeManager
 *    livekit installs a decode transform on every subscribed remote track and
 *    an armed cryptor fed PLAINTEXT destroys every frame silently — bytes
 *    arrive, nothing decodes, concealedSamples climbs. That is this plan's
 *    declared ciphertext signature produced by a genuine plaintext leak, so
 *    shape-(a) audio energy is evidence in NEITHER direction.
 *  - `ciphertext` is an ABSENCE and is admissible ONLY with a same-tick
 *    POSITIVE CONTROL: the carrier's ssrc audible with rising totalAudioEnergy
 *    in the very ticks where the subject's ssrc carries bytes with flat energy
 *    and climbing concealedSamples.
 *  - A run whose carrier byte series is not continuous is DISCARDED, NOT
 *    INTERPRETED, and selects no row of §2.5.
 *  - It selects a §2.5 row only from a shape-(b) run with an M1 value.
 *
 * Exit status:
 *   0  a report was produced
 *   3  an input was missing, unreadable, truncated or of the wrong schema —
 *      no report, because a partial parse is how a truncated capture becomes a
 *      confident verdict
 *   4  the run is DISCARDED (carrier not continuous / no carrier) — the
 *      timeline is printed, no verdict is
 *   5  --require-verdict was passed and M1 has no value
 *
 * ---------------------------------------------------------------------------
 * PINNED CROSS-FILE CONTRACT (rejoin-leak-plan.md, "Wave 0 lanes"): the log
 * tag is the literal `[gate-trace]` and every record is one
 *   console.error("[gate-trace]", { t, p, at, ... })
 * where `at` is a stable string literal naming the seam. The `at` literals are
 * pinned in SEAMS below; an unrecognised `at` is reported, never dropped.
 *
 * 🔴 The PAYLOAD KEY NAMES beyond { t, p, at } are NOT pinned by that
 * contract — they belong to W0-A (state.tsx) and W0-B (mlsCallSession.ts),
 * which this lane does not own. So every payload field is read through an
 * ALIAS list and anything not found is reported as `unknown` in an explicit
 * coverage table rather than defaulted. If the coverage table shows a field
 * missing, that field's M3 row is unfillable and says so.
 */

import fs from "node:fs";
import path from "node:path";

const SAMPLER_SCHEMA = "sloga-leg-sampler/1";

/** The pinned `at` literals. An `at` outside this set is surfaced, not dropped. */
const SEAMS = [
  "connect.add",
  "disconnect.preclear",
  "pauseGate",
  "pauseGate.staleRoom",
  "resumeGate",
  "localTrackPublished.entry",
  "localSenderCreated",
  "sweeper.dropped",
  "track.upstreamResumed",
  "track.processorUpdate",
  "setMode",
  "applyMode.effect",
  "dropModeToNegotiating",
  "rejoinFresh",
];

/** Payload aliases. First hit wins; absence is `unknown`, never a default. */
const ALIASES = {
  gate: ["gate", "reasons", "publishGate", "gateSet", "set"],
  gateSize: ["gateSize", "size", "reasonCount"],
  censusSize: [
    "censusSize",
    "pubCount",
    "trackPublicationsSize",
    "trackPublications",
    "publicationCount",
    "pubs",
  ],
  subjectSidPresent: [
    "subjectSidPresent",
    "sidPresent",
    "sidInMap",
    "inCensus",
    "present",
    "sidIsKey",
  ],
  publications: ["publications", "pubDetails", "entries", "gated", "perPub"],
  passes: ["passes", "sweeperPasses", "gateSweeperPasses"],
  stillCurrent: ["stillCurrent", "current"],
  trackSid: ["trackSid", "sid"],
  upstreamPaused: ["upstreamPaused", "isUpstreamPaused", "paused"],
  hasSender: ["hasSender", "sender"],
  senderHasTrack: ["senderHasTrack", "senderTrack", "hasSenderTrack"],
  transportState: ["transportState", "transport"],
  upstream: ["upstream", "upstreamState"],
  op: ["op", "verdict", "gateOp", "publishGateOp"],
};

function alias(obj, key) {
  if (!obj || typeof obj !== "object") return { found: false, value: undefined, via: null };
  for (const name of ALIASES[key] ?? [key]) {
    if (Object.prototype.hasOwnProperty.call(obj, name)) {
      return { found: true, value: obj[name], via: name };
    }
  }
  return { found: false, value: undefined, via: null };
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

function die(code, msg) {
  process.stderr.write(`gate-trace-reduce: ${msg}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { logs: [], shape: null, audible: "unknown", skewMs: 0, out: null, requireVerdict: false, maxStallMs: 500, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) die(3, `${a} needs a value`);
      return v;
    };
    switch (a) {
      case "--sampler": out.sampler = next(); break;
      case "--log": out.logs.push(next()); break;
      case "--shape": out.shape = next(); break;
      case "--audible-subject": out.audible = next(); break;
      case "--clock-skew-ms": out.skewMs = Number(next()); break;
      case "--max-stall-ms": out.maxStallMs = Number(next()); break;
      case "--out": out.out = next(); break;
      case "--require-verdict": out.requireVerdict = true; break;
      case "--quiet": out.quiet = true; break;
      case "-h":
      case "--help":
        process.stdout.write(HELP);
        process.exit(0);
        break;
      default:
        die(3, `unknown argument ${a}`);
    }
  }
  if (!out.sampler) die(3, "--sampler <file> is required; there is no reduction without the observer series");
  if (out.shape !== "a" && out.shape !== "b") {
    die(3, '--shape a|b is required. Shape decides whether M1 has a value at all: on shape (a) it never does.');
  }
  if (!["yes", "no", "unknown"].includes(out.audible)) {
    die(3, "--audible-subject must be yes|no|unknown (the operator's ear, recorded honestly)");
  }
  if (!Number.isFinite(out.skewMs)) die(3, "--clock-skew-ms must be a number");
  return out;
}

const HELP = `gate-trace-reduce.mjs — reduce a leg capture to M1/M2/M3 (rejoin-leak-plan.md wave 0)

  --sampler <file>            REQUIRED. observer-sampler.js dump (JSON).
  --log <file>                Chromium log and/or CDP console capture. Repeatable.
  --shape a|b                 REQUIRED. shape (a) => M1 is always unknown.
  --audible-subject yes|no|unknown
                              The operator's ear on the shape-(b) manager-free
                              observer. Plaintext is a POSITIVE finding.
  --clock-skew-ms <n>         Added to sampler wall clock before joining. Using
                              it WAIVES the fiducial alignment check and says so.
  --max-stall-ms <n>          Carrier continuity threshold (default 500).
  --out <file>                Write the reduction as JSON (temp + fsync + rename).
  --require-verdict           Exit 5 if M1 has no value.
  --quiet                     Suppress the human timeline; still writes --out.

Exit: 0 report, 3 bad input, 4 run discarded, 5 no verdict under --require-verdict.
`;

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

/** Best-effort repair of a console-printed JS object literal into JSON. */
function looseParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    /* fall through */
  }
  let t = text
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
    const tagAt = line.indexOf("[gate-trace]");
    if (tagAt < 0) continue;
    acc.seen += 1;
    const rest = line.slice(tagAt + "[gate-trace]".length);
    const prefix = CHROMIUM_PREFIX.exec(line);
    const prefixClock = prefix ? `${prefix[1]}-${prefix[2]} ${prefix[3]}:${prefix[4]}:${prefix[5]}.${prefix[6]}` : null;

    if (/\[object Object\]/.test(rest)) {
      acc.degraded.push({
        source: `${file}:${i + 1}`,
        why: "the payload was stringified to [object Object] — Chromium's console serializer collapsed the object argument, so the record carries no fields",
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
    // A CDP preview is LOSSY: it caps property count and truncates nested
    // objects. Mark it so the coverage table can say so.
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
    if (first !== "[gate-trace]") continue;
    any = true;
    acc.seen += 1;
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
// Series helpers (bytes are for pausedness ONLY; energy is the discriminator)
// --------------------------------------------------------------------------

function seriesByRole(dump, role, skewMs) {
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
function subjectFlowWindows(rows, maxStallMs) {
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

function ssrcChanges(rows) {
  const out = [];
  let last = null;
  for (const r of rows) {
    if (last !== null && r.ssrc !== last) out.push({ t: r.t, from: last, to: r.ssrc });
    last = r.ssrc;
  }
  return out;
}

// --------------------------------------------------------------------------
// M1
// --------------------------------------------------------------------------

function measureM1(dump, shape, audible, subjRows, carrRows, maxStallMs) {
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

  const flow = subjectFlowWindows(subjRows, maxStallMs);
  if (flow.length === 0) {
    return {
      verdict: "unknown",
      reason: "the subject's ssrc never carried new bytes in this capture — there is no leak window to classify, and an absence with an unexplained cause is not a result",
      notes,
      flowWindows: flow,
    };
  }

  // Energy must be PRESENT. A missing field is unknown, never flat.
  const energyKnown = subjRows.some((r) => r.energy !== null);
  const concealKnown = subjRows.some((r) => r.concealed !== null);

  // POSITIVE finding: within a flow window, the subject's energy rises (or the
  // operator heard intelligible speech). Bytes are the co-requirement, never
  // the evidence.
  const positives = [];
  for (const w of flow) {
    const inWin = subjRows.filter((r) => r.ssrc === w.ssrc && r.t >= w.from && r.t <= w.to && r.energy !== null);
    for (let i = 1; i < inWin.length; i++) {
      const dE = inWin[i].energy - inWin[i - 1].energy;
      const dB = (inWin[i].bytes ?? 0) - (inWin[i - 1].bytes ?? 0);
      if (dE > 0 && dB > 0) {
        positives.push({ t: inWin[i].t, ssrc: w.ssrc, dEnergy: dE, dBytes: dB, audioLevel: inWin[i].audioLevel });
      }
    }
  }

  if (audible === "yes") {
    return {
      verdict: "plaintext",
      reason:
        "the operator reported INTELLIGIBLE SPEECH from the subject on the manager-free observer. A keyless peer that decodes is receiving plaintext." +
        (positives.length ? ` Corroborated by ${positives.length} tick(s) of rising totalAudioEnergy in the same flow window.` : " NOT corroborated by rising totalAudioEnergy in the sampled series — record that disagreement."),
      notes,
      flowWindows: flow,
      positives,
    };
  }

  if (positives.length > 0) {
    return {
      verdict: "plaintext",
      reason: `${positives.length} tick(s) on the subject's ssrc show RISING totalAudioEnergy in the same tick as arriving bytes, on a manager-free observer. A decode is plaintext.`,
      notes,
      flowWindows: flow,
      positives,
    };
  }

  if (!energyKnown) {
    return {
      verdict: "unknown",
      reason: "totalAudioEnergy was ABSENT from every subject sample. A missing field is not flatness; bytes alone can never answer M1.",
      notes,
      flowWindows: flow,
    };
  }

  // CIPHERTEXT is an ABSENCE and needs a SAME-TICK POSITIVE CONTROL.
  if (!concealKnown) {
    return {
      verdict: "unknown",
      reason: "the subject's energy is flat, but concealedSamples was ABSENT — the ciphertext signature is flat energy AND climbing concealment, and half of it is unmeasured.",
      notes,
      flowWindows: flow,
    };
  }
  const controlled = [];
  for (const w of flow) {
    const subs = subjRows.filter((r) => r.ssrc === w.ssrc && r.t >= w.from && r.t <= w.to);
    for (let i = 1; i < subs.length; i++) {
      const a = subs[i - 1];
      const b = subs[i];
      if (a.energy === null || b.energy === null || a.concealed === null || b.concealed === null) continue;
      if (!b.sameReport) continue; // carrier + subject must be ONE sample
      const flat = b.energy - a.energy <= 0;
      const climbing = b.concealed - a.concealed > 0;
      const bytesMoving = (b.bytes ?? 0) - (a.bytes ?? 0) > 0;
      if (!(flat && climbing && bytesMoving)) continue;
      // same-tick positive control on the CARRIER
      const cA = carrRows.filter((r) => r.rawT === a.rawT);
      const cB = carrRows.filter((r) => r.rawT === b.rawT);
      let carrierRising = false;
      for (const x of cB) {
        const y = cA.find((z) => z.ssrc === x.ssrc);
        if (y && y.energy !== null && x.energy !== null && x.energy - y.energy > 0) carrierRising = true;
      }
      if (carrierRising) controlled.push({ t: b.t, ssrc: w.ssrc, dConcealed: b.concealed - a.concealed });
    }
  }
  if (controlled.length > 0) {
    return {
      verdict: "ciphertext",
      reason: `${controlled.length} tick(s) where the subject's ssrc carried bytes with FLAT totalAudioEnergy and CLIMBING concealedSamples while, IN THE SAME SAMPLE, the carrier's ssrc energy was rising. The positive control rules out a dead output path.`,
      notes,
      flowWindows: flow,
      controlledTicks: controlled,
    };
  }
  return {
    verdict: "unknown",
    reason:
      "the subject's energy did not rise, and the ciphertext reading has NO same-tick positive control (the carrier's energy was not rising in those samples, or subject and carrier did not come from one stats report). An absence with an unexplained cause is not a result: this run selects no row.",
    notes,
    flowWindows: flow,
  };
}

// --------------------------------------------------------------------------
// M2
// --------------------------------------------------------------------------

function measureM2(records) {
  if (records.length === 0) {
    return { verdict: "unknown", reason: "no [gate-trace] records were recovered — neither arm is positively witnessed, and silence is not evidence for either", evidence: [] };
  }
  const pre = records.filter((r) => r.at === "disconnect.preclear");
  const inPlace = records.filter((r) => r.at === "rejoinFresh" || r.at === "dropModeToNegotiating");
  const ev = [...pre, ...inPlace].map((r) => ({ at: r.at, t: r.t, source: r.source }));
  if (pre.length && inPlace.length) {
    return { verdict: "both", reason: "BOTH arms are witnessed in this window (a real disconnect AND an in-place re-establish). Attribute per-instant on the timeline before using this; the run is a mixed observation.", evidence: ev };
  }
  if (pre.length) return { verdict: "disconnect-ran", reason: `Voice.disconnect ran: ${pre.length} disconnect.preclear record(s)`, evidence: ev };
  if (inPlace.length) return { verdict: "no-disconnect", reason: `no disconnect.preclear; the in-place arm is positively witnessed by ${inPlace.length} rejoinFresh/dropModeToNegotiating record(s)`, evidence: ev };
  return { verdict: "unknown", reason: "gate-trace records were recovered but NEITHER arm's seam appeared. Neither arm is positively witnessed.", evidence: [] };
}

// --------------------------------------------------------------------------
// M3
// --------------------------------------------------------------------------

function readPublication(entry, coverage) {
  const get = (key) => {
    const r = alias(entry, key);
    coverage[key] = coverage[key] ?? { found: 0, missing: 0, via: new Set() };
    if (r.found) {
      coverage[key].found += 1;
      coverage[key].via.add(r.via);
    } else {
      coverage[key].missing += 1;
    }
    return r.found ? r.value : "unknown";
  };
  return {
    trackSid: get("trackSid"),
    upstreamPaused: get("upstreamPaused"),
    hasSender: get("hasSender"),
    senderHasTrack: get("senderHasTrack"),
    transportState: get("transportState"),
    upstream: get("upstream"),
    op: get("op"),
  };
}

function measureM3(records, leakAt, coverage) {
  const before = (at) => {
    const c = records.filter((r) => r.at === at && r.t <= leakAt);
    return c.length ? c[c.length - 1] : null;
  };
  const published = before("localTrackPublished.entry");
  const senderCreated = before("localSenderCreated");

  const readSeam = (rec) => {
    if (!rec) return null;
    const g = alias(rec.payload, "gate");
    const gs = alias(rec.payload, "gateSize");
    const cs = alias(rec.payload, "censusSize");
    const sp = alias(rec.payload, "subjectSidPresent");
    const ps = alias(rec.payload, "passes");
    const pubsA = alias(rec.payload, "publications");
    for (const [k, r] of [["gate", g], ["gateSize", gs], ["censusSize", cs], ["subjectSidPresent", sp], ["passes", ps], ["publications", pubsA]]) {
      coverage[k] = coverage[k] ?? { found: 0, missing: 0, via: new Set() };
      if (r.found) {
        coverage[k].found += 1;
        coverage[k].via.add(r.via);
      } else coverage[k].missing += 1;
    }
    const reasons = g.found ? (Array.isArray(g.value) ? g.value : [g.value]) : "unknown";
    const size = gs.found ? gs.value : Array.isArray(reasons) ? reasons.length : "unknown";
    const pubs = pubsA.found && Array.isArray(pubsA.value) ? pubsA.value.map((e) => readPublication(e, coverage)) : "unknown";
    return {
      at: rec.at,
      t: rec.t,
      source: rec.source,
      reasons,
      gateSize: size,
      censusSize: cs.found ? cs.value : "unknown",
      subjectSidPresent: sp.found ? sp.value : "unknown",
      passes: ps.found ? ps.value : "unknown",
      publications: pubs,
    };
  };

  const drops = records.filter((r) => r.at === "sweeper.dropped");
  const resumedNear = records.filter((r) => r.at === "track.upstreamResumed");
  const processorNear = records.filter((r) => r.at === "track.processorUpdate");

  return {
    leakAt,
    published: readSeam(published),
    senderCreated: readSeam(senderCreated),
    drops: drops.map((r) => ({ t: r.t, stillCurrent: alias(r.payload, "stillCurrent").found ? alias(r.payload, "stillCurrent").value : "unknown", passes: alias(r.payload, "passes").found ? alias(r.payload, "passes").value : "unknown", source: r.source })),
    upstreamResumed: resumedNear.map((r) => ({ t: r.t, source: r.source })),
    processorUpdate: processorNear.map((r) => ({ t: r.t, source: r.source })),
    coverage,
  };
}

// --------------------------------------------------------------------------
// §2.5 — first match wins, per publication, mixed goes to Investigate
// --------------------------------------------------------------------------

function selectRow(m1, m2, m3) {
  if (m1.verdict === "ciphertext") {
    return {
      row: "C2",
      conclusion: "there was no plaintext leak in this run; the user-facing defect is then the banner/chip being silent through the window, which is waves 2-3",
      wave1: "re-scope into waves 2-3 and record the new measurement ALONGSIDE the banked entry. No row may edit or delete the banked 2/2 defect.",
    };
  }
  if (m1.verdict !== "plaintext") {
    return { row: null, conclusion: "M1 has no value; this run selects NO row of the decision table", wave1: null };
  }
  const seam = m3.published ?? m3.senderCreated;
  if (!seam) {
    return { row: null, conclusion: "M1 = plaintext but NO localTrackPublished.entry or localSenderCreated record precedes the leak — M3 is unfillable and no row can be selected", wave1: null };
  }
  const size = seam.gateSize;
  if (size === "unknown") {
    return { row: null, conclusion: "M1 = plaintext but the reason-set size at publish is unknown (the seam payload did not carry it) — no row can be selected", wave1: null };
  }
  const empty = Number(size) === 0;
  if (empty) {
    if (m2.verdict === "no-disconnect") {
      return { row: "C1", conclusion: "C1 confirmed: the leave was an in-place re-establish and the gate was EMPTY at publish", wave1: "D2 primary, SEQUENCED WITH OR AFTER WAVE 2 (its escape half lands in mlsCallModePolicy.ts / VoiceCallCardStatus.tsx). Wave 1 may take D1/D4/D5 as hardening only." };
    }
    if (m2.verdict === "disconnect-ran") {
      return { row: null, conclusion: "plaintext + a real disconnect + an EMPTY set is a new carrier this plan does not account for — re-enter Investigate, do not guess", wave1: "hardening only (D1, D4, D5)" };
    }
    return { row: null, conclusion: "plaintext with an EMPTY set but M2 is unknown — the C1 and the unaccounted row differ only on M2, so no row can be selected", wave1: null };
  }

  // Non-empty. Evaluate per publication, first match wins WITHIN a publication.
  const pubs = Array.isArray(seam.publications) ? seam.publications : [];
  const perPub = [];
  const dropped = m3.drops.length > 0;
  for (const p of pubs) {
    if (dropped) {
      perPub.push({ trackSid: p.trackSid, row: "C3" });
      continue;
    }
    if (seam.subjectSidPresent === false) {
      perPub.push({ trackSid: p.trackSid, row: "C0" });
      continue;
    }
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
  // No per-publication detail at all: fall back to the run-level discriminators
  // that ARE readable, and stay unknown rather than defaulting to C4.
  if (pubs.length === 0) {
    if (dropped) return { row: "C3", conclusion: "C3 confirmed: the set was non-empty and a sweep drive dropped a trailing pass", wave1: "D4 primary", perPub };
    if (seam.subjectSidPresent === false) return { row: "C0", conclusion: "C0 confirmed: the set was non-empty and the subject's publication was ABSENT from trackPublications at the leak", wave1: "D0 primary", perPub };
    return { row: null, conclusion: "the set was non-empty but the seam carried no per-publication detail — C6 and C4 are unseparable here. Do NOT default to C4; that is the exact defect F4 corrects.", wave1: null, perPub };
  }
  const distinct = [...new Set(perPub.map((p) => p.row))].filter((r) => r !== null);
  if (distinct.length > 1) {
    return { row: "MIXED", conclusion: `two or more rows genuinely hold across publications (${distinct.join(", ")}) — this is a MIXED observation and goes to "re-enter Investigate", never to whichever row was read first`, wave1: null, perPub };
  }
  if (distinct.length === 1) {
    const row = distinct[0];
    const map = {
      C0: { c: "C0 confirmed: set non-empty, the publication ABSENT from trackPublications at the leak", w: "D0 primary" },
      C3: { c: "C3 confirmed: set non-empty and a sweep drive dropped a trailing pass", w: "D4 primary" },
      C6: { c: "C6 confirmed: set non-empty, publication present, isUpstreamPaused true over a live sender track", w: "D0 primary, including the repauseSpent / repausePending interaction" },
      C4: { c: "C4 confirmed: set non-empty, no drop, publication present, flag false, UpstreamResumed before the mute", w: "D6" },
    };
    return { row, conclusion: map[row].c, wave1: map[row].w, perPub };
  }
  return { row: null, conclusion: "set non-empty, no drop, and none of C0/C6/C4 matched — unaccounted, re-enter Investigate. Do NOT default to C4.", wave1: "hardening only (D0, D1, D4, D5)", perPub };
}

// --------------------------------------------------------------------------
// output
// --------------------------------------------------------------------------

/**
 * The coverage table stores `via` as a Set so a duplicate alias hit is not
 * double-counted. JSON.stringify renders a Set as `{}`, which would silently
 * empty the one table that says which M3 fields were unreadable — so it is
 * converted before serialization, never left to the serializer.
 */
function plainCoverage(coverage) {
  const out = {};
  for (const [k, v] of Object.entries(coverage ?? {})) {
    out[k] = { found: v.found, missing: v.missing, via: [...v.via] };
  }
  return out;
}

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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dump = loadSampler(args.sampler);
  const traces = args.logs.length ? loadTraces(args.logs) : { records: [], degraded: [], seen: 0, unknownSeams: new Set(), lossyPreview: 0, files: [] };

  if (dump.shape && dump.shape !== args.shape) {
    die(3, `the capture declares shape ${JSON.stringify(dump.shape)} but --shape ${args.shape} was passed — refusing to reduce a run under the wrong shape`);
  }

  const skew = args.skewMs;
  const subjRows = seriesByRole(dump, "subject", skew);
  const carrRows = seriesByRole(dump, "carrier", skew);
  const cc = carrierContinuity(dump, skew, args.maxStallMs);
  const changes = ssrcChanges(subjRows);

  // Fiducial alignment. Default assumes one wall clock (both seats on one box).
  let alignment;
  if (skew !== 0) {
    alignment = { status: "waived", reason: `--clock-skew-ms ${skew} was applied, which WAIVES the fiducial check; the run's alignment is asserted by the operator, not measured` };
  } else {
    // The plan's fiducial pair is the SSRC change on the observer and the
    // MINUS-negotiating edge on the subject. That edge is seam 4, `resumeGate`
    // — not `connect.add`, which is the PLUS edge and sits a whole connect
    // earlier, and not `rejoinFresh`, which is an M2 witness. Widening this
    // set turns every run "unaligned" and discards good captures.
    const negEdges = traces.records.filter((r) => r.at === "resumeGate");
    if (changes.length === 0 || negEdges.length === 0) {
      alignment = { status: "unknown", reason: `no fiducial pair available (subject ssrc changes: ${changes.length}, resumeGate edges: ${negEdges.length}) — alignment is UNVERIFIED, which is not the same as unaligned: the run is not discarded on this account` };
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
          ? { status: "unaligned", reason: `the nearest ssrc-change / resumeGate fiducial pair disagree by ${best.ms} ms, beyond one ${dump.intervalMs} ms sampling interval — the run is unaligned and is discarded`, ...best }
          : { status: "aligned", reason: `fiducials agree within ${best.ms} ms (ssrc change vs ${best.edge})`, ...best };
    }
  }

  const discarded = cc.verdict === "discarded" || alignment.status === "unaligned";

  const flow = subjectFlowWindows(subjRows, args.maxStallMs);
  const leakAt = flow.length ? flow[0].from : null;

  const m1 = discarded
    ? { verdict: "unknown", reason: `the run is DISCARDED, NOT INTERPRETED (${cc.verdict === "discarded" ? cc.reason : alignment.reason})`, notes: [] }
    : measureM1(dump, args.shape, args.audible, subjRows, carrRows, args.maxStallMs);
  const m2 = discarded ? { verdict: "unknown", reason: "the run is discarded", evidence: [] } : measureM2(traces.records);
  const coverage = {};
  const m3 = discarded || leakAt === null
    ? { leakAt, published: null, senderCreated: null, drops: [], upstreamResumed: [], processorUpdate: [], coverage, unfillable: true }
    : measureM3(traces.records, leakAt, coverage);

  const decision = discarded
    ? { row: null, conclusion: "DISCARDED, NOT INTERPRETED — this run selects no row", wave1: null }
    : args.shape === "a"
      ? { row: null, conclusion: "shape (a) runs contribute M2/M3 and the clean negotiating window and may CORROBORATE a row, never SELECT one — their M1 cell is unknown, which matches no row", wave1: null }
      : selectRow(m1, m2, m3);

  const report = {
    schema: "sloga-leg-reduction/1",
    inputs: { sampler: args.sampler, logs: traces.files, shape: args.shape, audibleSubject: args.audible, clockSkewMs: skew, maxStallMs: args.maxStallMs },
    capture: { label: dump.label, seat: dump.seat, intervalMs: dump.intervalMs, ticks: dump.ticks.length, truncated: !!dump.truncated, lateTicks: dump.lateTicks, statsErrors: dump.statsErrors, e2eeManagerPresent: dump.e2eeManagerPresent, roomRegistered: dump.roomRegistered },
    publications: dump.publications,
    carrierContinuity: cc,
    alignment,
    discarded,
    subjectSsrcChanges: changes,
    subjectFlowWindows: flow,
    traceRecords: traces.records.length,
    traceDegraded: traces.degraded,
    traceUnknownSeams: [...traces.unknownSeams],
    traceLossyPreviewRecords: traces.lossyPreview,
    M1: m1,
    M2: m2,
    M3: { ...m3, coverage: plainCoverage(m3.coverage) },
    decision,
  };

  if (!args.quiet) {
    const out = [];
    out.push("================ leg reduction ================");
    out.push(`sampler : ${args.sampler}  (label=${dump.label} seat=${dump.seat} shape=${args.shape} ticks=${dump.ticks.length})`);
    out.push(`logs    : ${traces.files.length ? traces.files.join(", ") : "(none)"}  records=${traces.records.length} degraded=${traces.degraded.length}`);
    out.push("");
    out.push("--- inputs this reduction NEVER reads: muted / enabled (annotationOnly). Pausedness is bytes only.");
    out.push("");
    out.push(`carrier continuity : ${cc.verdict}${cc.reason ? " — " + cc.reason : ""}`);
    for (const s of cc.stalls) out.push(`    stall ssrc=${s.ssrc} ${fmt(s.from)} .. ${fmt(s.to)} (${s.ms} ms)${s.openEnded ? " [open-ended]" : ""}`);
    out.push(`alignment          : ${alignment.status} — ${alignment.reason}`);
    out.push(`DISCARDED          : ${discarded ? "YES — not interpreted" : "no"}`);
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
    out.push("--- M3 field coverage (a missing field makes its row unfillable, never a default) ---");
    const cov = m3.coverage ?? {};
    const keys = Object.keys(cov);
    if (keys.length === 0) out.push("    (no seam payloads were read)");
    for (const k of keys) out.push(`    ${k.padEnd(20)} found=${cov[k].found} missing=${cov[k].missing} via=${[...cov[k].via].join("|") || "-"}`);
    out.push("");
    out.push(`M1 (plaintext?)   : ${m1.verdict}`);
    out.push(`    ${m1.reason}`);
    for (const n of m1.notes ?? []) out.push(`    NOTE: ${n}`);
    out.push(`M2 (real leave?)  : ${m2.verdict}`);
    out.push(`    ${m2.reason}`);
    out.push(`M3 (reason set + census at the leak) :`);
    if (m3.unfillable) out.push("    unknown — no leak instant, or the run is discarded");
    else {
      for (const key of ["senderCreated", "published"]) {
        const s = m3[key];
        out.push(`    ${key}: ${s ? `t=${s.t} reasons=${JSON.stringify(s.reasons)} size=${s.gateSize} census=${s.censusSize} subjectSidPresent=${s.subjectSidPresent} passes=${s.passes}` : "unknown (no such record before the leak)"}`);
        if (s && Array.isArray(s.publications)) for (const p of s.publications) out.push(`        pub ${p.trackSid}: paused=${p.upstreamPaused} sender=${p.hasSender} senderTrack=${p.senderHasTrack} transport=${p.transportState} upstream=${p.upstream} op=${p.op}`);
      }
      out.push(`    sweeper.dropped: ${m3.drops.length}  upstreamResumed: ${m3.upstreamResumed.length}  processorUpdate: ${m3.processorUpdate.length}`);
    }
    out.push("");
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

main();
