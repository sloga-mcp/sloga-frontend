import { For, JSX, Match, Show, Switch, createSignal } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { css } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { useUser } from "@revolt/client";
import { useDevice } from "@revolt/common";
import {
  UNICODE_EMOJI_PACKS,
  UnicodeEmoji,
  UnicodeEmojiPacks,
} from "@revolt/markdown/emoji/UnicodeEmoji";
import { useState } from "@revolt/state";
import { ContentWidth } from "@revolt/state/stores/Settings";
import {
  Avatar,
  Button,
  Checkbox,
  Column,
  FloatingSelect,
  IconButton,
  MenuItem,
  MessageContainer,
  Row,
  Slider,
  Text,
} from "@revolt/ui";
import {
  FONT_KEYS,
  Fonts,
  MONOSPACE_FONT_KEYS,
  MonospaceFonts,
} from "@revolt/ui/themes/fonts";
import { RAIL_ACCENT_PRESETS } from "@revolt/ui/themes/railAccent";

import MDPalette from "@material-design-icons/svg/outlined/palette.svg?component-solid";

import { LayoutArrangement } from "./LayoutArrangement";

/**
 * All appearance options for the client
 */
export function AppearanceMenu() {
  const user = useUser();
  const state = useState();
  const device = useDevice();
  const { t } = useLingui();
  const [pickerRef, setPickerRef] = createSignal<HTMLInputElement>();
  const [railPickerRef, setRailPickerRef] = createSignal<HTMLInputElement>();

  // Swatches compare case-insensitively: the native picker reports lowercase
  // hex, the presets are written uppercase, and a user who picked a preset
  // through the picker should still see it lit.
  const railAccent = () => state.theme.railAccent.toLowerCase();

  const contentWidth = () =>
    state.settings.getValue("appearance:content_width") ?? "full";
  const contentAlign = () =>
    state.settings.getValue("appearance:content_align") ?? "start";
  // Mirrors Message.tsx: compact rows are also "tail" rows (time in the
  // gutter, name inline), so the preview lays out exactly like the channel.
  const compact = () => !!state.settings.getValue("appearance:compact_mode");

  /**
   * The display's own resolution, for the disabled ultrawide row.
   *
   * Naming the ratio ("this display is 16:9") would mean reverse-engineering a
   * fraction from a float and getting it wrong on anything unusual; the raw
   * numbers are unambiguous and need no arithmetic.
   */
  const displayDimensions = () =>
    `${globalThis.screen?.width ?? 0}×${globalThis.screen?.height ?? 0}`;

  /**
   * Message column width presets.
   *
   * Fixed choices rather than a free pixel entry: the useful range is narrow,
   * and a hand-typed value small enough to break the composer is not a state
   * worth supporting.
   */
  const CONTENT_WIDTH_OPTIONS: {
    value: ContentWidth;
    label: () => JSX.Element;
  }[] = [
    { value: "full", label: () => <Trans>Full</Trans> },
    { value: "wide", label: () => <Trans>Wide</Trans> },
    { value: "comfortable", label: () => <Trans>Comfortable</Trans> },
    { value: "narrow", label: () => <Trans>Narrow</Trans> },
  ];

  return (
    <Column gap="lg">
      <Column>
        <Text class="title" size="small">
          <Trans>Colors</Trans>
        </Text>

        <Row justify="stretch">
          <Button
            group="connected-start"
            groupActive={state.theme.mode === "light"}
            onPress={() => state.theme.setMode("light")}
          >
            <Trans>Light</Trans>
          </Button>
          <Button
            group="connected"
            groupActive={state.theme.mode === "dark"}
            onPress={() => state.theme.setMode("dark")}
          >
            <Trans>Dark</Trans>
          </Button>
          <Button
            group="connected-end"
            groupActive={state.theme.mode === "system"}
            onPress={() => state.theme.setMode("system")}
          >
            <Trans>System</Trans>
          </Button>
        </Row>

        <Row justify="stretch">
          <Button
            group="connected-start"
            groupActive={state.theme.preset === "stoat"}
            onPress={() => state.theme.setPreset("stoat")}
          >
            <Trans>Sloga</Trans>
          </Button>
          <Button
            group="connected-end"
            groupActive={state.theme.preset === "you"}
            onPress={() => state.theme.setPreset("you")}
          >
            <Trans>Material You</Trans>
          </Button>
        </Row>

        <Show when={state.theme.preset === "you"}>
          <Row align justify wrap>
            {/* The swatch button and the hidden colour input shared one ref
                signal, so which element `pickerRef()` ended up pointing at was
                just whichever Solid created last. It happened to be the input,
                which is the one we want to click — only by accident. */}
            <IconButton
              variant="filled"
              shape="square"
              size="md"
              onPress={() => pickerRef()?.click()}
            >
              <MDPalette />
            </IconButton>
            <input
              ref={setPickerRef}
              type="color"
              value={state.theme.m3Accent ?? "#ffffff"}
              onInput={(e) => {
                const colour = (e.currentTarget as HTMLInputElement).value;
                state.theme.setM3Accent(colour);
              }}
              style={{
                position: "absolute",
                opacity: 0,
                width: "0px",
                height: "0px",
                padding: 0,
                border: "none",
              }}
            />
            <For
              each={[
                "#FF5733",
                "#ffdc2f",
                "#9bf088",
                "#54ecc1",
                "#549bec",
                "#5470ec",
                "#8C5FD3",
              ]}
            >
              {(colour) => (
                <Button
                  size="md"
                  bg={colour}
                  group="standard"
                  groupActive={state.theme.m3Accent === colour}
                  onPress={() => state.theme.setM3Accent(colour)}
                />
                // <div
                //   class={css({
                //     borderRadius: "var(--borderRadius-full)",
                //     width: "48px",
                //     height: "48px",
                //     cursor: "pointer",
                //   })}
                //   style={{ "background-color": colour }}
                //   onClick={() => state.theme.setM3Accent(colour)}
                // />
              )}
            </For>
            {/* <div
            class={css({
              borderRadius: "var(--borderRadius-full)",
              width: "48px",
              height: "48px",
              cursor: "pointer",
            })}
          >
            <MdColorize />
          </div> */}
          </Row>

          {/* TODO: Cursed on mobile; may need to be replaced
          with FloatingSelect / similar on small screens */}
          <Row justify="stretch">
            <Button
              size="xs"
              group="connected-start"
              groupActive={state.theme.m3Contrast.toFixed(1) === "-1.0"}
              onPress={() => state.theme.setM3Contrast(-1.0)}
            >
              <Trans>Reduced</Trans>
            </Button>
            <Button
              size="xs"
              group="connected"
              groupActive={state.theme.m3Contrast.toFixed(1) === "0.0"}
              onPress={() => state.theme.setM3Contrast(0)}
            >
              <Trans>Normal</Trans>
            </Button>
            <Button
              size="xs"
              group="connected"
              groupActive={state.theme.m3Contrast.toFixed(1) === "0.5"}
              onPress={() => state.theme.setM3Contrast(0.5)}
            >
              <Trans>More Contrast</Trans>
            </Button>
            <Button
              size="xs"
              group="connected-end"
              groupActive={state.theme.m3Contrast.toFixed(1) === "1.0"}
              onPress={() => state.theme.setM3Contrast(1.0)}
            >
              <Trans>High Contrast</Trans>
            </Button>
          </Row>

          <Row justify="stretch">
            <Button
              size="xs"
              group="connected-start"
              groupActive={state.theme.m3Variant === "monochrome"}
              onPress={() => state.theme.setM3Variant("monochrome")}
            >
              <Trans>Monochrome</Trans>
            </Button>
            <Button
              size="xs"
              group="connected"
              groupActive={state.theme.m3Variant === "neutral"}
              onPress={() => state.theme.setM3Variant("neutral")}
            >
              <Trans>Neutral</Trans>
            </Button>
            <Button
              size="xs"
              group="connected"
              groupActive={state.theme.m3Variant === "tonal_spot"}
              onPress={() => state.theme.setM3Variant("tonal_spot")}
            >
              <Trans>Tonal Spot</Trans>
            </Button>
            {/* <Button
            size="xs"
            group="connected"
            groupActive={state.theme.m3Variant === "vibrant"}
            onPress={() => state.theme.setM3Variant("vibrant")}
          >
            <Trans>Vibrant</Trans>
          </Button>
          <Button
            size="xs"
            group="connected"
            groupActive={state.theme.m3Variant === "expressive"}
            onPress={() => state.theme.setM3Variant("expressive")}
          >
            <Trans>Expressive</Trans>
          </Button>
          <Button
            size="xs"
            group="connected"
            groupActive={state.theme.m3Variant === "fidelity"}
            onPress={() => state.theme.setM3Variant("fidelity")}
          >
            <Trans>Fidelity</Trans>
          </Button>
          <Button
            size="xs"
            group="connected"
            groupActive={state.theme.m3Variant === "content"}
            onPress={() => state.theme.setM3Variant("content")}
          >
            <Trans>Content</Trans>
          </Button>
          <Button
            size="xs"
            group="connected"
            groupActive={state.theme.m3Variant === "rainbow"}
            onPress={() => state.theme.setM3Variant("rainbow")}
          >
            <Trans>Rainbow</Trans>
          </Button> */}
            <Button
              size="xs"
              group="connected-end"
              groupActive={state.theme.m3Variant === "fruit_salad"}
              onPress={() => state.theme.setM3Variant("fruit_salad")}
            >
              <Trans>Fruit Salad</Trans>
            </Button>
          </Row>
        </Show>

        <Text class="label">
          <Trans>Sidebar highlight</Trans>
        </Text>
        <Text class="label" size="small">
          <Trans>
            Used for unread channels, online members and the voice channel you
            are in. Sloga orange is the default.
          </Trans>
        </Text>
        <Row align justify wrap>
          <IconButton
            variant="filled"
            shape="square"
            size="md"
            onPress={() => railPickerRef()?.click()}
          >
            <MDPalette />
          </IconButton>
          <input
            ref={setRailPickerRef}
            type="color"
            value={state.theme.railAccent}
            onInput={(e) =>
              state.theme.setRailAccent(
                (e.currentTarget as HTMLInputElement).value,
              )
            }
            style={{
              position: "absolute",
              opacity: 0,
              width: "0px",
              height: "0px",
              padding: 0,
              border: "none",
            }}
          />
          <For each={RAIL_ACCENT_PRESETS}>
            {(colour) => (
              <Button
                size="md"
                bg={colour}
                group="standard"
                groupActive={railAccent() === colour.toLowerCase()}
                onPress={() => state.theme.setRailAccent(colour)}
              />
            )}
          </For>
        </Row>

        {/* A rendering effect of the theme, so it sits with the theme rather
            than among the message options it used to head. */}
        <Checkbox checked={state.theme.blur} onChange={state.theme.toggleBlur}>
          <Trans>
            Enable transparency glass/blur effects (slow on older machines)
          </Trans>
        </Checkbox>
      </Column>

      <Column>
        <Text class="title" size="small">
          <Trans>Messages</Trans>
        </Text>

        {/* The preview leads the section so every control under it has
            something to act on. It is a live MessageContainer, so it honours
            the timestamp/username toggles and the three sliders exactly as
            the channel view does. */}
        <Preview>
          <MessagePreview>
            <MessageContainer
              avatar={
                <Avatar
                  size={state.theme.messageAvatarSize}
                  src={user()?.animatedAvatarURL}
                  fallback={user()?.displayName}
                />
              }
              timestamp={new Date()}
              username={user()?.displayName}
              compact={compact()}
              tail={compact()}
              isLink="hide"
            >
              Sphinx of black quartz, judge my vow
            </MessageContainer>
            <MessageContainer
              avatar={
                <Avatar size={state.theme.messageAvatarSize} fallback={"M"} />
              }
              timestamp={new Date()}
              username={"MysticPixie"}
              compact={compact()}
              tail={compact()}
              isLink="hide"
            >
              <code class={css({ fontFamily: `var(--fonts-monospace)` })}>
                The quick brown fox jumped over the lazy dog
              </code>
            </MessageContainer>
          </MessagePreview>
        </Preview>

        <Checkbox
          checked={state.settings.getValue("appearance:show_timestamps")}
          onChange={(event) =>
            state.settings.setValue(
              "appearance:show_timestamps",
              event.currentTarget.checked,
            )
          }
        >
          <Trans>Show message timestamps</Trans>
        </Checkbox>

        <Checkbox
          checked={state.settings.getValue("appearance:show_usernames")}
          onChange={(event) =>
            state.settings.setValue(
              "appearance:show_usernames",
              event.currentTarget.checked,
            )
          }
        >
          <Trans>Show usernames</Trans>
        </Checkbox>

        <Checkbox
          checked={compact()}
          onChange={(event) =>
            state.settings.setValue(
              "appearance:compact_mode",
              event.currentTarget.checked,
            )
          }
        >
          <Trans>Compact mode</Trans>
        </Checkbox>

        <Text class="label">
          <Trans>Message Size</Trans>
        </Text>
        <Slider
          min={12}
          max={24}
          value={state.theme.messageSize}
          onInput={(event) =>
            (state.theme.messageSize = event.currentTarget.value)
          }
        />

        <Text class="label">
          <Trans>Avatar Size</Trans>
        </Text>
        <Slider
          min={24}
          max={48}
          step={2}
          value={state.theme.messageAvatarSize}
          onInput={(event) =>
            (state.theme.messageAvatarSize = event.currentTarget.value)
          }
          labelFormatter={(value) => `${value}px`}
        />

        <Text class="label">
          <Trans>Message Group Spacing</Trans>
        </Text>
        <Slider
          min={0}
          max={16}
          value={state.theme.messageGroupSpacing}
          onInput={(event) =>
            (state.theme.messageGroupSpacing = event.currentTarget.value)
          }
        />
      </Column>

      <Column>
        <Text class="title" size="small">
          <Trans>Fonts</Trans>
        </Text>

        <FloatingSelect
          label={t`Interface Font`}
          value={state.theme.interfaceFont}
          onChange={(e) =>
            state.theme.setInterfaceFont(e.currentTarget.value as Fonts)
          }
        >
          <For each={FONT_KEYS}>
            {(key) => <MenuItem value={key}>{key}</MenuItem>}
          </For>
        </FloatingSelect>

        <FloatingSelect
          label={t`Monospace Font`}
          value={state.theme.monospaceFont}
          onChange={(e) =>
            state.theme.setMonospaceFont(
              e.currentTarget.value as MonospaceFonts,
            )
          }
        >
          <For each={MONOSPACE_FONT_KEYS}>
            {(key) => <MenuItem value={key}>{key}</MenuItem>}
          </For>
        </FloatingSelect>
      </Column>

      <Column>
        <Text class="title" size="small">
          <Trans>Layout</Trans>
        </Text>

        {/* Hidden, not disabled, at phone widths: the slide drawer owns the
            layout there and no reason string would help a phone user. */}
        <Show when={device.layout() !== "phone"}>
          <LayoutArrangement />
        </Show>

        <Text class="label">
          <Trans>Message width</Trans>
        </Text>
        <Row justify="stretch">
          <For each={CONTENT_WIDTH_OPTIONS}>
            {(option, index) => (
              <Button
                size="xs"
                group={
                  index() === 0
                    ? "connected-start"
                    : index() === CONTENT_WIDTH_OPTIONS.length - 1
                      ? "connected-end"
                      : "connected"
                }
                groupActive={contentWidth() === option.value}
                onPress={() =>
                  state.settings.setValue(
                    "appearance:content_width",
                    option.value,
                  )
                }
              >
                {option.label()}
              </Button>
            )}
          </For>
        </Row>

        <Show when={contentWidth() !== "full"}>
          <Text class="label">
            <Trans>Message alignment</Trans>
          </Text>
          <Row justify="stretch">
            <Button
              size="xs"
              group="connected-start"
              groupActive={contentAlign() === "start"}
              onPress={() =>
                state.settings.setValue("appearance:content_align", "start")
              }
            >
              <Trans>Hug the channel list</Trans>
            </Button>
            <Button
              size="xs"
              group="connected-end"
              groupActive={contentAlign() === "center"}
              onPress={() =>
                state.settings.setValue("appearance:content_align", "center")
              }
            >
              <Trans>Centered</Trans>
            </Button>
          </Row>
        </Show>

        <Checkbox
          checked={
            state.settings.getValue("appearance:ultrawide_layout") === true
          }
          disabled={!device.ultrawideDisplay()}
          onChange={(event) => {
            const enabled = event.currentTarget.checked;
            state.settings.setValue("appearance:ultrawide_layout", enabled);

            // The rearrangement needs a capped message column to have a gutter
            // to move the member list into; with no cap there is nowhere to put
            // it and the switch would appear to do nothing. Give it one, once,
            // and visibly — the row above updates. Any width the user has
            // already chosen is left alone.
            if (enabled && contentWidth() === "full") {
              state.settings.setValue("appearance:content_width", "wide");
            }
          }}
        >
          <Trans>Ultrawide layout</Trans>
        </Checkbox>
        <Text class="label">
          <Show
            when={device.ultrawideDisplay()}
            fallback={
              <Trans>
                Requires a 21:9 or wider display. This display is{" "}
                {displayDimensions()}.
              </Trans>
            }
          >
            <Trans>
              Moves the member list out of the channel column and into the space
              beside your messages. The area past it is left empty on purpose.
            </Trans>
          </Show>
        </Text>
      </Column>

      <Column>
        <Text class="title" size="small">
          <Trans>Chat Input</Trans>
        </Text>

        <Checkbox
          checked={state.settings.getValue("appearance:show_send_button")}
          onChange={(event) =>
            state.settings.setValue(
              "appearance:show_send_button",
              event.currentTarget.checked,
            )
          }
        >
          <Trans>Show send message button</Trans>
        </Checkbox>

        <Checkbox
          checked={state.settings.getValue("appearance:expand_emoticons")}
          onChange={(event) =>
            state.settings.setValue(
              "appearance:expand_emoticons",
              event.currentTarget.checked,
            )
          }
        >
          <Trans>Turn emoticons like :D into emoji</Trans>
        </Checkbox>

        <FloatingSelect
          label={t`Emoji Pack (affects your messages only)`}
          value={state.settings.getValue("appearance:unicode_emoji")}
          onChange={(e) =>
            state.settings.setValue(
              "appearance:unicode_emoji",
              e.currentTarget.value as never,
            )
          }
        >
          <For each={UNICODE_EMOJI_PACKS}>
            {(pack) => <EmojiPack pack={pack} />}
          </For>
        </FloatingSelect>
      </Column>
    </Column>
  );
}

/**
 * Render an individual emoji pack
 * @param pack Pack
 */
function EmojiPack(props: { pack: UnicodeEmojiPacks }) {
  return (
    <MenuItem value={props.pack}>
      <Row>
        <UnicodeEmoji emoji="😃" pack={props.pack} />
        <UnicodeEmoji emoji="😂" pack={props.pack} />
        <UnicodeEmoji emoji="😶‍🌫️" pack={props.pack} />
        <UnicodeEmoji emoji="🤨" pack={props.pack} />
        <UnicodeEmoji emoji="🤔" pack={props.pack} />
        <Switch>
          <Match when={props.pack === "fluent-3d"}>Fluent 3D</Match>
          <Match when={props.pack === "fluent-color"}>Fluent Color</Match>
          <Match when={props.pack === "fluent-flat"}>Fluent Flat</Match>
          <Match when={props.pack === "mutant"}>Mutant Remix</Match>
          <Match when={props.pack === "noto"}>Noto</Match>
          {/* <Match when={props.pack === "openmoji"}>OpenMoji</Match> */}
          <Match when={props.pack === "twemoji"}>Twemoji</Match>
        </Switch>
      </Row>
    </MenuItem>
  );
}

const Preview = styled("div", {
  base: {
    // Grows with the avatar and message-size sliders instead of clipping the
    // second sample message at their upper end.
    minHeight: "126px",
    overflow: "hidden",
    borderRadius: "var(--borderRadius-lg)",
    background: "var(--md-sys-color-surface-container-highest)",
  },
});

const MessagePreview = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    padding: "var(--gap-md)",
    gap: "var(--message-group-spacing)",
  },
});
