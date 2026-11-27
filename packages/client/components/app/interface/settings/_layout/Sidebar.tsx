import { Accessor, For, Setter, Show, onMount } from "solid-js";

import { styled } from "styled-system/jsx";

import { Column, OverflowingText, iconSize } from "@revolt/ui";

// import MdError from "@material-design-icons/svg/filled/error.svg?component-solid";
import MdOpenInNew from "@material-design-icons/svg/filled/open_in_new.svg?component-solid";

import { SettingsList } from "..";
import { SettingsSearch, useSettingsNavigation } from "../Settings";

import {
  PhoneOnly,
  SettingsSearchField,
  SettingsSearchResults,
  hideOnPhone,
} from "./Search";
import {
  SidebarButton,
  SidebarButtonContent,
  SidebarButtonIcon,
  SidebarButtonTitle,
} from "./SidebarButton";

/**
 * Settings Sidebar Layout
 */
export function SettingsSidebar(props: {
  list: Accessor<SettingsList<unknown>>;
  setPage: Setter<string | undefined>;
  page: Accessor<string | undefined>;
  search?: SettingsSearch;
  searching: Accessor<boolean>;
}) {
  const { navigate } = useSettingsNavigation();

  /**
   * Opening a page from the sidebar ends the search, or the results would
   * stay on screen in front of it
   */
  function open(entry: Parameters<typeof navigate>[0]) {
    props.search?.setQuery("");
    navigate(entry);
  }

  /**
   * Enter in the search box opens the best result
   */
  function openFirst() {
    const first = props.search?.groups()[0];
    if (first) props.search!.onPick(first.page, first.rows[0]?.label);
  }

  /**
   * Select first page on load
   *
   * Skips hidden categories and entries. The first entry of the first category
   * is a hidden stub on the user settings list, and category order is not
   * fixed, so taking [0][0] blindly can land on a page with no sidebar row.
   */
  onMount(() => {
    if (!props.page()) {
      const firstVisible = props
        .list()
        .entries.filter((category) => !category.hidden)
        .flatMap((category) => category.entries)
        .find((entry) => !entry.hidden && entry.id);

      props.setPage(firstVisible?.id);
    }
  });

  return (
    <Base class="settings_sidebar">
      <div use:invisibleScrollable>
        <Content class="content">
          <Column gap="lg">
            {props.list().prepend}
            <Show when={props.search}>
              {(search) => (
                <>
                  <SettingsSearchField
                    query={search().query}
                    setQuery={search().setQuery}
                    onSubmit={openFirst}
                  />
                  {/* Phones show one pane at a time, so the results take
                      the category list's place there; wider layouts show
                      them in the content pane beside the list. */}
                  <Show when={props.searching()}>
                    <PhoneOnly>
                      <SettingsSearchResults
                        query={search().query}
                        groups={search().groups}
                        entry={search().entry}
                        onPick={search().onPick}
                      />
                    </PhoneOnly>
                  </Show>
                </>
              )}
            </Show>
            <For each={props.list().entries}>
              {(category) => (
                <Show when={!category.hidden}>
                  <Column class={props.searching() ? hideOnPhone : undefined}>
                    <Show when={category.title}>
                      <CategoryTitle>{category.title}</CategoryTitle>
                    </Show>
                    <Column gap="s">
                      <For each={category.entries}>
                        {(entry) => (
                          <Show when={!entry.hidden}>
                            <SidebarButton
                              onClick={() => open(entry)}
                              aria-selected={
                                props.page()?.split("/")[0] ===
                                entry.id?.split("/")[0]
                              }
                            >
                              <SidebarButtonTitle>
                                {entry.icon}
                                <SidebarButtonContent>
                                  <OverflowingText>
                                    {entry.title}
                                  </OverflowingText>
                                </SidebarButtonContent>
                              </SidebarButtonTitle>
                              {/* An href entry leaves the app entirely; say so
                                  before the click rather than after it. */}
                              <Show when={entry.href}>
                                <SidebarButtonIcon>
                                  <MdOpenInNew
                                    {...iconSize(16)}
                                    fill="var(--md-sys-color-outline)"
                                  />
                                </SidebarButtonIcon>
                              </Show>
                            </SidebarButton>
                          </Show>
                        )}
                      </For>
                    </Column>
                  </Column>
                </Show>
              )}
            </For>
            {props.list().append}
          </Column>
        </Content>
      </div>
    </Base>
  );
}

/**
 * Base layout of the sidebar
 */
const Base = styled("div", {
  base: {
    display: "flex",
    flex: "1 0 218px",
    paddingLeft: "8px",
    justifyContent: "flex-end",
    height: "100%",

    _phone: {
      position: "absolute",
      width: "100vw",
      paddingLeft: "12px",

      "& > *": {
        width: "100%",
      },
    },
  },
});

/**
 * Aligned content within the sidebar
 */
const Content = styled("div", {
  base: {
    minWidth: "230px",
    maxWidth: "300px",
    padding: "74px 0 8px",
    display: "flex",
    gap: "2px",

    flexDirection: "column",

    "& a > div": {
      margin: 0,
    },

    _tablet: {
      padding: "8px 0",
    },
    _phone: {
      padding: "8px 0",
      maxWidth: "unset",
    },
  },
});

/**
 * Titles for each category
 */
const CategoryTitle = styled("span", {
  base: {
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",

    textTransform: "uppercase",
    fontSize: "0.75rem",
    fontWeight: 700,
    margin: "0 8px",
    marginInlineEnd: "20px",

    color: "var(--md-sys-color-outline)",
  },
});
