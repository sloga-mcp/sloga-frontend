// Guard against source files whose names differ only by case; run with
// Node's built-in runner:
//   node --conditions=browser --test src/caseCollisions.test.ts
// On a case-insensitive filesystem (macOS APFS, Windows NTFS) an import of
// `./CipherPromo` next to both `CipherPromo.tsx` and `cipherPromo.ts` resolves
// to whichever extension vite tries first (`.ts` before `.tsx`), so the build
// breaks on those machines and passes on Linux. That shipped in v0.69.0 and
// only surfaced on the first iOS bundle built on the Mac mini.
//
// Two names collide when they sit in the same directory and their stems (the
// name minus its last extension) are equal ignoring case but not equal as
// written. Point `CASE_COLLISION_ROOT` at another client tree (the known-bad
// control: a v0.69.0 `packages/client`) to scan that instead; it must fail.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT =
  process.env.CASE_COLLISION_ROOT ||
  fileURLToPath(new URL("..", import.meta.url));

/** Directories scanned, relative to the client package */
const SCANNED = ["components", "src"];

/** Every extension vite's resolver tries for an extensionless import */
const SOURCE = /\.(?:[cm]?[jt]sx?|json)$/;

/**
 * Pairs of names in one directory listing whose stems differ only by case,
 * as `[a, b]` with `a` sorting first.
 */
function caseCollisions(names: string[]): [string, string][] {
  const byStem = new Map<string, string[]>();
  for (const name of names) {
    if (!SOURCE.test(name)) continue;
    const stem = name.slice(0, name.lastIndexOf("."));
    const key = stem.toLowerCase();
    byStem.set(key, [...(byStem.get(key) ?? []), name]);
  }

  const pairs: [string, string][] = [];
  for (const group of byStem.values()) {
    const sorted = [...group].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i].slice(0, sorted[i].lastIndexOf("."));
        const b = sorted[j].slice(0, sorted[j].lastIndexOf("."));
        if (a !== b) pairs.push([sorted[i], sorted[j]]);
      }
    }
  }
  return pairs;
}

/** Walk `dir`, returning every collision as paths relative to ROOT */
function scan(dir: string, found: string[], counted: { files: number }) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    if (entry.isDirectory()) scan(join(dir, entry.name), found, counted);
    else if (entry.isFile()) files.push(entry.name);
  }
  counted.files += files.length;
  for (const [a, b] of caseCollisions(files)) {
    found.push(`${relative(ROOT, join(dir, a))} <-> ${b}`);
  }
}

test("the detector flags names that differ only by case", () => {
  assert.deepEqual(
    caseCollisions([
      "CipherPromo.tsx",
      "cipherPromo.ts",
      "cipherPromo.test.ts",
      "Keybinds.ts",
      "keybinds.test.ts",
      "styles.css",
      "styles.ts",
      "notes.md",
      "Notes.md",
    ]),
    [["CipherPromo.tsx", "cipherPromo.ts"]],
  );
  assert.deepEqual(caseCollisions(["a.ts", "a.tsx", "b.js"]), []);
});

test("no two client sources differ only by case", () => {
  const found: string[] = [];
  const counted = { files: 0 };
  for (const dir of SCANNED) scan(join(ROOT, dir), found, counted);

  // An empty or mis-pointed root would pass vacuously.
  assert.ok(counted.files > 500, `scanned only ${counted.files} files`);
  assert.deepEqual(
    found,
    [],
    "rename one of each pair; an extensionless import resolves to either " +
      "on macOS and Windows",
  );
});
