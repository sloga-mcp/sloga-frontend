import { Match, Show, Switch } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { dividerCopy } from "@revolt/client/protectedCopy";

/**
 * Divider line
 */
const Base = styled("div", {
  base: {
    height: 0,
    display: "flex",
    userSelect: "none",
    alignItems: "center",
    margin: "17px 12px 17px 8px",

    "& time": {
      marginTop: "-2px",
      fontSize: "0.6875rem",
      lineHeight: "0.6875rem",
      fontWeight: 600,
      paddingInline: "5px 5px",

      borderRadius: "var(--borderRadius-md)",

      color: "var(--md-sys-color-outline)",
      background: "var(--md-sys-color-surface-container-lowest)",
    },
  },
  variants: {
    unread: {
      true: {
        borderTop: "thin solid var(--md-sys-color-primary)",
      },
      false: {
        borderTop: "thin solid var(--md-sys-color-outline-variant)",
      },
    },
  },
  defaultVariants: {
    unread: false,
  },
});

/**
 * Unread indicator
 */
const Unread = styled("div", {
  base: {
    fontSize: "0.625rem",
    fontWeight: 600,
    color: "var(--md-sys-color-on-primary)",
    background: "var(--md-sys-color-primary)",

    padding: "0 6px",
    marginTop: "-1px",
    borderRadius: "60px",
  },
});

/**
 * Label of the protected history boundary; same neutral look as the date.
 * One line: the row has no height, so a wrapped label would lie over its
 * neighbours. A label wider than the row ends in an ellipsis.
 */
const Boundary = styled("span", {
  base: {
    minWidth: 0,
    maxWidth: "100%",
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",

    marginTop: "-2px",
    fontSize: "0.6875rem",
    lineHeight: "0.6875rem",
    fontWeight: 600,
    // Room for descenders, which `overflow: hidden` would cut
    paddingBlock: "2px",
    paddingInline: "5px 5px",

    borderRadius: "var(--borderRadius-md)",

    color: "var(--md-sys-color-outline)",
    background: "var(--md-sys-color-surface-container-lowest)",
  },
});

interface Props {
  /**
   * Display the date
   */
  date?: string;

  /**
   * Show unread indicator
   */
  unread?: boolean;

  /**
   * Show the protected history boundary instead: earlier messages were
   * kept above this line, or wiped. The caller decides when to pass this;
   * the date and the unread indicator are not shown with it.
   */
  protectedBoundary?: "kept" | "wiped";
}

/**
 * Generic message divider
 */
export function MessageDivider(props: Props) {
  // The boundary is a separator named by its label. The date and unread
  // dividers keep no role: a separator's own text is not read out.
  return (
    <Base
      unread={props.protectedBoundary ? false : props.unread}
      role={props.protectedBoundary ? "separator" : undefined}
      aria-label={
        props.protectedBoundary
          ? dividerCopy(props.protectedBoundary)
          : undefined
      }
    >
      <Switch>
        <Match when={props.protectedBoundary}>
          {(boundary) => <Boundary>{dividerCopy(boundary())}</Boundary>}
        </Match>
        <Match when={true}>
          <Show when={props.unread}>
            <Unread>
              <Trans>NEW</Trans>
            </Unread>
          </Show>
          <Show when={props.date}>
            <time>{props.date}</time>
          </Show>
        </Match>
      </Switch>
    </Base>
  );
}
