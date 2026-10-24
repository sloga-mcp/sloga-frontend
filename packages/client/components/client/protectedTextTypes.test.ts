// Unit spec for the Protected channels shared types (W4 lane A1) — run with
// Node's built-in runner:
//   node --test --conditions=browser components/client/protectedTextTypes.test.ts
// Focus: the two runtime tables every later lane trusts. `TEXT_COMMANDS` is
// the bridge's text-command allow-list, so it must be exactly the 20 native
// commands. `NATIVE_ERROR_TAGS` / `TEXT_NATIVE_ERROR_TAGS` drive the total
// error mapping (plan D17), so a native variant missing here would reach the
// UI untyped. Both are pinned ALWAYS against the in-repo fixtures in
// `__fixtures__/protected/`, copied from the pinned native sources and design
// copy. When those sources are present (`/home/mcp/w4-notes/`, override with
// `W4_NOTES_DIR`) an extra test re-parses them and checks the fixtures have
// not drifted; that extra test skips, loudly, when they are absent.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { Message } from "stoat.js";
import type { EncryptedPayload as SdkEncryptedPayload } from "stoat.js/lib/lib/protected";

import {
  type EncryptedPayload,
  NATIVE_ERROR_TAGS,
  TEXT_COMMANDS,
  TEXT_LEFT_REASONS,
  TEXT_NATIVE_ERROR_TAGS,
} from "./protectedTextTypes.ts";

// ---------------------------------------------------------------------------
// Compile-time: A1's `EncryptedPayload` and the SDK's (stoat.js
// `src/lib/protected.ts`, and `Message.encrypted`) are mutually assignable.
// ---------------------------------------------------------------------------

type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const _sdkPayloadMatches: Mutual<EncryptedPayload, SdkEncryptedPayload> =
  true;
export const _messageEncryptedMatches: Mutual<
  EncryptedPayload,
  NonNullable<Message["encrypted"]>
> = true;

// ---------------------------------------------------------------------------
// Fixtures (always present) and the optional pinned sources
// ---------------------------------------------------------------------------

const fixture = <T>(name: string): T =>
  JSON.parse(
    readFileSync(
      new URL(`./__fixtures__/protected/${name}`, import.meta.url),
      "utf8",
    ),
  ) as T;

const COMMANDS = fixture<{
  design_8_3_table: string[];
  w3_additions: string[];
  named_in_native_sources: string[];
}>("native-text-commands.json");

const ERRORS = fixture<{
  error_enum: string[];
  w3_section: string[];
  design_8_4_rows: string[];
  design_8_4_existing: string[];
  text_left_reason: string[];
}>("native-error-tags.json");

const NOTES = process.env.W4_NOTES_DIR ?? "/home/mcp/w4-notes";
const ERROR_RS = join(NOTES, "w4_native_error.rs");
const TYPES_RS = join(NOTES, "w4_native_types.rs");
const DESIGN = join(NOTES, "w4_design.md");
const PINNED = [ERROR_RS, TYPES_RS, DESIGN].every((p) => existsSync(p));
const SKIP = PINNED ? false : `pinned native sources not found in ${NOTES}`;

const read = (p: string) => readFileSync(p, "utf8");
const sorted = (xs: Iterable<string>) => [...xs].sort();
const has = (xs: readonly string[], x: string) => xs.includes(x);

/** serde `rename_all = "snake_case"` for a PascalCase variant name. */
const snake = (name: string) =>
  name.replace(/[A-Z]/g, (c, i: number) => (i ? "_" : "") + c.toLowerCase());

/** The body of `pub enum <name> {` up to its closing `}` at column 0. */
function enumBody(src: string, name: string): string {
  const start = src.indexOf(`pub enum ${name} {`);
  assert.ok(start >= 0, `enum ${name} not found`);
  const end = src.indexOf("\n}", start);
  assert.ok(end > start, `enum ${name} not closed`);
  return src.slice(start, end);
}

/** Variant names of an enum body: the 4-space-indented PascalCase lines. */
const variants = (body: string) =>
  [...body.matchAll(/^ {4}([A-Z][A-Za-z0-9]*)\b/gm)].map((m) => m[1]);

/** Text between two markers (both must exist). */
function between(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  assert.ok(a >= 0, `marker not found: ${from}`);
  const b = src.indexOf(to, a + from.length);
  assert.ok(b > a, `marker not found: ${to}`);
  return src.slice(a, b);
}

// ---------------------------------------------------------------------------
// Always: tables against the fixtures
// ---------------------------------------------------------------------------

test("TEXT_COMMANDS: 20 unique names, all text-plane", () => {
  assert.equal(TEXT_COMMANDS.length, 20);
  assert.equal(new Set(TEXT_COMMANDS).size, 20);
  for (const c of TEXT_COMMANDS) {
    assert.match(c, /^(e2ee_text_[a-z_]+[a-z]|e2ee_mls_group_kind)$/, c);
  }
  // never a call-plane or DM command
  for (const c of TEXT_COMMANDS) assert.doesNotMatch(c, /call|e2ee_pin_/, c);
});

test("TEXT_COMMANDS equals the pinned native command list", () => {
  assert.equal(COMMANDS.design_8_3_table.length, 18, "design 8.3 rows");
  assert.deepEqual(
    sorted(TEXT_COMMANDS),
    sorted(new Set([...COMMANDS.design_8_3_table, ...COMMANDS.w3_additions])),
  );
  assert.ok(COMMANDS.named_in_native_sources.length >= 10);
  for (const c of COMMANDS.named_in_native_sources) {
    assert.ok(has(TEXT_COMMANDS, c), c);
  }
});

test("NATIVE_ERROR_TAGS equals the native Error enum, in order", () => {
  assert.ok(ERRORS.error_enum.length >= 60);
  assert.equal(new Set(ERRORS.error_enum).size, ERRORS.error_enum.length);
  assert.deepEqual([...NATIVE_ERROR_TAGS], ERRORS.error_enum);
});

test("TEXT_NATIVE_ERROR_TAGS = W3 variants + design 8.4 existing", () => {
  const tags: readonly string[] = TEXT_NATIVE_ERROR_TAGS;
  assert.equal(new Set(tags).size, tags.length);
  for (const t of tags) assert.ok(has(NATIVE_ERROR_TAGS, t), t);
  assert.equal(ERRORS.w3_section.length, 27, "W3 variants");
  assert.equal(ERRORS.design_8_4_rows.length, 25, "design 8.4 rows");
  assert.equal(ERRORS.design_8_4_existing.length, 6, "8.4 existing");
  for (const r of ERRORS.design_8_4_rows) {
    assert.ok(ERRORS.w3_section.includes(r), `design row ${r} not in W3`);
  }
  assert.deepEqual(
    sorted(tags),
    sorted(new Set([...ERRORS.w3_section, ...ERRORS.design_8_4_existing])),
  );
});

test("TEXT_LEFT_REASONS equals the native TextLeftReason enum", () => {
  assert.deepEqual([...TEXT_LEFT_REASONS], ERRORS.text_left_reason);
});

// ---------------------------------------------------------------------------
// Extra: the fixtures still match the pinned sources (skips when absent)
// ---------------------------------------------------------------------------

test("fixtures match the pinned native sources", { skip: SKIP }, () => {
  const design = read(DESIGN);
  const errorSrc = read(ERROR_RS);

  // commands: design 8.3 table, W3 additions, mentions in the .rs files
  const s83 = between(design, "### 8.3 Commands", "### 8.4");
  const table = [...s83.matchAll(/^\| `(e2ee_[a-z_]+)` /gm)].map((m) => m[1]);
  assert.deepEqual(table, COMMANDS.design_8_3_table);
  // `_mark_left` is named by the native error source (its reason enum);
  // `_pin_own_devices` is W3 plan D7 / 3a (no pinned file names it).
  assert.match(errorSrc, /`e2ee_text_mark_left`/);
  const COMMAND_TOKEN =
    /\b(e2ee_text_[a-z][a-z_]*[a-z]|e2ee_mls_group_kind)\b/g;
  const mentioned = new Set(
    [errorSrc, read(TYPES_RS)].flatMap((s) =>
      [...s.matchAll(COMMAND_TOKEN)].map((m) => m[1]),
    ),
  );
  assert.deepEqual(sorted(mentioned), COMMANDS.named_in_native_sources);

  // errors: the whole enum, its W3 section, design 8.4
  const body = enumBody(errorSrc, "Error");
  assert.deepEqual(variants(body).map(snake), ERRORS.error_enum);
  const marker = body.indexOf("// ---- protected-channel text MLS (W3");
  assert.ok(marker > 0, "W3 section marker");
  assert.deepEqual(variants(body.slice(marker)).map(snake), ERRORS.w3_section);
  const s84 = between(design, "### 8.4 Typed errors", "## 9.");
  const ROW = /^\| `([A-Z][A-Za-z]+)` \|/gm;
  const rows = [...s84.matchAll(ROW)].map((m) => snake(m[1]));
  assert.deepEqual(rows, ERRORS.design_8_4_rows);
  const para = between(s84, "Existing ", "apply to text groups");
  const existing = [...para.matchAll(/`([A-Z][A-Za-z]+)`/g)].map((m) =>
    snake(m[1]),
  );
  assert.deepEqual(existing, ERRORS.design_8_4_existing);
  const left = variants(enumBody(errorSrc, "TextLeftReason")).map(snake);
  assert.deepEqual(left, ERRORS.text_left_reason);
});
