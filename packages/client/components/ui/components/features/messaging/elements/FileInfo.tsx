import {
  BiRegularHeadphone,
  BiSolidFile,
  BiSolidFileTxt,
  BiSolidImage,
  BiSolidVideo,
} from "solid-icons/bi";
import { Match, Show, Switch } from "solid-js";

import { File, MessageEmbed } from "stoat.js";
import { styled } from "styled-system/jsx";

import { IconButton, Text } from "@revolt/ui/components/design";
import { Column, Row } from "@revolt/ui/components/layout";
import { humanFileSize } from "@revolt/ui/components/utils";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

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
 * Download affordance
 *
 * Brand orange on the purple card so it reads as the one thing to click,
 * rather than a grey glyph in the corner.
 */
const DownloadLink = styled("a", {
  base: {
    display: "flex",
    alignSelf: "center",

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
        <Match when={props.file?.metadata.type === "Audio"}>
          <BiRegularHeadphone size={24} />
        </Match>
        <Match when={props.file?.metadata.type === "Text"}>
          <BiSolidFileTxt size={24} />
        </Match>
      </Switch>
      <Column grow>
        <span>{props.file?.filename}</span>
        <Show when={props.file?.size}>
          <Text class="label" size="small">
            {humanFileSize(props.file!.size!)}
          </Text>
        </Show>
      </Column>
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
    </Base>
  );
}
