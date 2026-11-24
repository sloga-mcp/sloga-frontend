/**
 * Run with:
 *
 *     node --conditions=browser --test components/common/lib/passkey.test.ts
 *
 * Covers the passkey facade: the two error tables, the base64url conversion
 * of options and credentials against fixed vectors, the extension-result
 * filter, one ceremony at a time, giving up on an open ceremony, the desktop
 * shells, the native plugin contract and the server advert lookup.
 *
 * `./passkey.ts` imports `@capacitor/core`, which this spec swaps for a stub
 * via `module.registerHooks` (the approach `appOrigin.test.ts` uses for
 * `./env`). The hook matches only that import from the exact module under
 * test. Almost every spec builds its own facade over a fake host with
 * `createPasskeyFacade`; the last block drives the real host detection by
 * stubbing `globalThis.window` and the Capacitor stub.
 *
 * Known-bad control: set `PASSKEY_UNDER_TEST` to the path of a changed copy
 * of `passkey.ts` (for example one whose `filterExtensionResults` returns
 * its input) and the matching specs fail.
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const UNDER_TEST = process.env.PASSKEY_UNDER_TEST
  ? pathToFileURL(process.env.PASSKEY_UNDER_TEST).href
  : new URL("./passkey.ts", import.meta.url).href;

const CAPACITOR_STUB = "passkey-test:capacitor";

/** What the Capacitor stub answers; set per spec. */
interface CapacitorStub {
  native: boolean;
  platform: string;
  plugin: unknown;
  registered: string[];
}

const stubs = globalThis as unknown as {
  __passkeyCapacitor: CapacitorStub;
  window?: unknown;
};

function resetCapacitor() {
  stubs.__passkeyCapacitor = {
    native: false,
    platform: "web",
    plugin: undefined,
    registered: [],
  };
}
resetCapacitor();

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@capacitor/core" && context.parentURL === UNDER_TEST) {
      return { url: CAPACITOR_STUB, shortCircuit: true };
    }

    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === CAPACITOR_STUB) {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export const Capacitor = {
            isNativePlatform: () => globalThis.__passkeyCapacitor.native,
            getPlatform: () => globalThis.__passkeyCapacitor.platform,
          };
          export const registerPlugin = (name) => {
            globalThis.__passkeyCapacitor.registered.push(name);
            return globalThis.__passkeyCapacitor.plugin;
          };`,
      };
    }

    return nextLoad(url, context);
  },
});

// Dynamic, so the hooks above are installed first.
const passkey: typeof import("./passkey.ts") = await import(UNDER_TEST);
const {
  PasskeyError,
  __resetPasskeysAdvertCache,
  base64urlToBuffer,
  browserFailure,
  bufferToBase64url,
  createPasskeyFacade,
  creationOptionsFromJSON,
  credentialToJSON,
  filterExtensionResults,
  findPasskeysAdvert,
  getPasskeysAdvert,
  nativeFailure,
  passkeyNameFor,
  requestOptionsFromJSON,
} = passkey;

type Host = import("./passkey.ts").PasskeyHost;

/** Fixed vector: bytes that need both url-safe characters and padding. */
const BYTES = [0xfb, 0xff, 0xfe, 0x00, 0x01];
const TEXT = "-__-AAE";

/** A second vector, so two members are never equal by accident. */
const BYTES_2 = [0x00, 0x10, 0x83, 0x10, 0x51, 0x87];
const TEXT_2 = "ABCDEFGH";

function buffer(bytes: number[]): ArrayBuffer {
  return new Uint8Array(bytes).buffer as ArrayBuffer;
}

function bytesOf(value: unknown): number[] {
  assert.ok(value instanceof ArrayBuffer, "expected an ArrayBuffer");
  return [...new Uint8Array(value)];
}

/** Assert that a promise rejects with a PasskeyError of the given code. */
async function rejectsWith(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof PasskeyError, "expected a PasskeyError");
    assert.equal(error.code, code);
    // Only the code: no system text, options or credential
    assert.equal(error.message, code);
    return true;
  });
}

function named(name: string) {
  const error = new Error("system text that must not leak");
  error.name = name;
  return error;
}

function coded(code: string) {
  return Object.assign(new Error("system text that must not leak"), { code });
}

const CREATE_OPTIONS = {
  rp: { id: "app.sloga.gg", name: "Sloga" },
  user: { id: TEXT, name: "someone", displayName: "Someone" },
  challenge: TEXT_2,
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
  timeout: 300000,
  excludeCredentials: [{ type: "public-key", id: TEXT }],
  authenticatorSelection: { userVerification: "required" },
};

const GET_OPTIONS = {
  challenge: TEXT,
  rpId: "app.sloga.gg",
  timeout: 300000,
  userVerification: "required",
  allowCredentials: [{ type: "public-key", id: TEXT_2 }],
};

/** A browser attestation credential without `toJSON`, as old browsers give. */
function liveAttestation(extensions: unknown = {}) {
  return {
    id: TEXT,
    rawId: buffer(BYTES),
    type: "public-key",
    authenticatorAttachment: "platform",
    response: {
      clientDataJSON: buffer(BYTES_2),
      attestationObject: buffer(BYTES),
      getTransports: () => ["internal", "hybrid"],
      getAuthenticatorData: () => buffer(BYTES_2),
      getPublicKey: () => buffer(BYTES),
      getPublicKeyAlgorithm: () => -7,
    },
    getClientExtensionResults: () => extensions,
  };
}

/** A browser assertion credential without `toJSON`. */
function liveAssertion(extensions: unknown = {}) {
  return {
    id: TEXT,
    rawId: buffer(BYTES),
    type: "public-key",
    authenticatorAttachment: null,
    response: {
      clientDataJSON: buffer(BYTES_2),
      authenticatorData: buffer(BYTES),
      signature: new Uint8Array(BYTES_2),
      userHandle: buffer(BYTES),
    },
    getClientExtensionResults: () => extensions,
  };
}

const ATTESTATION_JSON = {
  id: TEXT,
  rawId: TEXT,
  type: "public-key",
  response: {
    clientDataJSON: TEXT_2,
    attestationObject: TEXT,
    authenticatorData: TEXT_2,
    publicKey: TEXT,
    transports: ["internal", "hybrid"],
    publicKeyAlgorithm: -7,
  },
  clientExtensionResults: {},
  authenticatorAttachment: "platform",
};

const ASSERTION_JSON = {
  id: TEXT,
  rawId: TEXT,
  type: "public-key",
  response: {
    clientDataJSON: TEXT_2,
    authenticatorData: TEXT,
    signature: TEXT_2,
    userHandle: TEXT,
  },
  clientExtensionResults: {},
};

/** A browser host whose ceremonies answer with the given credential. */
function browserHost(
  answer: () => Promise<unknown>,
  parser: Host["parser"] = {},
): Host & { seen: unknown[] } {
  const seen: unknown[] = [];
  return {
    kind: "browser",
    parser,
    credentials: {
      create: (options) => (seen.push(options), answer()),
      get: (options) => (seen.push(options), answer()),
    },
    seen,
  };
}

describe("base64url", () => {
  it("decodes the fixed vectors", () => {
    assert.deepEqual(bytesOf(base64urlToBuffer(TEXT)), BYTES);
    assert.deepEqual(bytesOf(base64urlToBuffer(TEXT_2)), BYTES_2);
    assert.deepEqual(bytesOf(base64urlToBuffer("")), []);
  });

  it("encodes the fixed vectors without padding", () => {
    assert.equal(bufferToBase64url(buffer(BYTES)), TEXT);
    assert.equal(bufferToBase64url(buffer(BYTES_2)), TEXT_2);
    assert.equal(bufferToBase64url(buffer([])), "");
  });

  it("encodes a view over part of a buffer", () => {
    const whole = new Uint8Array([9, 9, ...BYTES, 9]);
    assert.equal(bufferToBase64url(whole.subarray(2, 7)), TEXT);
  });

  it("round-trips every byte value", () => {
    const all = Array.from({ length: 256 }, (_, i) => i);
    assert.deepEqual(
      bytesOf(base64urlToBuffer(bufferToBase64url(buffer(all)))),
      all,
    );
  });

  it("tolerates padding and refuses anything else", () => {
    assert.deepEqual(bytesOf(base64urlToBuffer(TEXT + "=")), BYTES);
    assert.throws(() => base64urlToBuffer("+//+AAE"));
    assert.throws(() => base64urlToBuffer("ab cd"));
    assert.throws(() => base64urlToBuffer("abcde"));
    assert.throws(() => base64urlToBuffer(5 as unknown as string));
  });
});

describe("options from JSON", () => {
  it("converts creation options", () => {
    const options = creationOptionsFromJSON(CREATE_OPTIONS) as {
      challenge: unknown;
      user: { id: unknown; name: string; displayName: string };
      excludeCredentials: { id: unknown; type: string }[];
      rp: unknown;
      pubKeyCredParams: unknown;
      timeout: unknown;
      authenticatorSelection: unknown;
    };

    assert.deepEqual(bytesOf(options.challenge), BYTES_2);
    assert.deepEqual(bytesOf(options.user.id), BYTES);
    assert.equal(options.user.name, "someone");
    assert.equal(options.user.displayName, "Someone");
    assert.equal(options.excludeCredentials.length, 1);
    assert.deepEqual(bytesOf(options.excludeCredentials[0].id), BYTES);
    assert.equal(options.excludeCredentials[0].type, "public-key");
    assert.deepEqual(options.rp, CREATE_OPTIONS.rp);
    assert.deepEqual(options.pubKeyCredParams, CREATE_OPTIONS.pubKeyCredParams);
    assert.equal(options.timeout, 300000);
    assert.deepEqual(
      options.authenticatorSelection,
      CREATE_OPTIONS.authenticatorSelection,
    );
  });

  it("converts request options", () => {
    const options = requestOptionsFromJSON(GET_OPTIONS) as {
      challenge: unknown;
      allowCredentials: { id: unknown }[];
      rpId: unknown;
      userVerification: unknown;
    };

    assert.deepEqual(bytesOf(options.challenge), BYTES);
    assert.deepEqual(bytesOf(options.allowCredentials[0].id), BYTES_2);
    assert.equal(options.rpId, "app.sloga.gg");
    assert.equal(options.userVerification, "required");
  });

  it("leaves absent credential lists absent and adds no extensions", () => {
    const create = creationOptionsFromJSON({
      ...CREATE_OPTIONS,
      excludeCredentials: undefined,
    });
    assert.equal(create.excludeCredentials, undefined);
    assert.equal("extensions" in create, false);

    const get = requestOptionsFromJSON({ challenge: TEXT, rpId: "x" });
    assert.equal("allowCredentials" in get, false);
    assert.equal("extensions" in get, false);
  });

  it("does not change the options it was given", () => {
    const before = JSON.stringify(CREATE_OPTIONS);
    creationOptionsFromJSON(CREATE_OPTIONS);
    requestOptionsFromJSON(GET_OPTIONS);
    assert.equal(JSON.stringify(CREATE_OPTIONS), before);
    assert.equal(typeof GET_OPTIONS.challenge, "string");
  });

  it("refuses malformed options", () => {
    assert.throws(() => creationOptionsFromJSON(null));
    assert.throws(() => creationOptionsFromJSON({ challenge: TEXT }));
    assert.throws(() =>
      creationOptionsFromJSON({ ...CREATE_OPTIONS, challenge: "a+b" }),
    );
    assert.throws(() =>
      creationOptionsFromJSON({ ...CREATE_OPTIONS, excludeCredentials: {} }),
    );
    assert.throws(() => requestOptionsFromJSON({ rpId: "x" }));
    assert.throws(() =>
      requestOptionsFromJSON({
        challenge: TEXT,
        allowCredentials: [{ id: 1 }],
      }),
    );
  });
});

describe("credential to JSON", () => {
  it("converts an attestation read off the live object", () => {
    assert.deepEqual(
      credentialToJSON("create", liveAttestation()),
      ATTESTATION_JSON,
    );
  });

  it("converts an assertion read off the live object", () => {
    assert.deepEqual(credentialToJSON("get", liveAssertion()), ASSERTION_JSON);
  });

  it("leaves out a missing user handle", () => {
    const credential = liveAssertion();
    (credential.response as { userHandle: unknown }).userHandle = null;

    const json = credentialToJSON("get", credential) as {
      response: Record<string, unknown>;
    };
    assert.equal("userHandle" in json.response, false);
  });

  it("uses toJSON when there is one, and still drops unknown members", () => {
    const credential = {
      toJSON: () => ({
        ...ASSERTION_JSON,
        extra: "dropped",
        response: { ...ASSERTION_JSON.response, extra: "dropped" },
        clientExtensionResults: { prf: { results: { first: TEXT } } },
      }),
    };

    assert.deepEqual(credentialToJSON("get", credential), ASSERTION_JSON);
  });

  it("falls back to the live object when toJSON throws", () => {
    const credential = {
      ...liveAssertion(),
      toJSON: () => {
        throw new Error("broken add-on");
      },
    };

    assert.deepEqual(credentialToJSON("get", credential), ASSERTION_JSON);
  });

  it("refuses something that is not a credential", () => {
    assert.throws(() => credentialToJSON("get", null));
    assert.throws(() => credentialToJSON("get", {}));
    assert.throws(() => credentialToJSON("get", { id: TEXT, response: {} }));
  });
});

describe("extension results", () => {
  it("keeps credProps.rk on a create", () => {
    assert.deepEqual(
      filterExtensionResults("create", { credProps: { rk: true } }),
      { credProps: { rk: true } },
    );
    assert.deepEqual(
      filterExtensionResults("create", { credProps: { rk: false } }),
      { credProps: { rk: false } },
    );
  });

  it("drops every other key on a create", () => {
    assert.deepEqual(
      filterExtensionResults("create", {
        credProps: { rk: true, more: 1 },
        prf: { enabled: true },
        largeBlob: { supported: true },
        addOn: "x",
      }),
      { credProps: { rk: true } },
    );
    assert.deepEqual(
      filterExtensionResults("create", { prf: { enabled: true } }),
      {},
    );
  });

  it("drops credProps without a boolean rk", () => {
    assert.deepEqual(filterExtensionResults("create", { credProps: {} }), {});
    assert.deepEqual(
      filterExtensionResults("create", { credProps: { rk: "true" } }),
      {},
    );
    assert.deepEqual(filterExtensionResults("create", { credProps: 1 }), {});
  });

  it("sends nothing on a get, credProps included", () => {
    assert.deepEqual(
      filterExtensionResults("get", {
        credProps: { rk: true },
        prf: { results: { first: TEXT } },
      }),
      {},
    );
  });

  it("reads anything that is not an object as empty", () => {
    for (const value of [undefined, null, "x", 1, []]) {
      assert.deepEqual(filterExtensionResults("create", value), {});
    }
  });

  it("filters the results of a real ceremony", async () => {
    const results = { credProps: { rk: true }, prf: { enabled: true } };

    const create = createPasskeyFacade(() =>
      browserHost(async () => liveAttestation(results)),
    );
    assert.deepEqual(
      ((await create.createPasskey(CREATE_OPTIONS)) as Record<string, unknown>)
        .clientExtensionResults,
      { credProps: { rk: true } },
    );

    const get = createPasskeyFacade(() =>
      browserHost(async () => liveAssertion(results)),
    );
    assert.deepEqual(
      ((await get.getPasskey(GET_OPTIONS)) as Record<string, unknown>)
        .clientExtensionResults,
      {},
    );
  });
});

describe("error tables", () => {
  it("maps browser errors by name", () => {
    const table: [string, string][] = [
      ["NotAllowedError", "cancelled"],
      ["AbortError", "cancelled"],
      ["InvalidStateError", "failed"],
      ["SecurityError", "unavailable"],
      ["NotSupportedError", "unavailable"],
      ["UnknownError", "failed"],
      ["ConstraintError", "failed"],
      ["TypeError", "failed"],
    ];

    for (const [name, code] of table) {
      assert.equal(browserFailure(named(name)), code, name);
    }

    assert.equal(browserFailure(undefined), "failed");
    assert.equal(browserFailure(null), "failed");
    assert.equal(browserFailure("NotAllowedError"), "failed");
  });

  it("maps native plugin rejections by code", () => {
    const table: [unknown, string][] = [
      ["cancelled", "cancelled"],
      ["no_credential", "no_credential"],
      ["unavailable", "unavailable"],
      ["failed", "failed"],
      ["UNIMPLEMENTED", "unavailable"],
      ["UNAVAILABLE", "unavailable"],
      ["something else", "failed"],
      [undefined, "failed"],
      [7, "failed"],
    ];

    for (const [code, expected] of table) {
      assert.equal(nativeFailure({ code }), expected, String(code));
    }

    assert.equal(nativeFailure(undefined), "failed");
    // The message is never read, only the code
    assert.equal(nativeFailure(new Error("cancelled")), "failed");
  });

  it("turns a browser rejection into a PasskeyError with the code only", async () => {
    for (const [name, code] of [
      ["NotAllowedError", "cancelled"],
      ["InvalidStateError", "failed"],
      ["SecurityError", "unavailable"],
    ]) {
      const facade = createPasskeyFacade(() =>
        browserHost(() => Promise.reject(named(name))),
      );
      await rejectsWith(facade.getPasskey(GET_OPTIONS), code);
      await rejectsWith(facade.createPasskey(CREATE_OPTIONS), code);
    }
  });
});

describe("browser ceremonies", () => {
  it("runs a create with converted options and returns the JSON form", async () => {
    const host = browserHost(async () => liveAttestation());
    const facade = createPasskeyFacade(() => host);

    assert.deepEqual(
      await facade.createPasskey(CREATE_OPTIONS),
      ATTESTATION_JSON,
    );

    assert.equal(host.seen.length, 1);
    const { publicKey } = host.seen[0] as {
      publicKey: { challenge: unknown; user: { id: unknown } };
    };
    assert.deepEqual(bytesOf(publicKey.challenge), BYTES_2);
    assert.deepEqual(bytesOf(publicKey.user.id), BYTES);
    assert.equal("extensions" in publicKey, false);
  });

  it("runs a get with converted options and returns the JSON form", async () => {
    const host = browserHost(async () => liveAssertion());
    const facade = createPasskeyFacade(() => host);

    assert.deepEqual(await facade.getPasskey(GET_OPTIONS), ASSERTION_JSON);

    const { publicKey } = host.seen[0] as {
      publicKey: Record<string, unknown>;
    };
    assert.deepEqual(bytesOf(publicKey.challenge), BYTES);
    assert.equal("extensions" in publicKey, false);
  });

  it("uses the browser's own parser when it has one", async () => {
    const parsed = { parsed: true };
    const calls: string[] = [];
    const host = browserHost(async () => liveAssertion(), {
      parseCreationOptionsFromJSON: () => (calls.push("create"), parsed),
      parseRequestOptionsFromJSON: () => (calls.push("get"), parsed),
    });
    const facade = createPasskeyFacade(() => host);

    await facade.getPasskey(GET_OPTIONS);
    assert.deepEqual(calls, ["get"]);
    assert.equal((host.seen[0] as { publicKey: unknown }).publicKey, parsed);
  });

  it("converts by hand when the browser's parser refuses the options", async () => {
    const host = browserHost(async () => liveAssertion(), {
      parseRequestOptionsFromJSON: () => {
        throw new TypeError("unknown member");
      },
    });
    const facade = createPasskeyFacade(() => host);

    assert.deepEqual(await facade.getPasskey(GET_OPTIONS), ASSERTION_JSON);
    const { publicKey } = host.seen[0] as {
      publicKey: Record<string, unknown>;
    };
    assert.deepEqual(bytesOf(publicKey.challenge), BYTES);
  });

  it("fails on malformed options without opening a prompt", async () => {
    const host = browserHost(async () => liveAssertion());
    const facade = createPasskeyFacade(() => host);

    await rejectsWith(facade.getPasskey({ rpId: "x" }), "failed");
    await rejectsWith(facade.getPasskey("options"), "failed");
    await rejectsWith(facade.createPasskey(null), "failed");
    assert.equal(host.seen.length, 0);
  });

  it("fails when the browser gives no credential", async () => {
    const facade = createPasskeyFacade(() => browserHost(async () => null));
    await rejectsWith(facade.getPasskey(GET_OPTIONS), "failed");
  });

  it("is unavailable in a browser without WebAuthn", async () => {
    const facade = createPasskeyFacade(() => ({ kind: "browser" }));

    assert.equal(await facade.passkeysSupported(), false);
    await rejectsWith(facade.getPasskey(GET_OPTIONS), "unavailable");
    await rejectsWith(facade.createPasskey(CREATE_OPTIONS), "unavailable");
  });

  it("is supported in a browser with WebAuthn", async () => {
    const facade = createPasskeyFacade(() =>
      browserHost(async () => liveAssertion()),
    );
    assert.equal(await facade.passkeysSupported(), true);
  });
});

describe("one ceremony at a time", () => {
  it("refuses a second ceremony while one is open, then recovers", async () => {
    let finish!: (value: unknown) => void;
    const host = browserHost(
      () => new Promise((resolve) => (finish = resolve)),
    );
    const facade = createPasskeyFacade(() => host);

    /**
     * How a ceremony ends, or "still open" if it has not ended shortly. A
     * second ceremony that was let through would wait on its prompt forever,
     * so it is raced against a timer rather than awaited.
     */
    async function outcome(ceremony: Promise<unknown>): Promise<unknown> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          ceremony.then(
            () => "resolved",
            (error: unknown) => error,
          ),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve("still open"), 200);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }

    const first = facade.getPasskey(GET_OPTIONS);
    const resolveFirst = finish;

    for (const refused of [
      await outcome(facade.getPasskey(GET_OPTIONS)),
      await outcome(facade.createPasskey(CREATE_OPTIONS)),
    ]) {
      assert.ok(refused instanceof PasskeyError, `got: ${String(refused)}`);
      assert.equal(refused.code, "failed");
    }
    assert.equal(host.seen.length, 1, "the open prompt is the only one");
    finish = resolveFirst;

    finish(liveAssertion());
    assert.deepEqual(await first, ASSERTION_JSON);

    // The slot is free again after a success ...
    const second = facade.getPasskey(GET_OPTIONS);
    finish(liveAssertion());
    assert.deepEqual(await second, ASSERTION_JSON);
  });

  it("frees the slot after a failure", async () => {
    let fail = true;
    const facade = createPasskeyFacade(() =>
      browserHost(() =>
        fail
          ? Promise.reject(named("NotAllowedError"))
          : Promise.resolve(liveAssertion()),
      ),
    );

    await rejectsWith(facade.getPasskey(GET_OPTIONS), "cancelled");
    fail = false;
    assert.deepEqual(await facade.getPasskey(GET_OPTIONS), ASSERTION_JSON);
  });
});

describe("giving up on a ceremony", () => {
  /** A browser host whose prompts stay open until the spec answers them. */
  function stuckHost() {
    const answers: ((value: unknown) => void)[] = [];
    const host = browserHost(
      () => new Promise((resolve) => answers.push(resolve)),
    );
    return { host, answers };
  }

  function signalOf(seen: unknown): AbortSignal {
    const { signal } = seen as { signal?: unknown };
    assert.ok(signal instanceof AbortSignal, "expected an AbortSignal");
    return signal;
  }

  it("hands the browser a signal that is not aborted", async () => {
    const { host, answers } = stuckHost();
    const facade = createPasskeyFacade(() => host);

    const open = facade.createPasskey(CREATE_OPTIONS);
    await Promise.resolve();
    assert.equal(signalOf(host.seen[0]).aborted, false);

    answers[0](liveAttestation());
    assert.deepEqual(await open, ATTESTATION_JSON);
    assert.equal(signalOf(host.seen[0]).aborted, false);
  });

  it("ends a prompt that never answers as cancelled and aborts it", async () => {
    const { host } = stuckHost();
    const facade = createPasskeyFacade(() => host);

    const stuck = facade.getPasskey(GET_OPTIONS);
    await Promise.resolve();
    facade.cancelPasskeyCeremony();

    await rejectsWith(stuck, "cancelled");
    assert.equal(signalOf(host.seen[0]).aborted, true);
  });

  it("frees the slot, so a later ceremony runs", async () => {
    const { host, answers } = stuckHost();
    const facade = createPasskeyFacade(() => host);

    const stuck = facade.getPasskey(GET_OPTIONS);
    await Promise.resolve();
    facade.cancelPasskeyCeremony();
    await rejectsWith(stuck, "cancelled");

    const later = facade.getPasskey(GET_OPTIONS);
    await Promise.resolve();
    assert.equal(host.seen.length, 2, "the later ceremony opened a prompt");

    // The abandoned prompt answering late changes nothing
    answers[0](liveAttestation());
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(signalOf(host.seen[1]).aborted, false);

    answers[1](liveAssertion());
    assert.deepEqual(await later, ASSERTION_JSON);
  });

  it("does nothing when no ceremony is open", async () => {
    const { host, answers } = stuckHost();
    const facade = createPasskeyFacade(() => host);

    facade.cancelPasskeyCeremony();

    const first = facade.getPasskey(GET_OPTIONS);
    await Promise.resolve();
    answers[0](liveAssertion());
    assert.deepEqual(await first, ASSERTION_JSON);

    // After a ceremony has ended there is nothing to give up on either
    facade.cancelPasskeyCeremony();
    assert.equal(signalOf(host.seen[0]).aborted, false);

    const second = facade.getPasskey(GET_OPTIONS);
    await Promise.resolve();
    answers[1](liveAssertion());
    assert.deepEqual(await second, ASSERTION_JSON);
  });

  it("frees the slot in the phone apps, where the sheet cannot be closed", async () => {
    const answers: ((value: { credentialJson: string }) => void)[] = [];
    const facade = createPasskeyFacade(() => ({
      kind: "native",
      nativePlatform: "android",
      plugin: {
        isAvailable: async () => ({ available: true }),
        create: () => new Promise((resolve) => answers.push(resolve)),
        get: () => new Promise((resolve) => answers.push(resolve)),
      },
    }));

    const stuck = facade.getPasskey(GET_OPTIONS);
    await Promise.resolve();
    facade.cancelPasskeyCeremony();
    await rejectsWith(stuck, "cancelled");

    const later = facade.getPasskey(GET_OPTIONS);
    await Promise.resolve();
    assert.equal(answers.length, 2);
    answers[1]({ credentialJson: JSON.stringify(ASSERTION_JSON) });
    assert.deepEqual(await later, ASSERTION_JSON);
  });

  it("drops the answer of a prompt that was given up on", async () => {
    const { host, answers } = stuckHost();
    const facade = createPasskeyFacade(() => host);

    let settled: unknown = "open";
    const stuck = facade.getPasskey(GET_OPTIONS).then(
      (credential) => (settled = credential),
      (error: unknown) => (settled = error),
    );
    await Promise.resolve();

    facade.cancelPasskeyCeremony();
    answers[0](liveAssertion());
    await stuck;

    assert.ok(settled instanceof PasskeyError);
    assert.equal(settled.code, "cancelled");
  });
});

describe("desktop shells", () => {
  it("are unsupported and never reach a ceremony", async () => {
    const facade = createPasskeyFacade(() => ({ kind: "desktop" }));

    assert.equal(await facade.passkeysSupported(), false);
    await rejectsWith(facade.getPasskey(GET_OPTIONS), "unavailable");
    await rejectsWith(facade.createPasskey(CREATE_OPTIONS), "unavailable");
  });

  it("without a window is unsupported too", async () => {
    const facade = createPasskeyFacade(() => ({ kind: "none" }));

    assert.equal(await facade.passkeysSupported(), false);
    await rejectsWith(facade.getPasskey(GET_OPTIONS), "unavailable");
  });

  it("never throws from passkeysSupported", async () => {
    const facade = createPasskeyFacade(() => {
      throw new Error("no host");
    });

    assert.equal(await facade.passkeysSupported(), false);
    assert.equal(facade.defaultPasskeyName(), "Passkey");
    await rejectsWith(facade.getPasskey(GET_OPTIONS), "failed");
  });
});

describe("native plugin", () => {
  /** A native host over a fake plugin that records what it was sent. */
  function nativeHost(plugin: Partial<NonNullable<Host["plugin"]>>): Host {
    return {
      kind: "native",
      nativePlatform: "android",
      plugin: plugin as NonNullable<Host["plugin"]>,
    };
  }

  it("sends the options as JSON text and parses the credential", async () => {
    const sent: { optionsJson: string }[] = [];
    const facade = createPasskeyFacade(() =>
      nativeHost({
        create: async (options) => {
          sent.push(options);
          return { credentialJson: JSON.stringify(ATTESTATION_JSON) };
        },
        get: async (options) => {
          sent.push(options);
          return { credentialJson: JSON.stringify(ASSERTION_JSON) };
        },
      }),
    );

    assert.deepEqual(
      await facade.createPasskey(CREATE_OPTIONS),
      ATTESTATION_JSON,
    );
    assert.deepEqual(await facade.getPasskey(GET_OPTIONS), ASSERTION_JSON);

    assert.deepEqual(Object.keys(sent[0]), ["optionsJson"]);
    assert.equal(sent[0].optionsJson, JSON.stringify(CREATE_OPTIONS));
    assert.equal(sent[1].optionsJson, JSON.stringify(GET_OPTIONS));
  });

  it("maps Capacitor's UNIMPLEMENTED to unavailable", async () => {
    const unimplemented = () => Promise.reject(coded("UNIMPLEMENTED"));
    const facade = createPasskeyFacade(() =>
      nativeHost({
        isAvailable: unimplemented,
        create: unimplemented,
        get: unimplemented,
      }),
    );

    assert.equal(await facade.passkeysSupported(), false);
    await rejectsWith(facade.getPasskey(GET_OPTIONS), "unavailable");
    await rejectsWith(facade.createPasskey(CREATE_OPTIONS), "unavailable");
  });

  it("passes the plugin's four codes through", async () => {
    for (const code of [
      "cancelled",
      "no_credential",
      "unavailable",
      "failed",
    ]) {
      const facade = createPasskeyFacade(() =>
        nativeHost({ get: () => Promise.reject(coded(code)) }),
      );
      await rejectsWith(facade.getPasskey(GET_OPTIONS), code);
    }
  });

  it("fails on an answer that is not a credential object", async () => {
    for (const credentialJson of ["not json", "[]", '"text"', "null"]) {
      const facade = createPasskeyFacade(() =>
        nativeHost({ get: async () => ({ credentialJson }) }),
      );
      await rejectsWith(facade.getPasskey(GET_OPTIONS), "failed");
    }

    const empty = createPasskeyFacade(() =>
      nativeHost({
        get: async () => ({}) as unknown as { credentialJson: string },
      }),
    );
    await rejectsWith(empty.getPasskey(GET_OPTIONS), "failed");
  });

  it("fails on options that are not an object, without calling the plugin", async () => {
    let called = false;
    const facade = createPasskeyFacade(() =>
      nativeHost({
        get: async () => {
          called = true;
          return { credentialJson: "{}" };
        },
      }),
    );

    await rejectsWith(facade.getPasskey("options"), "failed");
    assert.equal(called, false);
  });

  it("reads isAvailable strictly", async () => {
    const answers: [unknown, boolean][] = [
      [{ available: true }, true],
      [{ available: false }, false],
      [{ available: "true" }, false],
      [{}, false],
      [undefined, false],
    ];

    for (const [answer, expected] of answers) {
      const facade = createPasskeyFacade(() =>
        nativeHost({
          isAvailable: async () => answer as { available: boolean },
        }),
      );
      assert.equal(await facade.passkeysSupported(), expected);
    }
  });
});

describe("default passkey name", () => {
  const UA = {
    windows:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36",
    mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15",
    iphone:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
    androidPhone:
      "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36",
    androidTablet:
      "Mozilla/5.0 (Linux; Android 15; Pixel Tablet) AppleWebKit/537.36 Chrome/130.0 Safari/537.36",
    linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0",
    chromebook: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36",
  };

  it("names browsers by their system", () => {
    const table: [string, number, string][] = [
      [UA.windows, 0, "Windows PC"],
      [UA.mac, 0, "Mac"],
      [UA.mac, 5, "iPad"],
      [UA.iphone, 5, "iPhone"],
      [UA.androidPhone, 5, "Android phone"],
      [UA.androidTablet, 5, "Android tablet"],
      [UA.linux, 0, "Linux PC"],
      [UA.chromebook, 0, "Chromebook"],
      ["", 0, "Passkey"],
    ];

    for (const [userAgent, touchPoints, name] of table) {
      assert.equal(
        passkeyNameFor({ kind: "browser", userAgent, touchPoints }),
        name,
      );
    }
  });

  it("names the phone apps by their platform", () => {
    assert.equal(
      passkeyNameFor({
        kind: "native",
        nativePlatform: "ios",
        userAgent: UA.iphone,
      }),
      "iPhone",
    );
    assert.equal(
      passkeyNameFor({
        kind: "native",
        nativePlatform: "ios",
        userAgent: UA.mac,
        touchPoints: 5,
      }),
      "iPad",
    );
    assert.equal(
      passkeyNameFor({
        kind: "native",
        nativePlatform: "android",
        userAgent: UA.androidPhone,
      }),
      "Android phone",
    );
  });
});

describe("server advert", () => {
  afterEach(() => __resetPasskeysAdvertCache());

  const OFF = {
    available: false,
    signup: false,
    signup_without_email: false,
    backup_unlock: false,
  };

  /** A fetch that answers every request with `body`, counting the calls. */
  function fakeFetch(body: unknown, ok = true) {
    const urls: string[] = [];
    const impl = (async (url: string) => {
      urls.push(url);
      return { ok, json: async () => body };
    }) as unknown as typeof fetch;
    return { impl, urls };
  }

  it("reads features.passkeys from the root document", async () => {
    const { impl, urls } = fakeFetch({
      features: {
        passkeys: {
          available: true,
          signup: false,
          signup_without_email: false,
          backup_unlock: false,
        },
      },
    });

    assert.deepEqual(await getPasskeysAdvert("https://api.test/api//", impl), {
      ...OFF,
      available: true,
    });
    assert.deepEqual(urls, ["https://api.test/api/"]);
  });

  it("reads a server without the advert as everything off", async () => {
    const { impl } = fakeFetch({ features: { captcha: { enabled: false } } });
    assert.deepEqual(await getPasskeysAdvert("https://api.test", impl), OFF);
  });

  it("takes only a real true as on", async () => {
    const { impl } = fakeFetch({
      features: { passkeys: { available: "true", signup: 1 } },
    });
    assert.deepEqual(await getPasskeysAdvert("https://api.test", impl), OFF);
  });

  it("remembers an answer and shares one request", async () => {
    const { impl, urls } = fakeFetch({
      features: { passkeys: { available: true } },
    });

    const [a, b] = await Promise.all([
      getPasskeysAdvert("https://api.test", impl),
      getPasskeysAdvert("https://api.test/", impl),
    ]);
    await getPasskeysAdvert("https://api.test", impl);

    assert.equal(a.available, true);
    assert.equal(b.available, true);
    assert.equal(urls.length, 1);
  });

  it("reads a failure as off and asks again next time", async () => {
    const failing = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    assert.deepEqual(await getPasskeysAdvert("https://api.test", failing), OFF);

    const refused = fakeFetch({}, false);
    assert.deepEqual(
      await getPasskeysAdvert("https://api.test", refused.impl),
      OFF,
    );

    const { impl } = fakeFetch({ features: { passkeys: { available: true } } });
    assert.equal(
      (await getPasskeysAdvert("https://api.test", impl)).available,
      true,
    );
  });

  // Fails if: a lookup that failed can no longer be told from a server
  // that answered "off" (the recovery page leaves on the second and offers
  // another try on the first), or the two lookups stop sharing one request
  it("tells a failed lookup from a server that says off", async () => {
    const failing = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    assert.equal(
      await findPasskeysAdvert("https://api.test", failing),
      undefined,
    );

    const refused = fakeFetch({}, false);
    assert.equal(
      await findPasskeysAdvert("https://api.test", refused.impl),
      undefined,
    );

    const { impl, urls } = fakeFetch({ features: {} });
    assert.deepEqual(await findPasskeysAdvert("https://api.test", impl), OFF);
    assert.deepEqual(await getPasskeysAdvert("https://api.test/", impl), OFF);
    assert.equal(urls.length, 1);
  });
});

describe("host detection", () => {
  afterEach(() => {
    delete stubs.window;
    resetCapacitor();
  });

  /** A window with WebAuthn, plus any shell globals in `extra`. */
  function stubWindow(url: string, extra: Record<string, unknown> = {}) {
    const { protocol, hostname } = new URL(url);
    const prompts: unknown[] = [];
    stubs.window = {
      location: { protocol, hostname },
      navigator: {
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        maxTouchPoints: 0,
        credentials: {
          create: async (options: unknown) => (
            prompts.push(options),
            liveAttestation()
          ),
          get: async (options: unknown) => (
            prompts.push(options),
            liveAssertion()
          ),
        },
      },
      PublicKeyCredential: {},
      ...extra,
    };
    return prompts;
  }

  it("is unsupported without a window", async () => {
    assert.equal(await passkey.passkeysSupported(), false);
    await rejectsWith(passkey.getPasskey(GET_OPTIONS), "unavailable");
  });

  it("uses WebAuthn on a web page", async () => {
    const prompts = stubWindow("https://app.sloga.gg/login/auth");

    assert.equal(await passkey.passkeysSupported(), true);
    assert.deepEqual(await passkey.getPasskey(GET_OPTIONS), ASSERTION_JSON);
    assert.deepEqual(
      await passkey.createPasskey(CREATE_OPTIONS),
      ATTESTATION_JSON,
    );
    assert.equal(prompts.length, 2);
    assert.equal(passkey.defaultPasskeyName(), "Windows PC");
    assert.deepEqual(stubs.__passkeyCapacitor.registered, []);
  });

  it("is unsupported in every desktop shell, WebAuthn or not", async () => {
    const shells: [string, Record<string, unknown>][] = [
      ["https://app.sloga.gg/", { __TAURI__: {} }],
      ["tauri://localhost/", {}],
      ["http://tauri.localhost/", {}],
      ["app://bundle/", { native: {} }],
      ["https://app.sloga.gg/", { native: {} }],
    ];

    for (const [url, extra] of shells) {
      const prompts = stubWindow(url, extra);

      assert.equal(await passkey.passkeysSupported(), false, url);
      await rejectsWith(passkey.getPasskey(GET_OPTIONS), "unavailable");
      await rejectsWith(passkey.createPasskey(CREATE_OPTIONS), "unavailable");
      assert.equal(prompts.length, 0, "no prompt in a desktop shell");
    }
  });

  it("uses the Passkey plugin in the phone apps, never WebAuthn", async () => {
    const prompts = stubWindow("https://localhost/");
    const sent: string[] = [];
    stubs.__passkeyCapacitor.native = true;
    stubs.__passkeyCapacitor.platform = "ios";
    stubs.__passkeyCapacitor.plugin = {
      isAvailable: async () => ({ available: true }),
      get: async ({ optionsJson }: { optionsJson: string }) => {
        sent.push(optionsJson);
        return { credentialJson: JSON.stringify(ASSERTION_JSON) };
      },
    };

    assert.equal(await passkey.passkeysSupported(), true);
    assert.deepEqual(await passkey.getPasskey(GET_OPTIONS), ASSERTION_JSON);
    assert.deepEqual(sent, [JSON.stringify(GET_OPTIONS)]);
    assert.equal(prompts.length, 0);
    assert.equal(passkey.defaultPasskeyName(), "iPhone");
    // Registered under the plugin's name, and only once
    assert.deepEqual(stubs.__passkeyCapacitor.registered, ["Passkey"]);
  });
});
