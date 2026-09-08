import type { JSX } from "solid-js";
import { For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { Motion, Presence } from "solid-motionone";

import { styled } from "styled-system/jsx";

import { Button } from "./Button";
import { typography } from "./Text";

export interface DialogProps {
  show: boolean;
  onClose: () => void;
}

export interface DialogAction {
  text: JSX.Element;
  onClick?: () => void | Promise<unknown> | true | false;
  isDisabled?: boolean;
}

type Props = DialogProps & {
  icon?: JSX.Element;
  title?: JSX.Element;
  children: JSX.Element;
  actions?: DialogAction[];
  isDisabled?: boolean;

  scrimBackground?: string;

  minWidth?: number;
  padding?: number;
};

/**
 * Dialogs provide important prompts in a user flow
 *
 * @specification https://m3.material.io/components/dialogs
 */
export function Dialog(props: Props) {
  return (
    <Portal mount={document.getElementById("floating")!}>
      <Dialog.Scrim
        show={props.show}
        onClick={props.onClose}
        class="dialog_scrim"
        style={{
          "--background": props.scrimBackground
            ? `url('${props.scrimBackground}'), rgba(0, 0, 0, 0.6)`
            : "rgba(0, 0, 0, 0.6)",
        }}
      >
        <Presence>
          <Show when={props.show}>
            <Motion.div
              initial={{
                opacity: 0,
                y: 20,
              }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              transition={{ duration: 0.3, easing: [0.05, 0.7, 0.1, 1.0] }}
              class="dialog"
            >
              <Container
                style={{
                  // Clamped to the viewport: the screenshare modals ask for
                  // 820px to fit seven equal-width tier buttons, which would
                  // otherwise overflow phones and half-snapped desktop
                  // windows with no way to reach the action buttons.
                  "min-width": props.minWidth
                    ? `min(${props.minWidth}px, calc(100vw - 2 * var(--gap-md)))`
                    : undefined,
                  padding: props.padding ? `${props.padding}px` : undefined,
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <Show when={props.icon}>
                  <Icon>{props.icon}</Icon>
                </Show>
                <Show when={props.title}>
                  <Title withIcon={typeof props.icon !== "undefined"}>
                    {props.title}
                  </Title>
                </Show>
                <Content class={typography()}>{props.children}</Content>
                <Show when={props.actions}>
                  <Actions>
                    <For each={props.actions}>
                      {(action) => (
                        <Button
                          variant="text"
                          size="small"
                          onPress={() => {
                            if (action.isDisabled) return;

                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            const value = action.onClick?.() as any;
                            if (value instanceof Promise) {
                              value.then(props.onClose).catch(() => {});
                            } else if (value !== false) {
                              props.onClose();
                            }
                          }}
                          isDisabled={action.isDisabled || props.isDisabled}
                        >
                          {action.text}
                        </Button>
                      )}
                    </For>
                  </Actions>
                </Show>
              </Container>
            </Motion.div>
          </Show>
        </Presence>
      </Dialog.Scrim>
    </Portal>
  );
}

/**
 * Full-screen scrim shown below dialogs
 *
 * @specification https://m3.material.io/components/dialogs
 */
Dialog.Scrim = styled("div", {
  base: {
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    position: "fixed",
    zIndex: "998",

    maxHeight: "100%",

    display: "grid",
    userSelect: "none",
    placeItems: "center",

    pointerEvents: "all",

    animationName: "scrimFadeIn",
    animationDuration: "0.1s",
    animationFillMode: "forwards",
    transition: "var(--transitions-medium) all",
  },
  variants: {
    show: {
      false: {
        animationName: "unset",
        pointerEvents: "none",
        background: "transparent",
      },
    },
    padding: {
      true: {
        padding: "80px",
        _phone: { padding: "30px" },
      },
    },
    overflow: {
      true: {
        overflowY: "auto",
      },
    },
    dark: {
      true: {
        "--background": "rgba(0, 0, 0, 0.9)",
      },
      false: {
        "--background": "rgba(0, 0, 0, 0.6)",
      },
    },
  },
  defaultVariants: {
    show: true,
    padding: true,
    overflow: true,
    dark: false,
  },
});

const Container = styled("div", {
  base: {
    padding: "24px",
    minWidth: "280px",
    maxWidth: "560px",
    borderRadius: "28px",

    display: "flex",
    flexDirection: "column",

    color: "var(--md-sys-color-on-surface)",
    background: "var(--md-sys-color-surface-container-high)",
  },
});

const Icon = styled("div", {
  base: {
    alignSelf: "center",
    marginBottom: "16px",
    fill: "var(--md-sys-color-on-surface)",
  },
});

const Title = styled("span", {
  base: {
    ...typography.raw({ class: "headline", size: "small" }),
    marginBlockEnd: "16px",
  },
  variants: {
    withIcon: {
      true: {
        textAlign: "center",
      },
    },
  },
  defaultVariants: {
    withIcon: false,
  },
});

const Content = styled("div", {
  base: {
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const Actions = styled("div", {
  base: {
    gap: "8px",
    display: "flex",
    // Buttons carry flexShrink: 0, so a row that does not fit cannot squash --
    // without wrapping it overflows, and because the row used to be
    // end-justified the overflow ran off the START edge, clipping the FIRST
    // action rather than the last. On a phone "Start a Chat Room or Server"
    // lost the left half of "Chat Room" that way.
    flexWrap: "wrap",
    // Centred rather than M3's end-alignment: once actions wrap, a trailing
    // line holding one button sits alone against the right edge and reads as
    // a mistake. Centring keeps both lines balanced, and applies to every
    // dialog so a two-action row does not shift alignment when a third is
    // added.
    justifyContent: "center",
    marginBlockStart: "24px",
  },
});
