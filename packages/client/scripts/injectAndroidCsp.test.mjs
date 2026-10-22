/**
 * injectAndroidCsp.mjs, run as the capacitor:copy:after hook runs it: a child
 * process with CAPACITOR_PLATFORM_NAME / SLOGA_FDROID in its environment and a
 * target path relative to the client root.
 *
 * Pins (plan D6 "CSP"): the Android policies stay exactly what they were at
 * 8821aac9 (the literals below), and the iOS policy is the standard one plus
 * `e2ee-att:` in img-src and media-src ONLY. Never connect-src (the webview
 * must not fetch plaintext), never frame-src (an embed must never frame an
 * attachment), never any other directive.
 *
 * Fixtures live in a mkdtemp folder under the OS temp dir, addressed by a
 * path relative to the script's client root, so a crashed run leaves nothing
 * in the tree.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "injectAndroidCsp.mjs");
// The script resolves its target as join(<client root>, argv[2]).
const ROOT = dirname(here);

// The 8821aac9 policies, copied literally. Do not regenerate these from the
// script: they are the byte-identity pin for the Android bundle.
const ANDROID_STANDARD_CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval' https://hcaptcha.com https://*.hcaptcha.com; style-src 'self' 'unsafe-inline' https://hcaptcha.com https://*.hcaptcha.com; img-src 'self' data: blob: https://app.sloga.gg; media-src 'self' blob: https://app.sloga.gg; font-src 'self' data:; connect-src 'self' blob: https://app.sloga.gg wss://app.sloga.gg https://*.sloga.gg wss://*.sloga.gg https://translate.googleapis.com https://api.drand.sh https://hcaptcha.com https://*.hcaptcha.com; worker-src 'self' blob:; manifest-src 'self'; frame-src https://hcaptcha.com https://*.hcaptcha.com https://www.youtube.com https://www.youtube-nocookie.com https://player.twitch.tv https://open.spotify.com https://w.soundcloud.com https://bandcamp.com https://new.lightspeed.tv; object-src 'none'; base-uri 'none'; form-action 'none'";
const ANDROID_FOSS_CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://app.sloga.gg; media-src 'self' blob: https://app.sloga.gg; font-src 'self' data:; connect-src 'self' blob: https://app.sloga.gg wss://app.sloga.gg https://*.sloga.gg wss://*.sloga.gg https://api.drand.sh; worker-src 'self' blob:; manifest-src 'self'; frame-src https://www.youtube.com https://www.youtube-nocookie.com https://player.twitch.tv https://open.spotify.com https://w.soundcloud.com https://bandcamp.com https://new.lightspeed.tv; object-src 'none'; base-uri 'none'; form-action 'none'";

const FIXTURE_HTML =
  '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="UTF-8" />\n<meta name="viewport" content="width=device-width, initial-scale=1.0" />\n<title>Sloga</title>\n</head>\n<body><div id="root"></div></body>\n</html>\n';

const MARKER_START = "<!-- android-csp:start -->";
const MARKER_END = "<!-- android-csp:end -->";
const META_RE =
  /<!-- android-csp:start --><meta http-equiv="Content-Security-Policy" content="([^"]*)"><!-- android-csp:end -->/g;

let tmp;
let counter = 0;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "inject-csp-test-"));
  assert.ok(
    !isAbsolute(relative(ROOT, tmp)),
    "the temp dir must be reachable by a relative path from the client root",
  );
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** A fresh fixture index.html at <tmp>/<n>/<shape>; returns its path. */
function fixture(shape) {
  const file = join(tmp, String(counter++), shape, "index.html");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, FIXTURE_HTML);
  return file;
}

const ANDROID_SHAPE = "android/app/src/main/assets/public";
const IOS_SHAPE = "ios/App/App/public";

/** Run the script on `file`; `env` adds to a copy with both knobs removed. */
function run(file, env = {}) {
  const base = { ...process.env };
  delete base.CAPACITOR_PLATFORM_NAME;
  delete base.SLOGA_FDROID;
  return spawnSync(process.execPath, [SCRIPT, relative(ROOT, file)], {
    cwd: ROOT,
    env: { ...base, ...env },
    encoding: "utf8",
  });
}

/** The single injected policy in `file` (asserts exactly one block). */
function injectedCsp(file) {
  const html = readFileSync(file, "utf8");
  assert.equal(html.split(MARKER_START).length - 1, 1, "one start marker");
  assert.equal(html.split(MARKER_END).length - 1, 1, "one end marker");
  const matches = [...html.matchAll(META_RE)];
  assert.equal(matches.length, 1, "one injected CSP meta");
  assert.ok(
    html.startsWith(`<!doctype html>\n<html lang="en">\n<head>${MARKER_START}`),
    "the block sits immediately after the literal <head>",
  );
  return matches[0][1];
}

/** Policy string -> Map(directive name -> source list). */
function parse(csp) {
  const map = new Map();
  for (const directive of csp.split(";")) {
    const [name, ...sources] = directive.trim().split(/\s+/);
    assert.ok(!map.has(name), `directive ${name} appears once`);
    map.set(name, sources);
  }
  return map;
}

function assertOk(result) {
  assert.equal(result.status, 0, `exit 0 expected; stderr: ${result.stderr}`);
}

describe("Android output is the 8821aac9 policy", () => {
  test("standard, CAPACITOR_PLATFORM_NAME unset (legacy bare default)", () => {
    const file = fixture(ANDROID_SHAPE);
    const result = run(file);
    assertOk(result);
    assert.equal(injectedCsp(file), ANDROID_STANDARD_CSP);
    assert.doesNotMatch(readFileSync(file, "utf8"), /e2ee-att/i);
    assert.equal(
      result.stdout,
      "[android-csp] injected main-document CSP into android assets index.html\n",
    );
  });

  test("standard, CAPACITOR_PLATFORM_NAME=android", () => {
    const file = fixture(ANDROID_SHAPE);
    assertOk(run(file, { CAPACITOR_PLATFORM_NAME: "android" }));
    assert.equal(injectedCsp(file), ANDROID_STANDARD_CSP);
    assert.doesNotMatch(readFileSync(file, "utf8"), /e2ee-att/i);
  });

  test("foss, SLOGA_FDROID=1 (platform unset and android)", () => {
    for (const env of [
      { SLOGA_FDROID: "1" },
      { SLOGA_FDROID: "1", CAPACITOR_PLATFORM_NAME: "android" },
    ]) {
      const file = fixture(ANDROID_SHAPE);
      const result = run(file, env);
      assertOk(result);
      assert.equal(injectedCsp(file), ANDROID_FOSS_CSP);
      assert.doesNotMatch(readFileSync(file, "utf8"), /e2ee-att/i);
      assert.equal(
        result.stdout,
        "[android-csp] injected foss (SLOGA_FDROID=1) main-document CSP into android assets index.html\n",
      );
    }
  });

  test("only the exact value 1 selects foss", () => {
    const file = fixture(ANDROID_SHAPE);
    assertOk(run(file, { SLOGA_FDROID: "true" }));
    assert.equal(injectedCsp(file), ANDROID_STANDARD_CSP);
  });
});

describe("iOS policy", () => {
  const standard = parse(ANDROID_STANDARD_CSP);

  test("e2ee-att: in img-src and media-src exactly once, nowhere else", () => {
    const file = fixture(IOS_SHAPE);
    const result = run(file, { CAPACITOR_PLATFORM_NAME: "ios" });
    assertOk(result);
    const ios = parse(injectedCsp(file));

    for (const name of ["img-src", "media-src"]) {
      const sources = ios.get(name);
      assert.equal(
        sources.filter((source) => source === "e2ee-att:").length,
        1,
        `${name} carries e2ee-att: exactly once`,
      );
      assert.equal(
        sources.filter((source) => /e2ee-att/i.test(source)).length,
        1,
        `${name} carries no other e2ee-att form`,
      );
      assert.deepEqual(sources, [...standard.get(name), "e2ee-att:"]);
    }
    for (const [name, sources] of ios) {
      if (name === "img-src" || name === "media-src") continue;
      assert.ok(
        !sources.some((source) => /e2ee-att/i.test(source)),
        `${name} must not carry e2ee-att in any form: ${sources.join(" ")}`,
      );
      assert.deepEqual(sources, standard.get(name), `${name} is standard`);
    }
    assert.deepEqual([...ios.keys()], [...standard.keys()]);
    assert.match(result.stdout, /\[ios-csp\] .*ios public index\.html/);
    assert.doesNotMatch(result.stdout, /android/);
  });

  test("frame-src and connect-src equal the Android standard ones", () => {
    const file = fixture(IOS_SHAPE);
    assertOk(run(file, { CAPACITOR_PLATFORM_NAME: "ios" }));
    const ios = parse(injectedCsp(file));
    assert.deepEqual(ios.get("frame-src"), standard.get("frame-src"));
    assert.deepEqual(ios.get("connect-src"), standard.get("connect-src"));
  });

  test("the whole policy mentions e2ee-att exactly twice", () => {
    const file = fixture(IOS_SHAPE);
    assertOk(run(file, { CAPACITOR_PLATFORM_NAME: "ios" }));
    const csp = injectedCsp(file);
    assert.equal(csp.match(/e2ee-att/gi)?.length, 2);
  });

  test("SLOGA_FDROID other than 1 is the standard iOS policy", () => {
    const plain = fixture(IOS_SHAPE);
    assertOk(run(plain, { CAPACITOR_PLATFORM_NAME: "ios" }));
    const zero = fixture(IOS_SHAPE);
    assertOk(run(zero, { CAPACITOR_PLATFORM_NAME: "ios", SLOGA_FDROID: "0" }));
    assert.equal(injectedCsp(zero), injectedCsp(plain));
  });
});

describe("idempotency", () => {
  for (const [label, shape, env] of [
    ["android", ANDROID_SHAPE, {}],
    ["android foss", ANDROID_SHAPE, { SLOGA_FDROID: "1" }],
    ["ios", IOS_SHAPE, { CAPACITOR_PLATFORM_NAME: "ios" }],
  ]) {
    test(`${label}: a second run leaves one identical block`, () => {
      const file = fixture(shape);
      assertOk(run(file, env));
      const first = readFileSync(file, "utf8");
      assertOk(run(file, env));
      assert.equal(readFileSync(file, "utf8"), first);
      injectedCsp(file);
    });
  }

  test("a foss block is replaced, not kept, by a standard run", () => {
    const file = fixture(ANDROID_SHAPE);
    assertOk(run(file, { SLOGA_FDROID: "1" }));
    assertOk(run(file));
    assert.equal(injectedCsp(file), ANDROID_STANDARD_CSP);
  });
});

describe("fail closed: exit 1 and the file untouched", () => {
  for (const [label, shape, env] of [
    ["unknown platform", ANDROID_SHAPE, { CAPACITOR_PLATFORM_NAME: "web" }],
    ["empty platform", ANDROID_SHAPE, { CAPACITOR_PLATFORM_NAME: "" }],
    ["platform case", IOS_SHAPE, { CAPACITOR_PLATFORM_NAME: "iOS" }],
    [
      "ios platform, android path",
      ANDROID_SHAPE,
      { CAPACITOR_PLATFORM_NAME: "ios" },
    ],
    [
      "android platform, ios path",
      IOS_SHAPE,
      { CAPACITOR_PLATFORM_NAME: "android" },
    ],
    ["unset platform, ios path", IOS_SHAPE, {}],
    [
      "ios + SLOGA_FDROID=1",
      IOS_SHAPE,
      { CAPACITOR_PLATFORM_NAME: "ios", SLOGA_FDROID: "1" },
    ],
    ["android foss, ios path", IOS_SHAPE, { SLOGA_FDROID: "1" }],
    [
      "path names both platforms",
      "android/ios/public",
      { CAPACITOR_PLATFORM_NAME: "ios" },
    ],
  ]) {
    test(label, () => {
      const file = fixture(shape);
      const result = run(file, env);
      assert.equal(
        result.status,
        1,
        `exit 1 expected; stdout: ${result.stdout}`,
      );
      assert.match(result.stderr, /FATAL/);
      assert.equal(readFileSync(file, "utf8"), FIXTURE_HTML);
    });
  }

  test("an already-injected file is left as it was", () => {
    const file = fixture(ANDROID_SHAPE);
    assertOk(run(file));
    const injected = readFileSync(file, "utf8");
    assert.equal(run(file, { CAPACITOR_PLATFORM_NAME: "ios" }).status, 1);
    assert.equal(readFileSync(file, "utf8"), injected);
  });
});
