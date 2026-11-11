import { mergeProps, Show, splitProps } from "solid-js";
import { JSX } from "solid-js/jsx-runtime";

import { AriaButtonProps, createButton } from "@solid-aria/button";
import { cva } from "styled-system/css/cva";

import { Ripple } from "./Ripple";
import { typography } from "./Text";

type Props = Omit<
  Parameters<typeof iconButton2>[0] &
    AriaButtonProps &
    JSX.DirectiveAttributes &
    Pick<
      JSX.ButtonHTMLAttributes<HTMLButtonElement>,
      "role" | "tabIndex" | "aria-selected" | "style"
    >,
  "onClick" | "disabled"
>;

/**
 * Icon buttons help people take minor actions with one tap
 *
 * @specification https://m3.material.io/components/icon-buttons
 */
export function IconButton(props: Props) {
  const [passthrough, propsRest] = splitProps(props, [
    "aria-selected",
    "tabIndex",
    "role",
    "style",
  ]);

  const [style, rest] = splitProps(propsRest, [
    "size",
    "shape",
    "width",
    "variant",
    "_compositionSendMessage",
  ]);
  let ref: HTMLButtonElement | undefined;

  const [btn, noBtnRest] = splitProps(rest, ["onPress"]);

  //Emulate delay of native onClick
  // See issue https://github.com/solidjs-community/solid-aria/issues/84
  // Delay must be at least 32ms for Safari
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onPress = (e: any) => setTimeout(() => btn.onPress?.(e), 32),
    btnRest = mergeProps(noBtnRest, { onPress, preventFocusOnPress: true });

  const { buttonProps } = createButton(btnRest, () => ref);
  return (
    <button
      {...passthrough}
      {...buttonProps}
      ref={ref}
      class={iconButton2({
        ...style,
        disabled: buttonProps.disabled,
      })}
      // @codegen directives props=rest include=floating
    >
      <Show when={!buttonProps.disabled}>
        <Ripple />
      </Show>
      {rest.children}
    </button>
  );
}

const iconButton2 = cva({
  base: {
    ...typography.raw(),

    // for <Ripple />:
    position: "relative",

    // ensure it's always 1:1
    aspectRatio: "1/1",

    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",

    fontWeight: 500,
    fontFamily: "inherit",

    cursor: "pointer",
    border: "none",
    transition: "var(--transitions-fast) all",

    color: "var(--colour)",
    fill: "var(--colour)",

    // Modern: keyboard focus ring, as on Button
    _modern: {
      _focusVisible: {
        outline: "2px solid var(--md-sys-color-primary)",
        outlineOffset: "2px",
      },
    },
  },
  variants: {
    variant: {
      // Modern: raised like Button's filled and tonal, a little lighter, and
      // without the hover lift (icon buttons sit in dense rows)
      filled: {
        background: "var(--md-sys-color-primary)",
        "--colour": "var(--md-sys-color-on-primary)",
        _modern: {
          backgroundImage:
            "linear-gradient(180deg, rgb(255 255 255 / 0.16), rgb(255 255 255 / 0) 65%)",
          boxShadow:
            "inset 0 1px 0 rgb(255 255 255 / 0.22), 0 1px 2px rgb(0 0 0 / 0.3), 0 4px 12px -4px color-mix(in srgb, var(--md-sys-color-primary) 50%, transparent)",
          _enabled: {
            _active: { boxShadow: "inset 0 2px 4px rgb(0 0 0 / 0.28)" },
          },
        },
      },
      tonal: {
        background: "var(--md-sys-color-secondary-container)",
        "--colour": "var(--md-sys-color-on-secondary-container)",
        _modern: {
          backgroundImage:
            "linear-gradient(180deg, rgb(255 255 255 / 0.06), rgb(255 255 255 / 0) 70%)",
          boxShadow:
            "inset 0 0 0 1px color-mix(in srgb, var(--md-sys-color-on-surface) 10%, transparent), 0 1px 2px rgb(0 0 0 / 0.22)",
          _enabled: {
            _active: {
              boxShadow:
                "inset 0 0 0 1px color-mix(in srgb, var(--md-sys-color-on-surface) 10%, transparent), inset 0 2px 3px rgb(0 0 0 / 0.3)",
            },
          },
        },
      },
      outlined: {
        border: "1px solid var(--md-sys-color-outline-variant)",
        "--colour": "var(--md-sys-color-on-surface-variant)",
      },
      standard: {
        // Overridable so a container can tone a whole group of standard
        // icon buttons at once (the composer turns its actions green while
        // the conversation is end-to-end encrypted). Filled/tonal/outlined
        // variants keep their own colours.
        "--colour":
          "var(--icon-button-colour, var(--md-sys-color-on-surface-variant))",
      },

      _header: {
        "--colour": "white",
      },
    },
    size: {
      xs: {
        height: "32px",
      },
      sm: {
        height: "40px",
      },
      md: {
        height: "56px",
      },
      lg: {
        height: "96px",
      },
      xl: {
        height: "136px",
      },
    },
    shape: {
      round: {
        borderRadius: "var(--borderRadius-full)",
      },
      square: {},
    },
    width: {
      narrow: {},
      default: {},
      wide: {},
    },
    /**
     * Whether the button is disabled
     */
    disabled: {
      true: {
        cursor: "not-allowed",
      },
      false: {},
    },
    _compositionSendMessage: {
      true: {
        width: "48px",
        aspectRatio: "unset",
        height: "100% !important",
        borderEndRadius: "var(--borderRadius-xl)",
      },
    },
  },
  defaultVariants: {
    variant: "standard",
    width: "default",
    shape: "round",
    size: "sm",
    disabled: false,
    _compositionSendMessage: false,
  },
  compoundVariants: [
    // disabled styles
    {
      variant: ["filled", "tonal", "outlined"],
      disabled: true,
      css: {
        // todo: check these are correct
        "--color":
          "color-mix(in srgb, 38% var(--md-sys-color-on-surface), transparent)",
        background:
          "color-mix(in srgb, 10% var(--md-sys-color-on-surface), transparent)",
        _modern: { backgroundImage: "none", boxShadow: "none" },
      },
    },
    {
      variant: "standard",
      disabled: true,
      css: {
        // todo: check these are correct
        "--color":
          "color-mix(in srgb, 38% var(--md-sys-color-on-surface), transparent)",
        background:
          "color-mix(in srgb, 10% var(--md-sys-color-on-surface), transparent)",
      },
    },

    {
      size: ["xs", "sm"],
      width: "narrow",
      css: {
        paddingInline: "4px",
      },
    },
    {
      size: "xs",
      width: "default",
      css: {
        paddingInline: "6px",
      },
    },
    {
      size: "xs",
      width: "wide",
      css: {
        paddingInline: "10px",
      },
    },
    {
      size: "sm",
      width: "default",
      css: {
        paddingInline: "8px",
      },
    },
    {
      size: "sm",
      width: "wide",
      css: {
        paddingInline: "14px",
      },
    },
    {
      size: "md",
      width: "narrow",
      css: {
        paddingInline: "12px",
      },
    },
    {
      size: "md",
      width: "default",
      css: {
        paddingInline: "16px",
      },
    },
    {
      size: "md",
      width: "wide",
      css: {
        paddingInline: "24px",
      },
    },
    {
      size: "lg",
      width: "narrow",
      css: {
        paddingInline: "16px",
      },
    },
    {
      size: "lg",
      width: "default",
      css: {
        paddingInline: "32px",
      },
    },
    {
      size: "lg",
      width: "wide",
      css: {
        paddingInline: "48px",
      },
    },
    {
      size: "xl",
      width: "narrow",
      css: {
        paddingInline: "32px",
      },
    },
    {
      size: "xl",
      width: "default",
      css: {
        paddingInline: "48px",
      },
    },
    {
      size: "xl",
      width: "wide",
      css: {
        paddingInline: "72px",
      },
    },
    {
      size: ["xs", "sm"],
      shape: "square",
      css: {
        borderRadius: "var(--borderRadius-md)",
      },
    },
    {
      size: "md",
      shape: "square",
      css: {
        borderRadius: "var(--borderRadius-lg)",
      },
    },
    {
      size: ["lg", "xl"],
      shape: "square",
      css: {
        borderRadius: "var(--borderRadius-xl)",
      },
    },
  ],
});
