import { Accessor, JSX, Show } from "solid-js";

import { css } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { useState } from "@revolt/state";
import { Breadcrumbs, IconButton, Text } from "@revolt/ui";

import MdArrowBack from "@material-design-icons/svg/outlined/arrow_back.svg?component-solid";
import MdClose from "@material-design-icons/svg/outlined/close.svg?component-solid";

import { SettingsList } from "..";
import { useSettingsNavigation } from "../Settings";

import { SettingsSearchTitle } from "./Search";

/**
 * Content portion of the settings menu
 */
export function SettingsContent(props: {
  onClose?: () => void;
  children: JSX.Element;
  list: Accessor<SettingsList<unknown>>;
  title: (ctx: SettingsList<never>, key: string) => string;
  page: Accessor<string | undefined>;
  ref: (element: HTMLDivElement) => void;
  searching: Accessor<boolean>;
}) {
  const { navigate } = useSettingsNavigation();
  const { diagDrawer } = useState();

  return (
    <div ref={props.ref} use:scrollable={{ class: base }}>
      <Show when={props.page() || props.searching()}>
        <InnerContent class="settings_cont">
          <InnerColumn>
            <BackAction>
              <IconButton
                variant="tonal"
                onPress={() => diagDrawer()?.setShown(false)}
              >
                <MdArrowBack />
              </IconButton>
            </BackAction>
            <Show when={props.searching()}>
              <Text class="title" size="large">
                <SettingsSearchTitle />
              </Text>
            </Show>
            <Show when={!props.searching() && props.page() !== "account"}>
              <Text class="title" size="large">
                <Breadcrumbs
                  elements={props.page()!.split("/")}
                  renderElement={(key) =>
                    props.title(props.list() as SettingsList<never>, key)
                  }
                  navigate={(keys) => navigate(keys.join("/"))}
                />
              </Text>
            </Show>
            {props.children}
            <div class={css({ minHeight: "80px" })} />
          </InnerColumn>
        </InnerContent>
      </Show>
      <Show when={props.onClose}>
        <CloseAction class="close">
          <IconButton variant="tonal" onPress={props.onClose}>
            <MdClose />
          </IconButton>
        </CloseAction>
      </Show>
    </div>
  );
}

/**
 * Base styles
 */
const base = css({
  minWidth: 0,
  flex: "1 1 800px",
  flexDirection: "row",
  display: "flex",
  background: "var(--md-sys-color-surface-container-low)",
  borderStartStartRadius: "30px",
  borderEndStartRadius: "30px",

  "& > a": {
    textDecoration: "none",
  },

  _phone: {
    borderRadius: 0,
  },
});

/**
 * Settings pane
 */
const InnerContent = styled("div", {
  base: {
    gap: "13px",
    minWidth: 0,
    width: "100%",
    display: "flex",
    maxWidth: "740px",
    padding: "80px 32px",
    justifyContent: "stretch",
    zIndex: 1,

    _tablet: { padding: "12px" },

    /*
      A *minimum* height, not a fixed one.

      This was `height: 100vh`, which pins the pane to exactly one viewport
      regardless of what is in it — it simply cannot grow.

      🔴 An earlier version of this comment also asserted that `vh` resolves
      against the large viewport and so does not follow the keyboard under
      `interactive-widget=resizes-content` (set in `index.html`). That was
      never verified and is not load-bearing here: this change is correct
      either way, because the defect being fixed is a height that cannot
      grow, not one that collapses. Do not repeat the claim as fact until
      someone has measured a `100vh` box against `innerHeight` on a real
      Android device with the keyboard up — it is one of the open questions
      behind the landscape-blanking report, whose phone/tablet breakpoint
      mechanism is now confirmed on the operator's device but which is still
      not fully accounted for. See the v0.59.0 block in changelogData.ts.

      `min-height` alone is not enough here: this is a stretch-aligned item of
      the row scroller above, and under `align-items: stretch` the cross size
      comes from the flex line rather than from the content, so the box would
      still be one viewport tall with long content spilling out of it. Opting
      out of stretch with `align-self` is what lets the height be content-based;
      the `min-height` then keeps the pane filling the screen when the page is
      short, which is all `height: 100vh` was ever doing.
    */
    _phone: { alignSelf: "flex-start", minHeight: "100vh" },
  },
});

/**
 * Pane content column
 */
const InnerColumn = styled("div", {
  base: {
    width: "100%",
    gap: "var(--gap-md)",
    display: "flex",
    flexDirection: "column",
    marginBlockEnd: "80px",
  },
});

/**
 * Back button returning to the settings list — only relevant on phone
 * layouts, where the content pane slides over the list and the only
 * other way back is a swipe gesture
 */
const BackAction = styled("div", {
  base: {
    display: "none",

    _phone: {
      display: "flex",
      position: "sticky",
      top: "8px",
      zIndex: 2,
    },
  },
});

/**
 * Positioning for close button
 */
const CloseAction = styled("div", {
  base: {
    flexGrow: 1,
    flexShrink: 0,
    padding: "80px 8px",
    visibility: "visible",
    position: "sticky",
    top: 0,

    "&:after": {
      content: '"ESC"',
      marginTop: "4px",
      display: "flex",
      justifyContent: "center",
      width: "40px",
      fontWeight: 600,
      color: "var(--md-sys-color-on-surface)",
      fontSize: "0.75rem",
    },

    _tablet: {
      display: "none",
    },
  },
});
