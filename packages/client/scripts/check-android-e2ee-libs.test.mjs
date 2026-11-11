/**
 * check-android-e2ee-libs.mjs (plan D11), run as android-compile-gate.sh runs
 * it: a child process whose exit status is the verdict.
 *
 * Every fixture is a client root in a mkdtemp folder under the OS temp dir:
 * a synthetic acutest_e2ee.kt, three synthetic ELF shared objects whose
 * .dynsym exports exactly the symbols a test chooses, and a PROVENANCE file in
 * regen-android.sh's format with the real hashes of those files. A good
 * fixture passes; each negative control breaks ONE thing and must fail for
 * that reason alone (the "FAILED: 1 check(s)" assertions).
 *
 * The stale-bindings control also runs on the real pre-S7 .kt, read from the
 * literal commit 5b61eef1 (the S7 frontend base, carrying the d12b6ed4 v0.69
 * regen), never from HEAD: a control against HEAD goes vacuous once the S7
 * regen lands.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ABIS,
  exportedFunctions,
  KT_REL,
  ktChecksumCount,
  ktSymbols,
  parseProvenance,
  PROVENANCE_REL,
  readDynamicSymbols,
  snakeToCamel,
  TEXT_METHODS,
} from "./check-android-e2ee-libs.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "check-android-e2ee-libs.mjs");
const CLIENT = dirname(here);
const REPO = dirname(dirname(CLIENT));

const PRE_S7_COMMIT = "5b61eef1";
const COMMIT = "e8939a5bd0209e410e718fee8214d0fdff0559c7";
const OTHER_COMMIT = "0123456789abcdef0123456789abcdef01234567";

const STB_LOCAL = 0;
const STB_GLOBAL = 1;
const STT_OBJECT = 1;
const STT_FUNC = 2;
const STV_HIDDEN = 2;

// ---- synthetic ELF -------------------------------------------------------

/**
 * A minimal little-endian ELF: header, .dynstr, .dynsym and the section
 * header table ([0] null, [1] .dynsym linked to [2] .dynstr). `symbols` are
 * { name, bind = GLOBAL, type = FUNC, visibility = DEFAULT, defined = true }.
 */
function buildElf({ elfClass, machine, type = 3, symbols }) {
  const is64 = elfClass === 64;
  const ehsize = is64 ? 64 : 52;
  const shentsize = is64 ? 64 : 40;
  const symSize = is64 ? 24 : 16;

  const names = [0];
  const nameOffsets = [];
  for (const s of symbols) {
    nameOffsets.push(names.length);
    names.push(...Buffer.from(s.name, "latin1"), 0);
  }
  const dynstr = Buffer.from(names);
  const dynstrOff = ehsize;
  const dynsymOff = Math.ceil((dynstrOff + dynstr.length) / 8) * 8;
  const dynsymSize = (symbols.length + 1) * symSize;
  const shoff = Math.ceil((dynsymOff + dynsymSize) / 8) * 8;
  const buf = Buffer.alloc(shoff + 3 * shentsize);

  buf.writeUInt32BE(0x7f454c46, 0);
  buf[4] = is64 ? 2 : 1;
  buf[5] = 1;
  buf[6] = 1;
  buf.writeUInt16LE(type, 16);
  buf.writeUInt16LE(machine, 18);
  buf.writeUInt32LE(1, 20);
  if (is64) {
    buf.writeBigUInt64LE(BigInt(shoff), 40);
    buf.writeUInt16LE(ehsize, 52);
    buf.writeUInt16LE(shentsize, 58);
    buf.writeUInt16LE(3, 60);
  } else {
    buf.writeUInt32LE(shoff, 32);
    buf.writeUInt16LE(ehsize, 40);
    buf.writeUInt16LE(shentsize, 46);
    buf.writeUInt16LE(3, 48);
  }

  dynstr.copy(buf, dynstrOff);
  symbols.forEach((s, i) => {
    const at = dynsymOff + (i + 1) * symSize;
    const info = ((s.bind ?? STB_GLOBAL) << 4) | (s.type ?? STT_FUNC);
    const shndx = s.defined === false ? 0 : 1;
    buf.writeUInt32LE(nameOffsets[i], at);
    buf[at + (is64 ? 4 : 12)] = info;
    buf[at + (is64 ? 5 : 13)] = s.visibility ?? 0;
    buf.writeUInt16LE(shndx, at + (is64 ? 6 : 14));
  });

  const section = (index, { type: shType, offset, size, link, entsize }) => {
    const at = shoff + index * shentsize;
    buf.writeUInt32LE(shType, at + 4);
    if (is64) {
      buf.writeBigUInt64LE(BigInt(offset), at + 24);
      buf.writeBigUInt64LE(BigInt(size), at + 32);
      buf.writeUInt32LE(link, at + 40);
      buf.writeBigUInt64LE(BigInt(entsize), at + 56);
    } else {
      buf.writeUInt32LE(offset, at + 16);
      buf.writeUInt32LE(size, at + 20);
      buf.writeUInt32LE(link, at + 24);
      buf.writeUInt32LE(entsize, at + 36);
    }
  };
  section(1, {
    type: 11,
    offset: dynsymOff,
    size: dynsymSize,
    link: 2,
    entsize: symSize,
  });
  section(2, {
    type: 3,
    offset: dynstrOff,
    size: dynstr.length,
    link: 0,
    entsize: 0,
  });
  return buf;
}

// ---- synthetic bindings --------------------------------------------------

/** A .kt shaped like uniffi's output: the text plane plus a few others. */
function goodKt({ methods = TEXT_METHODS } = {}) {
  const all = ["is_provisioned", "enable_group", ...methods];
  const lines = [
    "package uniffi.acutest_e2ee",
    "",
    "internal interface IntegrityCheckingUniffiLib : Library {",
    "    fun ffi_acutest_e2ee_uniffi_contract_version(",
    "    ): Int",
  ];
  for (const m of all) {
    lines.push(
      `    fun uniffi_acutest_e2ee_checksum_method_e2eeengine_${m}(`,
      "    ): Short",
    );
  }
  lines.push(
    "    fun uniffi_acutest_e2ee_checksum_method_textconfirm_confirm(",
    "    ): Short",
    "}",
    "internal interface UniffiLib : Library {",
    "    fun uniffi_acutest_e2ee_fn_init_callback_vtable_textconfirm(vtable: UniffiVTableCallbackInterfaceTextConfirm,",
    "    ): Unit",
    "    fun ffi_acutest_e2ee_rustbuffer_free(`buf`: RustBuffer.ByValue,uniffi_out_err: UniffiRustCallStatus,",
    "    ): Unit",
  );
  for (const m of all) {
    lines.push(
      `    fun uniffi_acutest_e2ee_fn_method_e2eeengine_${m}(\`ptr\`: Pointer,uniffi_out_err: UniffiRustCallStatus,`,
      "    ): RustBuffer.ByValue",
    );
  }
  lines.push(
    "}",
    "private fun uniffiCheckContractApiVersion(lib: IntegrityCheckingUniffiLib) {",
    "    val scaffolding_contract_version = lib.ffi_acutest_e2ee_uniffi_contract_version()",
    "}",
    "private fun uniffiCheckApiChecksums(lib: IntegrityCheckingUniffiLib) {",
  );
  for (const m of all) {
    lines.push(
      `    if (lib.uniffi_acutest_e2ee_checksum_method_e2eeengine_${m}() != 1234.toShort()) {`,
      '        throw RuntimeException("UniFFI API checksum mismatch: try cleaning and rebuilding your project")',
      "    }",
    );
  }
  lines.push("}", "public interface E2eeEngineInterface {");
  for (const m of all) lines.push(`    fun \`${snakeToCamel(m)}\`(): String`);
  lines.push("}", "open class E2eeEngine : E2eeEngineInterface {");
  for (const m of all) {
    lines.push(`    override fun \`${snakeToCamel(m)}\`(): String { TODO() }`);
  }
  lines.push("}", "public interface TextConfirm {", "}", "");
  return lines.join("\n");
}

/** What a correct .so exports for `kt`: every bound symbol, as functions. */
function exportsFor(kt) {
  const names = new Set(ktSymbols(kt));
  for (const m of TEXT_METHODS) {
    names.add(`uniffi_acutest_e2ee_fn_method_e2eeengine_${m}`);
    names.add(`uniffi_acutest_e2ee_checksum_method_e2eeengine_${m}`);
  }
  return [...names].sort().map((name) => ({ name }));
}

// Data and imported symbols a real .so also carries; never required.
const BACKGROUND_SYMBOLS = [
  { name: "UNIFFI_META_ACUTEST_E2EE_INTERFACE_E2EEENGINE", type: STT_OBJECT },
  { name: "malloc", defined: false },
  { name: "__cxa_finalize", defined: false },
];

// ---- fixture trees -------------------------------------------------------

let tmp;
let counter = 0;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "check-android-e2ee-libs-test-"));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const soRel = (abi) => `android/app/src/main/jniLibs/${abi}/libacutest_e2ee.so`;

function writeAt(root, rel, bytes) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

/** Writes `abi`'s .so under `root`, exporting `symbols`. */
function writeSo(root, abi, symbols) {
  writeAt(root, soRel(abi), buildElf({ ...ABIS[abi], symbols }));
}

/**
 * Writes PROVENANCE in regen-android.sh's layout with the hashes of the files
 * now under `root`. `overrides` replaces values; `null` drops the key;
 * `extra` appends raw lines.
 */
function writeProvenance(root, { overrides = {}, extra = [] } = {}) {
  const kt = readFileSync(join(root, KT_REL));
  const abis = Object.keys(ABIS);
  const entries = [
    ["format", "regen-android/1"],
    [
      "generator",
      "acutest-desktop/src-tauri/e2ee-android/scripts/regen-android.sh",
    ],
    ["generated_utc", "2026-10-27T07:00:00Z"],
    ["desktop_commit", COMMIT],
    ["desktop_branch", "feat/protected-channels-s7"],
    ["dirty", "false"],
    ["uniffi", "0.29.5"],
    ["kt_checksums", String(ktChecksumCount(kt.toString("utf8")))],
    ["regen_rule", "Regenerate whenever ...: cargo-ndk release builds"],
    ...abis.map((abi) => [`sha256.unstripped.${abi}`, sha256(abi)]),
    ...abis.map((abi) => [
      `sha256.shipped.${abi}`,
      sha256(readFileSync(join(root, soRel(abi)))),
    ]),
    ["sha256.kt", sha256(kt)],
  ];
  const lines = [
    "# libacutest_e2ee.so + acutest_e2ee.kt provenance. Written by regen-android.sh; do not edit.",
  ];
  for (const [key, value] of entries) {
    const v = key in overrides ? overrides[key] : value;
    if (v !== null) lines.push(`${key}: ${v}`);
  }
  writeAt(root, PROVENANCE_REL, [...lines, ...extra, ""].join("\n"));
}

/**
 * A complete, consistent client root. `exports(abi, symbols)` may edit an
 * ABI's export list before it is written.
 */
function makeTree({ kt = goodKt(), exports = (_abi, s) => s, root } = {}) {
  root ??= join(tmp, String(counter++));
  writeAt(root, KT_REL, kt);
  for (const abi of Object.keys(ABIS)) {
    writeSo(
      root,
      abi,
      exports(abi, [...exportsFor(kt), ...BACKGROUND_SYMBOLS]),
    );
  }
  writeProvenance(root);
  return root;
}

function run(args, { cwd = CLIENT, script = SCRIPT } = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
  });
}

const check = (root, ...args) => run(["--root", root, ...args]);

function assertPass(result) {
  assert.equal(
    result.status,
    0,
    `exit 0 expected; stderr: ${result.stderr}\nstdout: ${result.stdout}`,
  );
  assert.match(result.stdout, /\[android-e2ee-libs\] OK: /);
  assert.equal(result.stderr, "");
}

/** Exit 1, `failures` FAIL lines, and one of them matching `re`. */
function assertFails(result, re, failures = 1) {
  assert.equal(result.status, 1, `exit 1 expected; stdout: ${result.stdout}`);
  assert.match(result.stderr, re);
  assert.match(result.stderr, new RegExp(`FAILED: ${failures} check\\(s\\)`));
  assert.doesNotMatch(result.stdout, /OK: /);
}

// ---- tests ---------------------------------------------------------------

describe("ELF dynamic symbol reader", () => {
  for (const abi of Object.keys(ABIS)) {
    test(`${abi}: class, machine and every symbol round-trip`, () => {
      const symbols = [
        { name: "uniffi_acutest_e2ee_fn_a" },
        { name: "data_symbol", type: STT_OBJECT },
        { name: "imported", defined: false },
      ];
      const elf = readDynamicSymbols(buildElf({ ...ABIS[abi], symbols }));
      assert.equal(elf.elfClass, ABIS[abi].elfClass);
      assert.equal(elf.machine, ABIS[abi].machine);
      assert.equal(elf.type, 3);
      assert.deepEqual(
        elf.symbols.map((s) => [s.name, s.defined, s.type]),
        [
          ["uniffi_acutest_e2ee_fn_a", true, STT_FUNC],
          ["data_symbol", true, STT_OBJECT],
          ["imported", false, STT_FUNC],
        ],
      );
    });
  }

  test("only defined, global, visible functions count as exported", () => {
    const elf = readDynamicSymbols(
      buildElf({
        ...ABIS["arm64-v8a"],
        symbols: [
          { name: "exported" },
          { name: "undefined_import", defined: false },
          { name: "local", bind: STB_LOCAL },
          { name: "hidden", visibility: STV_HIDDEN },
          { name: "object", type: STT_OBJECT },
        ],
      }),
    );
    assert.deepEqual([...exportedFunctions(elf.symbols)], ["exported"]);
  });

  test("malformed input throws instead of guessing", () => {
    assert.throws(() => readDynamicSymbols(Buffer.alloc(100)), /not an ELF/);
    const good = buildElf({ ...ABIS.x86_64, symbols: [{ name: "a" }] });
    const bigEndian = Buffer.from(good);
    bigEndian[5] = 2;
    assert.throws(() => readDynamicSymbols(bigEndian), /little-endian/);
    assert.throws(
      () => readDynamicSymbols(good.subarray(0, good.length - 8)),
      /out of bounds/,
    );
    const noDynsym = Buffer.from(good);
    // section [1]'s type: 11 (SHT_DYNSYM) -> 1 (SHT_PROGBITS)
    noDynsym.writeUInt32LE(1, noDynsym.length - 2 * 64 + 4);
    assert.throws(() => readDynamicSymbols(noDynsym), /one \.dynsym/);
  });
});

describe("PROVENANCE parser", () => {
  test("key: value lines, comments and blanks skipped", () => {
    const map = parseProvenance(
      "# comment\n\nformat: regen-android/1\nregen_rule: a: b: c\n",
    );
    assert.deepEqual(
      [...map],
      [
        ["format", "regen-android/1"],
        ["regen_rule", "a: b: c"],
      ],
    );
  });

  test("a repeated key or a malformed line throws; dirty_path may repeat", () => {
    assert.throws(
      () => parseProvenance("dirty: false\ndirty: false\n"),
      /more than once/,
    );
    assert.throws(() => parseProvenance("dirty false\n"), /not "key: value"/);
    assert.deepEqual(
      parseProvenance("dirty_path: a\ndirty_path: b\n").get("dirty_path"),
      ["a", "b"],
    );
  });
});

describe("a consistent tree passes", () => {
  test("the synthetic good tree (exit 0)", () => {
    const result = check(makeTree());
    assertPass(result);
    for (const abi of Object.keys(ABIS)) {
      assert.match(
        result.stdout,
        new RegExp(`${abi}: exports all \\d+ required symbols`),
      );
    }
  });

  test("--expect-desktop-commit with the recorded commit", () => {
    assertPass(check(makeTree(), "--expect-desktop-commit", COMMIT));
  });

  test("the default root is the script's client root, from any cwd", () => {
    const repo = join(tmp, String(counter++), "repo");
    const client = join(repo, "packages", "client");
    const script = join(client, "scripts", "check-android-e2ee-libs.mjs");
    mkdirSync(dirname(script), { recursive: true });
    copyFileSync(SCRIPT, script);
    makeTree({ root: client });
    for (const cwd of [repo, client, tmp]) {
      const result = run([], { cwd, script });
      assertPass(result);
      assert.ok(
        result.stdout.startsWith(`[android-e2ee-libs] client root ${client}\n`),
        result.stdout,
      );
    }
  });
});

describe("negative controls (each must fail)", () => {
  test("hash mismatch: a shipped .so differs from PROVENANCE", () => {
    const root = makeTree();
    const path = join(root, soRel("x86_64"));
    writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from([0])]));
    assertFails(
      check(root),
      /FAIL: android\/app\/src\/main\/jniLibs\/x86_64\/libacutest_e2ee\.so sha256 [0-9a-f]{64} != PROVENANCE/,
    );
  });

  test("hash mismatch: the .kt differs from PROVENANCE", () => {
    const root = makeTree();
    writeFileSync(join(root, KT_REL), goodKt() + "// edited\n");
    assertFails(
      check(root),
      /FAIL: .*acutest_e2ee\.kt sha256 .* != PROVENANCE/,
    );
  });

  test("dirty: true (with its dirty_path lines)", () => {
    const root = makeTree();
    writeProvenance(root, {
      overrides: { dirty: "true" },
      extra: [
        "dirty_path:  M e2ee-core/src/lib.rs",
        "dirty_path: ?? scratch.rs",
      ],
    });
    assertFails(check(root), /FAIL: PROVENANCE dirty is "true"/);
  });

  test("missing symbol: one ABI lacks a checksum the .kt binds", () => {
    const gone =
      "uniffi_acutest_e2ee_checksum_method_e2eeengine_is_provisioned";
    const root = makeTree({
      exports: (abi, s) =>
        abi === "armeabi-v7a" ? s.filter((x) => x.name !== gone) : s,
    });
    const result = check(root);
    assertFails(
      result,
      new RegExp(
        `FAIL: .*armeabi-v7a/libacutest_e2ee\\.so does not export 1 symbol\\(s\\) the bindings need: ${gone}$`,
        "m",
      ),
    );
  });

  test("missing symbol: the contract version", () => {
    const root = makeTree({
      exports: (abi, s) =>
        abi === "arm64-v8a"
          ? s.filter(
              (x) => x.name !== "ffi_acutest_e2ee_uniffi_contract_version",
            )
          : s,
    });
    assertFails(
      check(root),
      /arm64-v8a.*does not export 1 symbol.*: ffi_acutest_e2ee_uniffi_contract_version$/m,
    );
  });

  test("missing symbol: a text method's function, though the .kt omits it", () => {
    // A .kt that never names the fn symbol must not shrink the requirement.
    const kt = goodKt().replace(
      /^ {4}fun uniffi_acutest_e2ee_fn_method_e2eeengine_text_encrypt\(.*\n.*\n/m,
      "",
    );
    assert.doesNotMatch(
      kt,
      /uniffi_acutest_e2ee_fn_method_e2eeengine_text_encrypt\b/,
    );
    const root = makeTree({
      kt,
      exports: (abi, s) =>
        abi === "x86_64"
          ? s.filter(
              (x) =>
                x.name !==
                "uniffi_acutest_e2ee_fn_method_e2eeengine_text_encrypt",
            )
          : s,
    });
    assertFails(
      check(root),
      /x86_64.*: uniffi_acutest_e2ee_fn_method_e2eeengine_text_encrypt$/m,
    );
  });

  for (const [label, edit] of [
    ["undefined (imported, not exported)", { defined: false }],
    ["LOCAL binding", { bind: STB_LOCAL }],
    ["HIDDEN visibility", { visibility: STV_HIDDEN }],
    ["a data object, not a function", { type: STT_OBJECT }],
  ]) {
    test(`missing symbol: present but ${label}`, () => {
      const name = "uniffi_acutest_e2ee_checksum_method_e2eeengine_text_join";
      const root = makeTree({
        exports: (abi, s) =>
          abi === "arm64-v8a"
            ? s.map((x) => (x.name === name ? { ...x, ...edit } : x))
            : s,
      });
      assertFails(
        check(root),
        new RegExp(`arm64-v8a.*does not export 1 symbol.*: ${name}$`, "m"),
      );
    });
  }

  test("stale .kt: synthetic pre-S7 bindings (no text plane)", () => {
    const root = makeTree({ kt: goodKt({ methods: [] }) });
    assertFails(
      check(root),
      /FAIL: .*acutest_e2ee\.kt lacks 21 of 21 protected-text methods \(stale bindings\?\)/,
    );
  });

  test(`stale .kt: the real pre-S7 bindings at ${PRE_S7_COMMIT}`, () => {
    const show = spawnSync(
      "git",
      ["-C", REPO, "show", `${PRE_S7_COMMIT}:packages/client/${KT_REL}`],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(show.status, 0, `git show failed: ${show.stderr}`);
    const kt = show.stdout;
    assert.ok(kt.includes("package uniffi.acutest_e2ee"), "a uniffi .kt");
    assert.ok(ktSymbols(kt).length > 100, "it binds the pre-S7 symbol set");
    // Libraries that export everything this .kt binds, and a PROVENANCE that
    // agrees with every file: only the missing text plane can fail it.
    const root = makeTree({ kt });
    assertFails(
      check(root),
      /acutest_e2ee\.kt lacks 21 of 21 protected-text methods/,
    );
  });

  test("stale .kt: one text method missing", () => {
    const root = makeTree({
      kt: goodKt({
        methods: TEXT_METHODS.filter((m) => m !== "text_capability"),
      }),
    });
    assertFails(
      check(root),
      /lacks 1 of 21 protected-text methods .*: text_capability$/m,
    );
  });

  test("PROVENANCE inside jniLibs (the old build-android.ps1 location)", () => {
    for (const rel of [
      "android/app/src/main/jniLibs/PROVENANCE.txt",
      "android/app/src/main/jniLibs/arm64-v8a/e2ee-native-PROVENANCE.txt",
    ]) {
      const root = makeTree();
      writeAt(root, rel, "format: regen-android/1\n");
      assertFails(
        check(root),
        new RegExp(`FAIL: ${rel.replaceAll(".", "\\.")} must not exist`),
      );
    }
  });
});

describe("more refusals", () => {
  test("wrong format", () => {
    const root = makeTree();
    writeProvenance(root, { overrides: { format: "build-android/0" } });
    assertFails(
      check(root),
      /PROVENANCE format is "build-android\/0", not regen-android\/1/,
    );
  });

  test("desktop_commit not a 40-hex sha", () => {
    for (const value of ["e8939a5", COMMIT.toUpperCase(), `${COMMIT}0`]) {
      const root = makeTree();
      writeProvenance(root, { overrides: { desktop_commit: value } });
      assertFails(check(root), /PROVENANCE desktop_commit is malformed/);
    }
  });

  test("--expect-desktop-commit mismatch", () => {
    assertFails(
      check(makeTree(), "--expect-desktop-commit", OTHER_COMMIT),
      new RegExp(`desktop_commit is ${COMMIT}, expected ${OTHER_COMMIT}`),
    );
  });

  test("a required key missing or malformed", () => {
    for (const key of [
      "format",
      "dirty",
      "desktop_commit",
      "sha256.kt",
      "kt_checksums",
      ...Object.keys(ABIS).map((abi) => `sha256.shipped.${abi}`),
      ...Object.keys(ABIS).map((abi) => `sha256.unstripped.${abi}`),
    ]) {
      const root = makeTree();
      writeProvenance(root, { overrides: { [key]: null } });
      assertFails(
        check(root),
        new RegExp(`PROVENANCE has no ${key.replaceAll(".", "\\.")}$`, "m"),
      );
    }
    const root = makeTree();
    writeProvenance(root, { overrides: { "sha256.unstripped.x86_64": "abc" } });
    assertFails(check(root), /sha256\.unstripped\.x86_64 is malformed/);
  });

  test("kt_checksums disagrees with the .kt", () => {
    const root = makeTree();
    writeProvenance(root, { overrides: { kt_checksums: "999" } });
    assertFails(
      check(root),
      /PROVENANCE kt_checksums 999 != \d+ checksum symbols/,
    );
  });

  test("a repeated key or a malformed line", () => {
    const repeated = makeTree();
    writeProvenance(repeated, { extra: ["dirty: false"] });
    assertFails(check(repeated), /malformed: key dirty appears more than once/);
    const malformed = makeTree();
    writeProvenance(malformed, { extra: ["not a key value line"] });
    assertFails(check(malformed), /malformed: line \d+ is not "key: value"/);
  });

  test("PROVENANCE, the .kt or a .so missing", () => {
    const noProv = makeTree();
    rmSync(join(noProv, PROVENANCE_REL));
    assertFails(check(noProv), /e2ee-native-PROVENANCE\.txt is missing/);
    const noKt = makeTree();
    rmSync(join(noKt, KT_REL));
    // the .kt and the symbols it would have required
    assertFails(check(noKt), /acutest_e2ee\.kt is missing/, 1);
    const noSo = makeTree();
    rmSync(join(noSo, soRel("armeabi-v7a")));
    assertFails(check(noSo), /armeabi-v7a\/libacutest_e2ee\.so is missing/);
  });

  test("a .so of the wrong ABI, hashes and exports otherwise right", () => {
    const root = makeTree();
    const symbols = [...exportsFor(goodKt()), ...BACKGROUND_SYMBOLS];
    writeAt(root, soRel("x86_64"), buildElf({ ...ABIS["arm64-v8a"], symbols }));
    writeProvenance(root);
    assertFails(
      check(root),
      /x86_64\/libacutest_e2ee\.so is ELF64 machine 183, expected ELF64 machine 62/,
    );
  });

  test("a .so that is not an ELF shared object", () => {
    const notElf = makeTree();
    writeAt(notElf, soRel("arm64-v8a"), "not a library");
    writeProvenance(notElf);
    assertFails(
      check(notElf),
      /arm64-v8a\/libacutest_e2ee\.so: not an ELF file/,
    );
    const exec = makeTree();
    const symbols = [...exportsFor(goodKt()), ...BACKGROUND_SYMBOLS];
    writeAt(
      exec,
      soRel("arm64-v8a"),
      buildElf({ ...ABIS["arm64-v8a"], type: 2, symbols }),
    );
    writeProvenance(exec);
    assertFails(
      check(exec),
      /arm64-v8a\/libacutest_e2ee\.so is not a shared object/,
    );
  });

  test("bad arguments exit 2", () => {
    for (const args of [
      ["--bogus"],
      ["--root"],
      ["--expect-desktop-commit"],
      ["--expect-desktop-commit", "e8939a5"],
      ["--expect-desktop-commit", COMMIT.toUpperCase()],
    ]) {
      const result = run(args);
      assert.equal(result.status, 2, `${args.join(" ")}: ${result.stderr}`);
      assert.match(result.stderr, /usage: /);
    }
  });
});
