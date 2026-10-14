import { type JSX, Accessor, Show } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { VirtualContainer } from "@minht11/solid-virtual-container";
import type { User } from "stoat.js";
import { cva } from "styled-system/css";

import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { FriendRow, ROW_HEIGHT } from "./FriendRow";

/**
 * Collapsible, virtualised section of the friends list. The caller owns the
 * collapse state, so sections can be keyed into whichever store holds it.
 */
export function FriendSection(props: {
  key: string;
  title: string;
  users: User[];
  collapsed: boolean;
  onToggle(): void;
  /**
   * Row for one user; a plain `FriendRow` when omitted. `tabIndex` is the
   * virtual list's roving tab stop and belongs on the row's root.
   */
  renderRow?: (u: User, tabIndex?: number) => JSX.Element;
  /** Shown instead of the rows when `users` is empty */
  empty?: JSX.Element;
  /** Element that scrolls the list, when it is not the section's own parent */
  scrollTarget?: Accessor<HTMLElement | undefined>;
}) {
  return (
    <>
      <div
        class={sectionHeader()}
        role="button"
        tabIndex={0}
        aria-expanded={!props.collapsed}
        data-section={props.key}
        onClick={() => props.onToggle()}
      >
        <Symbol size={18}>
          {props.collapsed ? "chevron_right" : "expand_more"}
        </Symbol>
        <span>
          {props.title} ({props.users.length})
        </span>
      </div>

      <Show when={!props.collapsed}>
        <Show when={props.users.length === 0}>
          {props.empty ?? (
            <div class={emptyRow()}>
              <Trans>Nobody here right now!</Trans>
            </div>
          )}
        </Show>

        <VirtualContainer
          items={props.users}
          scrollTarget={props.scrollTarget?.()}
          itemSize={{ height: ROW_HEIGHT }}
        >
          {(item) => (
            <div style={{ ...item.style, width: "100%" }}>
              {props.renderRow ? (
                props.renderRow(item.item, item.tabIndex)
              ) : (
                <FriendRow user={item.item} tabIndex={item.tabIndex} />
              )}
            </div>
          )}
        </VirtualContainer>
      </Show>
    </>
  );
}

const sectionHeader = cva({
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    paddingInline: "var(--gap-sm)",
    paddingBlock: "var(--gap-sm)",
    marginBlockStart: "var(--gap-sm)",
    cursor: "pointer",
    userSelect: "none",
    fontSize: "12px",
    fontWeight: 500,
    color: "var(--md-sys-color-on-surface-variant)",

    "&:hover": {
      color: "var(--md-sys-color-on-surface)",
    },
  },
});

const emptyRow = cva({
  base: {
    paddingInline: "var(--gap-sm)",
    paddingBlock: "var(--gap-sm)",
    fontSize: "13px",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});
