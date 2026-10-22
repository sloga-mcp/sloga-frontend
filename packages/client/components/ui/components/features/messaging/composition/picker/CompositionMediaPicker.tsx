import { useWindowCtx } from "@revolt/client/windowCtx";
import { useFloating } from "solid-floating-ui";
import {
  Accessor,
  JSX,
  Match,
  Setter,
  Show,
  Switch,
  createContext,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { Portal } from "solid-js/web";
import { Motion, Presence } from "solid-motionone";

import { flip, offset, shift } from "@floating-ui/dom";
import { cva } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { Button } from "@revolt/ui/components/design";
import { Row } from "@revolt/ui/components/layout";

import { EmojiPicker } from "./EmojiPicker";
import { GifPicker } from "./GifPicker";
import { StickerPicker } from "./StickerPicker";

export type MediaPickerProps = {
  ref: Setter<HTMLElement | undefined>;
  onClickGif: (_: unknown, ref?: HTMLDivElement) => void;
  onClickEmoji: (_: unknown, ref?: HTMLDivElement) => void;
  onClickSticker: (_: unknown, ref?: HTMLDivElement) => void;
};

interface Props {
  /**
   * User card trigger area
   * @param trigProps Props that need to be applied to the trigger area
   */
  children: (trigProps: MediaPickerProps) => JSX.Element;

  /**
   * Send a message
   */
  onMessage: (content: string) => void;

  /**
   * Text replacement
   */
  onTextReplacement: (node: string) => void;

  /**
   * Offer only the emoji tab. For pickers that choose an emoji rather than
   * compose a message (forum tag icons), where a GIF or sticker has nowhere
   * to go. Also lifts the picker above the settings overlay (z-index 100),
   * which it would otherwise open underneath.
   */
  emojiOnly?: boolean;
}

export const CompositionMediaPickerContext = createContext(
  null as unknown as Pick<Props, "onMessage" | "onTextReplacement">,
);

export function CompositionMediaPicker(props: Props) {
  const [anchor, setAnchor] = createSignal<HTMLElement>();
  const [show, setShow] = createSignal<"gif" | "emoji" | "sticker">();
  let altRef: HTMLDivElement | undefined;

  const context: Pick<Props, "onMessage" | "onTextReplacement"> = {
    onMessage: (content) => props.onMessage(content),
    onTextReplacement: (node) => {
      props.onTextReplacement(node);
      // An emoji-only picker chooses one emoji, so it is done after a pick;
      // the composer's picker stays open for inserting several.
      if (props.emojiOnly) setShow();
    },
  };

  return (
    <CompositionMediaPickerContext.Provider value={context}>
      {props.children({
        ref: setAnchor,
        onClickGif: (_, ref) => {
          altRef = ref;
          setShow((current) => (current === "gif" ? undefined : "gif"));
        },
        onClickEmoji: (_, ref) => {
          altRef = ref;
          setShow((current) => (current === "emoji" ? undefined : "emoji"));
        },
        onClickSticker: (_, ref) => {
          altRef = ref;
          setShow((current) => (current === "sticker" ? undefined : "sticker"));
        },
      })}
      <Presence>
        <Show when={show()}>
          <Portal mount={useWindowCtx().floatingMount()}>
            <Motion
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2, easing: [0.87, 0, 0.13, 1] }}
            >
              <Picker
                anchor={() => altRef || anchor()}
                show={show}
                setShow={setShow}
                onMessage={context.onMessage}
                onTextReplacement={context.onTextReplacement}
                emojiOnly={props.emojiOnly}
              />
            </Motion>
          </Portal>
        </Show>
      </Presence>
    </CompositionMediaPickerContext.Provider>
  );
}

function Picker(
  props: Pick<Props, "onMessage" | "onTextReplacement" | "emojiOnly"> & {
    anchor: Accessor<HTMLElement | undefined>;
    show: Accessor<"gif" | "emoji" | "sticker" | undefined>;
    setShow: Setter<"gif" | "emoji" | "sticker" | undefined>;
  },
) {
  const [floating, setFloating] = createSignal<HTMLDivElement>();
  const [fixed, setFixed] = createSignal(false);

  const position = useFloating(() => props.anchor(), floating, {
    placement: "top-end",
    middleware: [offset(5), flip(), shift()],
  });

  function onMouseDown(e: MouseEvent) {
    if (!floating()?.contains(e.target as Node)) props.setShow();
  }
  function onResize() {
    const el = floating();
    if (!el) return;
    const rect = el.getBoundingClientRect();

    //Prevent overflow off-screen
    if (rect.right > innerWidth || rect.bottom > innerHeight) setFixed(true);
  }
  onMount(() => {
    addEventListener("mousedown", onMouseDown);
    addEventListener("resize", onResize);
    setTimeout(onResize, 1);
  });
  onCleanup(() => {
    removeEventListener("mousedown", onMouseDown);
    removeEventListener("resize", onResize);
  });

  return (
    <Base
      ref={setFloating}
      style={{
        ...(fixed()
          ? { position: "absolute", bottom: 0, right: 0 }
          : {
              position: position.strategy,
              top: `${position.y ?? 0}px`,
              left: `${position.x ?? 0}px`,
            }),
        ...(props.emojiOnly ? { "z-index": 101 } : {}),
      }}
    >
      <Container>
        <Show when={!props.emojiOnly}>
          <Row justify class="CompositionButton">
            <Button
              groupActive={props.show() === "gif"}
              onPress={() => props.setShow("gif")}
              group="connected-start"
            >
              GIFs
            </Button>
            <Button
              groupActive={props.show() === "emoji"}
              onPress={() => props.setShow("emoji")}
              group="connected"
            >
              Emoji
            </Button>
            <Button
              groupActive={props.show() === "sticker"}
              onPress={() => props.setShow("sticker")}
              group="connected-end"
            >
              Stickers
            </Button>
          </Row>
        </Show>

        <Switch fallback={<span>Not available yet.</span>}>
          <Match when={props.show() === "gif"}>
            <GifPicker />
          </Match>
          <Match when={props.show() === "emoji"}>
            <EmojiPicker />
          </Match>
          <Match when={props.show() === "sticker"}>
            <StickerPicker />
          </Match>
        </Switch>
      </Container>
    </Base>
  );
}

/**
 * Base element
 */
const Base = styled("div", {
  base: {
    width: "400px",
    height: "400px",
    maxWidth: "100%",
    maxHeight: "calc(100% - 72px)",
  },
});

/**
 * Container element for the picker
 */
const Container = styled("div", {
  base: {
    width: "100%",
    height: "100%",

    userSelect: "none",

    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-md)",

    alignItems: "stretch",

    overflow: "hidden",
    padding: "var(--gap-md) 0",

    borderRadius: "var(--borderRadius-lg)",
    color: "var(--md-sys-color-on-surface)",
    fill: "var(--md-sys-color-on-surface)",
    boxShadow: "0 0 3px var(--md-sys-color-shadow)",
    background: "var(--md-sys-color-surface-container)",
  },
});

/**
 * Styles for the content container
 */
export const compositionContent = cva({
  base: {
    flexGrow: 1,
    minHeight: 0,
  },
});
