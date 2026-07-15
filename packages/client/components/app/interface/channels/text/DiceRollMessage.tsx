import { For, Match, Show, Switch, createMemo } from "solid-js";

import { styled } from "styled-system/jsx";

import { Markdown } from "@revolt/markdown";
import { FLAG_DICE_ROLL, isDiceRollMessage } from "@revolt/rtc/diceRoll";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

// Re-exported for existing importers (Message.tsx). The flag + predicate now
// live in @revolt/rtc/diceRoll so the in-call overlay can share them without a
// circular import.
export { FLAG_DICE_ROLL, isDiceRollMessage };

/**
 * Server roll content format (stable, produced by delta's dice engine):
 * 🎲 `2d6+3` → [4, 5] + 3 = **12**
 * 🎲 `4d6kh3` → [6, 5, 4, ~~2~~] = **15**
 * 🎲 `1d20+5` → [20] + 5 = **25** — Natural 20! 🎉
 */
const RE_DICE_CONTENT = /^🎲 `([^`]+)` → (.+) = \*\*(-?\d+)\*\*(?: — (.+))?$/;

interface Die {
  value: string;
  kept: boolean;
}

type Token =
  | { type: "dice"; sign?: string; dice: Die[] }
  | { type: "modifier"; text: string };

interface ParsedRoll {
  notation: string;
  tokens: Token[];
  total: string;
  natural?: "crit" | "fumble";
  suffix?: string;
}

/**
 * Parse the server's formatted roll content into a structured outcome.
 * Returns undefined if the content doesn't match (renders as markdown).
 */
function parseDiceContent(content: string): ParsedRoll | undefined {
  const match = RE_DICE_CONTENT.exec(content);
  if (!match) return undefined;

  const [, notation, body, total, suffix] = match;
  const tokens: Token[] = [];

  // Body tokens: dice groups `[4, 5]` / `- [4, 5]`, modifiers `+ 3` / `-3`
  const re = /([+-])?\s*(\[[^\]]*\]|-?\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const [, sign, tok] = m;
    if (tok.startsWith("[")) {
      const dice = tok
        .slice(1, -1)
        .split(", ")
        .filter((s) => s.length)
        .map((s) =>
          s.startsWith("~~")
            ? { value: s.slice(2, -2), kept: false }
            : { value: s, kept: true },
        );
      tokens.push({ type: "dice", sign, dice });
    } else {
      const text = sign ? `${sign} ${tok}` : tok;
      tokens.push({ type: "modifier", text });
    }
  }

  if (!tokens.some((t) => t.type === "dice")) return undefined;

  const natural = suffix?.includes("20")
    ? ("crit" as const)
    : suffix
      ? ("fumble" as const)
      : undefined;

  return { notation, tokens, total, natural, suffix };
}

interface Props {
  /**
   * Formatted roll content from the server
   */
  content: string;
}

/**
 * Rich card for server-authoritative dice roll messages
 */
export function DiceRollMessage(props: Props) {
  const parsed = createMemo(() => parseDiceContent(props.content));

  return (
    <Show when={parsed()} fallback={<Markdown content={props.content} />}>
      <Card data-natural={parsed()!.natural}>
        <Header>
          <Symbol size={18}>casino</Symbol>
          <Notation>{parsed()!.notation}</Notation>
        </Header>
        <Body>
          <For each={parsed()!.tokens}>
            {(token) => (
              <Switch>
                <Match when={token.type === "dice"}>
                  <Show
                    when={(token as Extract<Token, { type: "dice" }>).sign}
                  >
                    <Operator>
                      {(token as Extract<Token, { type: "dice" }>).sign}
                    </Operator>
                  </Show>
                  <DiceGroup>
                    <For
                      each={(token as Extract<Token, { type: "dice" }>).dice}
                    >
                      {(die) => (
                        <DieChip data-dropped={!die.kept || undefined}>
                          {die.value}
                        </DieChip>
                      )}
                    </For>
                  </DiceGroup>
                </Match>
                <Match when={token.type === "modifier"}>
                  <Operator>
                    {(token as Extract<Token, { type: "modifier" }>).text}
                  </Operator>
                </Match>
              </Switch>
            )}
          </For>
          <Operator>=</Operator>
          <Total data-natural={parsed()!.natural}>{parsed()!.total}</Total>
        </Body>
        <Show when={parsed()!.suffix}>
          <NaturalBanner data-natural={parsed()!.natural}>
            {parsed()!.suffix}
          </NaturalBanner>
        </Show>
      </Card>
    </Show>
  );
}

const Card = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",
    padding: "10px 14px",
    marginTop: "2px",
    width: "fit-content",
    maxWidth: "100%",
    borderRadius: "12px",
    background: "var(--md-sys-color-surface-container-high)",
    border: "1px solid var(--md-sys-color-outline-variant)",
    "&[data-natural='crit']": {
      borderColor: "#3BA55D",
    },
    "&[data-natural='fumble']": {
      borderColor: "var(--md-sys-color-error)",
    },
  },
});

const Header = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    color: "var(--md-sys-color-primary)",
  },
});

const Notation = styled("code", {
  base: {
    fontSize: "0.8rem",
    fontWeight: "700",
    letterSpacing: "0.02em",
  },
});

const Body = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "6px",
  },
});

const DiceGroup = styled("div", {
  base: {
    display: "flex",
    flexWrap: "wrap",
    gap: "4px",
  },
});

const DieChip = styled("span", {
  base: {
    minWidth: "26px",
    padding: "2px 6px",
    textAlign: "center",
    borderRadius: "6px",
    fontWeight: "700",
    fontSize: "0.85rem",
    background: "var(--md-sys-color-primary-container)",
    color: "var(--md-sys-color-on-primary-container)",
    "&[data-dropped]": {
      opacity: "0.45",
      textDecoration: "line-through",
      background: "var(--md-sys-color-surface-container)",
      color: "inherit",
    },
  },
});

const Operator = styled("span", {
  base: {
    fontWeight: "600",
    opacity: "0.7",
    fontSize: "0.9rem",
  },
});

const Total = styled("span", {
  base: {
    fontSize: "1.15rem",
    fontWeight: "800",
    "&[data-natural='crit']": {
      color: "#3BA55D",
    },
    "&[data-natural='fumble']": {
      color: "var(--md-sys-color-error)",
    },
  },
});

const NaturalBanner = styled("div", {
  base: {
    fontSize: "0.75rem",
    fontWeight: "700",
    "&[data-natural='crit']": {
      color: "#3BA55D",
    },
    "&[data-natural='fumble']": {
      color: "var(--md-sys-color-error)",
    },
  },
});
