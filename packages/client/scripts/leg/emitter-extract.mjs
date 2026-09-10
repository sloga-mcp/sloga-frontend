#!/usr/bin/env node
/*
 * emitter-extract.mjs — read the `[gate-trace]` EMITTERS and report, per seam,
 * exactly which payload keys they emit.
 *
 *   node packages/client/scripts/leg/emitter-extract.mjs [file...]
 *
 * ---------------------------------------------------------------------------
 * 🔴 WHY THIS FILE EXISTS.
 *
 * Wave 0's reducer read payload fields through a list of GUESSED alias names
 * and its selftest proved the reducer against fixtures the same lane had
 * HAND-WRITTEN with those same guesses. Both sides agreed; neither matched the
 * emitters. A decision-table row passed on a fixture that could not occur.
 *
 * The defect was not the aliases — it was the METHOD. So the fixtures are no
 * longer typed by a human at all: they are generated from the key sets this
 * file extracts out of `components/rtc/state.tsx` and
 * `components/rtc/mlsCallSession.ts` themselves. If an emitter renames a key,
 * the fixture renames with it and the bidirectional check in
 * `selftest-sampler.mjs` goes RED.
 *
 * This lane does not own those two files and never writes to them. It reads.
 *
 * ---------------------------------------------------------------------------
 * The pinned emit form is ONE pre-serialized string:
 *
 *   console.error("[gate-trace] " + JSON.stringify({ ... }))
 *
 * An object ARGUMENT (`console.error("[gate-trace]", { ... })`) renders in the
 * packaged Chromium log as `[object Object]` — the lines are present and the
 * data is gone — so a site in that form is reported as a PROBLEM, not quietly
 * parsed.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TAG = "[gate-trace]";

/**
 * Blank out comments, preserving every offset and every newline, so that
 * everything downstream can use plain string indexing without ever matching
 * inside a comment. String, template and regex literals are preserved.
 */
export function stripComments(src) {
  const out = src.split("");
  let i = 0;
  const n = src.length;
  let prevSignificant = "";
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      let j = i;
      while (j < n && src[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "/" && d === "*") {
      let j = i + 2;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
      blank(i, Math.min(j + 2, n));
      i = j + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === c) break;
        j++;
      }
      i = j + 1;
      prevSignificant = "str";
      continue;
    }
    if (c === "`") {
      // Template literal, with ${ } nesting. Anything inside ${ } is code and
      // could itself hold a comment; blanking it is not needed for our
      // purposes (we never index inside a template), so skip the whole thing.
      let j = i + 1;
      let depth = 0;
      while (j < n) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === "$" && src[j + 1] === "{") { depth++; j += 2; continue; }
        if (src[j] === "}" && depth > 0) { depth--; j++; continue; }
        if (src[j] === "`" && depth === 0) break;
        j++;
      }
      i = j + 1;
      prevSignificant = "str";
      continue;
    }
    if (c === "/" && regexCanStart(prevSignificant)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === "\n") break;
        if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        else if (src[j] === "/" && !inClass) { closed = true; break; }
        j++;
      }
      if (closed) {
        i = j + 1;
        prevSignificant = "str";
        continue;
      }
      // not a regex after all — fall through as an operator
    }
    if (!/\s/.test(c)) prevSignificant = c;
    i++;
  }
  return out.join("");
}

function regexCanStart(prev) {
  if (prev === "" ) return true;
  if (prev === "str") return false;
  return "(,=:[!&|?{};+-*%~^<>".includes(prev);
}

/**
 * Balanced scan from `src[start]` (which must be an opening bracket), skipping
 * strings and templates. Returns the index AFTER the matching close, or -1.
 * `src` is expected to be comment-stripped.
 */
export function matchBracket(src, start) {
  const open = src[start];
  const close = open === "{" ? "}" : open === "[" ? "]" : open === "(" ? ")" : null;
  if (!close) return -1;
  let depth = 0;
  let i = start;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === c) break;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (c === "`") {
      let j = i + 1;
      let d = 0;
      while (j < n) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === "$" && src[j + 1] === "{") { d++; j += 2; continue; }
        if (src[j] === "}" && d > 0) { d--; j++; continue; }
        if (src[j] === "`" && d === 0) break;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return -1;
}

/**
 * Split an object literal's body into top-level segments (comma separated at
 * depth 1). `src` is comment-stripped; `start` points at the `{`.
 */
export function objectSegments(src, start) {
  const end = matchBracket(src, start);
  if (end < 0) return null;
  const segs = [];
  let depth = 0;
  let segStart = start + 1;
  let i = start;
  while (i < end) {
    const c = src[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < end) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === c) break;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (c === "`") {
      let j = i + 1;
      let d = 0;
      while (j < end) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === "$" && src[j + 1] === "{") { d++; j += 2; continue; }
        if (src[j] === "}" && d > 0) { d--; j++; continue; }
        if (src[j] === "`" && d === 0) break;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") {
      depth--;
      if (depth === 0) {
        segs.push(src.slice(segStart, i));
        break;
      }
    } else if (c === "," && depth === 1) {
      segs.push(src.slice(segStart, i));
      segStart = i + 1;
    }
    i++;
  }
  return { end, segments: segs.map((s) => s.trim()).filter((s) => s !== "") };
}

const KEY_RE = /^(?:([A-Za-z_$][A-Za-z0-9_$]*)|"([^"]+)"|'([^']+)')\s*(:|$)/;

export function segmentKey(seg) {
  if (seg.startsWith("...")) return { spread: true };
  const m = KEY_RE.exec(seg);
  if (!m) return { unparsed: true };
  const key = m[1] ?? m[2] ?? m[3];
  const value = m[4] === ":" ? seg.slice(m[0].length).trim() : key; // shorthand
  return { key, value, shorthand: m[4] !== ":" };
}

function lineOf(src, idx) {
  let line = 1;
  for (let i = 0; i < idx && i < src.length; i++) if (src[i] === "\n") line++;
  return line;
}

/**
 * Extract the key set of the objects pushed into / mapped into the array that
 * a `publications:` value names. Returns a Set, or null when the shape is not
 * extractable — never a guess.
 */
function publicationEntryKeys(clean, valueExpr) {
  const keys = new Set();
  let found = false;
  const idm = /^([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(valueExpr);
  const collectAt = (braceIdx) => {
    const parsed = objectSegments(clean, braceIdx);
    if (!parsed) return;
    for (const seg of parsed.segments) {
      const k = segmentKey(seg);
      if (k.key) keys.add(k.key);
    }
    found = true;
  };
  const skipWs = (i) => {
    while (i < clean.length && /\s/.test(clean[i])) i++;
    return i;
  };
  if (idm) {
    const ident = idm[1];
    for (const marker of [`${ident}.push(`, `${ident} = [`, `${ident}: `]) {
      let from = 0;
      for (;;) {
        const at = clean.indexOf(marker, from);
        if (at < 0) break;
        from = at + marker.length;
        let i = skipWs(at + marker.length);
        if (clean[i] === "{") collectAt(i);
      }
    }
  }
  // `X.map((p) => ({ ... }))` and inline array literals of objects.
  if (!found) {
    const src = idm ? clean : valueExpr;
    const arrow = src.indexOf("=> ({");
    if (arrow >= 0) collectAt(src.indexOf("{", arrow + 3));
    else if (valueExpr.startsWith("[")) {
      const b = valueExpr.indexOf("{");
      if (b >= 0) {
        const parsed = objectSegments(valueExpr, b);
        if (parsed) {
          for (const seg of parsed.segments) {
            const k = segmentKey(seg);
            if (k.key) keys.add(k.key);
          }
          found = true;
        }
      }
    }
  }
  return found ? keys : null;
}

/** Extract every `[gate-trace]` emit site from the given source files. */
export function extractEmitters(files) {
  const seams = new Map();
  const problems = [];
  let pubEntryKeys = null;
  const sites = [];

  for (const file of files) {
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (e) {
      problems.push({ kind: "unreadable", file, detail: e.message });
      continue;
    }
    const clean = stripComments(raw);
    let from = 0;
    for (;;) {
      const at = clean.indexOf(TAG, from);
      if (at < 0) break;
      from = at + TAG.length;
      // The tag must be inside a string literal that is the first argument of
      // console.error. Find the end of that string.
      const quote = clean.lastIndexOf('"', at);
      if (quote < 0) {
        problems.push({ kind: "not-a-string", file, line: lineOf(raw, at), detail: "the tag is not inside a double-quoted string literal" });
        continue;
      }
      let end = at + TAG.length;
      while (end < clean.length && clean[end] !== '"') end++;
      let i = end + 1;
      while (i < clean.length && /\s/.test(clean[i])) i++;

      let form;
      let braceIdx = -1;
      if (clean[i] === "+") {
        i++;
        while (i < clean.length && /\s/.test(clean[i])) i++;
        if (clean.startsWith("JSON.stringify(", i)) {
          let j = i + "JSON.stringify(".length;
          while (j < clean.length && /\s/.test(clean[j])) j++;
          if (clean[j] === "{") {
            form = "pinned-string";
            braceIdx = j;
          }
        }
      } else if (clean[i] === ",") {
        let j = i + 1;
        while (j < clean.length && /\s/.test(clean[j])) j++;
        if (clean[j] === "{") {
          form = "object-argument";
          braceIdx = j;
        }
      }
      const line = lineOf(raw, at);
      if (braceIdx < 0) {
        problems.push({ kind: "unrecognised-emit-form", file, line, detail: `the emit site is neither \`"${TAG} " + JSON.stringify({...})\` nor \`"${TAG}", {...}\` — this extractor cannot read it, and refuses to guess` });
        continue;
      }
      if (form === "object-argument") {
        problems.push({
          kind: "not-pre-serialized",
          file,
          line,
          detail: `console.error("${TAG}", {...}) passes an OBJECT ARGUMENT. In the packaged Chromium log that renders as [object Object]: the line is present and every field is gone. The pinned form is one pre-serialized string.`,
        });
      }
      const parsed = objectSegments(clean, braceIdx);
      if (!parsed) {
        problems.push({ kind: "unbalanced-payload", file, line, detail: "the payload object literal is not balanced" });
        continue;
      }
      const keys = [];
      let atLiteral = null;
      let pubValue = null;
      for (const seg of parsed.segments) {
        const k = segmentKey(seg);
        if (k.spread) {
          problems.push({ kind: "spread", file, line, detail: `the payload spreads \`${seg}\`, so its key set is not statically knowable` });
          continue;
        }
        if (!k.key) {
          problems.push({ kind: "unparsed-key", file, line, detail: `could not read a key from the payload segment \`${seg.slice(0, 60)}\`` });
          continue;
        }
        keys.push(k.key);
        if (k.key === "at") {
          const m = /^"([^"]+)"$/.exec(k.value) ?? /^'([^']+)'$/.exec(k.value);
          if (m) atLiteral = m[1];
        }
        if (k.key === "publications") pubValue = k.value;
      }
      if (!atLiteral) {
        problems.push({ kind: "no-at-literal", file, line, detail: "the payload has no `at:` with a plain string literal — the seam name is the pinned contract and must not be computed" });
        continue;
      }
      sites.push({ file, line, at: atLiteral, form, keys });
      if (!seams.has(atLiteral)) seams.set(atLiteral, { keys: new Set(), sites: [] });
      const s = seams.get(atLiteral);
      for (const k of keys) s.keys.add(k);
      s.sites.push({ file, line, form });
      if (pubValue !== null) {
        const pk = publicationEntryKeys(clean, pubValue);
        if (pk === null) {
          problems.push({ kind: "publications-not-extractable", file, line, detail: `the \`publications:\` value \`${pubValue.slice(0, 60)}\` is not an expression this extractor can follow to an object literal. Its entry key set is UNKNOWN and no fixture may be generated for it.` });
        } else {
          pubEntryKeys = pubEntryKeys ?? new Set();
          for (const k of pk) pubEntryKeys.add(k);
        }
      }
    }
  }
  return { seams, sites, problems, pubEntryKeys };
}

// --------------------------------------------------------------------------

function cli() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const files = process.argv.slice(2);
  const targets = files.length
    ? files
    : [
        path.resolve(here, "../../components/rtc/state.tsx"),
        path.resolve(here, "../../components/rtc/mlsCallSession.ts"),
      ];
  const { seams, problems, pubEntryKeys, sites } = extractEmitters(targets);
  const out = [];
  out.push("=========== [gate-trace] emitter extraction ===========");
  for (const f of targets) out.push(`source: ${f}`);
  out.push(`sites : ${sites.length}   seams: ${seams.size}`);
  for (const [at, v] of [...seams].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push(`  ${at}`);
    out.push(`      keys : ${[...v.keys].join(", ")}`);
    out.push(`      sites: ${v.sites.map((s) => `${path.basename(s.file)}:${s.line}(${s.form})`).join(" ")}`);
  }
  out.push(`publications[] entry keys: ${pubEntryKeys ? [...pubEntryKeys].join(", ") : "NOT EXTRACTABLE"}`);
  if (problems.length) {
    out.push(`PROBLEMS (${problems.length}):`);
    for (const p of problems) out.push(`  ${p.kind} ${path.basename(p.file ?? "?")}:${p.line ?? "?"} — ${p.detail}`);
  }
  out.push("======================================================");
  process.stdout.write(out.join("\n") + "\n");
  process.exit(problems.length ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  cli();
}
