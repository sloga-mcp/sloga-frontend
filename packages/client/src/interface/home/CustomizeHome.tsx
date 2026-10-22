import { For, Show } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { useState } from "@revolt/state";
import {
  type HomeBlockId,
  customizableBlocks,
} from "@revolt/state/stores/homeLayoutRules";
import { Button, Checkbox } from "@revolt/ui";

import type { HomeBlockDef } from "./HomeGrid";

const Panel = styled("section", {
  base: {
    width: "100%",
    maxWidth: "1180px",
    marginInline: "auto",
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    padding: "16px",
    borderRadius: "16px",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface)",

    "@media (max-width: 1180px)": {
      maxWidth: "780px",
    },
  },
});

const Title = styled("h2", {
  base: {
    margin: 0,
    fontSize: "16px",
    fontWeight: 700,
  },
});

const Hint = styled("p", {
  base: {
    margin: 0,
    fontSize: "13px",
    lineHeight: 1.45,
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const Options = styled("div", {
  base: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
    gap: "2px 12px",
  },
});

const Option = styled("div", {
  base: {
    minHeight: "40px",
    display: "flex",
    alignItems: "center",
    gap: "4px",
    fontSize: "14px",
  },
});

const Note = styled("span", {
  base: {
    fontSize: "12px",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const Actions = styled("div", {
  base: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: "8px",
  },
});

/**
 * "Customize Home": switch cards on and off, put everything back, and a
 * reminder of how to move them. Moving happens on the cards themselves.
 */
export function CustomizeHome(props: {
  blocks: Record<HomeBlockId, HomeBlockDef>;
  onDone: () => void;
}) {
  const state = useState();

  return (
    <Panel aria-labelledby="home-customize-title">
      <Title id="home-customize-title">
        <Trans>Customize Home</Trans>
      </Title>
      <Hint>
        <Trans>
          Drag a card by its grip to move it (on a phone, press and hold the
          card), or use its menu. Cards you switch off here stay off until you
          switch them back on. Your layout follows your account to your other
          devices.
        </Trans>
      </Hint>
      <Options>
        <For
          each={customizableBlocks(
            (id) => props.blocks[id].offered?.() ?? true,
          )}
        >
          {(id) => (
            <Option>
              <Checkbox
                checked={!state.homeLayout.isHidden(id)}
                onChange={(event) =>
                  state.homeLayout.setHidden(id, !event.currentTarget.checked)
                }
              >
                {props.blocks[id].title()}
              </Checkbox>
              <Show
                when={
                  !state.homeLayout.isHidden(id) &&
                  !props.blocks[id].available()
                }
              >
                <Note>
                  <Trans>(nothing to show right now)</Trans>
                </Note>
              </Show>
            </Option>
          )}
        </For>
      </Options>
      <Actions>
        <Button variant="text" onPress={() => state.homeLayout.reset()}>
          <Trans>Reset layout</Trans>
        </Button>
        <Button variant="filled" onPress={() => props.onDone()}>
          <Trans>Done</Trans>
        </Button>
      </Actions>
    </Panel>
  );
}
