import { JSXElement, Show, createSignal } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { useState } from "@revolt/state";
import { Button, Text } from "@revolt/ui";

import MdLock from "@material-design-icons/svg/round/lock.svg?component-solid";

import { hashPassword } from "../../lib/channelPassword";
import { iconSize } from "@revolt/ui";

/**
 * Password gate for password-protected channels.
 * Wraps channel content and prompts for a password if one is set.
 */
export function PasswordGate(props: {
  passwordHash: string | null;
  channelId: string;
  channelName: string;
  children: JSXElement;
}) {
  const state = useState();
  const storageKey = () => `${props.channelId}-pw`;
  const unlocked = () =>
    state.layout.getSectionState(storageKey(), false);

  const [input, setInput] = createSignal("");
  const [error, setError] = createSignal(false);
  const [checking, setChecking] = createSignal(false);

  async function tryUnlock() {
    if (!input().trim()) return;
    setChecking(true);
    setError(false);
    const hash = await hashPassword(input().trim());
    if (hash === props.passwordHash) {
      state.layout.setSectionState(storageKey(), true);
    } else {
      setError(true);
    }
    setChecking(false);
    setInput("");
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") tryUnlock();
  }

  return (
    <Show when={props.passwordHash && !unlocked()} fallback={props.children}>
      <Base>
        <MdLock {...iconSize("5em")} style={{ fill: "#FF8A00" }} />
        <Text class="headline" size="large">
          {"#" + props.channelName}
        </Text>
        <Text class="body" size="large">
          <Trans>This channel is password protected.</Trans>
        </Text>
        <PasswordInput
          type="password"
          placeholder="Enter password"
          value={input()}
          onInput={(e) => setInput(e.currentTarget.value)}
          onKeyDown={onKeyDown}
          style={{
            padding: "10px 14px",
            "border-radius": "8px",
            border: error()
              ? "1.5px solid #E24B4A"
              : "1.5px solid var(--md-sys-color-outline)",
            background: "var(--md-sys-color-surface-container)",
            color: "var(--md-sys-color-on-surface)",
            "font-size": "1rem",
            width: "260px",
            outline: "none",
          }}
        />
        <Show when={error()}>
          <Text class="body" style={{ color: "#E24B4A" }}>
            <Trans>Incorrect password.</Trans>
          </Text>
        </Show>
        <Actions>
          <Button variant="text" onPress={() => history.back()}>
            <Trans>Back</Trans>
          </Button>
          <Button
            variant="filled"
            onPress={tryUnlock}
            isDisabled={checking() || !input().trim()}
          >
            <Trans>Enter Channel</Trans>
          </Button>
        </Actions>
      </Base>
    </Show>
  );
}

const Base = styled("div", {
  base: {
    height: "100%",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "var(--gap-lg)",
    userSelect: "none",
    overflowY: "auto",
    color: "var(--md-sys-color-on-surface)",
    gap: "var(--gap-md)",
  },
});

const PasswordInput = styled("input", {
  base: {},
});

const Actions = styled("div", {
  base: {
    display: "flex",
    marginTop: "var(--gap-lg)",
    gap: "var(--gap-lg)",
  },
});
