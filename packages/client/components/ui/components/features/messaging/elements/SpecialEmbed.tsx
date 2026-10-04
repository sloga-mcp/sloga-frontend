import { Show, createSignal } from "solid-js";

import { useLingui } from "@lingui-solid/solid/macro";
import type { WebsiteEmbed } from "stoat.js";
import { styled } from "styled-system/jsx";

import { CONFIGURATION } from "@revolt/common";
import { SizedContent } from "@revolt/ui/components/utils";

/**
 * Display names for the click-to-load label (brand names, not translated)
 */
const PROVIDER_NAMES: Record<string, string> = {
  YouTube: "YouTube",
  Twitch: "Twitch",
  Lightspeed: "Lightspeed",
  Spotify: "Spotify",
  Soundcloud: "SoundCloud",
  Bandcamp: "Bandcamp",
};

/**
 * Special Embed
 */
export function SpecialEmbed(props: { embed: WebsiteEmbed }) {
  const { t } = useLingui();

  // With EMBEDS_CLICK_TO_LOAD on (the foss build), the third-party frame is
  // not mounted until the user taps the placeholder, so rendering a message
  // contacts no provider. Unset, this starts true and the frame mounts at once.
  const [loaded, setLoaded] = createSignal(!CONFIGURATION.EMBEDS_CLICK_TO_LOAD);

  /**
   * Determine the media size
   */
  function getSize() {
    const special = props.embed.specialContent!;

    let width = 0,
      height = 0;
    switch (special.type) {
      case "YouTube": {
        width = props.embed.video?.width ?? 1280;
        height = props.embed.video?.height ?? 720;
        break;
      }
      case "Twitch": {
        width = 1280;
        height = 720;
        break;
      }
      case "Lightspeed": {
        width = 1280;
        height = 720;
        break;
      }
      case "Spotify": {
        width = 420;
        height = 355;
        break;
      }
      case "Soundcloud": {
        width = 480;
        height = 460;
        break;
      }
      case "Bandcamp": {
        width = props.embed.video?.width ?? 1280;
        height = props.embed.video?.height ?? 720;
        break;
      }
    }

    return { width, height };
  }

  /**
   * Label for the click-to-load placeholder
   */
  function loadLabel() {
    const type = props.embed.specialContent!.type;
    const provider = PROVIDER_NAMES[type] ?? type;
    return t`Load ${provider}`;
  }

  return (
    <SizedContent width={getSize()?.width} height={getSize()?.height}>
      <Show
        when={loaded()}
        fallback={
          <LoadButton type="button" onClick={() => setLoaded(true)}>
            {loadLabel()}
          </LoadButton>
        }
      >
        <iframe
          loading="lazy"
          scrolling="no"
          allowfullscreen
          allowtransparency
          frameborder={0}
          // style={{ width: getSize()?.width + "px" }}
          src={props.embed.embedURL}
        />
      </Show>
    </SizedContent>
  );
}

/**
 * Click-to-load placeholder; fills the sized box and loads nothing remote
 */
const LoadButton = styled("button", {
  base: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "var(--gap-md)",

    cursor: "pointer",
    border: "none",
    color: "var(--md-sys-color-on-surface)",
    background: "var(--md-sys-color-surface-container-high)",
    transition: "var(--transitions-fast) background",

    "&:hover": {
      background: "var(--md-sys-color-surface-container-highest)",
    },
  },
});
