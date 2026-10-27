import { Show, createRenderEffect, mergeProps, on, splitProps } from "solid-js";
import { JSX } from "solid-js/jsx-runtime";

import { AriaButtonProps, createButton } from "@solid-aria/button";
import { cva } from "styled-system/css/cva";

import { Ripple } from "./Ripple";
import { typography } from "./Text";

type Props = Omit<
  Parameters<typeof button>[0] &
    AriaButtonProps &
    JSX.DirectiveAttributes &
    Pick<
      JSX.ButtonHTMLAttributes<HTMLButtonElement>,
      "role" | "tabIndex" | "aria-selected"
    >,
  "onClick" | "_permitAnimation" | "disabled"
> & {
  groupActive?: boolean;
  bg?: string;
};

/**
 * Buttons prompt most actions in a UI
 *
 * If you wish to create standard button groups:
 *
 * ```tsx
 * <Row>
 *   <Button
 *     onPress={() => setActiveA()}
 *     groupActive={activeA()}
 *     group="standard"
 *   >
 *     Button A
 *   </Button>
 *   <Button
 *     onPress={() => setActiveB()}
 *     groupActive={activeB()}
 *     group="standard"
 *   >
 *     Button B
 *   </Button>
 *   <Button
 *     onPress={() => setActiveC()}
 *     groupActive={activeC()}
 *     group="standard"
 *   >
 *     Button C
 *   </Button>
 * </Row>
 * ```
 *
 * If you wish to create connected button groups:
 *
 * ```tsx
 * <Row>
 *   <Button
 *     onPress={() => setActiveA()}
 *     groupActive={activeA()}
 *     group="connected-start"
 *   >
 *     Button A
 *   </Button>
 *   <Button
 *     onPress={() => setActiveB()}
 *     groupActive={activeB()}
 *     group="connected"
 *   >
 *     Button B
 *   </Button>
 *   <Button
 *     onPress={() => setActiveC()}
 *     groupActive={activeC()}
 *     group="connected-end"
 *   >
 *     Button C
 *   </Button>
 * </Row>
 * ```
 *
 * @specification https://m3.material.io/components/buttons
 */
export function Button(props: Props) {
  const [passthrough, propsRest] = splitProps(props, [
    "aria-selected",
    "tabIndex",
    "role",
  ]);

  const [style, rest] = splitProps(propsRest, [
    "bg",
    "size",
    "shape",
    "variant",
    "group",
    "groupActive",
  ]);
  let ref: HTMLButtonElement | undefined;

  const shape = () =>
    style.group
      ? style.groupActive !== (style.group === "standard")
        ? "round"
        : "square"
      : style.shape;

  const variant = () =>
    style.group ? (style.groupActive ? "filled" : "tonal") : style.variant;

  let _permitAnimation = false;
  createRenderEffect(
    on(
      () => shape(),
      () => (_permitAnimation = true),
      { defer: true },
    ),
  );

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
      class={button({
        shape: shape(),
        variant: variant(),
        size: style.size,
        group: style.group,
        disabled: buttonProps.disabled,
        _permitAnimation,
      })}
      style={{
        "background-color": style.bg,
      }}
      // @codegen directives props=rest include=floating
    >
      <Show when={!buttonProps.disabled}>
        <Ripple />
      </Show>
      {rest.children}
    </button>
  );
}

const button = cva({
  base: {
    ...typography.raw(),

    // for <Ripple />:
    position: "relative",

    paddingInline: "var(--padding-inline)",

    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",

    fontWeight: 500,
    fontFamily: "inherit",

    cursor: "pointer",
    border: "none",
    transition: "var(--transitions-medium) all",

    color: "var(--color)",
    fill: "var(--color)",

    // Modern: a ring that shows only for keyboard focus. An outline rather
    // than a shadow, so it never fights the variant's own shadows.
    _modern: {
      _focusVisible: {
        outline: "2px solid var(--md-sys-color-primary)",
        outlineOffset: "2px",
      },
    },
  },
  variants: {
    /**
     * Variant is equivalent to 'color' in Material spec
     *
     * Under the Modern style the filled ones are raised: a translucent light
     * gradient over the fill (so a `bg` colour still shows through it), a
     * lit top edge and a soft shadow tinted with the fill. Hover lifts them a
     * pixel (unless reduced motion is on), press sinks them.
     */
    variant: {
      elevated: {
        boxShadow: "0 0.5px 1.5px #0004",
        background: "var(--md-sys-color-surface-container-low)",
        "--color": "var(--md-sys-color-primary)",
        _modern: {
          backgroundImage:
            "linear-gradient(180deg, rgb(255 255 255 / 0.07), rgb(255 255 255 / 0) 70%)",
          boxShadow:
            "inset 0 0 0 1px color-mix(in srgb, var(--md-sys-color-on-surface) 10%, transparent), inset 0 1px 0 rgb(255 255 255 / 0.06), 0 1px 2px rgb(0 0 0 / 0.25)",
          _enabled: {
            _hover: {
              boxShadow:
                "inset 0 0 0 1px color-mix(in srgb, var(--md-sys-color-on-surface) 14%, transparent), inset 0 1px 0 rgb(255 255 255 / 0.08), 0 2px 4px rgb(0 0 0 / 0.25), 0 8px 18px -8px rgb(0 0 0 / 0.45)",
              _motionSafe: { transform: "translateY(-1px)" },
            },
            _active: {
              transform: "none",
              boxShadow:
                "inset 0 0 0 1px color-mix(in srgb, var(--md-sys-color-on-surface) 10%, transparent), inset 0 2px 3px rgb(0 0 0 / 0.3)",
            },
          },
        },
      },
      filled: {
        background: "var(--md-sys-color-primary)",
        "--color": "var(--md-sys-color-on-primary)",
        _modern: {
          backgroundImage:
            "linear-gradient(180deg, rgb(255 255 255 / 0.18), rgb(255 255 255 / 0) 65%)",
          boxShadow:
            "inset 0 1px 0 rgb(255 255 255 / 0.25), 0 1px 2px rgb(0 0 0 / 0.3), 0 6px 16px -6px color-mix(in srgb, var(--md-sys-color-primary) 55%, transparent)",
          _enabled: {
            _hover: {
              boxShadow:
                "inset 0 1px 0 rgb(255 255 255 / 0.3), 0 2px 4px rgb(0 0 0 / 0.3), 0 10px 22px -6px color-mix(in srgb, var(--md-sys-color-primary) 70%, transparent)",
              _motionSafe: { transform: "translateY(-1px)" },
            },
            _active: {
              transform: "none",
              boxShadow: "inset 0 2px 4px rgb(0 0 0 / 0.28)",
            },
          },
        },
      },
      tonal: {
        background: "var(--md-sys-color-secondary-container)",
        "--color": "var(--md-sys-color-on-secondary-container)",
        _modern: {
          backgroundImage:
            "linear-gradient(180deg, rgb(255 255 255 / 0.07), rgb(255 255 255 / 0) 70%)",
          boxShadow:
            "inset 0 0 0 1px color-mix(in srgb, var(--md-sys-color-on-surface) 10%, transparent), inset 0 1px 0 rgb(255 255 255 / 0.06), 0 1px 2px rgb(0 0 0 / 0.25)",
          _enabled: {
            _hover: {
              boxShadow:
                "inset 0 0 0 1px color-mix(in srgb, var(--md-sys-color-on-surface) 14%, transparent), inset 0 1px 0 rgb(255 255 255 / 0.08), 0 2px 4px rgb(0 0 0 / 0.25), 0 8px 18px -8px rgb(0 0 0 / 0.45)",
              _motionSafe: { transform: "translateY(-1px)" },
            },
            _active: {
              transform: "none",
              boxShadow:
                "inset 0 0 0 1px color-mix(in srgb, var(--md-sys-color-on-surface) 10%, transparent), inset 0 2px 3px rgb(0 0 0 / 0.3)",
            },
          },
        },
      },
      outlined: {
        border: "1px solid var(--md-sys-color-outline-variant)",
        "--color": "var(--md-sys-color-on-surface-variant)",
      },
      text: {
        "--color": "var(--md-sys-color-primary)",
      },
      _error: {
        background: "var(--md-sys-color-error)",
        "--color": "var(--md-sys-color-on-error)",
        _modern: {
          backgroundImage:
            "linear-gradient(180deg, rgb(255 255 255 / 0.16), rgb(255 255 255 / 0) 65%)",
          boxShadow:
            "inset 0 1px 0 rgb(255 255 255 / 0.22), 0 1px 2px rgb(0 0 0 / 0.3), 0 6px 16px -6px color-mix(in srgb, var(--md-sys-color-error) 50%, transparent)",
          _enabled: {
            _hover: {
              boxShadow:
                "inset 0 1px 0 rgb(255 255 255 / 0.26), 0 2px 4px rgb(0 0 0 / 0.3), 0 10px 22px -6px color-mix(in srgb, var(--md-sys-color-error) 65%, transparent)",
              _motionSafe: { transform: "translateY(-1px)" },
            },
            _active: {
              transform: "none",
              boxShadow: "inset 0 2px 4px rgb(0 0 0 / 0.28)",
            },
          },
        },
      },
      /**
       * Tertiary-container fill, for a consequential ACTION sitting in a row
       * of toggles.
       *
       * `filled` cannot do this job: it resolves to the same
       * `primary`/`on-primary` pair as IconButton's *active* state, so a
       * filled Button next to a lit filled IconButton reads as "this is on"
       * rather than "press this to act". Tertiary is the only mounted
       * container colour that is neither of those, nor the error red that
       * means destructive.
       *
       * Carries its own `gap` because this variant is meant to be used with
       * an icon AND a label — the base has no gap, and adding one there would
       * reach every button in the app.
       */
      _tertiary: {
        background: "var(--md-sys-color-tertiary-container)",
        "--color": "var(--md-sys-color-on-tertiary-container)",
        gap: "var(--gap-sm)",
      },

      // Old entries:

      /**
       * @deprecated
       */
      success: {
        fill: "var(--unset-fg)",
        color: "var(--unset-fg)",
        background: "var(--unset-bg)",
      },
      /**
       * @deprecated
       */
      warning: {
        fill: "var(--unset-fg)",
        color: "var(--unset-fg)",
        background: "var(--unset-bg)",
      },
      /**
       * @deprecated
       */
      error: {
        fill: "var(--unset-fg)",
        color: "var(--unset-fg)",
        background: "var(--unset-bg)",
      },
      /**
       * @deprecated use filled
       */
      primary: {
        fill: "var(--unset-fg)",
        color: "var(--unset-fg)",
        background: "var(--unset-bg)",
      },
      /**
       * @deprecated use tonal
       */
      secondary: {
        fill: "var(--unset-fg)",
        color: "var(--unset-fg)",
        background: "var(--unset-bg)",
      },
      /**
       * @deprecated use text instead
       */
      plain: {
        fill: "var(--unset-fg)",
        color: "var(--unset-fg)",
        background: "var(--unset-bg)",
      },
    },
    /**
     * Expressive shapes
     */
    shape: {
      round: {
        borderRadius: "var(--borderRadius-full)",
      },
      square: {},
    },
    /**
     * Expressive button groups
     */
    group: {
      "connected-start": {},
      "connected-end": {},
      connected: {},
      standard: {},
    },
    /**
     * Internal helper for expressive button animation
     */
    _permitAnimation: {
      true: {},
      false: {},
    },
    /**
     * Expressive sizes
     */
    size: {
      xs: {
        height: "32px",
        "--padding-inline": "12px",
      },
      sm: {
        height: "40px",
        "--padding-inline": "16px",
      },
      md: {
        height: "56px",
        "--padding-inline": "24px",
      },
      lg: {
        height: "96px",
        "--padding-inline": "48px",
      },
      xl: {
        height: "136px",
        "--padding-inline": "64px",
      },

      // Old code:
      icon: {
        width: "36px",
        height: "36px",
      },
      /**
       * @deprecated
       */
      small: {
        height: "40px",
        paddingInline: "16px",
        borderRadius: "12px",

        ...typography.raw(),
      },
      /**
       * @deprecated
       */
      normal: {
        height: "38px",
        minWidth: "96px",
        padding: "2px 16px",
        fontSize: "0.8125rem",
      },
      /**
       * @deprecated
       */
      fab: {
        width: "42px",
        height: "42px",
        borderRadius: "var(--borderRadius-lg)",
      },
      /**
       * @deprecated
       */
      fluid: {
        borderRadius: "var(--borderRadius-md)",
      },
      /**
       * @deprecated
       */
      inline: {
        padding: "var(--gap-xs) var(--gap-md)",
        fontSize: "0.8125rem",
        borderRadius: "var(--borderRadius-md)",
      },
      /**
       * @deprecated
       */
      none: {
        borderRadius: "0",
      },
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
  },
  defaultVariants: {
    size: "sm",
    shape: "round",
    variant: "filled",
    disabled: false,
  },
  compoundVariants: [
    // disabled styles
    {
      variant: ["elevated", "filled", "tonal", "outlined"],
      disabled: true,
      css: {
        "--color":
          "color-mix(in srgb, 38% var(--md-sys-color-on-surface), transparent)",
        background:
          "color-mix(in srgb, 10% var(--md-sys-color-on-surface), transparent)",
        // a disabled button is flat in either style
        _modern: { backgroundImage: "none", boxShadow: "none" },
      },
    },
    {
      variant: "text",
      disabled: true,
      css: {
        "--color":
          "color-mix(in srgb, 38% var(--md-sys-color-on-surface), transparent)",
        background:
          "color-mix(in srgb, 10% var(--md-sys-color-on-surface), transparent)",
      },
    },

    // border radius for different squared sizes
    {
      shape: "square",
      size: ["sm", "xs"],
      css: {
        borderRadius: "var(--borderRadius-md)",
      },
    },
    {
      shape: "square",
      size: "md",
      css: {
        borderRadius: "var(--borderRadius-lg)",
      },
    },
    {
      shape: "square",
      size: ["xl", "lg"],
      css: {
        borderRadius: "var(--borderRadius-xl)",
      },
    },

    // hard-code values for rounded connected group shapes
    {
      shape: "round",
      size: ["sm", "xs"],
      css: {
        borderRadius: "48px",
      },
    },
    {
      shape: "round",
      size: ["md"],
      css: {
        borderRadius: "64px",
      },
    },
    {
      shape: "round",
      size: ["xl", "lg"],
      css: {
        borderRadius: "160px",
      },
    },

    // left-side connected group
    {
      shape: "square",
      size: ["sm", "xs"],
      group: "connected-start",
      css: {
        borderRadius: "48px var(--borderRadius-md) var(--borderRadius-md) 48px",
      },
    },
    {
      shape: "square",
      size: "md",
      group: "connected-start",
      css: {
        borderRadius: "64px var(--borderRadius-lg) var(--borderRadius-lg) 64px",
      },
    },
    {
      shape: "square",
      size: ["xl", "lg"],
      group: "connected-start",
      css: {
        borderRadius:
          "160px var(--borderRadius-xl) var(--borderRadius-xl) 160px",
      },
    },

    // right-side connected group
    {
      shape: "square",
      size: ["sm", "xs"],
      group: "connected-end",
      css: {
        borderRadius: "var(--borderRadius-md) 48px 48px var(--borderRadius-md)",
      },
    },
    {
      shape: "square",
      size: "md",
      group: "connected-end",
      css: {
        borderRadius: "var(--borderRadius-lg) 64px 64px var(--borderRadius-lg)",
      },
    },
    {
      shape: "square",
      size: ["xl", "lg"],
      group: "connected-end",
      css: {
        borderRadius:
          "var(--borderRadius-xl) 160px 160px var(--borderRadius-xl)",
      },
    },

    // run animation when group activates
    // connected doesn't actually animate:
    // {
    //   shape: "round",
    //   group: ["connected-start", "connected-end", "connected"],
    //   _permitAnimation: true,
    //   css: {
    //     animationName: "materialPhysicsButtonSelect",
    //     animationDuration: "0.3s",
    //     animationFillMode: "forwards",
    //   },
    // },
    {
      shape: "square",
      group: ["standard"],
      _permitAnimation: true,
      css: {
        animationName: "materialPhysicsButtonSelect",
        animationDuration: "0.3s",
        animationFillMode: "forwards",
      },
    },
  ],
});
