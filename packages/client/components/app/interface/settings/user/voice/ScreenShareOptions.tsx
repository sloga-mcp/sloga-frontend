import { Trans } from "@lingui-solid/solid/macro";

import { useVoice } from "@revolt/rtc";
import { useState } from "@revolt/state";
import { ScreenShareQualityName } from "@revolt/state/stores/Voice";
import {
  CategoryButton,
  CategorySelectOption,
  Checkbox,
  Column,
  Slider,
  Text,
} from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

export function ScreenShareOptions() {
  const { voice } = useState();
  const voiceContext = useVoice();

  const qualities = voiceContext.getEnabledScreenShareQualities();

  return (
    <Column>
      <Text class="title">
        <Trans>Camera Settings</Trans>
      </Text>
      <CategoryButton.Group>
        <CategoryButton
          icon={<Symbol>brightness_6</Symbol>}
          description={
            <Column gap="sm">
              <Text class="label">
                <Trans>Brightness: {voice.cameraBrightness}%</Trans>
              </Text>
              <Slider
                min={0}
                max={200}
                step={1}
                value={voice.cameraBrightness}
                onInput={(e) =>
                  voiceContext.setCameraBrightness(
                    Number(e.currentTarget.value),
                  )
                }
                labelFormatter={(v) => `${v}%`}
              />
            </Column>
          }
        >
          <Trans>Camera Brightness</Trans>
        </CategoryButton>
      </CategoryButton.Group>

      <Text class="title">
        <Trans>Screen Share Settings</Trans>
      </Text>
      <CategoryButton.Group>
        <CategoryButton.Select
          icon={<Symbol>screen_share</Symbol>}
          title={<Trans>Select screen share quality</Trans>}
          options={
            Object.fromEntries(
              Object.keys(qualities).map((name) => [
                name,
                {
                  title: qualities[name as ScreenShareQualityName]!.fullName,
                },
              ]),
            ) as { [key in ScreenShareQualityName]: CategorySelectOption }
          }
          value={voice.screenShareQuality}
          onUpdate={(ns) => (voice.screenShareQuality = ns)}
        />
        <CategoryButton
          icon="blank"
          action={<Checkbox checked={voice.screenShareQualityAsk} />}
          onClick={() =>
            (voice.screenShareQualityAsk = !voice.screenShareQualityAsk)
          }
        >
          <Trans>Always Ask for Screen Share Quality</Trans>
        </CategoryButton>
      </CategoryButton.Group>
    </Column>
  );
}
