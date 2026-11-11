import { createSignal, Show } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";

import { tauriInvoke } from "@revolt/common";
import {
  type Binding,
  type BindingConflict,
} from "@revolt/keybinds/globalKeybinds";
import { DISABLE_WEB_AUDIO_MIX_KEY } from "@revolt/rtc";
import {
  formatVoicePitch,
  VOICE_PITCH_DEFAULT,
  VOICE_PITCH_MAX,
  VOICE_PITCH_MIN,
} from "@revolt/rtc/voicePitch";
import { useState } from "@revolt/state";
import {
  CategoryButton,
  Checkbox,
  Column,
  isTypingChord,
  KeyCapture,
  Row,
  Slider,
  Text,
} from "@revolt/ui";

import { InputSensitivity } from "./InputSensitivity";
import { RNNoiseLogo } from "./RNNoiseLogo";

/**
 * The store's own default push-to-talk key, restated.
 *
 * 🔴 Keep in sync with the `pushToTalkKey: "Space"` entry in the defaults
 * block of `components/state/stores/Voice.ts`. That value is not exported and
 * this wave does not own the store, so a local restatement with a keep-in-sync
 * note is the honest option. See {@link VoiceProcessingOptions}'s
 * `resetPushToTalkKey` for why the row needs a default at all.
 */
const DEFAULT_PUSH_TO_TALK_KEY = "Space";

/**
 * Voice processing options
 */
export function VoiceProcessingOptions() {
  const { voice } = useState();
  const { t } = useLingui();

  /**
   * The conflict verdict for the last push-to-talk chord `KeyCapture`
   * captured, or `null` once retracted.
   *
   * `onConflict` is optional on the widget and is wired up anyway, because the
   * verdict here describes a real collision on the bare code the runtime will
   * honor: the row passes `conflictMode="code"`, so `KeyCapture` judges the
   * key alone, which is exactly what `onPushToTalkChange` stores and what
   * `#pttKeydown` / `#pttKeyup` in `@revolt/rtc/state.tsx` match. A soft
   * `in-app` verdict means an in-app shortcut shares that key and, while Sloga
   * is focused, pressing it may do both. The chord DID bind, so the row owes a
   * sentence under the keycap saying so.
   *
   * 🔴 Only the soft kind can arrive on this row, so the description renders a
   * single verdict and has no hard-refusal branch. The hard-refusal predicate
   * in `keyCapturePolicy.ts` refuses exactly two kinds, `reserved` and
   * `push-to-talk`, and neither is reachable here in code mode:
   *
   * - `reserved` is judged on the bare code the row will keep, and the panic
   *   combo needs all three modifiers held, so no bare code is ever reserved.
   * - `push-to-talk` is the collision with the caller's `pushToTalkKey`, which
   *   this row passes as `undefined`: it IS the push-to-talk key and cannot
   *   collide with itself.
   *
   * `KeyCapture` owns the verdict and the refusal. A second verdict computed
   * here from the same chord could only ever disagree with it, so this signal
   * stores what the widget reported and nothing more.
   */
  const [pttConflict, setPttConflict] = createSignal<BindingConflict | null>(
    null,
  );

  /** The last accepted chord carried modifiers this setting cannot store. */
  const [pttDroppedModifiers, setPttDroppedModifiers] = createSignal(false);

  /**
   * Can this build even ATTEMPT global (unfocused) push to talk?
   *
   * 🔴 The deep `__TAURI__.core.invoke` probe from `@revolt/common`, not the
   * `"__TAURI__" in window` test this row used to gate its copy on.
   * `tauriInvoke`'s own doc calls that shallow shape out by name: the bridge
   * exists only when `withGlobalTauri` is on AND the window has a capability
   * file, so the shallow check "reads as available in windows where every call
   * will ACL-fail".
   *
   * 🔴 Even the deep probe is NECESSARY, NOT SUFFICIENT, so this predicate is
   * only ever allowed to mean "the global path may be attempted".
   * `#ensureNativePtt` in `@revolt/rtc/state.tsx` additionally requires
   * `__TAURI__.event`, and then requires `ptt_arm` to RETURN TRUE (`if
   * (!armed) return;`), with a thrown error swallowed into the same
   * focused-only fallback. None of that outcome reaches the renderer —
   * `#pttNativeKey` is private and nothing exposes it — and arming only
   * happens once a call has a room, which a settings screen need not be in at
   * all. The copy below therefore claims the attempt and both outcomes, and
   * explicitly declines to claim which one the user got.
   */
  const globalPttPossible = () => tauriInvoke() !== undefined;

  /** "+3" / "-5" for the voice changer label. */
  const pitchLabel = () => formatVoicePitch(voice.voicePitchSemitones);

  /**
   * The store's bare `KeyboardEvent.code` as the `Binding` the widget wants.
   *
   * 🔴 This is the whole code↔`Binding` bridge, and it keeps only `code`,
   * pinning the three modifier bits to `false`. Modifiers are unrepresentable
   * END TO END for this setting, not merely unstored: the store field is one
   * `string` (`Voice.ts:207`), the native `ptt_arm` payload is `{ key }` with
   * no modifier fields, and both runtime matchers compare a bare `e.code` with
   * no modifier comparison at all (`rtc/state.tsx:7038` and `:7072`).
   * Widening the setting is a store change this wave does not own.
   *
   * `""` maps to `null` rather than to a blank keycap: the field is a
   * non-optional `string`, so an empty value can only arrive from a
   * hand-edited or corrupt persisted blob (`Voice.ts:504` accepts any string),
   * and `copy.empty` is the honest rendering of it.
   */
  const pushToTalkBinding = (): Binding | null =>
    voice.pushToTalkKey === ""
      ? null
      : { code: voice.pushToTalkKey, ctrl: false, shift: false, alt: false };

  /**
   * Store an accepted chord, keeping its key and dropping its modifiers.
   *
   * 🔴 The drop is disclosed, not silent: the row renders
   * {@link pttDroppedModifiers} whenever this fires with a modifier held. The
   * stored bare code is also what the runtime actually honors — the matchers
   * ignore modifier state, so the key alone opens the mic, which is exactly
   * what the notice says.
   */
  function onPushToTalkChange(binding: Binding) {
    voice.pushToTalkKey = binding.code;
    setPttDroppedModifiers(binding.ctrl || binding.shift || binding.alt);
  }

  /**
   * Reset to {@link DEFAULT_PUSH_TO_TALK_KEY} — deliberately a reset, not an
   * unbind.
   *
   * 🔴 `pushToTalkKey` has no value meaning "unbound", and inventing one
   * (`""`) would reach three places this wave does not own: it would blank the
   * key legend in `RemoteControlOverlays.tsx:50`, hand `ptt_arm` an empty key,
   * and leave push to talk enabled but unable to ever open the mic. The
   * control's `copy.clear` label says "reset" so the button does not claim to
   * do something it cannot.
   */
  function resetPushToTalkKey() {
    voice.pushToTalkKey = DEFAULT_PUSH_TO_TALK_KEY;
    setPttDroppedModifiers(false);
  }

  /**
   * Record a verdict, and drop any stale modifier notice with it.
   *
   * Ordering is safe in both directions: `KeyCapture` calls `onConflict`
   * *before* `onChange` on a commit, so clearing here cannot wipe the flag
   * `onChange` is about to set; and a refusal never reaches `onChange` at all,
   * so the clear is what stops a previous capture's notice sitting under a
   * chord that was rejected.
   */
  function onPushToTalkConflict(conflict: BindingConflict | null) {
    setPttDroppedModifiers(false);
    setPttConflict(conflict);
  }

  return (
    <Column>
      <Text class="title">
        <Trans>Microphone Gain</Trans>
      </Text>
      <CategoryButton.Group>
        <CategoryButton
          icon="blank"
          description={
            <Column gap="sm">
              <Text class="label"><Trans>Gain: {voice.microphoneGain}%</Trans></Text>
              <Slider
                min={0}
                max={200}
                step={1}
                value={voice.microphoneGain}
                onInput={(e) => (voice.microphoneGain = Number(e.currentTarget.value))}
                labelFormatter={(v) => `${v}%`}
              />
            </Column>
          }
        >
          <Trans>Input Gain</Trans>
        </CategoryButton>
      </CategoryButton.Group>

      <Text class="title">
        <Trans>Voice Processing</Trans>
      </Text>
      <CategoryButton.Group>
        <CategoryButton.Select
          icon={"blank"}
          title={<Trans>Select noise suppression</Trans>}
          options={{
            disabled: { title: <Trans>Disabled</Trans> },
            browser: { title: <Trans>Browser</Trans> },
            enhanced: {
              title: <Trans>Enhanced</Trans>,
              // The wordmark IS the credit line, the way Discord shows Krisp:
              // the filter is what makes this option worth choosing.
              description: <RNNoiseLogo height={32} />,
              shortDesc: (
                <Row align gap="sm">
                  <Trans>Enhanced</Trans>
                  <RNNoiseLogo />
                </Row>
              ),
            },
          }}
          value={voice.noiseSupression}
          onUpdate={(ns) => (voice.noiseSupression = ns)}
        />
        <CategoryButton
          icon="blank"
          action={<Checkbox checked={voice.echoCancellation} />}
          onClick={() => (voice.echoCancellation = !voice.echoCancellation)}
        >
          <Trans>Browser Echo Cancellation</Trans>
        </CategoryButton>
        <CategoryButton
          icon="blank"
          action={<Checkbox checked={voice.autoGainControl} />}
          onClick={() => (voice.autoGainControl = !voice.autoGainControl)}
        >
          <Trans>Automatic Gain Control</Trans>
        </CategoryButton>
      </CategoryButton.Group>

      <Text class="title">
        <Trans>Voice Shaper</Trans>
      </Text>
      <CategoryButton.Group>
        {/* A radio-style select on purpose: the microphone runs ONE
            processor, and the shaper is a single stage inside it, so exactly
            one preset can be active. The list is the closed catalog in
            rtc/voiceTonePresets.ts — add a preset there, not here. */}
        <CategoryButton.Select
          icon="blank"
          title={<Trans>Select a voice shaper</Trans>}
          options={{
            off: {
              title: <Trans>Off</Trans>,
              description: <Trans>Your microphone as it is.</Trans>,
              shortDesc: <Trans>Off</Trans>,
            },
            warm: {
              title: <Trans>Warm</Trans>,
              description: (
                <Trans>
                  Rounder low end, a touch less edge. Softens thin headset mics.
                </Trans>
              ),
              shortDesc: <Trans>Warm</Trans>,
            },
            bright: {
              title: <Trans>Bright</Trans>,
              description: (
                <Trans>
                  Cuts rumble, lifts presence and air. Helps a muffled or boomy
                  mic.
                </Trans>
              ),
              shortDesc: <Trans>Bright</Trans>,
            },
            deep: {
              title: <Trans>Deep</Trans>,
              description: (
                <Trans>Fuller chest tone with a rolled-off top.</Trans>
              ),
              shortDesc: <Trans>Deep</Trans>,
            },
            radio: {
              title: <Trans>Radio</Trans>,
              description: (
                <Trans>
                  Narrow and squashed, like a walkie-talkie or dispatch call.
                </Trans>
              ),
              shortDesc: <Trans>Radio</Trans>,
            },
            podcast: {
              title: <Trans>Podcast</Trans>,
              description: (
                <Trans>
                  Broadcast polish: clears mud, adds presence, evens out your
                  level.
                </Trans>
              ),
              shortDesc: <Trans>Podcast</Trans>,
            },
          }}
          value={voice.voiceTonePreset}
          onUpdate={(preset) => (voice.voiceTonePreset = preset)}
        />
        <CategoryButton
          icon="blank"
          description={
            <Trans>
              One shaper at a time. It runs alongside noise suppression and
              input gain, and switching applies live during a call.
            </Trans>
          }
        >
          <Trans>How it works</Trans>
        </CategoryButton>
      </CategoryButton.Group>

      <Text class="title">
        <Trans>Voice Changer</Trans>
      </Text>
      <CategoryButton.Group>
        {/* Copy rule (rtc/voicePitch.ts): a toy for calls. It moves your
            pitch; it does not make you anonymous, so never say it does. */}
        <CategoryButton
          icon="blank"
          description={
            <Column gap="sm">
              <Text class="label">
                <Show
                  when={voice.voicePitchSemitones !== VOICE_PITCH_DEFAULT}
                  fallback={<Trans>Pitch: normal</Trans>}
                >
                  {/* Bare "+3": "semitones" needs a plural for ±1. */}
                  <Trans>Pitch: {pitchLabel()}</Trans>
                </Show>
              </Text>
              <Slider
                min={VOICE_PITCH_MIN}
                max={VOICE_PITCH_MAX}
                step={1}
                value={voice.voicePitchSemitones}
                onInput={(e) =>
                  (voice.voicePitchSemitones = Number(e.currentTarget.value))
                }
                labelFormatter={formatVoicePitch}
              />
              <Text class="label">
                <Trans>
                  Slide left for a deeper voice, right for a higher one. Just
                  for fun: it applies live during calls, stays on until you
                  reset it, and does not hide who you are.
                </Trans>
              </Text>
            </Column>
          }
        >
          <Trans>Voice Pitch</Trans>
        </CategoryButton>
        <Show when={voice.voicePitchSemitones !== VOICE_PITCH_DEFAULT}>
          <CategoryButton
            icon="blank"
            onClick={() => (voice.voicePitchSemitones = VOICE_PITCH_DEFAULT)}
            description={<Trans>Put your voice back to normal.</Trans>}
          >
            <Trans>Reset Pitch</Trans>
          </CategoryButton>
        </Show>
      </CategoryButton.Group>

      <Text class="title">
        <Trans>Incoming Voices</Trans>
      </Text>
      <CategoryButton.Group>
        <CategoryButton
          icon="blank"
          action={<Checkbox checked={voice.audioNormalization} />}
          onClick={() => (voice.audioNormalization = !voice.audioNormalization)}
          description={
            <Column gap="sm">
              <Trans>
                Evens out loud and quiet people automatically. Only voices are
                leveled — music and screen share audio are never touched.
              </Trans>
              {/* §0.3: a feature that silently does nothing is worse than one
                  that says why it is off. The shared mix is what the leveler
                  builds its processing into — and it is read at join time,
                  so turning it back on cannot help the CURRENT call. The
                  localStorage escape hatch disables the mix just as hard as
                  the setting does; check both or this reads as available
                  while support has kill-switched it. */}
              <Show
                when={
                  !voice.webAudioMix ||
                  localStorage.getItem(DISABLE_WEB_AUDIO_MIX_KEY) === "1"
                }
              >
                <Text class="label">
                  <Trans>
                    Unavailable while the shared audio mix is off. Turning the
                    mix back on takes effect when you next join a call.
                  </Trans>
                </Text>
              </Show>
            </Column>
          }
        >
          <Trans>Level Incoming Voices</Trans>
        </CategoryButton>
        <Show when={voice.audioNormalization}>
          <CategoryButton
            icon="blank"
            description={
              <Column gap="sm">
                <Text class="label">
                  <Trans>Strength: {voice.audioNormalizationStrength}%</Trans>
                </Text>
                <Slider
                  min={0}
                  max={100}
                  step={1}
                  value={voice.audioNormalizationStrength}
                  onInput={(e) =>
                    (voice.audioNormalizationStrength = Number(
                      e.currentTarget.value,
                    ))
                  }
                  labelFormatter={(v) => `${v}%`}
                />
                <Text class="label">
                  <Trans>
                    How far a quiet voice may be raised. Loud voices are always
                    tamed, at any strength.
                  </Trans>
                </Text>
              </Column>
            }
          >
            <Trans>Leveling Strength</Trans>
          </CategoryButton>
        </Show>
      </CategoryButton.Group>

      <Text class="title">
        <Trans>Microphone Mode</Trans>
      </Text>
      <CategoryButton.Group>
        <CategoryButton
          icon="blank"
          action={<Checkbox checked={voice.openMic} />}
          onClick={() => voice.setMicrophoneMode("openMic")}
          description={<Trans>Microphone stays on automatically when in a voice channel.</Trans>}
        >
          <Trans>Open Microphone</Trans>
        </CategoryButton>
        <CategoryButton
          icon="blank"
          action={<Checkbox checked={voice.vadEnabled} />}
          onClick={() => voice.setMicrophoneMode("vad")}
          description={<Trans>Mic only activates when your volume exceeds the threshold below.</Trans>}
        >
          <Trans>Voice Activity Detection</Trans>
        </CategoryButton>
        <Show when={voice.vadEnabled}>
          <InputSensitivity />
        </Show>
      </CategoryButton.Group>

      <Text class="title">
        <Trans>Push to Talk</Trans>
      </Text>
      <CategoryButton.Group>
        <CategoryButton
          icon="blank"
          action={<Checkbox checked={voice.pushToTalk} />}
          onClick={() => voice.setMicrophoneMode("pushToTalk")}
          description={
            <Column gap="sm">
              <Trans>Hold a key to unmute while in a voice channel.</Trans>
              {/* EL-PTT honesty (P5): say which key source this build has
                  instead of silently degrading. The presence question is
                  answered by `globalPttPossible`, whose comment spells out why
                  the affirmative branch promises an ATTEMPT and names both
                  outcomes rather than promising the global one. */}
              <Show
                when={globalPttPossible()}
                fallback={
                  <Text class="label">
                    <Trans>
                      In this build the key only registers while the app is
                      focused — the desktop app supports global push to talk.
                    </Trans>
                  </Text>
                }
              >
                <Text class="label">
                  <Trans>
                    This build asks the system for a global key hook when you
                    join a call. If the desktop shell grants it, the key
                    registers even while your game or another app is focused; if
                    it refuses, push to talk falls back to working only while
                    Sloga is focused. This screen cannot tell you which one you
                    got.
                  </Trans>
                </Text>
              </Show>
            </Column>
          }
        >
          <Trans>Enable Push to Talk</Trans>
        </CategoryButton>
        <Show when={voice.pushToTalk}>
          <CategoryButton
            icon="blank"
            action={
              /* The shared capture control. Every decision it makes lives in
                 `keyCapturePolicy.ts`; the bridge to this setting's bare
                 `code` string, and why `pushToTalkKey` is `undefined` here,
                 are documented on the handlers above.

                 `conflictMode="code"` because this setting stores and matches
                 `code` alone: `onPushToTalkChange` drops the modifiers and
                 both runtime matchers compare a bare `e.code`. The verdict
                 therefore has to be computed on the bare code the row will
                 actually keep. Judged chord-wise it was wrong in both
                 directions: bare `ArrowDown` drew no notice even though the
                 stored code then opened the mic under `Alt+ArrowDown` (channel
                 navigation) and under every bare arrow press while scrolling
                 chat, while `Alt+ArrowDown` captured deliberately DID warn and
                 stored the identical bare code. */
              <KeyCapture
                value={pushToTalkBinding()}
                pushToTalkKey={undefined}
                conflictMode="code"
                onChange={onPushToTalkChange}
                onClear={resetPushToTalkKey}
                onConflict={onPushToTalkConflict}
                copy={{
                  label: t`Push to Talk Key`,
                  listening: t`Press any key...`,
                  empty: t`Not bound`,
                  clear: t`Reset the push to talk key to its default`,
                }}
              />
            }
            description={
              <Column gap="sm">
                <Trans>Click to change the push to talk keybind.</Trans>
                {/* The single verdict this row can receive. It is always the
                    soft kind — `pttConflict`'s doc gives both reasons a hard
                    verdict cannot arrive here in code mode — so there is no
                    hard/soft branch and no refusal copy. */}
                <Show when={pttConflict()?.kind === "in-app"}>
                  <Text class="label">
                    <Trans>
                      This key is also used by a Sloga shortcut, so while Sloga
                      is focused pressing it may do both.
                    </Trans>
                  </Text>
                </Show>
                {/* Derived from the STORED binding, not from a capture event,
                    so a bare typing key bound before a reload still draws the
                    note (the same shape as `settings/user/Keybinds.tsx`).

                    🔴 This renders under the default `Space`, and that is
                    honest: `#pttKeydown` has no editable-target guard, so with
                    push to talk on, a space typed into the composer opens the
                    mic. The default is not special-cased.

                    Unlike `Keybinds.tsx`, nothing suppresses it under a
                    conflict: no hard verdict can co-exist here, so there is
                    never a "nothing was saved" sentence for it to contradict.
                    And it does not suggest adding a modifier — this setting
                    DROPS modifiers, so that advice would be false here. */}
                <Show when={pushToTalkBinding()}>
                  {(b) => (
                    <Show when={isTypingChord(b())}>
                      <Text class="label">
                        <Trans>
                          You use this key while typing, so it will also open
                          your mic in the message box, in search, anywhere text
                          goes.
                        </Trans>
                      </Text>
                    </Show>
                  )}
                </Show>
                <Show when={pttDroppedModifiers()}>
                  <Text class="label">
                    <Trans>
                      Push to talk matches a single key, so the modifiers you
                      held were not saved. The key on its own opens your mic.
                    </Trans>
                  </Text>
                </Show>
              </Column>
            }
          >
            <Trans>Push to Talk Key</Trans>
          </CategoryButton>
        </Show>
      </CategoryButton.Group>
    </Column>
  );
}
