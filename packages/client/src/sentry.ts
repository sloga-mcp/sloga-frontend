import * as Sentry from "@sentry/browser";

import { version } from "../../../package.json";

if (import.meta.env.PROD && import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    tunnel: import.meta.env.VITE_SENTRY_TUNNEL,
    release: version,
    // `@sentry/browser`'s default integrations capture every console call as a
    // breadcrumb. The MLS call session's `[mls]` lines carry device identities
    // and key indexes — and because `key_index = epoch mod 16`, a stream of
    // them leaks per-device epoch churn, i.e. who joined or left a call and
    // when, which is beyond the who/when/duration metadata this service keeps.
    // No key material is ever logged; this is about the metadata around it.
    // Drop them at the boundary rather than auditing every call site.
    beforeBreadcrumb: (breadcrumb) => {
      if (breadcrumb.category !== "console") return breadcrumb;
      const message = breadcrumb.message;
      if (typeof message !== "string") return breadcrumb;
      // Our own lines...
      if (message.startsWith("[mls]")) return null;
      // ...including wave-0's `[gate-trace]` publish-gate seams, which carry
      // the same churn class: call-mode kinds, `localConfirmed`,
      // `reestablishes`, gate reasons, trackSids and gate generations, once
      // per gate edge. The prefix catches both emission forms, because the
      // console integration builds `message` as `safeJoin(args, " ")` — the
      // two-argument `console.error("[gate-trace]", payload)` and the
      // pre-stringified `console.error("[gate-trace] " + json)` alike. It
      // also keeps the raw objects in `data.arguments`, so dropping the whole
      // crumb is what suppresses them. Temporary: these seams were added in
      // 88e43742 and are reverted in a named commit before wave 1 merges, so
      // this line goes with them.
      if (message.startsWith("[gate-trace]")) return null;
      // ...and livekit-client's, which reach the console UNPREFIXED via
      // `E2eeManager.onWorkerMessage` → loglevel: "MissingKey: missing key at
      // index N for participant X" and "InvalidKey: valid key missing for
      // participant X" carry the same pair. Matched on shape, because a
      // prefix filter cannot see them.
      if (/^(MissingKey|InvalidKey|InternalError):/.test(message)) return null;
      return breadcrumb;
    },
    // tracing:
    // integrations: [Sentry.browserTracingIntegration()],
    // tracesSampleRate: 0.1,
  });
}
