/**
 * Takes one-time tokens out of addresses before they go into a crash report.
 *
 * Several signed-out pages carry a secret in their path: a recovery, reset,
 * verification or deletion link, and the code of an OAuth redirect. The
 * crash reporter records the page address with every event and every
 * navigation as a breadcrumb, so without this a report holds a token that
 * may still work.
 *
 * Leaf module: no imports, so `node --test` loads it (`sentryScrub.test.ts`).
 */

/** What a removed token reads as */
export const SCRUBBED = "[token]";

/**
 * Paths whose next segment is a token: the app routes `/login/.../:token`
 * (src/index.tsx) and the API route the verify page calls.
 *
 * Any letter case: the app router compares the fixed parts of a path in
 * lower case, so `/LOGIN/Reset/<token>` opens the reset page too.
 */
const TOKEN_PATH =
  /(\/login\/(?:passkey\/recover|reset|verify|delete)\/|\/auth\/account\/verify\/)[^/?#\s"'<>]+/gi;

/**
 * The one-time code of an OAuth redirect: `/login/oauth?code=...`. Any
 * letter case, for the same reason.
 */
const OAUTH_CODE = /(\/login\/oauth[^\s"'<>]*?[?&#]code=)[^&#\s"'<>]*/gi;

/**
 * Replace every token in a piece of text. Takes a full URL, a bare path, or
 * any text that contains one; text with no token comes back unchanged.
 * @param text Text
 * @returns The text with each token replaced by `[token]`
 */
export function scrubUrl(text: string): string {
  return text
    .replace(TOKEN_PATH, `$1${SCRUBBED}`)
    .replace(OAUTH_CODE, `$1${SCRUBBED}`);
}

/** Scrub a value only when it is text */
function scrubValue<T>(value: T): T {
  return typeof value === "string" ? (scrubUrl(value) as T) : value;
}

/** The parts of a breadcrumb that can hold an address */
type CrumbLike = {
  message?: string;
  data?: { [key: string]: unknown };
};

/** Breadcrumb data keys that hold an address: navigation and requests */
const CRUMB_DATA_KEYS = ["from", "to", "url"] as const;

/**
 * Scrub a breadcrumb: its message, the `from`, `to` and `url` of its data,
 * and the text entries of `arguments` (a console breadcrumb keeps what was
 * logged there as well as in the message). Returns a copy; the breadcrumb
 * given is not changed.
 * @param crumb Breadcrumb
 * @returns The scrubbed breadcrumb
 */
export function scrubBreadcrumb<T extends CrumbLike>(crumb: T): T {
  const next: CrumbLike = { ...crumb };

  if (typeof next.message === "string") {
    next.message = scrubUrl(next.message);
  }

  if (next.data && typeof next.data === "object") {
    const data = { ...next.data };
    for (const key of CRUMB_DATA_KEYS) {
      if (key in data) data[key] = scrubValue(data[key]);
    }
    if (Array.isArray(data.arguments)) {
      data.arguments = data.arguments.map((entry) => scrubValue(entry));
    }
    next.data = data;
  }

  return next as T;
}

/** The parts of a stack frame that can hold an address */
type FrameLike = {
  filename?: string;
  abs_path?: string;
};

/** The parts of a reported exception that can hold an address */
type ExceptionLike = {
  value?: string;
  stacktrace?: { frames?: FrameLike[] };
};

/**
 * Scrub a stack frame: the file it names, which is the page address itself
 * for code that runs from the page. Returns a copy.
 */
function scrubFrame<T extends FrameLike>(frame: T): T {
  const next: FrameLike = { ...frame };

  if (typeof next.filename === "string") {
    next.filename = scrubUrl(next.filename);
  }
  if (typeof next.abs_path === "string") {
    next.abs_path = scrubUrl(next.abs_path);
  }

  return next as T;
}

/**
 * Scrub a reported exception: its message text and every frame of its
 * stack. Returns a copy.
 */
function scrubException<T extends ExceptionLike>(exception: T): T {
  const next: ExceptionLike = { ...exception };

  if (typeof next.value === "string") next.value = scrubUrl(next.value);

  if (
    next.stacktrace &&
    typeof next.stacktrace === "object" &&
    Array.isArray(next.stacktrace.frames)
  ) {
    next.stacktrace = {
      ...next.stacktrace,
      frames: next.stacktrace.frames.map((frame) => scrubFrame(frame)),
    };
  }

  return next as T;
}

/** The parts of an event that can hold an address */
type EventLike = {
  message?: string;
  exception?: { values?: ExceptionLike[] };
  request?: {
    url?: string;
    headers?: { [key: string]: string };
  };
  transaction?: string;
  breadcrumbs?: CrumbLike[];
};

/**
 * Scrub an event: its message, the text and stack frames of every exception
 * on it, the page address, the referrer, the transaction name and every
 * breadcrumb. Returns a copy; the event given is not changed.
 * @param event Event
 * @returns The scrubbed event
 */
export function scrubEvent<T extends EventLike>(event: T): T {
  const next: EventLike = { ...event };

  if (typeof next.message === "string") {
    next.message = scrubUrl(next.message);
  }

  if (
    next.exception &&
    typeof next.exception === "object" &&
    Array.isArray(next.exception.values)
  ) {
    next.exception = {
      ...next.exception,
      values: next.exception.values.map((value) => scrubException(value)),
    };
  }

  if (next.request && typeof next.request === "object") {
    const request = { ...next.request };
    if (typeof request.url === "string") request.url = scrubUrl(request.url);

    if (request.headers && typeof request.headers === "object") {
      const headers = { ...request.headers };
      for (const name of Object.keys(headers)) {
        // The header name is not case-sensitive
        if (name.toLowerCase() === "referer") {
          headers[name] = scrubValue(headers[name]);
        }
      }
      request.headers = headers;
    }

    next.request = request;
  }

  if (typeof next.transaction === "string") {
    next.transaction = scrubUrl(next.transaction);
  }

  if (Array.isArray(next.breadcrumbs)) {
    next.breadcrumbs = next.breadcrumbs.map((crumb) => scrubBreadcrumb(crumb));
  }

  return next as T;
}
