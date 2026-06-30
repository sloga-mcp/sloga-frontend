import { createSignal, Show } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";

import { useState } from "@revolt/state";
import { CategoryButton, Checkbox, Column, Text } from "@revolt/ui";

/**
 * Voice processing options
 */
export function VoiceProcessingOptions() {
  const { voice } = useState();
  const [bindingKey, setBindingKey] = createSignal(false);

  function startBinding() {
    setBindingKey(true);

    function onKey(e: KeyboardEvent) {
      e.preventDefault();
      voice.pushToTalkKey = e.code;
      setBindingKey(false);
      window.removeEventListener("keydown", onKey);
    }

    window.addEventListener("keydown", onKey);
  }

  function formatKey(code: string) {
    return code
      .replace("Key", "")
      .replace("Digit", "")
      .replace("Arrow", "↑↓←→".includes(code) ? "" : "Arrow ")
      .replace("Space", "Space");
  }

  return (
    <Column>
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
              description: <Trans>Powered by RNNoise</Trans>,
              shortDesc: <Trans>Enhanced (RNNoise)</Trans>,
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
        <Trans>Push to Talk</Trans>
      </Text>
      <CategoryButton.Group>
        <CategoryButton
          icon="blank"
          action={<Checkbox checked={voice.pushToTalk} />}
          onClick={() => (voice.pushToTalk = !voice.pushToTalk)}
          description={<Trans>Hold a key to unmute while in a voice channel.</Trans>}
        >
          <Trans>Enable Push to Talk</Trans>
        </CategoryButton>
        <Show when={voice.pushToTalk}>
          <CategoryButton
            icon="blank"
            action={
              <span style={{ "font-size": "0.8em", opacity: "0.7", "font-family": "monospace" }}>
                {bindingKey() ? <Trans>Press any key...</Trans> : formatKey(voice.pushToTalkKey)}
              </span>
            }
            onClick={startBinding}
            description={<Trans>Click to change the push to talk keybind.</Trans>}
          >
            <Trans>Push to Talk Key</Trans>
          </CategoryButton>
        </Show>
      </CategoryButton.Group>
    </Column>
  );
}
