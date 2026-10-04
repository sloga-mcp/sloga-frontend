import { createSignal } from "solid-js";

import { Handler } from "mdast-util-to-hast";
import { styled } from "styled-system/jsx";

const Spoiler = styled("span", {
  base: {
    padding: "0 2px",
    borderRadius: "var(--borderRadius-md)",
  },
  variants: {
    shown: {
      true: {
        color: "var(--md-sys-color-inverse-on-surface)",
        background: "var(--md-sys-color-inverse-surface)",
      },
      false: {
        cursor: "pointer",
        userSelect: "none",
        color: "transparent",
        background: "#151515",

        "> *": {
          opacity: 0,
          pointerEvents: "none",
        },
      },
    },
  },
});

export function RenderSpoiler(props: {
  children: Element;
  disabled?: boolean;
}) {
  const [shown, setShown] = createSignal(false);

  return (
    <Spoiler
      shown={shown()}
      onClick={props.disabled ? undefined : () => setShown(true)}
    >
      {props.children}
    </Spoiler>
  );
}

// The syntax plugin lives in a pure module so it can be spec-tested under node.
export { remarkSpoiler } from "./spoilerSyntax";

export const spoilerHandler: Handler = (h, node) => {
  return {
    type: "element" as const,
    tagName: "spoiler",
    children: h.all({
      type: "paragraph",
      children: node.children,
    }),
    properties: {},
  };
};
