import { Accessor, createMemo } from "solid-js";

import type {
  Completion,
  CompletionContext,
  CompletionResult,
} from "@codemirror/autocomplete";
import { User } from "stoat.js";

import { useClient } from "@revolt/client";
import {
  UNICODE_EMOJI_PACK_PUA,
  unicodeEmojiUrl,
} from "@revolt/markdown/emoji/UnicodeEmoji";
import { useState } from "@revolt/state";

import emojiMapping from "../../../emojiMapping.json";
import { AutoCompleteSearchSpace } from "../../utils/autoComplete";

import { isInCodeBlock } from "./codeMirrorCommon";

const EMOJI_KEYS = Object.keys(emojiMapping).sort();
const MAPPED_EMOJI_KEYS = EMOJI_KEYS.map(
  (id) =>
    ({
      type: "emoji",
      label: `:${id}:`,
      apply: emojiMapping[id as keyof typeof emojiMapping],
    }) as Completion,
);

const RE_match = /(?<!\w)[:@%#]\w*/;
const RE_emojiValidFor = /(?<!\w):\w*/;
const RE_mentionValidFor = /(?<!\w)@\w*/;
const RE_roleValidFor = /(?<!\w)@\w*/;
const RE_channelValidFor = /(?<!\w)#\w*/;
// Slash commands: only ever matched at the very start of the draft (a
// command must lead the message), so URLs containing "/" never trigger it.
const RE_slashMatch = /\/[\w-]*/;
const RE_slashValidFor = /^\/[\w-]*$/;

export function codeMirrorAutoCompleteSource(
  searchSpace: Accessor<AutoCompleteSearchSpace>,
) {
  const state = useState();
  const client = useClient();

  const emoji = createMemo(() => {
    return ([] as Completion[]).concat(
      MAPPED_EMOJI_KEYS.map((emoji) => ({
        ...emoji,
        apply: `${UNICODE_EMOJI_PACK_PUA[state.settings.getValue("appearance:unicode_emoji")!] ?? ""}${emoji.apply as string}`,
        url: unicodeEmojiUrl(
          state.settings.getValue("appearance:unicode_emoji"),
          emoji.apply as string,
        ),
      })),
      client().emojis.map((emoji) => ({
        type: "emoji",
        label: `:${emoji.name}:`,
        apply: `:${emoji.id}: `,
        url: emoji.url,
      })),
    );
  });

  const users = createMemo(() =>
    (
      searchSpace()?.members ??
      searchSpace()?.users ??
      client().users.toList()
    ).map((entry) => {
      // avoiding using `instanceof`, presumed slow
      const user = ((entry as { user: User })?.user ?? entry) as User;

      return {
        type: "user",
        label: ("@" + entry.displayName).normalize("NFKC"),
        displayLabel: entry.displayName,
        detail:
          entry.displayName !== user.username
            ? `${user.username}#${user.discriminator}`
            : undefined,
        apply: `<@${typeof entry.id === "string" ? entry.id : entry.id.user}> `,
        url: entry.animatedAvatarURL,
      };
    }),
  );

  const roles = createMemo(() => {
    return (
      searchSpace()?.roles?.map(
        (entry) =>
          ({
            type: "role",
            label: ("%" + entry.name).normalize("NFKC"),
            displayLabel: entry.name,
            apply: `<%${entry.id}> `,
            colour: entry.colour,
          }) as Completion,
      ) ?? []
    );
  });

  const channels = createMemo(() =>
    (searchSpace()?.channels ?? client().channels.toList()).map(
      (entry) =>
        ({
          type: "channel",
          label: ("#" + entry.name).normalize("NFKC"),
          displayLabel: "#" + entry.name,
          apply: `<#${entry.id}> `,
        }) as Completion,
    ),
  );

  const commands = createMemo(() =>
    (searchSpace()?.commands ?? []).map((command) => {
      const bot = client().users.get(command.bot_id);
      return {
        type: "command",
        label: "/" + command.name,
        displayLabel: "/" + command.name,
        detail: bot
          ? `${command.description} — ${bot.username}`
          : command.description,
        // Insert the command; the user follows with option values, and send
        // routes it through the interaction endpoint.
        apply: `/${command.name} `,
        url: bot?.animatedAvatarURL,
      } as Completion;
    }),
  );

  // eslint-disable-next-line solid/reactivity
  return (context: CompletionContext) => {
    if (isInCodeBlock(context.state, context.pos, context.pos)) {
      return null;
    }

    // '/' command picker — strictly anchored to the start of the draft.
    const slashToken = context.matchBefore(RE_slashMatch);
    if (slashToken && slashToken.from === 0 && commands().length) {
      return {
        from: 0,
        options: commands(),
        validFor: RE_slashValidFor,
      } as CompletionResult;
    }

    const token = context.matchBefore(RE_match);
    if (!token) return null;
    const normalizedText = token.text.normalize("NFKC");
    switch (normalizedText[0]) {
      case ":":
        return {
          from: token.from,
          options: emoji(),
          validFor: RE_emojiValidFor,
        } as CompletionResult;
      case "@":
        return {
          from: token.from,
          options: users(),
          validFor: RE_mentionValidFor,
        } as CompletionResult;
      case "%":
        return {
          from: token.from,
          options: roles(),
          validFor: RE_roleValidFor,
        } as CompletionResult;
      case "#":
        return {
          from: token.from,
          options: channels(),
          validFor: RE_channelValidFor,
        } as CompletionResult;
      default:
        return null;
    }
  };
}
