/**
 * Passkey ceremonies for every shell, behind one small API.
 *
 * - Android and iOS apps: the native `Passkey` Capacitor plugin. The webview
 *   there is not the relying party's origin, so the page cannot run WebAuthn
 *   itself.
 * - The website: `navigator.credentials`.
 * - Desktop apps (Tauri, Electron): not supported. Their page origin is not
 *   the relying party either and there is no native plugin yet.
 *
 * Options come from the server as the bare `publicKey` object in its JSON
 * form (base64url strings). The result is the credential in its JSON form,
 * sent back to the server as given.
 *
 * No extension is ever added to the options, and the only extension output
 * that leaves this file is `credProps.rk` on a create. Anything else a
 * browser or a password-manager add-on puts in `clientExtensionResults` is
 * dropped, since the server refuses a result that carries more.
 *
 * Nothing here is logged, and a `PasskeyError` carries its code only: no
 * options, credential or system error text.
 *
 * The only import is `@capacitor/core`, which `passkey.test.ts` swaps for a
 * stub so `node --test` can load this file.
 */
import { Capacitor, registerPlugin } from "@capacitor/core";

export type PasskeyFailure =
  | "cancelled"
  | "no_credential"
  | "unavailable"
  | "failed";

/**
 * A ceremony that did not produce a credential. Callers switch on `code`.
 *
 * - `cancelled`: the user closed the prompt (on iOS and in browsers this is
 *   also what "no passkey here" looks like), or the app gave up on it with
 *   `cancelPasskeyCeremony`.
 * - `no_credential`: no passkey for this site on the device (Android 14+).
 * - `unavailable`: this shell or device cannot run a ceremony.
 * - `failed`: anything else, including a second ceremony while one is open
 *   and, in a browser, a passkey that is already registered.
 */
export class PasskeyError extends Error {
  readonly code: PasskeyFailure;

  constructor(code: PasskeyFailure) {
    super(code);
    this.name = "PasskeyError";
    this.code = code;
  }
}

/** The passkey part of the server's root document (`GET {api}/`). */
export interface PasskeysAdvert {
  available: boolean;
  signup: boolean;
  signup_without_email: boolean;
  backup_unlock: boolean;
}

/** The native `Passkey` plugin (Android `PasskeyPlugin.kt`, iOS `PasskeyPlugin.swift`). */
export interface PasskeyPlugin {
  isAvailable(): Promise<{ available: boolean }>;
  create(options: { optionsJson: string }): Promise<{ credentialJson: string }>;
  get(options: { optionsJson: string }): Promise<{ credentialJson: string }>;
}

/** The part of `navigator.credentials` used here. */
export interface PasskeyCredentialsContainer {
  create(options: {
    publicKey: unknown;
    signal?: AbortSignal;
  }): Promise<unknown>;
  get(options: { publicKey: unknown; signal?: AbortSignal }): Promise<unknown>;
}

/** The part of `window.PublicKeyCredential` used here. Both parsers are optional. */
export interface PasskeyOptionsParser {
  parseCreationOptionsFromJSON?: (options: unknown) => unknown;
  parseRequestOptionsFromJSON?: (options: unknown) => unknown;
}

/** Where the app is running, as far as passkeys are concerned. */
export interface PasskeyHost {
  /**
   * `native` = Android or iOS app, `desktop` = Tauri or Electron,
   * `browser` = a web page, `none` = no window at all
   */
  kind: "native" | "desktop" | "browser" | "none";
  /** Native plugin (`native` only) */
  plugin?: PasskeyPlugin;
  /** Capacitor platform, `android` or `ios` (`native` only) */
  nativePlatform?: string;
  /** `navigator.credentials` (`browser` only) */
  credentials?: PasskeyCredentialsContainer;
  /** `window.PublicKeyCredential` (`browser` only) */
  parser?: PasskeyOptionsParser;
  userAgent?: string;
  touchPoints?: number;
}

type Ceremony = "create" | "get";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Decode unpadded base64url. Trailing `=` padding is tolerated; any other
 * character outside the base64url alphabet throws.
 */
export function base64urlToBuffer(text: string): ArrayBuffer {
  if (typeof text !== "string") throw new Error("not base64url");

  const body = text.replace(/=+$/, "");
  if (!/^[A-Za-z0-9_-]*$/.test(body) || body.length % 4 === 1) {
    throw new Error("not base64url");
  }

  const binary = atob(
    body.replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - (body.length % 4)) % 4),
  );

  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return buffer;
}

/** Encode bytes as unpadded base64url. */
export function bufferToBase64url(
  value: ArrayBuffer | ArrayBufferView,
): string {
  const bytes = ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value);

  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Decode the `id` of each entry of a credential descriptor list. */
function descriptorsFromJSON(list: unknown): unknown[] {
  if (!Array.isArray(list)) throw new Error("bad credential list");

  return list.map((entry) => {
    if (!isObject(entry) || typeof entry.id !== "string") {
      throw new Error("bad credential list");
    }

    return { ...entry, id: base64urlToBuffer(entry.id) };
  });
}

/**
 * Creation options from their JSON form, for browsers without
 * `PublicKeyCredential.parseCreationOptionsFromJSON`: `challenge`, `user.id`
 * and each `excludeCredentials[].id` become buffers, the rest is copied.
 */
export function creationOptionsFromJSON(options: unknown): JsonObject {
  if (
    !isObject(options) ||
    typeof options.challenge !== "string" ||
    !isObject(options.user) ||
    typeof options.user.id !== "string"
  ) {
    throw new Error("bad creation options");
  }

  const result: JsonObject = {
    ...options,
    challenge: base64urlToBuffer(options.challenge),
    user: { ...options.user, id: base64urlToBuffer(options.user.id) },
  };

  if (options.excludeCredentials !== undefined) {
    result.excludeCredentials = descriptorsFromJSON(options.excludeCredentials);
  }

  return result;
}

/**
 * Request options from their JSON form, for browsers without
 * `PublicKeyCredential.parseRequestOptionsFromJSON`: `challenge` and each
 * `allowCredentials[].id` become buffers, the rest is copied.
 */
export function requestOptionsFromJSON(options: unknown): JsonObject {
  if (!isObject(options) || typeof options.challenge !== "string") {
    throw new Error("bad request options");
  }

  const result: JsonObject = {
    ...options,
    challenge: base64urlToBuffer(options.challenge),
  };

  if (options.allowCredentials !== undefined) {
    result.allowCredentials = descriptorsFromJSON(options.allowCredentials);
  }

  return result;
}

/**
 * Options for `navigator.credentials`: the browser's own parser when it has
 * one, the conversion above when it has none or refuses the options.
 */
function parseOptions(
  ceremony: Ceremony,
  options: unknown,
  parser: PasskeyOptionsParser | undefined,
): unknown {
  if (!isObject(options)) throw new Error("bad options");

  const native =
    ceremony === "create"
      ? parser?.parseCreationOptionsFromJSON
      : parser?.parseRequestOptionsFromJSON;

  if (typeof native === "function") {
    try {
      return native.call(parser, options);
    } catch {
      // fall through to the manual conversion
    }
  }

  return ceremony === "create"
    ? creationOptionsFromJSON(options)
    : requestOptionsFromJSON(options);
}

/**
 * The extension results the server accepts: `credProps.rk` on a create,
 * nothing on a get. Every other key is dropped.
 */
export function filterExtensionResults(
  ceremony: Ceremony,
  results: unknown,
): JsonObject {
  if (ceremony !== "create" || !isObject(results)) return {};

  const credProps = results.credProps;
  if (isObject(credProps) && typeof credProps.rk === "boolean") {
    return { credProps: { rk: credProps.rk } };
  }

  return {};
}

/** Binary members of the response that are base64url text in the JSON form. */
const RESPONSE_BINARY = [
  "clientDataJSON",
  "attestationObject",
  "authenticatorData",
  "signature",
  "userHandle",
  "publicKey",
] as const;

/** A member that is base64url text in the JSON form, from text or bytes. */
function binaryText(value: unknown): string | undefined {
  if (typeof value === "string") return value;

  if (
    ArrayBuffer.isView(value) ||
    Object.prototype.toString.call(value) === "[object ArrayBuffer]"
  ) {
    return bufferToBase64url(value as ArrayBuffer | ArrayBufferView);
  }

  return undefined;
}

/** Call a method of `target` if it has one; `undefined` if not or if it throws. */
function callIfPresent(target: unknown, method: string): unknown {
  try {
    const fn = (target as Record<string, unknown>)[method];
    return typeof fn === "function" ? fn.call(target) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The members of a credential before they are filtered: its own `toJSON()`
 * where that works, else read off the object one by one.
 */
function credentialMembers(credential: unknown): JsonObject {
  const json = callIfPresent(credential, "toJSON");
  if (isObject(json) && isObject(json.response)) return json;

  const source = credential as JsonObject;
  const response = source.response as JsonObject | null | undefined;
  if (typeof response !== "object" || response === null) {
    throw new Error("bad credential");
  }

  return {
    id: source.id,
    rawId: source.rawId,
    type: source.type,
    authenticatorAttachment: source.authenticatorAttachment,
    response: {
      clientDataJSON: response.clientDataJSON,
      attestationObject: response.attestationObject,
      authenticatorData:
        response.authenticatorData ??
        callIfPresent(response, "getAuthenticatorData"),
      signature: response.signature,
      userHandle: response.userHandle,
      transports: callIfPresent(response, "getTransports"),
      publicKey: callIfPresent(response, "getPublicKey"),
      publicKeyAlgorithm: callIfPresent(response, "getPublicKeyAlgorithm"),
    },
    clientExtensionResults: callIfPresent(
      credential,
      "getClientExtensionResults",
    ),
  };
}

/**
 * A credential from `navigator.credentials` in its JSON form. Built member
 * by member, so nothing outside the known set is sent to the server.
 */
export function credentialToJSON(
  ceremony: Ceremony,
  credential: unknown,
): JsonObject {
  if (typeof credential !== "object" || credential === null) {
    throw new Error("bad credential");
  }

  const members = credentialMembers(credential);
  const source = members.response as JsonObject;

  const rawId = binaryText(members.rawId);
  const id = typeof members.id === "string" ? members.id : rawId;
  if (!id) throw new Error("bad credential");

  const response: JsonObject = {};
  for (const name of RESPONSE_BINARY) {
    const text = binaryText(source[name]);
    if (text !== undefined) response[name] = text;
  }

  if (typeof response.clientDataJSON !== "string") {
    throw new Error("bad credential");
  }

  if (Array.isArray(source.transports)) {
    response.transports = source.transports.filter(
      (transport) => typeof transport === "string",
    );
  }

  if (typeof source.publicKeyAlgorithm === "number") {
    response.publicKeyAlgorithm = source.publicKeyAlgorithm;
  }

  const result: JsonObject = {
    id,
    rawId: rawId ?? id,
    type: typeof members.type === "string" ? members.type : "public-key",
    response,
    clientExtensionResults: filterExtensionResults(
      ceremony,
      members.clientExtensionResults,
    ),
  };

  if (typeof members.authenticatorAttachment === "string") {
    result.authenticatorAttachment = members.authenticatorAttachment;
  }

  return result;
}

/** Failure code for an error thrown by `navigator.credentials`. */
export function browserFailure(error: unknown): PasskeyFailure {
  switch ((error as { name?: unknown } | null | undefined)?.name) {
    case "NotAllowedError":
    case "AbortError":
      return "cancelled";
    case "SecurityError":
    case "NotSupportedError":
      return "unavailable";
    // A passkey for this account is already on the authenticator
    case "InvalidStateError":
      return "failed";
    default:
      return "failed";
  }
}

/**
 * Failure code for a rejection of the native plugin. Capacitor's own
 * `UNIMPLEMENTED` (an app build without the plugin) and `UNAVAILABLE` both
 * mean this app cannot run a ceremony.
 */
export function nativeFailure(error: unknown): PasskeyFailure {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  switch (code) {
    case "cancelled":
    case "no_credential":
    case "unavailable":
    case "failed":
      return code;
    case "UNIMPLEMENTED":
    case "UNAVAILABLE":
      return "unavailable";
    default:
      return "failed";
  }
}

/** Whether a browser host has what a ceremony needs. */
function browserReady(host: PasskeyHost): boolean {
  return (
    !!host.parser &&
    typeof host.credentials?.create === "function" &&
    typeof host.credentials?.get === "function"
  );
}

async function nativeCeremony(
  ceremony: Ceremony,
  plugin: PasskeyPlugin,
  options: unknown,
): Promise<unknown> {
  if (!isObject(options)) throw new PasskeyError("failed");
  const optionsJson = JSON.stringify(options);

  let credentialJson: unknown;
  try {
    const reply =
      ceremony === "create"
        ? await plugin.create({ optionsJson })
        : await plugin.get({ optionsJson });
    credentialJson = reply?.credentialJson;
  } catch (error) {
    throw new PasskeyError(nativeFailure(error));
  }

  if (typeof credentialJson !== "string") throw new PasskeyError("failed");

  const credential: unknown = JSON.parse(credentialJson);
  if (!isObject(credential)) throw new PasskeyError("failed");
  return credential;
}

async function browserCeremony(
  ceremony: Ceremony,
  host: PasskeyHost,
  options: unknown,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  if (!browserReady(host)) throw new PasskeyError("unavailable");

  const publicKey = parseOptions(ceremony, options, host.parser);

  let credential: unknown;
  try {
    credential =
      ceremony === "create"
        ? await host.credentials!.create({ publicKey, signal })
        : await host.credentials!.get({ publicKey, signal });
  } catch (error) {
    throw new PasskeyError(browserFailure(error));
  }

  return credentialToJSON(ceremony, credential);
}

/** A default passkey name for a host, e.g. "Windows PC", "Android phone", "iPhone". */
export function passkeyNameFor(host: PasskeyHost): string {
  const userAgent = host.userAgent ?? "";
  const touch = (host.touchPoints ?? 0) > 0;

  // iPadOS reports a Mac user agent; a Mac has no touch screen
  const ipad = /iPad/.test(userAgent) || (/Macintosh/.test(userAgent) && touch);
  const android = /Mobile/.test(userAgent) ? "Android phone" : "Android tablet";

  if (host.kind === "native" && host.nativePlatform === "ios") {
    return ipad ? "iPad" : "iPhone";
  }

  if (host.kind === "native" && host.nativePlatform === "android") {
    return android;
  }

  if (/iPhone|iPod/.test(userAgent)) return "iPhone";
  if (ipad) return "iPad";
  if (/Android/.test(userAgent)) return android;
  if (/Windows/.test(userAgent)) return "Windows PC";
  if (/CrOS/.test(userAgent)) return "Chromebook";
  if (/Macintosh|Mac OS X/.test(userAgent)) return "Mac";
  if (/Linux/.test(userAgent)) return "Linux PC";
  return "Passkey";
}

/**
 * The facade functions over a given host reader. The app uses the one
 * instance exported below; specs build their own with a fake host.
 */
export function createPasskeyFacade(readHost: () => PasskeyHost) {
  // One ceremony at a time: a second one is refused, never queued. Holds
  // the way to give up on the open one.
  let open: { cancel: () => void } | undefined;

  /** The ceremony itself, on whichever host this is */
  async function perform(
    ceremony: Ceremony,
    options: unknown,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    const host = readHost();

    if (host.kind === "native" && host.plugin) {
      return await nativeCeremony(ceremony, host.plugin, options);
    }

    if (host.kind === "browser") {
      return await browserCeremony(ceremony, host, options, signal);
    }

    throw new PasskeyError("unavailable");
  }

  async function run(ceremony: Ceremony, options: unknown): Promise<unknown> {
    if (open) throw new PasskeyError("failed");

    const abort =
      typeof AbortController === "function" ? new AbortController() : undefined;

    // Rejects when the caller gives up. The slot is freed when that
    // rejection settles the ceremony, one microtask later, whether or not
    // the prompt ever answers; a late answer is dropped.
    let cancel!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => {
        reject(new PasskeyError("cancelled"));
        abort?.abort();
      };
    });

    const slot = { cancel };
    open = slot;

    try {
      const work = perform(ceremony, options, abort?.signal);
      // Still running after a cancel; how it ends no longer matters
      work.catch(() => {});

      return await Promise.race([work, cancelled]);
    } catch (error) {
      // Only a code leaves this file
      throw error instanceof PasskeyError ? error : new PasskeyError("failed");
    } finally {
      if (open === slot) open = undefined;
    }
  }

  return {
    async passkeysSupported(): Promise<boolean> {
      try {
        const host = readHost();

        if (host.kind === "native" && host.plugin) {
          // True on iOS does not prove a ceremony will work (the app may not
          // be associated with the domain); a ceremony then says `unavailable`
          return (await host.plugin.isAvailable())?.available === true;
        }

        return host.kind === "browser" && browserReady(host);
      } catch {
        return false;
      }
    },

    createPasskey(options: unknown): Promise<unknown> {
      return run("create", options);
    },

    getPasskey(options: unknown): Promise<unknown> {
      return run("get", options);
    },

    cancelPasskeyCeremony(): void {
      open?.cancel();
    },

    defaultPasskeyName(): string {
      try {
        return passkeyNameFor(readHost());
      } catch {
        return "Passkey";
      }
    },
  };
}

let nativePlugin: PasskeyPlugin | undefined;

/** The host this page runs in. */
function currentHost(): PasskeyHost {
  if (typeof window === "undefined") return { kind: "none" };

  const win = window as unknown as {
    __TAURI__?: unknown;
    native?: unknown;
    location?: { protocol?: string; hostname?: string };
    navigator?: {
      userAgent?: string;
      maxTouchPoints?: number;
      credentials?: PasskeyCredentialsContainer;
    };
    PublicKeyCredential?: PasskeyOptionsParser;
  };

  const userAgent = win.navigator?.userAgent ?? "";
  const touchPoints = win.navigator?.maxTouchPoints ?? 0;

  // Same shell checks as `isNativeShell` in appOrigin.ts
  if (
    win.__TAURI__ ||
    win.native ||
    win.location?.protocol === "tauri:" ||
    win.location?.hostname === "tauri.localhost"
  ) {
    return { kind: "desktop", userAgent, touchPoints };
  }

  if (Capacitor.isNativePlatform()) {
    nativePlugin ??= registerPlugin<PasskeyPlugin>("Passkey");
    return {
      kind: "native",
      plugin: nativePlugin,
      nativePlatform: Capacitor.getPlatform(),
      userAgent,
      touchPoints,
    };
  }

  return {
    kind: "browser",
    credentials: win.navigator?.credentials,
    parser: win.PublicKeyCredential,
    userAgent,
    touchPoints,
  };
}

const facade = createPasskeyFacade(currentHost);

/**
 * True when this device/app can run a passkey ceremony at all (native plugin
 * present, or WebAuthn in the browser). False in the desktop apps. Never
 * throws.
 */
export function passkeysSupported(): Promise<boolean> {
  return facade.passkeysSupported();
}

/**
 * Runs the create ceremony for server options (the bare publicKey object)
 * and returns the credential JSON to send back. Rejects with a
 * `PasskeyError`.
 */
export function createPasskey(options: unknown): Promise<unknown> {
  return facade.createPasskey(options);
}

/**
 * Runs the get ceremony for server options and returns the assertion JSON to
 * send back. Rejects with a `PasskeyError`.
 */
export function getPasskey(options: unknown): Promise<unknown> {
  return facade.getPasskey(options);
}

/**
 * Gives up on the open ceremony, if there is one: it rejects with
 * `cancelled` and the next ceremony may start. Does nothing when idle.
 *
 * A browser prompt is closed. The phone apps have no way to close their
 * system sheet from here: it stays up until the user closes it, and the app
 * refuses another ceremony until then.
 */
export function cancelPasskeyCeremony(): void {
  facade.cancelPasskeyCeremony();
}

/**
 * A default name for a new passkey on this device, e.g. "Windows PC",
 * "Android phone", "iPhone". Plain English on purpose: it is saved on the
 * account and shown on every device, whatever its language.
 */
export function defaultPasskeyName(): string {
  return facade.defaultPasskeyName();
}

const ADVERT_OFF: PasskeysAdvert = {
  available: false,
  signup: false,
  signup_without_email: false,
  backup_unlock: false,
};

/**
 * Successful advert lookups, and lookups still in flight, keyed by the API
 * URL without its trailing slashes. A failed lookup removes its own entry.
 */
const adverts = new Map<string, Promise<PasskeysAdvert | undefined>>();

async function fetchPasskeysAdvert(
  base: string,
  fetchImpl: typeof fetch,
): Promise<PasskeysAdvert | null> {
  try {
    const response = await fetchImpl(`${base}/`);
    if (!response.ok) return null;

    const body: unknown = await response.json();
    if (!isObject(body)) return null;

    const features = body.features;
    const advert = isObject(features) ? features.passkeys : undefined;
    if (!isObject(advert)) return { ...ADVERT_OFF };

    return {
      available: advert.available === true,
      signup: advert.signup === true,
      signup_without_email: advert.signup_without_email === true,
      backup_unlock: advert.backup_unlock === true,
    };
  } catch {
    return null;
  }
}

/**
 * What the server says about passkeys (`features.passkeys` on `GET {api}/`).
 * Every passkey surface stays hidden unless `available` is true.
 *
 * Concurrent callers share one request. An answer is remembered for the life
 * of the page; a failed lookup reads as everything off and is retried on the
 * next call. Never rejects. Pass `CONFIGURATION.DEFAULT_API_URL`.
 */
export function getPasskeysAdvert(
  apiUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PasskeysAdvert> {
  return findPasskeysAdvert(apiUrl, fetchImpl).then(
    (advert) => advert ?? { ...ADVERT_OFF },
  );
}

/**
 * The same lookup as {@link getPasskeysAdvert}, sharing its requests and
 * its remembered answers, except that a failed lookup resolves to undefined.
 * For the few places that must tell "the server says off" from "the server
 * did not answer". Never rejects.
 */
export function findPasskeysAdvert(
  apiUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PasskeysAdvert | undefined> {
  const base = apiUrl.replace(/\/+$/, "");

  const cached = adverts.get(base);
  if (cached) return cached;

  const pending: Promise<PasskeysAdvert | undefined> = fetchPasskeysAdvert(
    base,
    fetchImpl,
  ).then((result) => {
    if (result) return result;

    if (adverts.get(base) === pending) adverts.delete(base);
    return undefined;
  });

  adverts.set(base, pending);
  return pending;
}

/** Forget every remembered advert. For specs only. */
export function __resetPasskeysAdvertCache(): void {
  adverts.clear();
}
