import { For, Show, createSignal, createUniqueId, onMount } from "solid-js";

import { useLingui } from "@lingui-solid/solid/macro";

import { styled } from "styled-system/jsx";

import { IconButton } from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { type GameLookupResult, pickerIndexAfterKey } from "./gameLookup";

interface Props {
  /**
   * Results to choose from (1 to 5)
   */
  results: GameLookupResult[];

  /**
   * A result was chosen; the composer sends its URL
   */
  onPick: (result: GameLookupResult) => void;

  /**
   * The picker was dismissed; the draft stays as typed
   */
  onCancel: () => void;
}

/**
 * Result list for the composer's game lookup commands, shown directly above
 * the message box. Takes focus when it opens: up and down move, Enter picks,
 * Escape cancels; a click or tap picks too.
 */
export function GameLookupPicker(props: Props) {
  const { t } = useLingui();
  const [active, setActive] = createSignal(0);
  const id = createUniqueId();

  let list: HTMLDivElement | undefined;
  onMount(() => list?.focus());

  /**
   * Keyboard navigation. Handled keys stop here so the editor's and the
   * app's keybinds (Escape, arrow keys) do not also act on them.
   */
  function onKeyDown(event: KeyboardEvent) {
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
        setActive((index) =>
          pickerIndexAfterKey(index, event.key, props.results.length),
        );
        break;
      case "Enter": {
        const result = props.results[active()];
        if (result) props.onPick(result);
        break;
      }
      case "Escape":
        props.onCancel();
        break;
      default:
        return;
    }

    event.preventDefault();
    event.stopPropagation();
  }

  return (
    <Panel>
      <Header>
        <span id={`${id}-label`}>{t`Pick a result to send`}</span>
        <IconButton
          size="sm"
          aria-label={t`Cancel`}
          onPress={() => props.onCancel()}
        >
          <Symbol>close</Symbol>
        </IconButton>
      </Header>
      <List
        ref={list}
        role="listbox"
        tabIndex={0}
        aria-labelledby={`${id}-label`}
        aria-activedescendant={`${id}-${active()}`}
        onKeyDown={onKeyDown}
      >
        <For each={props.results}>
          {(result, index) => (
            <Option
              id={`${id}-${index()}`}
              role="option"
              aria-selected={active() === index()}
              data-active={active() === index()}
              onMouseEnter={() => setActive(index())}
              onClick={() => props.onPick(result)}
            >
              <Title>{result.title}</Title>
              <Show when={result.subtitle}>
                <Subtitle>{result.subtitle}</Subtitle>
              </Show>
            </Option>
          )}
        </For>
      </List>
      <Hint>{t`Enter to send, Esc to cancel`}</Hint>
    </Panel>
  );
}

const Panel = styled("div", {
  base: {
    margin: "0 12px 8px",
    padding: "8px 0",
    borderRadius: "12px",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface)",
    border: "1px solid var(--md-sys-color-outline-variant)",
    boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
  },
});

const Header = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 8px 4px 16px",
    fontSize: "0.75em",
    fontWeight: "600",
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    "& > span": {
      opacity: "0.6",
    },
  },
});

const List = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    outline: "none",
  },
});

const Option = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    padding: "8px 16px",
    cursor: "pointer",
    "&[data-active='true']": {
      background: "var(--md-sys-color-primary-container)",
      color: "var(--md-sys-color-on-primary-container)",
    },
  },
});

const Title = styled("span", {
  base: {
    fontSize: "0.9em",
    fontWeight: "600",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});

const Subtitle = styled("span", {
  base: {
    fontSize: "0.75em",
    opacity: "0.7",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});

const Hint = styled("div", {
  base: {
    padding: "6px 16px 0",
    fontSize: "0.7em",
    opacity: "0.5",
  },
});
