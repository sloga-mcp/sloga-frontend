import { Accessor, createMemo } from "solid-js";

import type {
  Completion,
  CompletionContext,
  CompletionResult,
} from "@codemirror/autocomplete";
import { User } from "stoat.js";
import type { ApplicationCommandData, CommandOptionData } from "stoat.js";

import { useClient } from "@revolt/client";
import {
  UNICODE_EMOJI_PACK_PUA,
  unicodeEmojiUrl,
} from "@revolt/markdown/emoji/UnicodeEmoji";
import { useState } from "@revolt/state";

import emojiMapping from "../../../emojiMapping.json";
import { AutoCompleteSearchSpace } from "../../utils/autoComplete";

import { isInCodeBlock } from "./codeMirrorCommon";
import {
  RE_emojiValidFor,
  emojiSuggestionsOpenFor,
} from "./emojiSuggestionGate";

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
const RE_mentionValidFor = /(?<!\w)@\w*/;
const RE_roleValidFor = /(?<!\w)@\w*/;
const RE_channelValidFor = /(?<!\w)#\w*/;
// Slash commands: only ever matched at the very start of the draft (a
// command must lead the message), so URLs containing "/" never trigger it.
const RE_slashMatch = /\/[\w-]*/;
const RE_slashValidFor = /^\/[\w-]*$/;

// `/name ` followed by whatever the user has typed for its options.
const RE_commandHead = /^\/([a-z0-9_-]+)\s+/i;
// The `option:value` the caret currently sits in, quoted or bare.
const RE_focusedOption = /(?:^|\s)([\w-]+):("[^"]*|[^\s"]*)$/;
// Same grammar the composer uses to turn a draft into option values.
const RE_optionToken = /([\w-]+):(?:"([^"]*)"|(\S*))/g;

/**
 * How long to sit on a keystroke before asking a bot for suggestions.
 *
 * CodeMirror aborts a query as soon as the next one supersedes it, so
 * waiting here means only the last keystroke of a burst reaches the network.
 * Without it a fast typist would spend the autocomplete ratelimit (40 per
 * 10s) in about four seconds and get nothing back for the rest.
 */
const AUTOCOMPLETE_DEBOUNCE_MS = 250;

/**
 * Work out which command option the caret is inside, if any.
 *
 * Returns the option, the document offset its value starts at, and the
 * values of every other option typed so far — the bot is told what has been
 * filled in already so it can narrow its suggestions.
 */
function focusedCommandOption(
  text: string,
  commands: ApplicationCommandData[],
) {
  const head = RE_commandHead.exec(text);
  if (!head) return null;

  const command = commands.find(
    (entry) => entry.name === head[1].toLowerCase(),
  );
  if (!command?.options?.length) return null;

  const args = text.slice(head[0].length);

  let option: CommandOptionData | undefined;
  let from: number;

  const focused = RE_focusedOption.exec(text);
  if (focused) {
    option = command.options.find((entry) => entry.name === focused[1]);
    // Point AT any opening quote rather than past it: an applied suggestion
    // brings its own quoting, so leaving the original in place would produce
    // `track:""Blue Monday"`.
    from = text.length - focused[2].length;
  } else if (command.options.length === 1 && !args.includes(":")) {
    // The composer's convenience form: with a single option, a bare
    // argument is that option's value.
    option = command.options[0];
    from = head[0].length;
  } else {
    return null;
  }

  if (!option?.autocomplete) return null;

  // Everything else already typed, by the composer's own grammar.
  const options: Record<string, string> = {};
  RE_optionToken.lastIndex = 0;
  let token: RegExpExecArray | null;
  while ((token = RE_optionToken.exec(args))) {
    options[token[1]] = token[2] ?? token[3] ?? "";
  }
  // The bot is told what the user MEANS, not how they quoted it.
  options[option.name] = text.slice(from).replace(/^"/, "");

  return { command, option, from, options };
}

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

  // The raw command list, shared by the '/' picker below and the option
  // autocomplete branch (which needs the typed option schema, not labels).
  const commandData = createMemo(() => searchSpace()?.commands ?? []);

  const commands = createMemo(() =>
    commandData().map((command) => {
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

    // Option autocomplete — only past the command name, and only for
    // options whose bot asked to be consulted. Unlike every other branch
    // this one is asynchronous: the answers come from the bot.
    const request = searchSpace()?.requestCommandAutocomplete;
    if (request) {
      const textBefore = context.state.sliceDoc(0, context.pos);
      const focused = focusedCommandOption(textBefore, commandData());
      if (focused) {
        return (async () => {
          // Sit out the burst. CodeMirror aborts this query the moment the
          // next keystroke starts one, so only the final one hits the API.
          await new Promise((resolve) =>
            setTimeout(resolve, AUTOCOMPLETE_DEBOUNCE_MS),
          );
          if (context.aborted) return null;

          const choices = await request(
            focused.command._id,
            focused.option.name,
            focused.options,
          );
          if (context.aborted || !choices.length) return null;

          return {
            from: focused.from,
            to: context.pos,
            options: choices.map(
              (choice) =>
                ({
                  type: "command-option",
                  label: choice.name,
                  displayLabel: choice.name,
                  detail:
                    choice.name === choice.value ? undefined : choice.value,
                  // Quote anything with a space, or the composer's
                  // `name:value` grammar would read only the first word.
                  apply: /\s/.test(choice.value)
                    ? `"${choice.value}" `
                    : `${choice.value} `,
                }) as Completion,
            ),
            // Deliberately no validFor: these answers were computed by the
            // bot for this exact prefix, so they must not be re-filtered
            // locally against anything typed afterwards.
          } as CompletionResult;
        })();
      }
    }

    const token = context.matchBefore(RE_match);
    if (!token) return null;
    const normalizedText = token.text.normalize("NFKC");
    switch (normalizedText[0]) {
      case ":":
        if (!context.explicit && !emojiSuggestionsOpenFor(normalizedText)) {
          return null;
        }
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
