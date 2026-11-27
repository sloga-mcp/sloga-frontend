import {
  type JSX,
  Accessor,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  Setter,
  Show,
  useContext,
} from "solid-js";
import { Motion, Presence } from "solid-motionone";

import { Rerun } from "@solid-primitives/keyed";

import { useState } from "@revolt/state";

import { SettingsConfiguration, SettingsEntry, SettingsList } from ".";
import { SettingsContent } from "./_layout/Content";
import {
  clearSettingsReveal,
  revealSetting,
  SettingsSearchResults,
} from "./_layout/Search";
import { searchSettings } from "./_layout/searchMatch";
import { SettingsSidebar } from "./_layout/Sidebar";

/**
 * Sidebar search state, handed to the sidebar and the content pane
 */
export type SettingsSearch = {
  query: Accessor<string>;
  setQuery: (query: string) => void;
  groups: Accessor<ReturnType<typeof searchSettings>>;
  entry: (page: string) => SettingsEntry | undefined;
  onPick: (page: string, label?: string) => void;
};

export interface SettingsProps {
  /**
   * Close settings
   */
  onClose?: () => void;

  /**
   * Settings context
   */
  context: never;

  contentRef: Setter<HTMLDivElement | undefined>;
}

/**
 * Transition animation
 */
export type SettingsTransition = "normal" | "to-child" | "to-parent";

/**
 * Provide navigation to child components
 */
const SettingsNavigationContext = createContext<{
  page: Accessor<string | undefined>;
  navigate: (path: string | SettingsEntry) => void;
}>();

/**
 * Generic Settings component
 */
export function Settings(props: SettingsProps & SettingsConfiguration<never>) {
  const [page, setPage] = createSignal<undefined | string>(
    // eslint-disable-next-line
    (props.context as any)?.page,
  );
  const [transition, setTransition] =
    createSignal<SettingsTransition>("normal");

  /**
   * Navigate to a certain page
   */
  function navigate(entry: string | SettingsEntry) {
    let id;
    if (typeof entry === "object") {
      if (entry.onClick) {
        entry.onClick();
      } else if (entry.href) {
        window.open(entry.href, "_blank");
      } else if (entry.id) {
        id = entry.id;
      }
    } else {
      id = entry;
    }

    if (!id) return;

    const current = page();
    if (current?.startsWith(id)) {
      setTransition("to-parent");
    } else if (current && id.startsWith(current)) {
      setTransition("to-child");
    } else {
      setTransition("normal");
    }

    setPage(id);
  }

  const { diagDrawer } = useState();
  const [query, setQuery] = createSignal("");
  let contentEl: HTMLDivElement | undefined;

  /**
   * What the search box can find. Built here, inside the component, because
   * the index translates its labels.
   */
  const searchIndex = createMemo(() => props.searchIndex?.() ?? []);
  const searching = () => !!props.searchIndex && query().trim().length > 0;

  // The word highlight left on a page by a search result goes away as soon
  // as the user moves on, or starts a new search
  createEffect(on(page, clearSettingsReveal, { defer: true }));
  createEffect(
    on(query, (value) => value && clearSettingsReveal(), { defer: true }),
  );
  onCleanup(clearSettingsReveal);

  return (
    <SettingsNavigationContext.Provider
      value={{
        page,
        navigate,
      }}
    >
      <MemoisedList
        context={props.context}
        list={props.list}
        onClose={props.onClose}
      >
        {(list) => {
          /**
           * Entries the sidebar shows right now, by id. Search only finds
           * pages that have a visible row, so a result never opens a page
           * this build or account cannot use.
           */
          const visible = createMemo(() => {
            const entries = new Map<string, SettingsEntry>();
            for (const category of list().entries) {
              if (category.hidden) continue;
              for (const entry of category.entries) {
                if (!entry.hidden && entry.id) entries.set(entry.id, entry);
              }
            }
            return entries;
          });

          const groups = createMemo(() => {
            if (!searching()) return [];
            const shown = visible();
            return searchSettings(searchIndex(), query(), (id) =>
              shown.has(id),
            );
          });

          /**
           * Open a result: the page, then the setting on it
           */
          function onPick(id: string, label?: string) {
            const entry = visible().get(id);
            if (!entry) return;

            const words = query();
            setQuery("");

            if (entry.onClick || entry.href) {
              navigate(entry);
              return;
            }

            // Phones: slide over to the content pane, as a sidebar row does
            diagDrawer()?.setShown(true);
            navigate(entry);

            // After the page-change effect above, which would otherwise
            // cancel this reveal if it ran later in the same update
            queueMicrotask(() => {
              if (contentEl) revealSetting(contentEl, words, label);
            });
          }

          const search: SettingsSearch | undefined = props.searchIndex
            ? {
                query,
                setQuery,
                groups,
                entry: (id) => visible().get(id),
                onPick,
              }
            : undefined;

          return (
            <>
              <SettingsSidebar
                list={list}
                page={page}
                setPage={setPage}
                search={search}
                searching={searching}
              />
              <SettingsContent
                ref={(el) => {
                  contentEl = el;
                  props.contentRef(el);
                }}
                page={page}
                list={list}
                title={props.title}
                onClose={props.onClose}
                searching={searching}
              >
                <Show when={searching() && search} fallback={<SettingsPage />}>
                  {(search) => (
                    <SettingsSearchResults
                      query={search().query}
                      groups={search().groups}
                      entry={search().entry}
                      onPick={search().onPick}
                    />
                  )}
                </Show>
              </SettingsContent>
            </>
          );
        }}
      </MemoisedList>
    </SettingsNavigationContext.Provider>
  );

  /**
   * The current page, with its enter/exit animation
   */
  function SettingsPage() {
    return (
      <Presence exitBeforeEnter>
        <Rerun on={page}>
          {/*
                    No `visibility` manipulation here, deliberately.

                    A `to-child` / `to-parent` page used to render with
                    `visibility: hidden` and be revealed by a bare 250ms
                    `setTimeout` holding the ref. That timeout wrote to the
                    node it captured, so anything that replaced the element
                    inside the window revealed a node that was no longer on
                    screen and left the live pane present-but-invisible — a
                    blank settings page with the DOM fully intact. It is the
                    only mechanism in this surface that produces a blank
                    rather than a misplacement, so it is removed rather than
                    rescheduled.

                    Nothing is lost by removing it: `Presence exitBeforeEnter`
                    runs `createSwitchTransition` in "out-in" mode, which
                    *creates* the incoming element in a computed but only
                    inserts it once the outgoing element's exit animation has
                    finished — so there is no window in which this element is
                    in the document and unstyled. At insertion it already
                    carries its `initial` transform inline (motionone writes
                    `initial` into the style prop at creation), exactly as the
                    `normal` transition has always relied on.
                  */}
          <Motion.div
            initial={
              transition() === "normal"
                ? { opacity: 0, y: 50 }
                : transition() === "to-child"
                  ? {
                      x: "100vw",
                    }
                  : { x: "-100vw" }
            }
            animate={{
              opacity: 1,
              x: 0,
              y: 0,
            }}
            exit={
              transition() === "normal"
                ? undefined
                : transition() === "to-child"
                  ? {
                      x: "-100vw",
                    }
                  : { x: "100vw" }
            }
            transition={{
              duration: 0.2,
              easing: [0.17, 0.67, 0.58, 0.98],
            }}
          >
            {props.render({ page }, props.context)}
          </Motion.div>
        </Rerun>
      </Presence>
    );
  }
}

/**
 * Memoise the list but generate it within context
 */
function MemoisedList(props: {
  context: never;
  onClose?: () => void;
  list: (context: never, onClose?: () => void) => SettingsList<unknown>;
  children: (list: Accessor<SettingsList<unknown>>) => JSX.Element;
}) {
  /**
   * Generate list of categories / links
   */
  const list = createMemo(() => props.list(props.context, props.onClose));
  return <>{props.children(list)}</>;
}

/**
 * Use settings navigation context
 */
export const useSettingsNavigation = () =>
  useContext(SettingsNavigationContext)!;
