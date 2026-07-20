/**
 * Whether this window is the detachable friends popout — FROZEN at module
 * init, i.e. at window boot. Window identity must NOT follow later SPA
 * navigation: the E2EE engine attach (Controller construction) and the
 * per-window worker gates are boot-time decisions, and a live pathname
 * check would let them disagree with each other if the window ever
 * navigates away from the popout route. `Interface` additionally bounces
 * any such navigation straight back, so a popout window can never host
 * the full app shell.
 *
 * `startsWith` (not equality) so a trailing slash or sub-path spelling
 * from a shell can't silently flip a popout window back to full-client.
 */
export const IS_POPOUT_WINDOW: boolean =
  typeof window !== "undefined" &&
  window.location.pathname.startsWith("/friends-popout");
