import { For, Match, Show, Switch, createSignal } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";

import {
  type KeybindArmState,
  keybindArmState,
} from "@revolt/keybinds/armState";
import {
  type BindingConflict,
  type GlobalKeybindAction,
  GLOBAL_KEYBIND_ACTIONS,
  KEYBIND_REQUIREMENT,
} from "@revolt/keybinds/globalKeybinds";
import { useState } from "@revolt/state";
import {
  CategoryButton,
  ColouredText,
  Column,
  KeyCapture,
  Text,
  isHardConflict,
  isTypingChord,
} from "@revolt/ui";

import {
  GLOBAL_TIER_ACTIONS,
  IN_APP_TIER_ACTIONS,
  blocksCapture,
  blocksClear,
  globalTierStatus,
  keybindRowStatus,
} from "./keybindRowPolicy.ts";

// The tier split, the row status and the capture lock are decided in
// `./keybindRowPolicy.ts` and tested there. What stays on this page is
// composition and the per-row glue: labels, the conflict verdicts a capture
// reports, and the ordering of a store write.

/**
 * Global keybinds settings page.
 *
 * One row per `GLOBAL_KEYBIND_ACTIONS` entry, in that order, split into the
 * two groups `KEYBIND_TIER` defines. The split is the point of the page: a
 * binding the user believes is system-wide and silently is not is worse than
 * one labeled honestly, and the second group says *why* its three actions can
 * never be system-wide instead of reading as a degraded fallback.
 *
 * Nothing is bound by default (`defaultKeybinds()` is twelve `null`s), so the
 * blank state is the normal one, not an error state.
 */
export function KeybindsSettings() {
  const { keybinds } = useState();

  const anyBound = () =>
    GLOBAL_KEYBIND_ACTIONS.some((action) => keybinds.binding(action) !== null);

  return (
    <Column gap="lg">
      <Text class="label">
        <Trans>
          Nothing is bound by default. A global keybind takes its key
          combination away from every other program on this computer while Sloga
          is running, so Sloga ships none of them and you choose the ones you
          want.
        </Trans>
      </Text>

      <GlobalKeybindGroup />
      <InAppKeybindGroup />

      <Show when={anyBound()}>
        <CategoryButton.Group>
          <CategoryButton
            icon="blank"
            description={<Trans>Unbinds every keybind on this page.</Trans>}
            onClick={() => keybinds.resetBindings()}
          >
            <ColouredText colour="var(--md-sys-color-error)">
              <Trans>Clear all keybinds</Trans>
            </ColouredText>
          </CategoryButton>
        </CategoryButton.Group>
      </Show>
    </Column>
  );
}

/**
 * The keybinds that fire while Sloga is unfocused.
 *
 * 🔴 The availability claim is gated on `keybindArmState()`, a real capability
 * probe, and NOT on `"__TAURI__" in window`. The shallow check is what the
 * push-to-talk row in `voice/VoiceProcessingOptions.tsx` uses to promise
 * "Works globally", and the helper's own documentation warns against it: the
 * global half is a Tauri *command* that exists only in the Windows desktop
 * shell, so a Tauri build without it passes `"__TAURI__" in window` and fires
 * nothing.
 *
 * 🔴 An unanswered probe gets its own branch rather than falling into the
 * unavailable copy or the available copy. `probed === false` means "still
 * asking", and flashing either answer before it lands is the same lie in one
 * direction or the other for the width of a frame.
 *
 * 🔴 The invariant behind the four-way split below: a state with NO evidence
 * never locks capture, because binding something is the only way to get
 * evidence. With nothing bound, the worker submits nothing to `keybinds_arm`
 * and so learns nothing about the hook — reading that silence as "no hook"
 * would lock every row and make the first global key impossible to bind, on
 * every platform including the one that has the hook. The red note is
 * reserved for proven negatives: the bridge is absent, or a real arm through
 * the bridge produced no evidence of a hook. `"unproven"` gets a neutral note
 * that says the check happens at first bind, and `"available"` renders
 * nothing.
 */
function GlobalKeybindGroup() {
  const tier = () => globalTierStatus(keybindArmState());

  return (
    <>
      <Text class="title">
        <Trans>Global keybinds</Trans>
      </Text>

      <Text class="label">
        <Trans>
          These fire while Sloga is not the focused app — while you are in a
          game, a browser, or another window.
        </Trans>
      </Text>

      <Switch>
        <Match when={tier() === "probing"}>
          <Text class="label">
            <Trans>
              Checking whether this device can register system-wide keys…
            </Trans>
          </Text>
        </Match>
        <Match when={tier() === "unavailable"}>
          <ColouredText colour="var(--md-sys-color-error)">
            <Text class="label">
              <Trans>
                This device cannot register system-wide keys, so any keys you
                have bound here will only fire while Sloga is focused. The
                Windows desktop app can register them everywhere.
              </Trans>
            </Text>
          </ColouredText>
        </Match>
        <Match when={tier() === "unproven"}>
          <Text class="label">
            <Trans>
              Sloga checks whether this device can register system-wide keys
              when you bind the first one.
            </Trans>
          </Text>
        </Match>
        {/* `"available"` has no <Match>: a hook that is proven present needs
            no note, and the rows below carry the per-binding claims. */}
      </Switch>

      <CategoryButton.Group>
        <For each={GLOBAL_TIER_ACTIONS}>
          {(action) => <KeybindRow action={action} arm={keybindArmState()} />}
        </For>
      </CategoryButton.Group>
    </>
  );
}

/**
 * The keybinds that can only ever fire while Sloga is focused.
 *
 * 🔴 This is not a lesser fallback tier and the copy must not read as one.
 * All three need transient user activation, which a focused keydown grants and
 * a native hook has nothing to offer for — so the limitation is in the
 * browser's activation rules, not in Sloga's shell support, and no amount of
 * native work lifts it. The reasons are stated on the group rather than left
 * implicit, because the push-to-talk row's promise is currently wrong for
 * precisely the opposite omission.
 */
function InAppKeybindGroup() {
  return (
    <>
      <Text class="title">
        <Trans>In-app only</Trans>
      </Text>

      <Text class="label">
        <Trans>
          These fire only while Sloga is focused, and that is not a limitation
          Sloga can lift. Fullscreen, theater mode and starting a screen share
          all need the browser to have seen your keypress itself before it will
          allow them, and a system-wide hook has no keypress to hand over.
          Starting a screen share also always opens the source picker, so an
          unfocused press would send you back to Sloga anyway — and a canceled
          picker fails with nothing shown at all.
        </Trans>
      </Text>

      <CategoryButton.Group>
        <For each={IN_APP_TIER_ACTIONS}>
          {(action) => <KeybindRow action={action} arm={keybindArmState()} />}
        </For>
      </CategoryButton.Group>
    </>
  );
}

/**
 * One action's row.
 *
 * `arm` is taken as a prop rather than read here so the two groups each read
 * `keybindArmState()` once in their own JSX; Solid compiles the attribute to a
 * getter, so the row still tracks it.
 */
function KeybindRow(props: {
  action: GlobalKeybindAction;
  arm: KeybindArmState;
}) {
  const { keybinds, voice } = useState();
  const { t } = useLingui();

  /** The verdict from the last capture, or `null` once retracted. */
  const [conflict, setConflict] = createSignal<BindingConflict | null>(null);
  /** The action this row's chord was taken away from, if any. */
  const [stolenFrom, setStolenFrom] = createSignal<GlobalKeybindAction | null>(
    null,
  );
  /** `setBinding` returned false — it re-validates and can refuse. */
  const [storeRefused, setStoreRefused] = createSignal(false);

  const status = () => keybindRowStatus(props.action, props.arm);
  const binding = () => keybinds.binding(props.action);

  /**
   * Is a hard capture refusal on screen right now?
   *
   * Only meaningful for the typing note below, which is derived from the
   * STORED binding and so describes the previous chord while a refusal of the
   * new one is live. See that note's comment for why that specific overlap is
   * the one case worth suppressing.
   */
  const hardRefusalLive = () => {
    const verdict = conflict();
    return verdict !== null && isHardConflict(verdict);
  };

  /**
   * 🔴 Push-to-talk IS passed here, deliberately.
   *
   * `findBindingConflict` hard-refuses any chord whose `code` equals it —
   * modifiers not compared, because push-to-talk is matched by a bare
   * `e.code` in `@revolt/rtc/state.tsx` and so `Ctrl+Space` drives it too.
   * That refusal is correct for *these* rows: a keybind must not steal the
   * talk key out from under a held microphone. It is the push-to-talk row's
   * own capture that must pass `undefined`, since a key is not its own
   * conflict.
   *
   * `undefined` while push-to-talk is off, per that function's contract:
   * `voice.pushToTalk === false` leaves the key configured but inert, so
   * there is nothing to collide with.
   */
  const pushToTalkKey = () =>
    voice.pushToTalk ? voice.pushToTalkKey : undefined;

  /**
   * The user-visible name of an action.
   *
   * Takes the action rather than closing over `props.action` so the
   * conflicting-action note can name the *other* row. A `switch` with no
   * `default` and a `string` return type is what makes a thirteenth action a
   * compile error here; a `Record` literal cannot be used because `t` must be
   * called inside a component, under the i18n provider.
   *
   * `dismiss-call` is "Decline": it runs the store's `declineCall`, the same
   * decline the ring popup's button sends, so in a one-to-one call the
   * caller is told. The action id keeps its old name so saved bindings
   * still apply.
   */
  const label = (action: GlobalKeybindAction): string => {
    switch (action) {
      case "toggle-mute":
        return t`Mute and unmute microphone`;
      case "toggle-deafen":
        return t`Deafen and undeafen`;
      case "toggle-camera":
        return t`Turn camera on and off`;
      case "screenshare-stop":
        return t`Stop screen share`;
      case "screenshare-start":
        return t`Start screen share`;
      case "disconnect-call":
        return t`Leave call`;
      case "accept-call":
        return t`Answer incoming call`;
      case "dismiss-call":
        return t`Decline incoming call`;
      case "toggle-window":
        return t`Show and hide Sloga`;
      case "toggle-overlay":
        return t`Show and hide the in-game overlay`;
      case "toggle-fullscreen":
        return t`Fullscreen the call`;
      case "toggle-theater":
        return t`Theater mode`;
    }
  };

  /**
   * Accessible name of the capture control.
   *
   * The action name goes through a local `const` so the generated placeholder
   * is named after it rather than positional — the catalog entry a later lane
   * must hand-append is `Keybind for {name}`.
   */
  const captureLabel = () => {
    const name = label(props.action);
    return t`Keybind for ${name}`;
  };

  /**
   * Drop the notes that describe a previous capture's outcome.
   *
   * `KeyCapture` calls `onConflict` before `onChange` on a commit and before
   * `onClear` on a clear, so clearing these from `onConflict` — including on
   * its `null` retraction at the start of every capture — means a stale
   * "taken from" or "could not save" note can never outlive the chord it was
   * about.
   */
  function dropOutcomeNotes() {
    setStolenFrom(null);
    setStoreRefused(false);
  }

  return (
    <CategoryButton
      icon="blank"
      disabled={blocksCapture(status())}
      action={
        <KeyCapture
          value={binding()}
          disabled={blocksCapture(status())}
          disableClear={blocksClear(status())}
          pushToTalkKey={pushToTalkKey()}
          copy={{
            label: captureLabel(),
            listening: t`Press a key…`,
            empty: t`Not bound`,
            clear: t`Clear this keybind`,
          }}
          onConflict={(verdict) => {
            dropOutcomeNotes();
            setConflict(verdict);
          }}
          onChange={(candidate) => {
            // 🔴 Read BEFORE the write. `setBinding` resolves a collision by
            // taking the chord — the previous holder is nulled — so asked
            // afterwards there is nothing left to name.
            const held = keybinds.conflictingAction(candidate, props.action);
            const accepted = keybinds.setBinding(props.action, candidate);
            setStolenFrom(accepted ? held : null);
            setStoreRefused(!accepted);
          }}
          onClear={() => {
            dropOutcomeNotes();
            keybinds.clearBinding(props.action);
          }}
        />
      }
      description={
        /* Passed unconditionally, which costs `Content`'s 2px gap under the
           title on the five rows that have nothing to say. The alternative —
           a `hasNotes()` predicate gating the whole block — would be a second
           copy of every condition below, and the failure mode of that copy
           under-reporting is a SUPPRESSED "Unbindable" warning: a row that
           renders as bound and never fires, the one outcome this page exists
           to prevent. 2px is the cheaper side of that trade. */
        <Column gap="sm">
          {/* Facts about the action that the row would otherwise leave the
              user guessing wrong about. */}
          <Switch>
            <Match when={props.action === "dismiss-call"}>
              <Text class="label">
                <Trans>
                  Declines the incoming call. In a one-to-one call, the caller
                  sees that you declined.
                </Trans>
              </Text>
            </Match>
            <Match when={props.action === "screenshare-stop"}>
              <Text class="label">
                <Trans>
                  Stopping works while Sloga is not focused; starting does not,
                  which is why they are separate keybinds.
                </Trans>
              </Text>
            </Match>
            <Match when={props.action === "toggle-theater"}>
              <Text class="label">
                <Trans>
                  Only does anything while the call is already fullscreen.
                </Trans>
              </Text>
            </Match>
          </Switch>

          {/* From KEYBIND_REQUIREMENT, so a row that needs a live call says
              so rather than looking broken when pressed idle. */}
          <Switch>
            <Match when={KEYBIND_REQUIREMENT[props.action] === "room"}>
              <Text class="label">
                <Trans>Does nothing unless you are in a call.</Trans>
              </Text>
            </Match>
            <Match when={KEYBIND_REQUIREMENT[props.action] === "incoming-call"}>
              <Text class="label">
                <Trans>Does nothing unless a call is ringing.</Trans>
              </Text>
            </Match>
          </Switch>

          {/* 🔴 The arm result. A row native would not arm says so instead of
              rendering as bound, which is the obligation
              `KeybindsArmResult` puts on the renderer. */}
          <Switch>
            <Match when={status() === "unsupported"}>
              <ColouredText colour="var(--md-sys-color-error)">
                <Text class="label">
                  <Trans>
                    Unbindable: Sloga cannot register that physical key. Media
                    keys, IME keys and Pause/NumLock are not available. Pick a
                    different key.
                  </Trans>
                </Text>
              </ColouredText>
            </Match>
            <Match when={status() === "refused"}>
              <ColouredText colour="var(--md-sys-color-error)">
                <Text class="label">
                  <Trans>
                    Unbindable: this combination was refused. It is either
                    reserved for a system shortcut, or past the keybind limit.
                    Pick a different key.
                  </Trans>
                </Text>
              </ColouredText>
            </Match>
            <Match when={status() === "armed"}>
              <Text class="label">
                <Trans>Registered system-wide.</Trans>
              </Text>
            </Match>
          </Switch>

          {/* The capture's own verdict. `reserved` and `push-to-talk` are hard
              refusals — nothing was saved. `in-app` is a warning: the chord
              IS saved and both handlers may fire. */}
          <Switch>
            <Match when={conflict()?.kind === "reserved"}>
              <ColouredText colour="var(--md-sys-color-error)">
                <Text class="label">
                  <Trans>
                    Ctrl + Shift + Alt + Q is reserved for the remote-control
                    panic shortcut and cannot be bound.
                  </Trans>
                </Text>
              </ColouredText>
            </Match>
            <Match when={conflict()?.kind === "push-to-talk"}>
              <ColouredText colour="var(--md-sys-color-error)">
                <Text class="label">
                  <Trans>
                    That key is your push-to-talk key. Change push to talk under
                    Voice first, or pick a different key here.
                  </Trans>
                </Text>
              </ColouredText>
            </Match>
            <Match when={conflict()?.kind === "in-app"}>
              <Text class="label">
                <Trans>
                  This is also a Sloga shortcut while the app is focused. It is
                  saved, and both may fire.
                </Trans>
              </Text>
            </Match>
          </Switch>

          {/* 🔴 A bare, modifier-less chord on a key the user types with.

              Derived from the STORED binding, not from the capture verdict: a
              bare KeyM bound yesterday still fires while typing today, so the
              row owes this warning on every render — including one with no
              capture anywhere in its past. A capture-driven note would flash
              once and vanish on reload.

              A <Show>, not a <Match> in either <Switch> above: it is not
              exclusive with the arm status or with the conflict verdict, and
              composes independently of both.

              🔴 There are TWO refusal sources on this row and they do NOT get
              the same treatment, because only one of them means "nothing was
              saved".

              (1) status() "unsupported" / "refused" — the NATIVE layer would
              not register the chord. The chord IS still in the store, and the
              DOM transport has no editable-target filter by design (adding one
              would make it disagree with the native transport, which has no
              DOM to consult), so this chord still fires from a focused
              composer. The warning is true on exactly those rows, and its
              closing "It is saved" is true too. Deliberately NOT suppressed:
              suppressing it there would be the bug, not the fix.

              (2) conflict() a HARD verdict — `reserved` or `push-to-talk`, per
              isHardConflict. Here the capture wrote NOTHING, so binding() is
              still the PREVIOUS chord and this note is describing that older
              chord while the red note above describes the key just pressed.
              Both sentences are individually true, but side by side the user
              who pressed Space and was refused reads "It is saved" as being
              about Space. So the note is suppressed while a hard verdict is
              live — the ONE case where "nothing was saved" is simultaneously on
              screen. The suppression is NOT self-retracting: `conflict` is a
              component-scope signal that only the next capture, a clear, or
              unmount resets, so a hard verdict hides this note until one of
              those happens. That is safe for a different reason — the red
              hard-refusal note above is driven by the same signal and is
              therefore always co-resident with the suppression, so the user
              never sees a silently missing warning, only a suppressed one
              with its explanation beside it.

              A soft `in-app` verdict is NOT suppressed: that chord really was
              saved, so the two notes agree and belong together.

              Soft styling with no ColouredText, matching the `in-app` note
              rather than the red `Unbindable` ones: the binding IS saved, and
              red would read as a refusal. */}
          <Show when={binding()}>
            {(b) => (
              <Show when={isTypingChord(b()) && !hardRefusalLive()}>
                <Text class="label">
                  {/* 🔴 The closing advice must NOT be "add Ctrl, Shift or
                      Alt": this note now also fires for a binding whose KEY is
                      a modifier, where that reads as "add Ctrl to Ctrl", and
                      `{ShiftLeft, ctrl}` still fires on the Shift half of
                      every Ctrl+Shift shortcut. Only pairing with a regular
                      key takes the binding out of ordinary typing. */}
                  <Trans>
                    You use this key while typing, so it will also fire in the
                    message box, in search, anywhere text goes. It is saved.
                    Binding it together with a regular key avoids that.
                  </Trans>
                </Text>
              </Show>
            )}
          </Show>

          {/* The store took the chord off another action. Named in a sibling
              slot rather than interpolated into the sentence: nested JSX
              inside <Trans> is a recorded landmine in this repo. */}
          <Show when={stolenFrom()}>
            {(other) => (
              <Text class="label">
                <Trans>
                  This combination was taken from another keybind, which is now
                  unbound:
                </Trans>{" "}
                {label(other())}
              </Text>
            )}
          </Show>

          <Show when={storeRefused()}>
            <ColouredText colour="var(--md-sys-color-error)">
              <Text class="label">
                <Trans>
                  Sloga could not save that combination. Pick a different key.
                </Trans>
              </Text>
            </ColouredText>
          </Show>
        </Column>
      }
    >
      {label(props.action)}
    </CategoryButton>
  );
}
