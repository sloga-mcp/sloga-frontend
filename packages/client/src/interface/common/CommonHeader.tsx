import { BiRegularChevronLeft, BiRegularChevronRight } from "solid-icons/bi";

import { JSX, Match, Show, Switch } from "solid-js";

import MdArrowBack from "@material-design-icons/svg/outlined/arrow_back.svg?component-solid";

import { useLingui } from "@lingui-solid/solid/macro";
import { css } from "styled-system/css";

import { useSlimMode } from "@revolt/client/useSlimMode";
import { useState } from "@revolt/state";
import { LAYOUT_SECTIONS } from "@revolt/state/stores/Layout";
import { useLayoutSides } from "@revolt/ui";

/**
 * Wrapper for header icons which adds the chevron on the
 * correct side for toggling sidebar (if on desktop) and
 * the hamburger icon to open sidebar (if on mobile).
 *
 * In Slim view on a wide layout the sidebar cannot be collapsed (it holds
 * the user bar, and with it Settings), so the icon is shown alone, with
 * nothing to toggle. On a phone the arrow still opens the drawer.
 */
export function HeaderIcon(props: { children: JSX.Element }) {
  const state = useState();
  const slim = useSlimMode();

  return (
    <Show
      when={slim() && !state.appDrawer()}
      fallback={<SidebarToggle>{props.children}</SidebarToggle>}
    >
      <div class={plain}>{props.children}</div>
    </Show>
  );
}

/**
 * The header icon as a sidebar toggle
 */
function SidebarToggle(props: { children: JSX.Element }) {
  const state = useState();
  const { t } = useLingui();
  const sides = useLayoutSides();
  // The chevrons point toward the sidebar they act on: inward to collapse,
  // outward to expand. That is "left" only while the nav is on the left.
  const navRight = () => sides().nav === "right";

  return (
    <div
      class={container}
      onClick={() => {
        const ad = state.appDrawer();
        if (ad) ad.setShown(false);
        else
          state.layout.toggleSectionState(
            LAYOUT_SECTIONS.PRIMARY_SIDEBAR,
            true,
          );
      }}
      use:floating={{
        tooltip: {
          placement: "bottom",
          content: t`Toggle main sidebar`,
        },
      }}
    >
      <Switch
        fallback={
          <>
            <Show
              when={navRight()}
              fallback={<BiRegularChevronRight size={20} />}
            >
              <BiRegularChevronLeft size={20} />
            </Show>
            {props.children}
          </>
        }
      >
        <Match when={state.appDrawer()}>
          <MdArrowBack />
        </Match>
        <Match
          when={state.layout.getSectionState(
            LAYOUT_SECTIONS.PRIMARY_SIDEBAR,
            true,
          )}
        >
          <Show when={navRight()} fallback={<BiRegularChevronLeft size={20} />}>
            <BiRegularChevronRight size={20} />
          </Show>
          {props.children}
        </Match>
      </Switch>
    </div>
  );
}

const container = css({
  display: "flex",
  cursor: "pointer",
  alignItems: "center",
});

const plain = css({
  display: "flex",
  alignItems: "center",
});
