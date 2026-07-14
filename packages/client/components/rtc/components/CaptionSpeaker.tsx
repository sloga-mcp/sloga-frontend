import { createEffect, onCleanup } from "solid-js";

import { translateText } from "@revolt/common";
import { useState } from "@revolt/state";

import { WebSpeechCaptionVoice } from "../captions/captionSpeech";

import { useVoice } from "..";

/**
 * Headless narrator (captions phase 2): speaks each remote participant's
 * FINALIZED caption aloud, translated into the viewer's caption language, using
 * on-device TTS. Mounted inside <InRoom>, so it only runs during a call.
 *
 * - Only FINAL utterances are spoken (interim text changes as you talk).
 * - Your OWN captions are never read back to you (skips the local identity).
 * - Runs entirely on the receiving side; adds no data egress beyond the
 *   translation call the caption already makes.
 */
export function CaptionSpeaker() {
  const voice = useVoice();
  const state = useState();
  const speaker = new WebSpeechCaptionVoice();

  // identity -> last text spoken for it, so a lingering final isn't repeated.
  const spoken = new Map<string, string>();

  createEffect(() => {
    const enabled =
      !!state.settings.getValue("captions:enabled") &&
      !!state.settings.getValue("captions:speak");
    if (!enabled) {
      speaker.cancel();
      return;
    }

    const target = (state.settings.getValue("captions:target") as string) || "en";
    const localId = voice.captions.localIdentity;

    for (const [identity, entry] of voice.captions.entries) {
      if (!entry.isFinal || identity === localId) continue;
      if (spoken.get(identity) === entry.text) continue;
      spoken.set(identity, entry.text);
      translateText(entry.text, target).then((result) =>
        speaker.speak(result?.text ?? entry.text, target),
      );
    }
  });

  onCleanup(() => speaker.cancel());

  return null;
}
