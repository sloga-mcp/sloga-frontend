/**
 * Android E2EE native library gate (Protected channels S7, plan D11).
 *
 * The three shipped libacutest_e2ee.so files and the uniffi Kotlin bindings
 * acutest_e2ee.kt must come from ONE regen-android.sh run of ONE clean desktop
 * commit. uniffi stamps an API checksum per method into the .kt and the .so
 * verifies it at load, so a .kt from one build and a .so from another throws
 * "UniFFI API checksum mismatch" on the first E2EE call: a total Android E2EE
 * outage that nothing short of a device run shows.
 *
 * This gate cannot compare checksum VALUES (only a device can call them; that
 * is the D11 on-device smoke). It checks everything a build box can:
 *  - android/app/e2ee-native-PROVENANCE.txt (written by regen-android.sh) says
 *    `format: regen-android/1`, `dirty: false`, a 40-hex `desktop_commit`, and
 *    carries well-formed sha256.shipped.<abi>, sha256.unstripped.<abi>,
 *    sha256.kt and kt_checksums values;
 *  - the sha256 of each shipped .so and of the .kt equals its PROVENANCE value,
 *    and kt_checksums equals the number of distinct checksum symbols the .kt
 *    names (counted the way regen-android.sh counts them);
 *  - each .so is an ELF shared object of its ABI's class and machine;
 *  - each .so EXPORTS every uniffi_acutest_e2ee_* / ffi_acutest_e2ee_* function
 *    symbol the .kt names (the checksum functions and the contract version
 *    included) and, for the protected text plane, both the method and its
 *    checksum function;
 *  - the .kt declares and checksums the 20 protected-text methods plus
 *    text_capability (a pre-S7 .kt has none of them);
 *  - no PROVENANCE file sits anywhere under jniLibs/ (the old
 *    build-android.ps1 location), where the APK would package it.
 *
 * Symbols are read from the ELF dynamic symbol table (.dynsym + its string
 * table) by the small reader below; no NDK tool is needed. "Exported" means
 * defined (st_shndx != SHN_UNDEF), GLOBAL or WEAK binding, DEFAULT or
 * PROTECTED visibility, and STT_FUNC: what `llvm-nm -D --defined-only` lists
 * as T/W.
 *
 *   node check-android-e2ee-libs.mjs [--root <client-root>]
 *                                    [--expect-desktop-commit <40-hex sha>]
 *
 * The client root defaults to the folder above this script
 * (packages/client), so the working directory does not matter: it runs the
 * same from the repo root, from packages/client or from anywhere else.
 * Exit 0 = every check passed; 1 = at least one check failed (each failure is
 * printed); 2 = bad arguments.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TAG = "[android-e2ee-libs]";

export const PROVENANCE_REL = "android/app/e2ee-native-PROVENANCE.txt";
export const MAIN_REL = "android/app/src/main";
export const JNI_LIBS_REL = `${MAIN_REL}/jniLibs`;
export const LIB_FILE = "libacutest_e2ee.so";
export const KT_REL = `${MAIN_REL}/java/uniffi/acutest_e2ee/acutest_e2ee.kt`;
export const FORMAT = "regen-android/1";

// ABI -> the ELF class and e_machine its .so must have.
export const ABIS = {
  "arm64-v8a": { elfClass: 64, machine: 183 }, // EM_AARCH64
  "armeabi-v7a": { elfClass: 32, machine: 40 }, // EM_ARM
  x86_64: { elfClass: 64, machine: 62 }, // EM_X86_64
};

// The protected text plane (S7 A1) plus text_capability, as regen-android.sh
// lists them (TEXT_METHODS).
export const TEXT_METHODS = [
  "text_group_create",
  "text_join",
  "text_admit",
  "text_process",
  "text_commit_won",
  "text_commit_lost",
  "text_pending_commit",
  "text_encrypt",
  "text_decrypt",
  "text_seat_list_verify",
  "text_owner_pin_state",
  "text_remove",
  "text_update",
  "text_state",
  "text_mark_left",
  "text_pin_own_devices",
  "mls_group_kind",
  "text_seat_list_sign",
  "text_owner_confirm_change",
  "text_owner_handover_sign",
  "text_capability",
];

const CONTRACT_VERSION_SYMBOL = "ffi_acutest_e2ee_uniffi_contract_version";
// Every native symbol the bindings bind by name.
const KT_SYMBOL_RE = /\b(?:uniffi|ffi)_acutest_e2ee_[A-Za-z0-9_]+\b/g;
// regen-android.sh's kt_checksum_count: grep -o 'uniffi_acutest_e2ee_checksum_[a-z0-9_]*'.
const KT_CHECKSUM_RE = /uniffi_acutest_e2ee_checksum_[a-z0-9_]*/g;
const SHA256_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
// `dirty_path` repeats (one per dirty file); every other key appears once.
const REPEATABLE_KEYS = new Set(["dirty_path"]);

export const snakeToCamel = (name) =>
  name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * The PROVENANCE file as a Map(key -> value). `#` lines and blank lines are
 * skipped. Throws on a malformed line or a repeated key.
 */
export function parseProvenance(text) {
  const map = new Map();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    if (line.trim() === "" || line.startsWith("#")) continue;
    const match = /^([A-Za-z0-9_.-]+): (.*)$/.exec(line);
    if (!match) throw new Error(`line ${i + 1} is not "key: value"`);
    const [, key, value] = match;
    if (REPEATABLE_KEYS.has(key)) {
      map.set(key, [...(map.get(key) ?? []), value]);
      continue;
    }
    if (map.has(key)) throw new Error(`key ${key} appears more than once`);
    map.set(key, value);
  }
  return map;
}

const SHT_STRTAB = 3;
const SHT_DYNSYM = 11;
const ET_DYN = 3;
const STB_GLOBAL = 1;
const STB_WEAK = 2;
const STT_FUNC = 2;
const STV_DEFAULT = 0;
const STV_PROTECTED = 3;

/**
 * Reads the dynamic symbol table of a little-endian ELF32/ELF64 file.
 * Returns { elfClass, machine, type, symbols: [{ name, bind, type,
 * visibility, defined }] } (the null symbol at index 0 is omitted). Throws on
 * anything malformed: a gate that guesses is no gate.
 */
export function readDynamicSymbols(bytes) {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 64 || buf.readUInt32BE(0) !== 0x7f454c46) {
    throw new Error("not an ELF file");
  }
  const elfClass = { 1: 32, 2: 64 }[buf[4]];
  if (!elfClass) throw new Error(`unknown ELF class ${buf[4]}`);
  if (buf[5] !== 1) throw new Error("not a little-endian ELF file");
  const is64 = elfClass === 64;
  const word = (off) =>
    is64 ? Number(buf.readBigUInt64LE(off)) : buf.readUInt32LE(off);

  const type = buf.readUInt16LE(16);
  const machine = buf.readUInt16LE(18);
  const shoff = word(is64 ? 40 : 32);
  const shentsize = buf.readUInt16LE(is64 ? 58 : 46);
  const shnum = buf.readUInt16LE(is64 ? 60 : 48);
  if (shentsize !== (is64 ? 64 : 40)) {
    throw new Error(`unexpected section header size ${shentsize}`);
  }
  if (shnum === 0 || shoff + shnum * shentsize > buf.length) {
    throw new Error("section header table missing or out of bounds");
  }

  const sections = [];
  for (let i = 0; i < shnum; i++) {
    const at = shoff + i * shentsize;
    sections.push({
      type: buf.readUInt32LE(at + 4),
      offset: word(at + (is64 ? 24 : 16)),
      size: word(at + (is64 ? 32 : 20)),
      link: buf.readUInt32LE(at + (is64 ? 40 : 24)),
      entsize: word(at + (is64 ? 56 : 36)),
    });
  }
  const inBounds = (s) => s.offset + s.size <= buf.length;

  const dynsyms = sections.filter((s) => s.type === SHT_DYNSYM);
  if (dynsyms.length !== 1) {
    throw new Error(`expected one .dynsym section, found ${dynsyms.length}`);
  }
  const dynsym = dynsyms[0];
  const symSize = is64 ? 24 : 16;
  if (dynsym.entsize !== symSize || dynsym.size % symSize !== 0) {
    throw new Error("malformed .dynsym entry size");
  }
  const strtab = sections[dynsym.link];
  if (!strtab || strtab.type !== SHT_STRTAB) {
    throw new Error(".dynsym does not link to a string table");
  }
  if (!inBounds(dynsym) || !inBounds(strtab)) {
    throw new Error(".dynsym or its string table is out of bounds");
  }

  const nameAt = (off) => {
    if (off >= strtab.size) throw new Error("symbol name out of bounds");
    const start = strtab.offset + off;
    const end = buf.indexOf(0, start);
    if (end === -1 || end >= strtab.offset + strtab.size) {
      throw new Error("unterminated symbol name");
    }
    return buf.toString("latin1", start, end);
  };

  const symbols = [];
  for (let i = 1; i < dynsym.size / symSize; i++) {
    const at = dynsym.offset + i * symSize;
    const info = buf[at + (is64 ? 4 : 12)];
    const other = buf[at + (is64 ? 5 : 13)];
    const shndx = buf.readUInt16LE(at + (is64 ? 6 : 14));
    symbols.push({
      name: nameAt(buf.readUInt32LE(at)),
      bind: info >> 4,
      type: info & 0xf,
      visibility: other & 0x3,
      defined: shndx !== 0,
    });
  }
  return { elfClass, machine, type, symbols };
}

/** The names a loader can resolve: defined, global/weak, visible functions. */
export function exportedFunctions(symbols) {
  return new Set(
    symbols
      .filter(
        (s) =>
          s.defined &&
          (s.bind === STB_GLOBAL || s.bind === STB_WEAK) &&
          (s.visibility === STV_DEFAULT || s.visibility === STV_PROTECTED) &&
          s.type === STT_FUNC,
      )
      .map((s) => s.name),
  );
}

/** Every native symbol name the bindings reference, sorted. */
export function ktSymbols(kt) {
  return [...new Set(kt.match(KT_SYMBOL_RE) ?? [])].sort();
}

/** regen-android.sh's kt_checksum_count. */
export function ktChecksumCount(kt) {
  return new Set(kt.match(KT_CHECKSUM_RE) ?? []).size;
}

/** The TEXT_METHODS the .kt does not both declare and checksum. */
export function missingTextMethods(kt) {
  return TEXT_METHODS.filter((m) => {
    // the interface declaration and the override, as regen-android.sh counts
    const declared = kt.split(`fun \`${snakeToCamel(m)}\`(`).length - 1 >= 2;
    const checksummed = kt.includes(
      `lib.uniffi_acutest_e2ee_checksum_method_e2eeengine_${m}()`,
    );
    return !(declared && checksummed);
  });
}

/** Every file under `dir` (recursive), as paths relative to `dir`. */
function filesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const sub of filesUnder(path)) out.push(join(entry.name, sub));
    } else {
      out.push(entry.name);
    }
  }
  return out;
}

/**
 * Runs every check against the client root. Returns { failures: string[],
 * notes: string[] }; an empty `failures` is a pass.
 */
export function checkAndroidE2eeLibs(root, { expectDesktopCommit } = {}) {
  const failures = [];
  const notes = [];
  const fail = (msg) => failures.push(msg);

  // PROVENANCE
  const provPath = join(root, PROVENANCE_REL);
  let prov = null;
  if (!existsSync(provPath)) {
    fail(`${PROVENANCE_REL} is missing`);
  } else {
    try {
      prov = parseProvenance(readFileSync(provPath, "utf8"));
    } catch (err) {
      fail(`${PROVENANCE_REL} is malformed: ${err.message}`);
    }
  }
  const field = (key, re) => {
    if (!prov) return null;
    const value = prov.get(key);
    if (value === undefined) {
      fail(`PROVENANCE has no ${key}`);
      return null;
    }
    if (re && !re.test(value)) {
      fail(`PROVENANCE ${key} is malformed: ${JSON.stringify(value)}`);
      return null;
    }
    return value;
  };
  if (prov) {
    const format = field("format");
    if (format !== null && format !== FORMAT) {
      fail(`PROVENANCE format is ${JSON.stringify(format)}, not ${FORMAT}`);
    }
    const dirty = field("dirty");
    if (dirty !== null && dirty !== "false") {
      fail(
        `PROVENANCE dirty is ${JSON.stringify(dirty)}: the libraries were built from an uncommitted desktop tree`,
      );
    }
    const commit = field("desktop_commit", COMMIT_RE);
    if (commit !== null) notes.push(`desktop_commit ${commit}`);
    if (expectDesktopCommit !== undefined && commit !== expectDesktopCommit) {
      fail(
        `PROVENANCE desktop_commit is ${commit ?? "unusable"}, expected ${expectDesktopCommit}`,
      );
    }
    for (const abi of Object.keys(ABIS)) {
      field(`sha256.unstripped.${abi}`, SHA256_RE);
    }
  }

  // The .kt
  const ktPath = join(root, KT_REL);
  let kt = null;
  if (!existsSync(ktPath)) {
    fail(`${KT_REL} is missing`);
  } else {
    const bytes = readFileSync(ktPath);
    kt = bytes.toString("utf8");
    const want = field("sha256.kt", SHA256_RE);
    if (want !== null && sha256(bytes) !== want) {
      fail(`${KT_REL} sha256 ${sha256(bytes)} != PROVENANCE ${want}`);
    }
    const missing = missingTextMethods(kt);
    if (missing.length > 0) {
      fail(
        `${KT_REL} lacks ${missing.length} of ${TEXT_METHODS.length} protected-text methods (stale bindings?): ${missing.join(" ")}`,
      );
    }
    if (!kt.includes(CONTRACT_VERSION_SYMBOL)) {
      fail(`${KT_REL} does not reference ${CONTRACT_VERSION_SYMBOL}`);
    }
    const count = field("kt_checksums", /^[0-9]+$/);
    if (count !== null && Number(count) !== ktChecksumCount(kt)) {
      fail(
        `PROVENANCE kt_checksums ${count} != ${ktChecksumCount(kt)} checksum symbols in ${KT_REL}`,
      );
    }
  }

  // Symbols the .so files must export: everything the .kt binds, plus the
  // text plane's methods and checksums named explicitly.
  const required = new Set(kt === null ? [] : ktSymbols(kt));
  for (const m of TEXT_METHODS) {
    required.add(`uniffi_acutest_e2ee_fn_method_e2eeengine_${m}`);
    required.add(`uniffi_acutest_e2ee_checksum_method_e2eeengine_${m}`);
  }
  required.add(CONTRACT_VERSION_SYMBOL);

  // The .so files
  for (const [abi, want] of Object.entries(ABIS)) {
    const rel = `${JNI_LIBS_REL}/${abi}/${LIB_FILE}`;
    const path = join(root, rel);
    if (!existsSync(path)) {
      fail(`${rel} is missing`);
      continue;
    }
    const bytes = readFileSync(path);
    const pinned = field(`sha256.shipped.${abi}`, SHA256_RE);
    if (pinned !== null && sha256(bytes) !== pinned) {
      fail(`${rel} sha256 ${sha256(bytes)} != PROVENANCE ${pinned}`);
    }
    let elf;
    try {
      elf = readDynamicSymbols(bytes);
    } catch (err) {
      fail(`${rel}: ${err.message}`);
      continue;
    }
    if (elf.type !== ET_DYN) fail(`${rel} is not a shared object`);
    if (elf.elfClass !== want.elfClass || elf.machine !== want.machine) {
      fail(
        `${rel} is ELF${elf.elfClass} machine ${elf.machine}, expected ELF${want.elfClass} machine ${want.machine} for ${abi}`,
      );
    }
    const exported = exportedFunctions(elf.symbols);
    const absent = [...required].filter((name) => !exported.has(name)).sort();
    if (absent.length > 0) {
      const shown = absent.slice(0, 10).join(" ");
      fail(
        `${rel} does not export ${absent.length} symbol(s) the bindings need: ${shown}${absent.length > 10 ? " ..." : ""}`,
      );
    } else {
      notes.push(`${abi}: exports all ${required.size} required symbols`);
    }
  }

  // Nothing provenance-like may be packaged from jniLibs.
  const jniLibs = join(root, JNI_LIBS_REL);
  if (existsSync(jniLibs)) {
    for (const file of filesUnder(jniLibs)) {
      if (/provenance/i.test(file)) {
        fail(
          `${JNI_LIBS_REL}/${file} must not exist (the APK would package it; PROVENANCE lives at ${PROVENANCE_REL})`,
        );
      }
    }
  }

  return { failures, notes };
}

function usage(message) {
  if (message) console.error(`${TAG} ${message}`);
  console.error(
    "usage: node check-android-e2ee-libs.mjs [--root <client-root>] [--expect-desktop-commit <40-hex sha>]",
  );
  process.exit(2);
}

function main(argv) {
  let root = dirname(dirname(fileURLToPath(import.meta.url)));
  let expectDesktopCommit;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--root" || arg === "--expect-desktop-commit") {
      const value = argv[++i];
      if (value === undefined) usage(`${arg} needs a value`);
      if (arg === "--root") {
        root = resolve(value);
      } else {
        if (!COMMIT_RE.test(value)) {
          usage(`--expect-desktop-commit wants a full 40-hex lowercase sha`);
        }
        expectDesktopCommit = value;
      }
    } else if (arg === "-h" || arg === "--help") {
      usage();
    } else {
      usage(`unknown argument ${JSON.stringify(arg)}`);
    }
  }

  console.log(`${TAG} client root ${root}`);
  const { failures, notes } = checkAndroidE2eeLibs(root, {
    expectDesktopCommit,
  });
  for (const note of notes) console.log(`${TAG} ${note}`);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`${TAG} FAIL: ${failure}`);
    console.error(`${TAG} FAILED: ${failures.length} check(s)`);
    process.exit(1);
  }
  console.log(`${TAG} OK: 3 .so + .kt match ${PROVENANCE_REL}`);
}

// Run only as a CLI; the test imports the reader and the checks.
function invokedDirectly() {
  try {
    return (
      realpathSync(resolve(process.argv[1] ?? "")) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}
if (invokedDirectly()) main(process.argv.slice(2));
