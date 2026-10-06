/**
 * Shared vocabulary for GLOBAL (system-wide) keybinds — the ones the Windows
 * desktop shell's low-level keyboard hook can fire while Sloga is not the
 * focused application.
 *
 * This module is deliberately a **dependency-free leaf**: it imports nothing.
 * The store, the capture UI and the dispatch layer all import it, and
 * `./suppress` records two blank-`#root` failures in this codebase caused by
 * module-init ordering. A vocabulary module that pulled in `solid-js` (via
 * `./keybindActions` → `./suppress`, which calls `createSignal` at module
 * scope) would put a side-effecting init on the import path of every consumer
 * for no gain. The cost of that choice is the hand-maintained table in
 * {@link IN_APP_DEFAULT_SEQUENCES}; see its comment.
 *
 * # This is NOT the in-app keybind registry
 *
 * `./keybindActions` + `./keybindHandler` are a separate, older system: they
 * listen on `document.body`, only work while focused, and match on
 * `KeyboardEvent.key`. This module describes bindings the **native** layer
 * arms, matched on `KeyboardEvent.code`. The two are different vocabularies
 * over different transports and must not be mixed — see {@link Binding} and
 * {@link IN_APP_COMPARABLE_CODES}.
 */

/* ------------------------------------------------------------------------ *
 * 1. Actions
 * ------------------------------------------------------------------------ */

/**
 * Every action a global keybind can be bound to, in the order the settings UI
 * lists them.
 *
 * # Why a `const` array + derived union, and not an `enum`
 *
 * `./keybindActions` expresses its closed set as a string `enum`, so the house
 * idiom would be `enum GlobalKeybindAction { ToggleMute = "toggle-mute", … }`.
 * Three properties of *this* set make the const-array form strictly better,
 * and none of them applied to that one:
 *
 * 1. **These ids are wire values.** They cross the Tauri boundary in both
 *    directions (`keybinds_arm`'s payload out, `keybind:down` / `keybind:up`'s
 *    `{ id: string }` back in). A TypeScript `enum` type is not assignable
 *    from a bare `string`, so every ingress point would need a cast — and a
 *    cast is exactly the thing that lets an unknown id through. With a union,
 *    ingress narrows through {@link isGlobalKeybindAction}, which is a real
 *    runtime check the compiler then trusts.
 * 2. **The ids are hyphenated**, which is not a legal enum member name. An
 *    enum would therefore carry two parallel spellings (`TOGGLE_MUTE` and
 *    `"toggle-mute"`) to keep in sync, and the persisted/wire one would be the
 *    one never written at a call site.
 * 3. **The set must be iterable and ordered.** The settings UI renders one row
 *    per action and enforces {@link MAX_BINDINGS}. `Object.values()` over an
 *    enum gives that too, but the array *is* the source of truth here rather
 *    than a derivation of it, so the render order cannot drift from the type.
 *
 * `Record<GlobalKeybindAction, …>` on the tables below still gives the
 * exhaustiveness an enum would: adding an id here fails to compile until
 * {@link KEYBIND_TIER} and {@link KEYBIND_REQUIREMENT} are both extended.
 */
export const GLOBAL_KEYBIND_ACTIONS = [
  "toggle-mute",
  "toggle-deafen",
  "toggle-camera",
  "screenshare-stop",
  "screenshare-start",
  "disconnect-call",
  "accept-call",
  "dismiss-call",
  "toggle-window",
  "toggle-overlay",
  "toggle-fullscreen",
  "toggle-theater",
] as const;

/** One of {@link GLOBAL_KEYBIND_ACTIONS}. */
export type GlobalKeybindAction = (typeof GLOBAL_KEYBIND_ACTIONS)[number];

/**
 * Narrow an id arriving from the native layer.
 *
 * 🔴 Every consumer of a `keybind:down` / `keybind:up` payload MUST go through
 * this. The payload is typed `{ id: string }` (see
 * {@link KeybindEventPayload}) because the native side stringifies whatever it
 * was armed with, and a stale `keybinds_arm` racing a rebuild of the binding
 * list can deliver an id this build does not know. Casting instead would put
 * an unknown key into {@link KEYBIND_REQUIREMENT}, read `undefined` as "no
 * precondition", and dispatch an action with no guard.
 */
export function isGlobalKeybindAction(id: string): id is GlobalKeybindAction {
  return (GLOBAL_KEYBIND_ACTIONS as readonly string[]).includes(id);
}

/* ------------------------------------------------------------------------ *
 * 2. Bindings
 * ------------------------------------------------------------------------ */

/**
 * One key combination, as the native layer speaks it.
 *
 * # `code`, never `key`
 *
 * `code` is a `KeyboardEvent.code` — the **physical** key ("KeyQ",
 * "ArrowDown", "Semicolon"), which is what the native scan-code table already
 * maps to and from. It is deliberately NOT `KeyboardEvent.key`:
 *
 * - `key` is **layout-dependent**. The same physical key is `"q"` on QWERTY
 *   and `"a"` on AZERTY, so a binding stored as `key` follows the user's
 *   active layout and silently moves when they switch it. The native hook
 *   receives scan codes and has no layout to consult, so it could not honor a
 *   `key` binding at all.
 * - `key` is **shift-dependent**. `code: "Digit1"` with `shift: true` is
 *   `key: "!"`, so a `key`-based store would need a different record for the
 *   shifted and unshifted forms of one physical key. With `code`, the
 *   modifiers are orthogonal — which is what makes exact modifier matching
 *   (below) meaningful.
 *
 * 🔴 The existing in-app registry (`./keybindSequences`) is `key`-based. A
 * `Binding.code` and an in-app sequence entry are **not interchangeable** and
 * must never be compared directly. {@link IN_APP_COMPARABLE_CODES} is the only
 * sanctioned bridge, and it covers six keys.
 *
 * There is no `meta` / Command bit, because the pinned `keybinds_arm` payload
 * has no field for one: it is `{ id, code, ctrl, shift, alt }`. The native half
 * exists only in the Windows desktop shell. Adding Meta later is a change to
 * the native payload first and to this type second — 🔴 not a field that can be
 * added here alone.
 *
 * # A modifier can be the key
 *
 * `code` may itself be Ctrl, Shift or Alt — `"ShiftLeft"`, `"ControlRight"`
 * and the rest of the six named by {@link selfModifier}. Such a binding never
 * carries its own flag: `{ code: "ShiftLeft", shift: true }` is not a distinct
 * chord from `{ code: "ShiftLeft", shift: false }`, and {@link normalizeBinding}
 * folds the first into the second. The other two flags keep their usual
 * meaning, and for a modifier-keyed chord the key is the modifier pressed
 * LAST: `{ code: "ShiftLeft", ctrl: true }` is "Ctrl + Shift" (Ctrl held,
 * Shift pressed) and `{ code: "ControlLeft", shift: true }` is "Shift + Ctrl"
 * (Shift held, Ctrl pressed). They are two bindings, each firing on the
 * gesture that created it and not on the other.
 */
export type Binding = {
  /** A `KeyboardEvent.code` (physical key), e.g. `"KeyM"`, `"F13"`. */
  code: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
};

/**
 * The minimum shape this module needs off a real `KeyboardEvent`.
 *
 * Duck-typed rather than taking `KeyboardEvent`, matching
 * `@revolt/rtc/remoteControlMapping`: it keeps the match predicates callable
 * from `node --test` with a plain object literal, and from a native event
 * payload that is not a DOM event at all.
 */
export type KeyLikeEvent = {
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
};

/** The flag a modifier key sets on its own keydown — see {@link selfModifier}. */
export type SelfModifier = "ctrl" | "shift" | "alt";

/**
 * The {@link Binding} flag that `code`'s OWN keydown sets, if `code` is one of
 * the six bindable modifier keys; `null` for every other code.
 *
 * Only Ctrl, Shift and Alt, left and right: the three flags a `Binding`
 * carries. Meta is `null` on purpose, for the same reason the type has no
 * `meta` field — the native payload cannot express it as a flag, so this
 * module cannot treat it as a key either, and the capture UI refuses it.
 */
export function selfModifier(code: string): SelfModifier | null {
  switch (code) {
    case "ControlLeft":
    case "ControlRight":
      return "ctrl";
    case "ShiftLeft":
    case "ShiftRight":
      return "shift";
    case "AltLeft":
    case "AltRight":
      return "alt";
    default:
      return null;
  }
}

/**
 * A copy of `binding` with the flag its own key sets cleared: `shift` for a
 * `ShiftLeft` / `ShiftRight` binding, `ctrl` for the Ctrl pair, `alt` for the
 * Alt pair. Every other field is copied as-is, and a binding whose key is not
 * a modifier comes back as an equal copy — equal by value, not by reference,
 * so callers must not test identity. Idempotent.
 *
 * # Why the own flag is never stored
 *
 * A modifier's own keydown carries its flag on the DOM: `ShiftLeft` arrives as
 * `{ code: "ShiftLeft", shiftKey: true }`, because the key is already down by
 * the time the event is dispatched. A binding captured straight off that
 * event would read `{ ShiftLeft, shift: true }`, while one written by hand or
 * loaded from an earlier build might read `{ ShiftLeft, shift: false }` — the
 * same gesture in two spellings, which a field-wise duplicate sweep would not
 * catch. Clearing the own flag makes the cleared form the ONE canonical
 * spelling, so {@link bindingsEqual} and the store's duplicate check keep
 * working unchanged. {@link bindingMatchesPress} then never consults that flag
 * at all, and the native hook masks the same bit before it compares
 * (`self_modifier_bit` in the desktop shell's `ptt.rs`), so both transports
 * agree on what a modifier-keyed binding means.
 *
 * The store is expected to normalize on every write and on load, so a
 * persisted `{ ShiftLeft, shift: true }` from any earlier build cleans itself.
 */
export function normalizeBinding(binding: Binding): Binding {
  const own = selfModifier(binding.code);
  const copy = { ...binding };
  if (own !== null) copy[own] = false;
  return copy;
}

/**
 * Does `event` PRESS `binding`?
 *
 * Modifier match is **exact equality on every flag the binding's own key does
 * not set**. For a binding on a regular key that is all three: a binding with
 * `ctrl: false` does not fire while Ctrl is held. This is what keeps global
 * bindings from stealing every superset chord out from under the focused
 * application — bind `Alt+KeyM` loosely and it would also fire on
 * `Ctrl+Alt+Shift+KeyM`, which belongs to whatever the user is actually typing
 * into.
 *
 * # A modifier as the key
 *
 * When `binding.code` is itself Ctrl, Shift or Alt ({@link selfModifier}),
 * that ONE flag is not compared and the other two still are. A modifier's own
 * keydown always carries its flag on the DOM — `ShiftLeft` arrives with
 * `shiftKey: true` — so comparing it against the stored `shift: false` (the
 * normalized form, see {@link normalizeBinding}) would mean a bare Shift
 * binding could never match its own key. The native hook masks the same bit
 * before it compares (`self_modifier_bit` in `ptt.rs`), so a modifier-keyed
 * binding means the same thing on both transports.
 *
 * The superset argument holds unchanged for the two flags that ARE compared:
 * `{ ShiftLeft, ctrl: true }` ("Ctrl + Shift") fires on Shift pressed while
 * Ctrl is held — not while Ctrl and Alt are held, and not on a bare Shift.
 * Because a chord's key is the modifier pressed LAST, `{ ControlLeft, shift:
 * true }` ("Shift + Ctrl") is a different binding that fires on the reverse
 * gesture; {@link bindingsEqual} tells them apart and each matches only its
 * own keydown.
 *
 * A bare modifier binding fires on EVERY press of that modifier, before any
 * chord it starts is known: Ctrl+C in a game, Ctrl+click, the Alt of Alt+Tab.
 * Native passes the key through rather than consuming it, so the application
 * underneath still gets its shortcut and the binding fires alongside it. That
 * is the accepted cost of binding a lone modifier, not a defect to filter.
 */
export function bindingMatchesPress(
  binding: Binding,
  event: KeyLikeEvent,
): boolean {
  if (event.code !== binding.code) return false;
  const own = selfModifier(binding.code);
  return (
    (own === "ctrl" || event.ctrlKey === binding.ctrl) &&
    (own === "shift" || event.shiftKey === binding.shift) &&
    (own === "alt" || event.altKey === binding.alt)
  );
}

/**
 * Does `event` RELEASE `binding`?
 *
 * 🔴 **Physical key identity alone — modifiers are NOT compared.** This
 * asymmetry against {@link bindingMatchesPress} is the whole point, and it is
 * load-bearing rather than sloppy.
 *
 * Users release a chord in whatever order their hand unrolls, and letting go
 * of Ctrl before the letter is the common one. Under exact equality the
 * release of `Ctrl+KeyM` arrives as `{ code: "KeyM", ctrlKey: false }`, fails
 * the modifier comparison, and the action **never gets its up edge** — it
 * latches down. For a momentary binding (push-to-mute, push-to-talk) that is a
 * microphone held open after the user has let go: the exact failure this
 * codebase treats as unacceptable elsewhere.
 *
 * This asymmetry is the Wave 1 native contract, not a renderer invention: the
 * native hook matches releases on physical key identity alone. So a
 * renderer-side DOM listener using exact equality on release would also
 * *disagree with the native layer* about which actions are held, which is the
 * second-order bug. 🔴 The later DOM-listener lane must call **this** predicate
 * for `keyup`, never {@link bindingMatchesPress}.
 *
 * The cost is accepted and bounded: releasing the letter of `Ctrl+KeyM` while
 * `Alt+KeyM` is separately bound and held would end both. That needs two
 * bindings on one physical key — which the capture UI has no reason to offer,
 * and which the store is expected to reject as a duplicate (this module does
 * not detect duplicates; see {@link findBindingConflict}).
 *
 * # 🔴 The other half of the up-edge invariant: no down, no up
 *
 * Matching is only half of what native does. The up is posted **only where
 * the slot's down bit was actually set** — `BINDING_DOWN.fetch_and(!bit) & bit
 * != 0` — so on the native transport "an up is emitted exactly for the downs
 * that were emitted, and never otherwise."
 *
 * A renderer listener owes the same gate, and this predicate does not provide
 * it: it answers "is this key the binding's key", not "was this action down".
 * 🔴 Dispatch an up **only for an action the listener's own held-set records as
 * down**, and clear that record as you dispatch. Without it the asymmetry
 * above becomes a liability instead of a fix — one physical release would emit
 * an up for a binding on that key that was never pressed (it was pressed with
 * the wrong modifiers and never matched), and every teardown-cleared action
 * would get a second, spurious up on the next release of its key. The
 * held-set is also what {@link ARM_RELEASES_ALL_HELD} and
 * {@link KEYBIND_COMMANDS}`.disarm` require you to clear wholesale.
 */
export function bindingMatchesRelease(
  binding: Binding,
  event: Pick<KeyLikeEvent, "code">,
): boolean {
  return event.code === binding.code;
}

/** Are two bindings the same chord? Field-wise, not reference. */
export function bindingsEqual(a: Binding, b: Binding): boolean {
  return (
    a.code === b.code &&
    a.ctrl === b.ctrl &&
    a.shift === b.shift &&
    a.alt === b.alt
  );
}

/* ------------------------------------------------------------------------ *
 * 3. Tier — can it fire unfocused?
 * ------------------------------------------------------------------------ */

/**
 * Whether an action can be driven by the native hook while Sloga is
 * unfocused (`"global"`), or only by a focused keystroke (`"in-app"`).
 *
 * An `"in-app"` action is still a *global keybind* in the UI's sense — the
 * user binds it in the same list — but it must be delivered by a focused DOM
 * keydown. The capture UI is expected to say so on the row, because a binding
 * the user believes is system-wide and silently is not is worse than one
 * labeled honestly.
 */
export type KeybindTier = "global" | "in-app";

/**
 * Per-action tier. Every reason below was measured against the browser's
 * transient-activation rules and this codebase's error handling, not guessed.
 *
 * The explicit `Record<…>` annotation (as on `./keybindSequences`' tables) is
 * what makes a new action a compile error until it is classified here. It also
 * widens the values: `KEYBIND_TIER["screenshare-start"]` has type
 * {@link KeybindTier}, not `"in-app"`. That is intended — consumers branch on
 * these at runtime — but it means a per-action value cannot be pinned by a type
 * assertion, only by a runtime assertion in a test.
 */
export const KEYBIND_TIER: Record<GlobalKeybindAction, KeybindTier> = {
  "toggle-mute": "global",
  "toggle-deafen": "global",
  "toggle-camera": "global",

  /**
   * Stopping needs no activation: it is `setScreenShareEnabled(false)` on an
   * already-granted capture, so it works unfocused. Split from
   * `screenshare-start` for exactly this reason — a single toggle would have
   * had to take the stricter `"in-app"` tier and lose the unfocused stop,
   * which is the direction users actually need in a hurry.
   */
  "screenshare-stop": "global",

  /**
   * 🔴 Requires transient user activation, so the native hook cannot drive it.
   * Three separate reasons, any one of which is disqualifying:
   *
   * 1. `getDisplayMedia()` requires transient activation. A focused keydown
   *    grants it; a hook callback with no DOM event behind it does not.
   * 2. It always opens the OS/browser source picker. There is no
   *    re-share-last-source path in this client, so even if it were armed the
   *    user would have to come back to the window to pick a source — which
   *    defeats the point of an unfocused binding.
   * 3. Its failure is **silent**. A canceled picker rejects with
   *    `NotAllowedError`, and `Voice.onErr` (`@revolt/rtc/state.tsx`) drops
   *    every `NotAllowedError` without a modal — precisely so a canceled
   *    picker is not reported as a fault. So an unfocused press produces no
   *    share, no error and no feedback of any kind.
   */
  "screenshare-start": "in-app",

  "disconnect-call": "global",
  "accept-call": "global",
  "dismiss-call": "global",
  "toggle-window": "global",
  "toggle-overlay": "global",

  /**
   * 🔴 `Element.requestFullscreen()` requires transient user activation. A
   * focused keydown grants it; the native hook has no activation to give and
   * the promise rejects.
   */
  "toggle-fullscreen": "in-app",

  /**
   * Inherits `toggle-fullscreen`'s tier rather than having a reason of its
   * own. Theater mode is only offered inside fullscreen (see the theater
   * control in
   * `@revolt/ui/components/features/voice/callCard/VoiceCallCardActiveRoom`),
   * so it can only ever be pressed from a state that already required
   * activation to enter — and entering it from an unfocused press would have
   * to enter fullscreen first, which cannot work.
   */
  "toggle-theater": "in-app",
};

/* ------------------------------------------------------------------------ *
 * 4. Precondition — what must exist before dispatch
 * ------------------------------------------------------------------------ */

/**
 * The precondition the dispatch layer MUST satisfy before invoking an action.
 *
 * - `"none"` — safe to invoke unconditionally.
 * - `"room"` — requires a live voice room (`voice.room()`).
 * - `"incoming-call"` — requires a ringing inbound call
 *   (`incomingCall()` from `@revolt/rtc/incomingCall`).
 *
 * This is a three-valued discriminator rather than the boolean "needs a call"
 * the plan asked for, because two of the twelve actions need a *ringing* call
 * and specifically need there to be **no** room yet. Collapsing both states
 * into one flag would have made `accept-call` either falsely guarded by a
 * room check (never dispatchable) or falsely unguarded.
 */
export type KeybindRequirement = "none" | "room" | "incoming-call";

/**
 * Per-action precondition.
 *
 * 🔴 **Why this table exists at all.** The voice actions are not uniformly
 * safe to call with no room, and the unsafe ones do not fail quietly — they
 * pop an error modal in the user's face. In `@revolt/rtc/state.tsx`,
 * `toggleMute`, `toggleDeafen` and `toggleCamera` each guard on
 * `if (!room) throw "invalid state"`, and their `catch` routes to
 * `#captureFailed` → `onErr` → `openModal({ type: "error2" })`. `onErr` only
 * swallows `NotAllowedError`, and `"invalid state"` is a bare string with no
 * `.name`, so it is not swallowed: pressing a global mute key with no call
 * open would throw a modal over whatever the user was doing — from a keypress
 * they made in **another application**. `toggleScreenshare` throws the same
 * way, uncaught.
 *
 * The safe three are safe for concrete, different reasons:
 *
 * - `toggle-mute` / `toggle-deafen` must be dispatched through the
 *   `toggleMuteAnywhere` / `toggleDeafenAnywhere` variants, which check
 *   `#liveToggleReady()` and fall back to flipping the persisted preference so
 *   the next call starts in the chosen state. Dispatching the bare
 *   `toggleMute` / `toggleDeafen` instead reintroduces the modal.
 * - `disconnect-call` is `Voice.disconnect()`, which is a synchronous,
 *   idempotent teardown with no room guard — it bumps the connect generation
 *   and stops the ringtone, both no-ops when nothing is live.
 */
export const KEYBIND_REQUIREMENT: Record<
  GlobalKeybindAction,
  KeybindRequirement
> = {
  /** Via `toggleMuteAnywhere()` — see the table comment. */
  "toggle-mute": "none",
  /** Via `toggleDeafenAnywhere()` — see the table comment. */
  "toggle-deafen": "none",

  "toggle-camera": "room",
  "screenshare-stop": "room",
  "screenshare-start": "room",

  "disconnect-call": "none",

  "accept-call": "incoming-call",
  "dismiss-call": "incoming-call",

  "toggle-window": "none",
  "toggle-overlay": "none",
  "toggle-fullscreen": "none",

  /**
   * `"none"` because it cannot throw: with no call there is no call card
   * mounted and the toggle has nothing to write, so the press is inert.
   *
   * Inert is not the same as effective. Theater's real precondition is
   * *already being in fullscreen*, which is renderer UI state and not
   * something this table models — the dispatch layer reads it directly. The
   * value here answers only "does this need a guard to avoid the modal".
   */
  "toggle-theater": "none",
};

/* ------------------------------------------------------------------------ *
 * 5. Rate limiting
 * ------------------------------------------------------------------------ */

/**
 * Minimum gap between two accepted PRESS edges of the same action, in ms.
 *
 * 🔴 Applies to the `keybind:down` edge ONLY. Throttling `keybind:up` would
 * drop a release, and a dropped release latches the action down — see
 * {@link bindingMatchesRelease}. A release must always be delivered.
 *
 * # Why a floor is needed at all
 *
 * None of the voice toggles has an in-flight guard. On the click path they do
 * not need one: a human finger on a button cannot produce a second press
 * inside one renegotiation, so the guard comes free from the input device. A
 * key does not give that for free — but the reason is **deliberate
 * double-tapping**, not OS auto-repeat. See the note on auto-repeat below
 * before reaching for that argument.
 *
 * **The publish-gate sweep** is the failure. Each mic unmute ends in an
 * unconditional `resumeUpstream()`, which emits `UpstreamResumed`, which
 * re-asserts the publish gate and re-enters `coalescingSweeper`. That sweeper's
 * episode budget is its own `maxPasses` default parameter, `= 4`
 * (`coalescingSweeper` in `@revolt/rtc/publishGate.ts` — cited by symbol
 * deliberately: that file moves, and a line number here would rot on the next
 * rebase while still looking authoritative), and the convergent path already
 * consumes three of them — a margin of exactly one round. A second unmute
 * landing inside the same drive spends that margin, and the drive then ends
 * with a trigger still pending, which fires `onDropped()`: a sweep something
 * asked for was **discarded** while its caller's `await` resolved as if it had
 * run. The observable end state is a track left upstream-paused behind a mic
 * button that reads live.
 *
 * # 🔴 Auto-repeat is NOT the reason, and this tier is not where it bites
 *
 * An earlier draft of this comment argued that a held key delivers ~20 press
 * edges through the hook and that each would be a mute toggle. That is wrong
 * about the native layer this module mirrors: `keyboard_proc` already collapses
 * auto-repeat **twice**, independently.
 *
 * 1. The `key_busy` pre-scan. A press only matches while the physical key holds
 *    no down bit in any slot, so once the first true down latches a binding,
 *    every repeat for that key is inert before any field comparison runs. (It
 *    is there for a sharper bug than repeat volume: hold a bare `KeyK` binding,
 *    then press Ctrl, and the next repeat would otherwise match a separate
 *    `Ctrl+KeyK` slot — one physical press firing two actions.)
 * 2. The per-slot `fetch_or` gate, `BINDING_DOWN.fetch_or(bit) & bit == 0`,
 *    whose comment is explicit: "key auto-repeat must produce one
 *    `keybind:down`, not one per repeat tick."
 *
 * So on the `"global"` transport a held key contributes **exactly one** press
 * edge, and this floor is not what prevents the rest. The auto-repeat argument
 * applies only to the `"in-app"` tier ({@link KEYBIND_TIER}), whose edges come
 * from a focused DOM `keydown` — which does repeat, and where a listener that
 * does not consult `KeyboardEvent.repeat` gets the ~20-edges-per-second
 * behavior for real. That tier needs this floor for exactly the reason the
 * global tier does not.
 *
 * # Why 300 ms
 *
 * Lower bound: it must exceed one offer/answer round on a healthy SFU
 * connection, so two presses cannot share a held-gate episode. It also clears
 * the fastest configurable Windows repeat delay (~250 ms), which is what makes
 * it a sufficient floor for the `"in-app"` tier's DOM repeats as well — a
 * happy coincidence, not the derivation.
 *
 * Upper bound: a deliberate double-tap starts to feel dropped somewhere past
 * ~300–400 ms, so this sits at the bottom of that band.
 *
 * The trade-off is taken knowingly in this direction: the worst case of too
 * high is a second tap the user has to repeat, with the state plainly visible
 * on screen. The worst case of too low is a dropped publish-gate sweep, i.e. a
 * microphone the UI reports as live and which is not on the wire. This
 * codebase has bled on the second failure and not the first.
 */
export const KEYBIND_MIN_INTERVAL_MS = 300;

/* ------------------------------------------------------------------------ *
 * 6. Native contract
 * ------------------------------------------------------------------------ */

/**
 * Maximum bindings the native hook will arm in one `keybinds_arm` call.
 *
 * Restated here (it is a native-side limit) so the capture UI can refuse a
 * 17th binding at the point the user adds it, rather than discovering it in an
 * arm result.
 *
 * 🔴 Overflow is a **partial** refusal, not a failed call. Native arms the
 * first {@link MAX_BINDINGS} entries normally and returns every later id in
 * {@link KeybindsArmResult}`.refused`; it does not reject the submission or
 * restore what was armed before. So exceeding the ceiling silently publishes a
 * truncated set — the user's 17th binding is dead and the other sixteen are
 * live — which is precisely why the UI must refuse at add time AND still read
 * `refused`.
 */
export const MAX_BINDINGS = 16;

/** Tauri command names. String literals so a typo is a compile error. */
export const KEYBIND_COMMANDS = {
  /**
   * Replaces the whole armed set.
   *
   * Takes {@link KeybindArmPayload} — i.e. the bindings go in a **`bindings`
   * field of an object**, not as a bare array. The native signature is
   * `keybinds_arm(app, bindings: Vec<KeybindSpec>)`, and Tauri's `invoke`
   * matches command arguments by parameter name, so a bare
   * {@link ArmedBinding}`[]` deserializes to nothing at all.
   *
   * 🔴 **Returns {@link KeybindsArmResult}, and the result must be read.** The
   * call does not throw for a binding it would not arm; it reports it. See that
   * type — a caller that discards the result renders every row as working while
   * some (or, off Windows, all) of them fire nothing.
   */
  arm: "keybinds_arm",
  /**
   * Unarms everything. Takes no arguments, returns nothing, idempotent.
   *
   * 🔴 **Disarm is a release-all, exactly like arm** — see
   * {@link ARM_RELEASES_ALL_HELD}, whose rule this command shares. The native
   * `keybinds_disarm` clears the whole held-key word and emits **no synthetic
   * `keybind:up`** for what was held: "the frontend must treat disarm as
   * releasing every bound action."
   *
   * So the teardown / feature-off path owes the same unconditional local drop
   * of every held action that a re-arm does, and it owes it *before or as* the
   * disarm, never in response to an up that is not coming. Skipping it strands
   * a held push-to-mute exactly as a re-arm would, with the extra sting that
   * nothing will re-arm to give the key another edge.
   */
  disarm: "keybinds_disarm",
  /** Show/hide the main window — the `toggle-window` action's effect. */
  toggleWindowVisible: "window_toggle_visible",
} as const;

/** Event names the native side emits to the `main` window. */
export const KEYBIND_EVENTS = {
  down: "keybind:down",
  up: "keybind:up",
} as const;

/**
 * One entry of the `keybinds_arm` payload.
 *
 * 🔴 The native side identifies an action by its **array index**, not by `id`
 * — `action_id` is the position in the array passed to `keybinds_arm`. The
 * `id` field is carried only so the events can name it back. Two consequences
 * the caller owns:
 *
 * - The array must be built in one place and passed whole. Reordering it
 *   between arms is legal (the ids travel with the entries) but mutating it
 *   after the call is not: the native table is a snapshot of the indices.
 * - A sparse or filtered array shifts every index after the gap, so filtering
 *   out `"in-app"`-tier actions (which must not be armed) has to happen
 *   **before** the array is built, never by blanking entries in place.
 */
export type ArmedBinding = Binding & { id: GlobalKeybindAction };

/**
 * The `keybinds_arm` invoke payload.
 *
 * 🔴 **The array is wrapped.** `invoke(KEYBIND_COMMANDS.arm, { bindings })`,
 * never `invoke(KEYBIND_COMMANDS.arm, bindings)`. Tauri binds command
 * arguments by parameter name, and the native parameter is named `bindings`
 * (`pub fn keybinds_arm(app: tauri::AppHandle, bindings: Vec<KeybindSpec>)`).
 * `KeybindSpec` is `{ id, code, ctrl, shift, alt }` — field-for-field
 * {@link ArmedBinding}, and `id` is `String` on that side because native never
 * interprets it, only echoes it back.
 */
export type KeybindArmPayload = { bindings: ArmedBinding[] };

/**
 * What `keybinds_arm` RETURNS. 🔴 Not optional to read.
 *
 * # Every submitted id lands in exactly one list
 *
 * The native loop pushes each spec's id to exactly one of the three and
 * `continue`s, so the three lists partition the submitted array: their lengths
 * sum to `bindings.length`, and set-union equals the submitted id set. A
 * caller may therefore treat "not in `armed`" as "did not take", with no
 * fourth outcome to worry about — the call reports failure per binding instead
 * of throwing.
 *
 * # 🔴 The three `GlobalKeybindAction[]`s are an OPTIMISTIC declaration
 *
 * Native types them `Vec<String>` and echoes back whatever it was armed with,
 * so what actually crosses the boundary is untyped JSON — exactly as for
 * {@link KeybindEventPayload}, which is honestly typed `{ id: string }` for
 * this reason. These are narrower than the wire because a *caller-built*
 * payload cannot contain anything else, and keeping them narrow is what lets
 * consumers index {@link KEYBIND_TIER} without a cast.
 *
 * That holds only while the caller owns the submitted list. It stops holding
 * the moment a result outlives the arm that produced it — a stale
 * `keybinds_arm` racing a rebuild can echo an id this build has dropped, the
 * same race {@link isGlobalKeybindAction} exists for. 🔴 So the ingress point
 * that resolves the promise MUST filter each list through
 * {@link isGlobalKeybindAction} before handing it on; after that one filter
 * the type is true and no consumer needs to re-check. Do not treat the
 * declared type as evidence that the filter already happened.
 *
 * # 🔴 An all-empty result means "no native layer", NOT "armed"
 *
 * Off Windows `keybinds_arm` returns `KeybindsArmResult::default()` — all three
 * lists empty, **and no error**. Nothing is armed, nothing is reported, the
 * call resolves. That is the same shape as submitting zero bindings, and it is
 * indistinguishable from success to anything that only checks for a thrown
 * error.
 *
 * So the discharge rule is positive, never negative: a row is armed **iff its
 * id is in `armed`**. `refused.length === 0 && unsupported.length === 0` is not
 * evidence of anything. A caller that ignores the result shows every row as
 * working while nothing fires — on Windows for the unbindable keys, and on
 * every other platform for all of them.
 *
 * The obligation the native doc puts on the renderer is to
 * "mark the key as unbindable rather than show it as bound and never fire";
 * this type is what discharges it.
 */
export type KeybindsArmResult = {
  /**
   * Installed — a global hook is live for these. The **only** positive signal
   * that a binding took.
   */
  armed: GlobalKeybindAction[];
  /**
   * The `code` is absent from the native scan table, so the physical key
   * cannot be expressed: media keys, IME keys, and the ambiguous
   * Pause/NumLock 0x45. Not the user's fault and not policy — the key is
   * **unbindable** and the row must say so, because retrying will not help.
   */
  unsupported: GlobalKeybindAction[];
  /**
   * Rejected on policy: the reserved remote-control panic combo (see
   * {@link RESERVED_COMBO}), or a submission past {@link MAX_BINDINGS} — the
   * native side refuses the overflow by id rather than truncating, precisely
   * so a dropped binding is not indistinguishable from a broken one.
   *
   * 🔴 This list is the only **complete** reserved-combo signal.
   * {@link isReservedCombo} is a cheap capture-time subset of the native
   * refusal; see its comment.
   */
  refused: GlobalKeybindAction[];
};

/**
 * Payload of `keybind:down` / `keybind:up`.
 *
 * `id` is `string`, not {@link GlobalKeybindAction}: it comes off the wire and
 * a stale arm can name an action this build dropped. Narrow with
 * {@link isGlobalKeybindAction}.
 */
export type KeybindEventPayload = { id: string };

/**
 * 🔴 **`keybinds_arm` is a release-all.** The native side clears every
 * down-bit as it installs the new table, so any key held across a re-arm never
 * produces its `keybind:up` — the bit it would have cleared is already gone.
 *
 * A consumer MUST therefore drop every action it believes is held whenever it
 * calls `keybinds_arm`, and it must do so unconditionally, including on a
 * re-arm it considers a no-op (same bindings, new array) — the native side
 * clears regardless of whether the table changed.
 *
 * The failure this prevents is the latch again, and worse than the release
 * asymmetry: hold push-to-mute, have the settings UI re-arm (saving any other
 * binding does), and the microphone stays open with no further event ever
 * coming to close it. Nothing recovers it short of another press.
 *
 * 🔴 This is **not a feature flag** — it is always `true` and there is no
 * configuration that makes it false. It exists only so the store and dispatch
 * lanes can cite one symbol for the rule instead of restating it. Do not
 * branch on it as though the native behavior could vary.
 */
export const ARM_RELEASES_ALL_HELD = true as const;

/* ------------------------------------------------------------------------ *
 * 7. Reserved combo
 * ------------------------------------------------------------------------ */

/**
 * Ctrl+Shift+Alt+Q — the remote-control panic combo.
 *
 * The native layer refuses to arm this, so a user who binds it gets a row that
 * looks saved and never fires. {@link isReservedCombo} exists so the capture
 * UI can refuse it **at capture time**, while the user still has their fingers
 * on the keys and the refusal is self-explanatory.
 *
 * The combo is also matched renderer-side by `isPanicCombo` in
 * `@revolt/rtc/remoteControlMapping`, whose own comment records the bug that
 * came from having two hard-coded copies: the 2026-08-02 rebind (End → Q)
 * updated one of them and the other kept matching the dead key. This is
 * therefore a third copy, and that is a real cost — taken deliberately, for
 * two reasons:
 *
 * 1. `isPanicCombo` takes `{ code, key, ctrlKey, shiftKey, altKey }` and
 *    matches `code === "KeyQ" || key.toLowerCase() === "q"`. A {@link Binding}
 *    has no `key` by design, so calling it would mean synthesizing one — and
 *    passing `key: ""` to a predicate documented as fail-safe on either arm
 *    silently reduces it to half of what it claims to check.
 * 2. It would make this leaf import `@revolt/rtc/*`, which is the direction
 *    `./suppress` exists to avoid.
 *
 * 🔴 If the panic combo is rebound again, this constant and
 * `remoteControlMapping.isPanicCombo` must both change.
 */
export const RESERVED_COMBO: Binding = {
  code: "KeyQ",
  ctrl: true,
  shift: true,
  alt: true,
};

/**
 * Is this candidate the reserved panic combo?
 *
 * Exact match on the physical key and all three modifiers. A partial chord
 * (`Ctrl+Alt+KeyQ`) is not reserved and arms normally.
 *
 * # 🔴 This is a SUBSET of the arm-side refusal, not the same comparison
 *
 * Native `is_reserved_combo` gates on all three modifiers and then makes
 * **two** tests, either of which refuses:
 *
 * 1. `spec.code == "KeyQ"` — the physical position, which is what this
 *    predicate checks.
 * 2. the binding's resolved scan code equalling
 *    `MapVirtualKeyW(PANIC_VK, MAPVK_VK_TO_VSC)` with `!ext` — i.e. **the key
 *    LABELLED Q under the active layout**. The panic combo is matched by
 *    virtual key, so the label is what actually owns the kill switch;
 *    keybinds are matched by scan code. On QWERTY the two tests name the same
 *    key. On AZERTY the labelled-Q key is physical `KeyA`, and only test (2)
 *    catches it.
 *
 * Test (2) is layout-dependent and resolved from the OS at arm time, so it is
 * not computable here: this leaf has no layout to consult, and neither does
 * anything else in the renderer. That is a real gap, not a hypothetical. On
 * AZERTY a user binds Ctrl+Shift+Alt+`KeyA`, it passes this check and the
 * store's duplicate/reserved drop, persists as a saved row, and is then
 * `refused` natively — a binding that looks bound and never fires, which is
 * the exact outcome {@link RESERVED_COMBO} exists to prevent.
 *
 * 🔴 Therefore: keep calling this — it is the cheap capture-time check, it
 * costs nothing, and it catches the common case while the user's fingers are
 * still on the keys — but it is **not sufficient**. The `refused` list of
 * {@link KeybindsArmResult} is the only complete signal, and the UI must still
 * mark a row unbindable when an id comes back in it.
 *
 * (The native scan resolution is itself a snapshot taken at arm time: a user
 * who switches layout after arming can end up holding a binding on the
 * combo's new physical position until the next `keybinds_arm` re-evaluates
 * it. One more reason the post-arm result, not a pre-arm predicate, is the
 * authority.)
 */
export function isReservedCombo(candidate: Binding): boolean {
  return bindingsEqual(candidate, RESERVED_COMBO);
}

/* ------------------------------------------------------------------------ *
 * 8. Conflict checking for the capture UI
 * ------------------------------------------------------------------------ */

/**
 * The only `KeyboardEvent.code` values this module is willing to compare
 * against the in-app registry's `KeyboardEvent.key`-based sequences: the keys
 * whose `code` and `key` are the same string, on every layout.
 *
 * 🔴 **This is a deliberately partial map and there is no complete one.** For
 * every other key, `code` → `key` depends on the user's active keyboard layout
 * and on the shift state, neither of which is knowable from a stored
 * {@link Binding}. A table that guessed (`"KeyQ"` → `"q"`) would be wrong on
 * AZERTY and wrong again under Shift, and it would produce *false* conflict
 * reports — refusing a binding the user is entitled to.
 *
 * So: a candidate whose `code` is not a key of this map is **not cross-checked
 * against the in-app registry at all**. {@link findBindingConflict} returns
 * `null` for it, and that `null` is a known, accepted blind spot rather than an
 * assertion that no conflict exists — it is the honest answer available.
 *
 * This map is exported for the capture UI, not used by
 * {@link findBindingConflict} (which does not need it — see the note in its
 * body). The UI's use for it is to tell the two `null`s apart: for a code in
 * this map, "no conflict" was actually checked; for one outside it, the check
 * was skipped, and a UI that wants to be honest with the user can say so
 * instead of implying a clean result.
 *
 * Main-block keys only. `NumpadEnter` reports `key: "Enter"` but a distinct
 * `code`, and the numpad arrows report `code: "Numpad8"` with `key:
 * "ArrowUp"` when NumLock is off — including those would map two codes to one
 * key and break the map's one-to-one reading.
 */
export const IN_APP_COMPARABLE_CODES: Readonly<Record<string, string>> = {
  Escape: "Escape",
  Enter: "Enter",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
};

/**
 * The in-app registry's default sequences, restated in {@link Binding} space
 * — only the ones expressible through {@link IN_APP_COMPARABLE_CODES}.
 *
 * # Why this is a hand-maintained copy
 *
 * The real table is `DEFAULT_SEQUENCES` in `./keybindSequences`. Importing it
 * would cost this module its leaf status (it pulls `./keybindActions` →
 * `./suppress` → `solid-js`, with a module-scope `createSignal`), and it could
 * not be compared field-wise anyway: its entries are `(string | RegExp)[]` in
 * `key` space, so every entry would still need translating through the partial
 * map above. `./keybindActions` sets the precedent for this shape —
 * `ESCAPE_GROUP_MEMBERS` there is likewise an explicit list restating
 * something not machine-readable from its source, with a keep-in-sync note.
 *
 * 🔴 Keep in sync with `DEFAULT_SEQUENCES`. Drift here does not break a build;
 * it silently stops warning about a real conflict.
 *
 * # What is NOT in this list, and why
 *
 * - `CHAT_FOCUS_COMPOSITION` is bound to the regex `/^[^ ]$/` — any single
 *   non-space character, i.e. nearly every printable key, unmodified. It is
 *   omitted because it cannot be expressed here: no code in the comparable map
 *   produces a single-character `key`, so it could never match, and adding
 *   letter codes to the map to make it match would require exactly the layout
 *   guess that map refuses.
 * - `DEFAULT_MAC_SEQUENCES` is not modeled. There is no macOS native hook, so
 *   no global binding can exist on the platform that table serves.
 * - `CHAT_MARK_SERVER_AS_READ` (`Shift+Escape`) and the four navigation
 *   sequences are all present below.
 */
export const IN_APP_DEFAULT_SEQUENCES: readonly Binding[] = [
  /** Escape — CLOSE_MODAL / CLOSE_FLOATING / CLOSE_SIDEBAR / CHAT_* . */
  { code: "Escape", ctrl: false, shift: false, alt: false },
  /** Shift+Escape — CHAT_MARK_SERVER_AS_READ. */
  { code: "Escape", ctrl: false, shift: true, alt: false },
  /**
   * Alt+ArrowDown — NAVIGATION_CHANNEL_DOWN, and also
   * NAVIGATION_CHANNEL_UP, which is bound to `["Alt", "ArrowDown"]` too in
   * `./keybindSequences`. That looks like an upstream typo for `ArrowUp`, but
   * it is not this module's to fix; restated as-is so this list reflects what
   * the registry actually does today. `Alt+ArrowUp` is consequently NOT an
   * in-app default on non-Mac and is free to bind.
   */
  { code: "ArrowDown", ctrl: false, shift: false, alt: true },
  /** Ctrl+Alt+ArrowUp — NAVIGATION_SERVER_UP. */
  { code: "ArrowUp", ctrl: true, shift: false, alt: true },
  /** Ctrl+Alt+ArrowDown — NAVIGATION_SERVER_DOWN. */
  { code: "ArrowDown", ctrl: true, shift: false, alt: true },
];

/**
 * Why a candidate binding was refused.
 *
 * `"reserved"` and `"push-to-talk"` are hard refusals — the binding provably
 * cannot work as the user expects. `"in-app"` is a genuine collision the UI
 * may present as a warning rather than a block, since an `"in-app"`-tier
 * action colliding with a focused-only sequence is a different severity from a
 * `"global"`-tier one shadowing it system-wide.
 */
export type BindingConflict =
  | { kind: "reserved" }
  | { kind: "push-to-talk"; code: string }
  | { kind: "in-app"; sequence: Binding };

/**
 * Check a candidate binding for the collisions the capture UI can actually
 * detect, in descending severity. Returns the first, or `null`.
 *
 * The reserved and in-app arms compare the whole chord, which is right only
 * for a consumer that is matched chord-wise at runtime;
 * {@link findCodeWiseBindingConflict} is the counterpart for one that matches
 * `code` alone.
 *
 * @param candidate the chord the user just pressed
 * @param pushToTalkKey the current `voice.pushToTalkKey`, a bare
 * `KeyboardEvent.code` string (`"Space"` by default). Passed in rather than
 * read here: reaching `@revolt/state` from this leaf is the import direction
 * `./suppress` exists to avoid, and a caller that has already read the store
 * should not make this module read it again. Pass `undefined` when
 * push-to-talk is off — `voice.pushToTalk === false` means the key is
 * configured but inert, so there is nothing to collide with.
 *
 * # What this does NOT check
 *
 * - **Duplicates within the user's own global bindings.** The binding set
 *   lives in the store, which owns that comparison; {@link bindingsEqual} is
 *   exported for it.
 * - **Anything keyed on a code outside {@link IN_APP_COMPARABLE_CODES}.** See
 *   that map's comment. A `null` return means "no conflict this check can
 *   see", never "no conflict".
 * - **OS- and other-application-level bindings.** Nothing in the renderer can
 *   enumerate those; the native arm failing is the only signal, which is why
 *   {@link RESERVED_COMBO} is special-cased rather than discovered.
 */
export function findBindingConflict(
  candidate: Binding,
  pushToTalkKey?: string,
): BindingConflict | null {
  if (isReservedCombo(candidate)) return { kind: "reserved" };

  // Physical key identity only, ignoring modifiers — deliberately the same
  // rule as `bindingMatchesRelease`. Push-to-talk is matched by bare
  // `e.code !== pushToTalkKey` in `@revolt/rtc/state.tsx`, with no modifier
  // comparison at all, so `Ctrl+Space` DOES drive push-to-talk. A candidate
  // that merely adds modifiers to the push-to-talk key therefore still
  // collides, and comparing modifiers here would miss it.
  if (pushToTalkKey !== undefined && candidate.code === pushToTalkKey) {
    return { kind: "push-to-talk", code: pushToTalkKey };
  }

  // Searched directly, with no "is this code comparable" pre-check: every
  // entry of IN_APP_DEFAULT_SEQUENCES already uses a code from
  // IN_APP_COMPARABLE_CODES by construction, so a non-comparable candidate
  // cannot match one and a guard would only add a branch that never changes
  // the answer. It would also be actively harmful later — a guard would
  // SUPPRESS a sequence someone adds with a code outside the map, hiding a
  // real conflict instead of reporting it.
  const sequence = IN_APP_DEFAULT_SEQUENCES.find((entry) =>
    bindingsEqual(entry, candidate),
  );
  if (sequence) return { kind: "in-app", sequence };

  return null;
}

/**
 * The code-wise counterpart of {@link findBindingConflict}: the same three
 * arms in the same severity order, for a consumer whose RUNTIME matcher
 * compares `code` alone. Modifiers on `candidate` are ignored in every arm.
 *
 * # Whom this is for
 *
 * A consumer that stores only `binding.code` and matches presses on bare
 * `e.code` with no modifier comparison. Today that is the push-to-talk row
 * (`settings/user/voice/VoiceProcessingOptions.tsx`), whose keydown/keyup
 * handlers in `@revolt/rtc/state.tsx` compare `e.code` against the stored key
 * with no modifier comparison at all. The twelve global keybind rows are NOT
 * such a consumer: they store the whole chord and are matched by
 * {@link bindingMatchesPress}, so they keep calling
 * {@link findBindingConflict}.
 *
 * # Why the axis is the consumer's runtime matcher, not the action kind
 *
 * A conflict check is a prediction of what will collide at runtime, so it has
 * to ask the question the runtime matcher will ask. {@link findBindingConflict}
 * asks "is this chord one of those", which is right only for a consumer that
 * will match the chord. For a consumer that will match the code, the chord-wise
 * answer is wrong in both directions: bare `ArrowDown` captured on the
 * push-to-talk row draws no notice (no table entry is a modifier-less
 * `ArrowDown`), yet at runtime `Alt+ArrowDown` — channel navigation — opens
 * the microphone, and so does every bare arrow press while scrolling chat;
 * while `Alt+ArrowDown` captured on the same row DOES warn, and then stores the
 * identical bare `"ArrowDown"`. Two captures with the same stored value get
 * opposite verdicts. Keying the choice on "is this the push-to-talk action"
 * would only relocate that mistake: what decides which comparison is honest is
 * how the consumer matches, and a consumer states that by calling this
 * function instead of the other one.
 *
 * The property the spec pins follows from this: two candidates with the same
 * `code` and any modifiers get deep-equal verdicts.
 *
 * # Why reserved-ness is evaluated on the effective bare binding
 *
 * The consumer will store `candidate.code` alone, so what it will actually
 * hold is `{ code, ctrl: false, shift: false, alt: false }`, and that is what
 * is tested against {@link RESERVED_COMBO}. `Ctrl+Shift+Alt+KeyQ` captured on
 * such a row is therefore NOT reserved: the row will store bare `KeyQ`, which
 * is not the panic combo. The panic combo needs all three modifiers, so a bare
 * code can never be it today; the arm is still written against the constant
 * rather than short-circuited, so that a modifier-less {@link RESERVED_COMBO}
 * would refuse the bare code as it should.
 *
 * # Why the in-app arm returns the first match in table order
 *
 * With modifiers ignored, one code can collide with several entries — bare
 * `ArrowDown` collides with both `Alt+ArrowDown` and `Ctrl+Alt+ArrowDown`. One
 * verdict is enough to warn, and the first entry in
 * {@link IN_APP_DEFAULT_SEQUENCES} order is the one whose comment names the
 * channel-navigation sequence.
 *
 * @param candidate the chord the user just pressed; only its `code` is read
 * @param pushToTalkKey as for {@link findBindingConflict}
 */
export function findCodeWiseBindingConflict(
  candidate: Binding,
  pushToTalkKey?: string,
): BindingConflict | null {
  // The binding the consumer will actually store and match.
  const effective: Binding = {
    code: candidate.code,
    ctrl: false,
    shift: false,
    alt: false,
  };
  if (isReservedCombo(effective)) return { kind: "reserved" };

  if (pushToTalkKey !== undefined && candidate.code === pushToTalkKey) {
    return { kind: "push-to-talk", code: pushToTalkKey };
  }

  const sequence = IN_APP_DEFAULT_SEQUENCES.find(
    (entry) => entry.code === candidate.code,
  );
  if (sequence) return { kind: "in-app", sequence };

  return null;
}
