import {
  BiRegularHeadphone,
  BiSolidFile,
  BiSolidFileTxt,
  BiSolidImage,
  BiSolidVideo,
} from "solid-icons/bi";
import { Match, Show, Switch } from "solid-js";

import { AudioEmbed, File, MessageEmbed } from "stoat.js";
import { styled } from "styled-system/jsx";

import { IconButton, Text } from "@revolt/ui/components/design";
import { Column, Row } from "@revolt/ui/components/layout";
import { humanFileSize } from "@revolt/ui/components/utils";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { audioEmbedFilename } from "./audioEmbed";

/**
 * Base container
 */
const Base = styled(Row, {
  base: {
    // keep the filename from crowding the download button once the card is
    // only as wide as its contents
    paddingInlineEnd: "var(--gap-sm)",
  },
});

/**
 * Filename column
 *
 * `minWidth: 0` is load-bearing: a flex item defaults to `min-width: auto`,
 * which refuses to shrink below its content, so a long filename widened this
 * column until the download button was pushed off the card entirely.
 */
const Details = styled(Column, {
  base: {
    minWidth: 0,
  },
});

/**
 * The filename itself
 *
 * `anywhere` rather than `break-word`: browsers already break after hyphens,
 * which is why `screen-2026-09-19.mp4` wrapped and looked fine while
 * `Screencast_20260920_121354.webm` did not — nothing breaks at an
 * underscore, so the unbroken run pushed the button out.
 *
 * `unicodeBidi: "isolate"` (with `dir="auto"` on the element): an audio link's
 * name comes from a URL anyone can type, and a right-to-left override inside
 * it would otherwise reorder the text around it. Isolating keeps any bidi
 * control inside the name. `dir="auto"` also flips `start` alignment for a
 * right-to-left name, so `match-parent` keeps it aligned with the size below.
 */
const Filename = styled("span", {
  base: {
    overflowWrap: "anywhere",
    unicodeBidi: "isolate",
    textAlign: "match-parent",
  },
});

/**
 * Download affordance
 *
 * Brand orange on the purple card so it reads as the one thing to click,
 * rather than a grey glyph in the corner.
 */
const DownloadLink = styled("a", {
  base: {
    display: "flex",
    alignSelf: "center",
    // never give up space to the filename; it is the only control here
    flexShrink: 0,

    "& button": {
      background: "#FF8A00",
      "--colour": "#2E1A5E",
    },

    "&:hover button": {
      background: "#FFA333",
    },
  },
});

interface Props {
  /**
   * File information
   */
  file?: File;

  /**
   * Embed information
   */
  embed?: MessageEmbed;
}

/**
 * Information about a given attachment or embed
 */
export function FileInfo(props: Props) {
  /**
   * The embed, if it is a pasted audio link
   */
  const audio = () =>
    props.embed?.type === "Audio" ? (props.embed as AudioEmbed) : undefined;

  /**
   * Name to show: an upload keeps its own filename, an audio link gets one
   * derived from the embed
   */
  const name = () => {
    const embed = audio();
    return props.file || !embed
      ? props.file?.filename
      : audioEmbedFilename(embed);
  };

  /**
   * Size in bytes, when known (january omits it for an audio link whose host
   * sends no length)
   */
  const size = () => (props.file ? props.file.size : audio()?.size);

  return (
    <Base align>
      <Switch fallback={<BiSolidFile size={24} />}>
        <Match
          when={
            props.file?.metadata.type === "Image" ||
            props.embed?.type === "Image"
          }
        >
          <BiSolidImage size={24} />
        </Match>
        <Match
          when={
            props.file?.metadata.type === "Video" ||
            props.embed?.type === "Video"
          }
        >
          <BiSolidVideo size={24} />
        </Match>
        <Match
          when={
            props.file?.metadata.type === "Audio" ||
            props.embed?.type === "Audio"
          }
        >
          <BiRegularHeadphone size={24} />
        </Match>
        <Match when={props.file?.metadata.type === "Text"}>
          <BiSolidFileTxt size={24} />
        </Match>
      </Switch>
      <Details grow>
        <Filename dir="auto">{name()}</Filename>
        <Show when={size()}>
          <Text class="label" size="small">
            {humanFileSize(size()!)}
          </Text>
        </Show>
      </Details>
      <Show when={props.file}>
        <DownloadLink
          target="_blank"
          href={props.file?.originalUrl}
          download={props.file?.filename}
        >
          <IconButton>
            <Symbol>download</Symbol>
          </IconButton>
        </DownloadLink>
      </Show>
      {/*
       * An audio link opens the original in a new tab rather than downloading:
       * the file lives on a third-party host, where `download` is ignored
       * cross-origin anyway, and `noopener noreferrer` keeps that host from
       * getting a handle on this window or learning which page linked it.
       */}
      <Show when={audio()}>
        {(embed) => (
          <DownloadLink
            target="_blank"
            rel="noopener noreferrer"
            href={embed().url}
          >
            <IconButton>
              <Symbol>open_in_new</Symbol>
            </IconButton>
          </DownloadLink>
        )}
      </Show>
    </Base>
  );
}
