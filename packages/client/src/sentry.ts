import * as Sentry from "@sentry/browser";

import { version } from "../../../package.json";
import { scrubBreadcrumb } from "./sentryScrubPolicy";

if (import.meta.env.PROD && import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    tunnel: import.meta.env.VITE_SENTRY_TUNNEL,
    release: version,
    // The default integrations record every console call, request and
    // navigation as a breadcrumb, and breadcrumbs ride along with any event
    // the SDK sends. `scrubBreadcrumb` is what keeps the call-encryption
    // diagnostics, the auth-flow tokens and the identifiers out of that —
    // see `sentryScrubPolicy` for what and why. It runs inside the SDK, so
    // the developer console and the CDP tail still see every line.
    beforeBreadcrumb: scrubBreadcrumb,
    // tracing:
    // integrations: [Sentry.browserTracingIntegration()],
    // tracesSampleRate: 0.1,
  });
}
