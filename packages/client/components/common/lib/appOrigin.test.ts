/**
 * Run with:
 *
 *     node --conditions=browser --test components/common/lib/appOrigin.test.ts
 *
 * Covers native-shell detection (`isNativeShell`) and the origin `appOrigin`
 * builds shareable links from, by stubbing `globalThis.window` per spec.
 *
 * `./appOrigin.ts` imports `./env`, which is extensionless and reads
 * `import.meta.env`, so neither resolves under Node. That one specifier is
 * swapped for a fixed configuration via `module.registerHooks`, the approach
 * `../../state/stores/keybinds.test.ts` documents. The hook matches only an
 * import of `./env` from the exact module under test; if it stops matching,
 * the dynamic import below throws and this file fails loudly.
 *
 * Known-bad control: set `APPORIGIN_UNDER_TEST` to the path of a copy of
 * `appOrigin.ts` without the Electron (`window.native`) check, and the
 * Electron detection specs fail.
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const UNDER_TEST = process.env.APPORIGIN_UNDER_TEST
  ? pathToFileURL(process.env.APPORIGIN_UNDER_TEST).href
  : new URL("./appOrigin.ts", import.meta.url).href;

const ENV_STUB = "apporigin-test:env";

/** The API every native shell falls back to, and its origin */
const API_URL = "https://api-host.test/api";
const API_ORIGIN = "https://api-host.test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./env" && context.parentURL === UNDER_TEST) {
      return { url: ENV_STUB, shortCircuit: true };
    }

    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === ENV_STUB) {
      return {
        format: "module",
        shortCircuit: true,
        source: `export default {
          DEFAULT_API_URL: ${JSON.stringify(API_URL)},
          APP_URL: "",
          IS_STOAT: false,
        };`,
      };
    }

    return nextLoad(url, context);
  },
});

// Dynamic, so the hooks above are installed first.
const { appOrigin, isNativeShell }: typeof import("./appOrigin.ts") =
  await import(UNDER_TEST);

const globals = globalThis as unknown as { window?: unknown };

/**
 * Install a minimal `window` whose `location` is parsed from `url`, plus any
 * shell globals in `extra`.
 */
function stubWindow(url: string, extra: Record<string, unknown> = {}) {
  const { protocol, hostname, origin } = new URL(url);
  globals.window = { location: { protocol, hostname, origin }, ...extra };
}

afterEach(() => {
  delete globals.window;
});

describe("isNativeShell", () => {
  it("is false without a window", () => {
    assert.equal(isNativeShell(), false);
  });

  it("is false on a plain https web page", () => {
    stubWindow("https://self-hosted.test/app");
    assert.equal(isNativeShell(), false);
  });

  it("is false on the vite dev server", () => {
    stubWindow("http://localhost:5173/");
    assert.equal(isNativeShell(), false);
  });

  it("is true when the Tauri global is present", () => {
    stubWindow("https://self-hosted.test/", { __TAURI__: {} });
    assert.equal(isNativeShell(), true);
  });

  it("is true on the tauri: scheme", () => {
    stubWindow("tauri://localhost/");
    assert.equal(isNativeShell(), true);
  });

  it("is true on the tauri.localhost host", () => {
    stubWindow("http://tauri.localhost/");
    assert.equal(isNativeShell(), true);
  });

  it("is true in Electron, which exposes window.native", () => {
    stubWindow("app://bundle/", { native: {} });
    assert.equal(isNativeShell(), true);
  });

  it("detects Electron by window.native alone, not by its scheme", () => {
    stubWindow("https://self-hosted.test/", { native: {} });
    assert.equal(isNativeShell(), true);
  });

  it("ignores a window.native that is present but empty", () => {
    stubWindow("https://self-hosted.test/", { native: undefined });
    assert.equal(isNativeShell(), false);
    stubWindow("https://self-hosted.test/", { native: null });
    assert.equal(isNativeShell(), false);
  });

  it("is true when Capacitor reports a native platform", () => {
    stubWindow("https://localhost/", {
      Capacitor: { isNativePlatform: () => true },
    });
    assert.equal(isNativeShell(), true);
  });

  it("is false in Capacitor's web runtime", () => {
    stubWindow("https://self-hosted.test/", {
      Capacitor: { isNativePlatform: () => false },
    });
    assert.equal(isNativeShell(), false);
  });
});

describe("appOrigin", () => {
  it("uses the page origin on a real web page", () => {
    stubWindow("https://self-hosted.test/app");
    assert.equal(appOrigin(), "https://self-hosted.test");
  });

  it("falls back to the API origin in Tauri", () => {
    stubWindow("http://tauri.localhost/");
    assert.equal(appOrigin(), API_ORIGIN);
  });

  it("falls back to the API origin in Capacitor", () => {
    stubWindow("https://localhost/", {
      Capacitor: { isNativePlatform: () => true },
    });
    assert.equal(appOrigin(), API_ORIGIN);
  });

  it("falls back to the API origin in Electron", () => {
    stubWindow("app://bundle/", { native: {} });
    assert.equal(appOrigin(), API_ORIGIN);
  });

  it("falls back to the API origin without a window", () => {
    assert.equal(appOrigin(), API_ORIGIN);
  });
});
