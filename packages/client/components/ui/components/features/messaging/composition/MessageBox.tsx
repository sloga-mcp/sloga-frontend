import { BiRegularBlock } from "solid-icons/bi";
import { Accessor, JSX, Match, Show, Switch, onMount } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { useDevice } from "@revolt/common";
import { Row } from "@revolt/ui";
import { AutoCompleteSearchSpace } from "@revolt/ui/components/utils/autoComplete";

import { TextEditor2 } from "../../texteditor/TextEditor2";

interface Props {
  /**
   * Initial content
   */
  initialValue: readonly [string];

  /**
   * Node replacement
   */
  nodeReplacement?: readonly [string | "_focus"];

  /**
   * Text content
   */
  content: string;

  /**
   * Handle event to send message
   */
  onSendMessage: () => void;

  /**
   * Handle event when user is typing
   */
  onTyping: () => void;

  /**
   * Handle event when user wants to edit the last message in chat
   */
  onEditLastMessage: () => void;

  /**
   * Update text content
   * @param v New content
   */
  setContent: (v: string) => void;

  /**
   * Actions to the left of the message box
   */
  actionsStart: JSX.Element;

  /**
   * Actions to the right of the message box
   */
  actionsEnd: JSX.Element;

  /**
   * Elements appended after the message box row
   */
  actionsAppend: JSX.Element;

  /**
   * Whether there are elements appended after the message box row
   */
  hasActionsAppend: boolean;

  /**
   * Placeholder in message box
   */
  placeholder: string;

  /**
   * Whether sending messages is allowed
   */
  sendingAllowed: boolean;

  /**
   * Auto complete config
   */
  autoCompleteSearchSpace?: Accessor<AutoCompleteSearchSpace>;

  /**
   * Update the current draft selection
   *
   * @deprecated have to hook into ProseMirror instance now!
   */
  updateDraftSelection?: (start: number, end: number) => void;
}

/**
 * Message box container
 */
const Base = styled("div", {
  base: {
    flexGrow: 1,
    minWidth: 0,

    padding: "var(--gap-sm) var(--gap-md)",
    borderStartRadius: "var(--borderRadius-xl)",

    display: "flex",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface)",
  },
  variants: {
    hasActionsAppend: {
      true: {
        borderEndRadius: "var(--borderRadius-md)",
      },
      false: {
        borderEndRadius: "var(--borderRadius-xl)",
      },
    },
  },
  defaultVariants: {
    hasActionsAppend: false,
  },
});

const Parent = styled("div", {
  base: {
    flexGrow: 1,
    flexShrink: 0,

    display: "flex",
    gap: "var(--gap-md)",
    margin: "0 0 var(--gap-md) 0",
    maxHeight: "var(--layout-height-message-box)",
  },
});

/**
 * Two-row composer wrapper (phone): the action bar stacked above the input row.
 */
const StackedParent = styled("div", {
  base: {
    flexGrow: 1,
    flexShrink: 0,

    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",
    margin: "0 0 var(--gap-md) 0",
  },
});

/**
 * Top bar (phone) holding every composer action. Scrolls horizontally when
 * the icons don't fit, so the input row below always keeps its full width.
 */
const ActionBar = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",

    padding: "var(--gap-sm) var(--gap-md)",
    borderRadius: "var(--borderRadius-xl)",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface)",

    overflowX: "auto",
    scrollbarWidth: "none",
    "&::-webkit-scrollbar": { display: "none" },
  },
});

/**
 * Bottom bar (phone): the text field alongside the send button.
 */
const InputRow = styled("div", {
  base: {
    display: "flex",
    gap: "var(--gap-md)",
    minWidth: 0,
    maxHeight: "var(--layout-height-message-box)",
  },
});

/**
 * Blocked message
 */
const Blocked = styled(Row, {
  base: {
    flexGrow: 1,
    fontSize: "14px",
    userSelect: "none",
    padding: "var(--gap-md)",
  },
  variants: {
    noPad: { true: { padding: 0 } },
  },
});

/**
 * Specific-width icon container
 */
export const InlineIcon = styled("div", {
  base: {
    flexShrink: 0,
    display: "flex",
    alignItems: "end",
    justifyContent: "center",
  },
  variants: {
    size: {
      short: { width: "14px" },
      normal: { width: "42px" },
    },
  },
  defaultVariants: {
    size: "normal",
  },
});

const FloatingAction = styled("div", {
  base: {
    flexShrink: 0,
    flexGrow: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "end",
  },
  variants: {
    size: {
      short: {
        height: "1em",
      },
      normal: {
        height: "1.5em",
      },
      tall: {
        height: "2em",
      },
    },
    error: {
      true: {
        color: "var(--md-sys-color-error)",
      },
    },
  },
});

const ActionContainer = styled("div", {
  base: {
    flexShrink: 0,
    display: "flex",
    flexGrow: 1,
  },
  variants: {
    column: {
      true: {
        flexFlow: "column",
      },
    },
  },
});

/**
 * Message box
 */
export function MessageBox(props: Props) {
  // props.updateDraftSelection?.(
  //   event.currentTarget.selectionStart,
  //   event.currentTarget.selectionEnd,
  // );

  const { layout } = useDevice();

  /**
   * On phones and tablets the composer stacks into two bars: every action
   * moves to a top bar, leaving the bottom bar as just the text field + send
   * button. Desktop keeps everything on a single row.
   */
  const twoRow = () => layout() !== "desktop";

  /**
   * Set initial draft selection
   */
  onMount(() =>
    props.updateDraftSelection?.(props.content.length, props.content.length),
  );

  /**
   * The text field, or a permission notice when sending isn't allowed.
   * Shared by both layouts (only one is ever mounted at a time).
   */
  const Editor = () => (
    <Switch
      fallback={
        <TextEditor2
          placeholder={props.placeholder}
          initialValue={props.initialValue}
          nodeReplacement={props.nodeReplacement}
          onChange={props.setContent}
          onComplete={props.onSendMessage}
          onTyping={props.onTyping}
          onPreviousContext={props.onEditLastMessage}
          autoCompleteSearchSpace={props.autoCompleteSearchSpace}
        />
      }
    >
      <Match when={!props.sendingAllowed}>
        <Blocked align noPad>
          <Trans>
            You don't have permission to send messages in this channel.
          </Trans>
        </Blocked>
      </Match>
    </Switch>
  );

  return (
    <>
      {/* Phone: two stacked bars — actions on top, input + send below */}
      <Show when={twoRow()}>
        <StackedParent>
          <Show when={props.sendingAllowed}>
            <ActionBar>
              {props.actionsStart}
              {props.actionsEnd}
            </ActionBar>
          </Show>
          <InputRow>
            <Base hasActionsAppend={props.hasActionsAppend}>
              <Show when={!props.sendingAllowed}>
                <InlineIcon>
                  <Blocked>
                    <BiRegularBlock size={24} />
                  </Blocked>
                </InlineIcon>
              </Show>
              <Editor />
            </Base>
            <Show when={props.sendingAllowed}>{props.actionsAppend}</Show>
          </InputRow>
        </StackedParent>
      </Show>

      {/* Desktop / tablet: everything on a single row */}
      <Show when={!twoRow()}>
        <Parent>
          <Base hasActionsAppend={props.hasActionsAppend}>
            <Switch fallback={props.actionsStart}>
              <Match when={!props.sendingAllowed}>
                <InlineIcon>
                  <Blocked>
                    <BiRegularBlock size={24} />
                  </Blocked>
                </InlineIcon>
              </Match>
            </Switch>
            <Editor />
            <Show when={props.sendingAllowed}>{props.actionsEnd}</Show>
          </Base>
          <Show when={props.sendingAllowed}>{props.actionsAppend}</Show>
        </Parent>
      </Show>
    </>
  );
}

MessageBox.InlineIcon = InlineIcon;

MessageBox.FloatingAction = FloatingAction;

MessageBox.ActionContainer = ActionContainer;
