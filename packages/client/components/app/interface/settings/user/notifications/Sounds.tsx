import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { For, Show } from "solid-js";
import { styled } from "styled-system/jsx";

import { useSound } from "@revolt/client";
import { useState } from "@revolt/state";
import { MESSAGE_PRESETS, RINGTONE_PRESETS, DISCONNECT_PRESETS } from "@revolt/client/Sounds";
import {
  CategoryButton,
  Checkbox,
  Column,
  IconButton,
  Row,
  Text,
  iconSize,
} from "@revolt/ui";

import MdVolumeUp from "@material-design-icons/svg/outlined/volume_up.svg?component-solid";

export default function Sounds() {
  const { settings, sounds } = useState();
  const soundController = useSound();
  const { t } = useLingui();

  const activeVariant = () => (settings.getValue("sounds:message_variant") ?? 4) as number;
  const setVariant = (v: number) => settings.setValue("sounds:message_variant", v);

  const activeRingtone = () => (settings.getValue("sounds:ringtone_variant") ?? 1) as number;
  const setRingtone = (v: number) => {
    settings.setValue("sounds:ringtone_variant", v);
    soundController.stopRingtone();
  };

  const activeDisconnect = () => (settings.getValue("sounds:disconnect_variant") ?? 1) as number;
  const setDisconnect = (v: number) => settings.setValue("sounds:disconnect_variant", v);

  const playSoundString = t`Play sound`;

  return (
    <Show when={settings.desktopNotificationsState !== "unsupported"}>
      <Column>
        <Text class="title">
          <Trans>Sounds</Trans>
        </Text>
        <CategoryButton.Group>
          <CategoryButton
            action={<Checkbox checked={sounds.enabled("message")} />}
            onClick={() => sounds.toggle("message")}
            icon="blank"
          >
            <Content>
              <Trans>Message Received</Trans>{" "}
              <IconButton
                onPress={() => soundController.playSound("message", true)}
                use:floating={{
                  tooltip: {
                    placement: "top",
                    content: playSoundString,
                  },
                }}
              >
                <MdVolumeUp {...iconSize(18)} />
              </IconButton>
            </Content>
          </CategoryButton>
        </CategoryButton.Group>
        <Text class="title">
          <Trans>Message Sound Style</Trans>
        </Text>
        <CategoryButton.Group>
          <For each={MESSAGE_PRESETS}>
            {(preset, i) => (
              <CategoryButton
                action={
                  <Row align gap="sm">
                    <IconButton
                      onPress={() => {
                        setVariant(i() + 1);
                        soundController.playSound("message", true);
                      }}
                      use:floating={{
                        tooltip: { placement: "top", content: t`Preview` },
                      }}
                    >
                      <MdVolumeUp {...iconSize(18)} />
                    </IconButton>
                    <Checkbox checked={activeVariant() === i() + 1} />
                  </Row>
                }
                onClick={() => setVariant(i() + 1)}
                icon="blank"
              >
                <Trans>{preset.label}</Trans>
              </CategoryButton>
            )}
          </For>
        </CategoryButton.Group>
        <CategoryButton.Group>
          <CategoryButton
            action={<Checkbox checked={sounds.enabled("messageSent")} />}
            onClick={() => sounds.toggle("messageSent")}
            icon="blank"
          >
            <Content>
              <Trans>Message Sent</Trans>{" "}
              <IconButton
                onPress={() => soundController.playSound("messageSent", true)}
                use:floating={{
                  tooltip: {
                    placement: "top",
                    content: playSoundString,
                  },
                }}
              >
                <MdVolumeUp {...iconSize(18)} />
              </IconButton>
            </Content>
          </CategoryButton>
          <CategoryButton
            action={<Checkbox checked={sounds.enabled("mute")} />}
            onClick={() => sounds.toggle("mute")}
            icon="blank"
          >
            <Content>
              <Trans>Mute</Trans>
              <IconButton
                onPress={() => soundController.playSound("mute", true)}
                use:floating={{
                  tooltip: {
                    placement: "top",
                    content: playSoundString,
                  },
                }}
              >
                <MdVolumeUp {...iconSize(18)} />
              </IconButton>
            </Content>
          </CategoryButton>
          <CategoryButton
            action={<Checkbox checked={sounds.enabled("unmute")} />}
            onClick={() => sounds.toggle("unmute")}
            icon="blank"
          >
            <Content>
              <Trans>Unmute</Trans>
              <IconButton
                onPress={() => soundController.playSound("unmute", true)}
                use:floating={{
                  tooltip: {
                    placement: "top",
                    content: playSoundString,
                  },
                }}
              >
                <MdVolumeUp {...iconSize(18)} />
              </IconButton>
            </Content>
          </CategoryButton>
          <CategoryButton
            action={<Checkbox checked={sounds.enabled("deafen")} />}
            onClick={() => sounds.toggle("deafen")}
            icon="blank"
          >
            <Content>
              <Trans>Deafen</Trans>
              <IconButton
                onPress={() => soundController.playSound("deafen", true)}
                use:floating={{
                  tooltip: {
                    placement: "top",
                    content: playSoundString,
                  },
                }}
              >
                <MdVolumeUp {...iconSize(18)} />
              </IconButton>
            </Content>
          </CategoryButton>
          <CategoryButton
            action={<Checkbox checked={sounds.enabled("undeafen")} />}
            onClick={() => sounds.toggle("undeafen")}
            icon="blank"
          >
            <Content>
              <Trans>Undeafen</Trans>
              <IconButton
                onPress={() => soundController.playSound("undeafen", true)}
                use:floating={{
                  tooltip: {
                    placement: "top",
                    content: playSoundString,
                  },
                }}
              >
                <MdVolumeUp {...iconSize(18)} />
              </IconButton>
            </Content>
          </CategoryButton>
          {/* I don't think we need this? */}
          <Show when={false}>
            <CategoryButton
              action={<Checkbox onChange={(value) => void value} />}
              onClick={() => void 0}
              icon="blank"
            >
              <Trans>Message Sent</Trans>
            </CategoryButton>
          </Show>
          <CategoryButton
            action={<Checkbox checked={sounds.enabled("ringtoneIncoming")} />}
            onClick={() => sounds.toggle("ringtoneIncoming")}
            icon="blank"
          >
            <Content>
              <Trans>Incoming Call Ringtone</Trans>
              <IconButton
                onPress={() => soundController.playSound("ringtoneIncoming", true)}
                use:floating={{
                  tooltip: {
                    placement: "top",
                    content: playSoundString,
                  },
                }}
              >
                <MdVolumeUp {...iconSize(18)} />
              </IconButton>
            </Content>
          </CategoryButton>
          <CategoryButton
            action={<Checkbox checked={sounds.enabled("ringtoneOutgoing")} />}
            onClick={() => sounds.toggle("ringtoneOutgoing")}
            icon="blank"
          >
            <Content>
              <Trans>Outgoing Call Ringtone</Trans>
              <IconButton
                onPress={() => soundController.playSound("ringtoneOutgoing", true)}
                use:floating={{
                  tooltip: {
                    placement: "top",
                    content: playSoundString,
                  },
                }}
              >
                <MdVolumeUp {...iconSize(18)} />
              </IconButton>
            </Content>
          </CategoryButton>
        </CategoryButton.Group>
        <Text class="title">
          <Trans>Ringtone Style</Trans>
        </Text>
        <CategoryButton.Group>
          <For each={RINGTONE_PRESETS}>
            {(preset, i) => (
              <CategoryButton
                action={
                  <Row align gap="sm">
                    <IconButton
                      onPress={() => {
                        setRingtone(i() + 1);
                        soundController.stopRingtone();
                        soundController.playSound("ringtoneIncoming", true);
                      }}
                      use:floating={{
                        tooltip: { placement: "top", content: t`Preview` },
                      }}
                    >
                      <MdVolumeUp {...iconSize(18)} />
                    </IconButton>
                    <Checkbox checked={activeRingtone() === i() + 1} />
                  </Row>
                }
                onClick={() => setRingtone(i() + 1)}
                icon="blank"
              >
                <Trans>{preset.label}</Trans>
              </CategoryButton>
            )}
          </For>
        </CategoryButton.Group>
        <CategoryButton.Group>
          <CategoryButton
            action={<Checkbox checked={sounds.enabled("userJoinVoice")} />}
            onClick={() => sounds.toggle("userJoinVoice")}
            icon="blank"
          >
            <Content>
              <Trans>User Joined Call</Trans>
              <IconButton
                onPress={() => soundController.playSound("userJoinVoice", true)}
                use:floating={{
                  tooltip: {
                    placement: "top",
                    content: playSoundString,
                  },
                }}
              >
                <MdVolumeUp {...iconSize(18)} />
              </IconButton>
            </Content>
          </CategoryButton>
          <CategoryButton
            action={<Checkbox checked={sounds.enabled("userLeaveVoice")} />}
            onClick={() => sounds.toggle("userLeaveVoice")}
            icon="blank"
          >
            <Content>
              <Trans>User Left Call</Trans>
              <IconButton
                onPress={() =>
                  soundController.playSound("userLeaveVoice", true)
                }
                use:floating={{
                  tooltip: {
                    placement: "top",
                    content: playSoundString,
                  },
                }}
              >
                <MdVolumeUp {...iconSize(18)} />
              </IconButton>
            </Content>
          </CategoryButton>
        </CategoryButton.Group>
        <Text class="title">
          <Trans>Disconnect Sound Style</Trans>
        </Text>
        <CategoryButton.Group>
          <For each={DISCONNECT_PRESETS}>
            {(preset, i) => (
              <CategoryButton
                action={
                  <Row align gap="sm">
                    <IconButton
                      onPress={() => {
                        setDisconnect(i() + 1);
                        soundController.playSound("userLeaveVoice", true);
                      }}
                      use:floating={{
                        tooltip: { placement: "top", content: t`Preview` },
                      }}
                    >
                      <MdVolumeUp {...iconSize(18)} />
                    </IconButton>
                    <Checkbox checked={activeDisconnect() === i() + 1} />
                  </Row>
                }
                onClick={() => setDisconnect(i() + 1)}
                icon="blank"
              >
                <Trans>{preset.label}</Trans>
              </CategoryButton>
            )}
          </For>
        </CategoryButton.Group>
        <CategoryButton.Group>
          <CategoryButton
            action={<Checkbox checked={sounds.enabled("streamStart")} />}
            onClick={() => sounds.toggle("streamStart")}
            icon="blank"
          >
            <Content>
              <Trans>Stream Start</Trans>
              <IconButton
                onPress={() => soundController.playSound("streamStart", true)}
                use:floating={{
                  tooltip: {
                    placement: "top",
                    content: playSoundString,
                  },
                }}
              >
                <MdVolumeUp {...iconSize(18)} />
              </IconButton>
            </Content>
          </CategoryButton>
          <CategoryButton
            action={<Checkbox checked={sounds.enabled("streamEnd")} />}
            onClick={() => sounds.toggle("streamEnd")}
            icon="blank"
          >
            <Content>
              <Trans>Stream End</Trans>
              <IconButton
                onPress={() => soundController.playSound("streamEnd", true)}
                use:floating={{
                  tooltip: {
                    placement: "top",
                    content: playSoundString,
                  },
                }}
              >
                <MdVolumeUp {...iconSize(18)} />
              </IconButton>
            </Content>
          </CategoryButton>
        </CategoryButton.Group>
      </Column>
    </Show>
  );
}

/**
 * Sound content wrapper
 */
const Content = styled("div", {
  base: {
    display: "flex",
    flexGrow: 1,
    flexDirection: "row",
    alignItems: "center",
  },
});
