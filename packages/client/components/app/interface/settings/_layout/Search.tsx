import { Accessor, For, JSX, Show } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { css } from "styled-system/css";

import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { SettingsEntry } from "..";

import {
  SearchGroup,
  SearchRanges,
  fold,
  queryWords,
  splitByRanges,
} from "./searchMatch";

/**
 * Search box at the top of the settings sidebar
 */
export function SettingsSearchField(props: {
  query: Accessor<string>;
  setQuery: (query: string) => void;
  onSubmit: () => void;
}) {
  const { t } = useLingui();

  /**
   * A native listener, not Solid's delegated `onKeyDown`: the Escape that
   * clears the box has to stop before the window-level keybind handler sees
   * it and closes settings altogether.
   */
  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape" && props.query()) {
      event.preventDefault();
      event.stopPropagation();
      props.setQuery("");
    } else if (event.key === "Enter") {
      event.preventDefault();
      props.onSubmit();
    }
  }

  return (
    <div class={field} role="search">
      <Symbol size={20}>search</Symbol>
      <input
        class={input}
        type="text"
        inputmode="search"
        enterkeyhint="search"
        autocomplete="off"
        spellcheck={false}
        placeholder={t`Search`}
        aria-label={t`Search`}
        value={props.query()}
        onInput={(event) => props.setQuery(event.currentTarget.value)}
        on:keydown={onKeyDown}
      />
      <Show when={props.query()}>
        <button
          type="button"
          class={clear}
          aria-label={t`Clear search`}
          title={t`Clear search`}
          onClick={() => props.setQuery("")}
        >
          <Symbol size={18}>close</Symbol>
        </button>
      </Show>
    </div>
  );
}

/**
 * Search results, grouped by settings page
 */
export function SettingsSearchResults(props: {
  query: Accessor<string>;
  groups: Accessor<SearchGroup[]>;
  entry: (page: string) => SettingsEntry | undefined;
  onPick: (page: string, label?: string) => void;
}) {
  const { t } = useLingui();

  // A plain `query` identifier, so the message keeps its `{query}`
  // placeholder and matches the msgid already in the catalogs
  const noResults = () => {
    const query = props.query().trim();
    return t`No results for “${query}”.`;
  };

  return (
    <div class={results}>
      <Show
        when={props.groups().length}
        fallback={<span class={empty}>{noResults()}</span>}
      >
        <For each={props.groups()}>
          {(group) => (
            <div class={groupBox}>
              <button
                type="button"
                class={groupHeader}
                onClick={() => props.onPick(group.page)}
              >
                {iconCopy(props.entry(group.page)?.icon)}
                <span class={headerText}>
                  <Show
                    when={group.header}
                    fallback={iconCopy(props.entry(group.page)?.title)}
                  >
                    {(header) => (
                      <Highlighted
                        label={header().label}
                        ranges={header().ranges}
                      />
                    )}
                  </Show>
                </span>
                <Show when={props.entry(group.page)?.href}>
                  <Symbol size={16}>open_in_new</Symbol>
                </Show>
              </button>
              <For each={group.rows}>
                {(row) => (
                  <button
                    type="button"
                    class={rowButton}
                    onClick={() => props.onPick(group.page, row.label)}
                  >
                    <span class={rowText}>
                      <Highlighted label={row.label} ranges={row.ranges} />
                    </span>
                    <Symbol size={18}>chevron_right</Symbol>
                  </button>
                )}
              </For>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}

/**
 * The search title shown above the results
 */
export function SettingsSearchTitle() {
  return <Trans>Search</Trans>;
}

/**
 * A copy of a sidebar entry's icon.
 *
 * The entry holds one already-built DOM node, and a node can only be in one
 * place: inserting it here would pull it out of the sidebar row.
 */
function iconCopy(icon: JSX.Element) {
  return icon instanceof Node ? icon.cloneNode(true) : undefined;
}

/**
 * Label with the matched words marked
 */
function Highlighted(props: { label: string; ranges: SearchRanges }) {
  return (
    <For each={splitByRanges(props.label, props.ranges)}>
      {(part) =>
        part.hit ? <mark class={mark}>{part.text}</mark> : <>{part.text}</>
      }
    </For>
  );
}

const HIGHLIGHT = "settings-search";

let stopReveal: (() => void) | undefined;

/**
 * Stop any reveal in progress and remove the in-page word highlight
 */
export function clearSettingsReveal() {
  stopReveal?.();
  stopReveal = undefined;
}

/**
 * After jumping to a page from a search result: scroll the setting into view,
 * flash it, and mark the searched words on the page.
 *
 * The page is not there yet when this is called (the old one animates out
 * first), so it polls for a few seconds. Words are marked with the CSS Custom
 * Highlight API, which paints ranges without touching the DOM Solid owns;
 * browsers without it just skip that part.
 */
export function revealSetting(
  root: HTMLElement,
  query: string,
  label?: string,
) {
  clearSettingsReveal();

  const doc = root.ownerDocument;
  const view = doc.defaultView;
  if (!view) return;

  const words = queryWords(query);
  const started = view.performance.now();
  let timer: number | undefined;
  let cancelled = false;

  const tick = () => {
    if (cancelled) return;

    const elapsed = view.performance.now() - started;
    const content = root.querySelector(".settings_cont");
    let target = label ? findSetting(root, label) : undefined;

    // Wait for the page to render (and, briefly, for the setting on it)
    if (!content || (label && !target && elapsed < 1500)) {
      if (elapsed < 3000) timer = view.setTimeout(tick, 100);
      return;
    }

    // The setting is not on screen: some only show behind a toggle (Push to
    // Talk Key appears once Push to Talk is on). Go to where the searched
    // words are instead, so the jump still lands somewhere useful.
    if (label && !target) target = findWords(root, words);

    if (target) {
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      target.animate(
        [
          {
            boxShadow: "0 0 0 2px var(--md-sys-color-primary)",
            backgroundColor:
              "color-mix(in srgb, var(--md-sys-color-primary) 22%, transparent)",
          },
          { boxShadow: "0 0 0 2px transparent" },
        ],
        { duration: 2400, easing: "ease-out" },
      );
    }

    markWords(root, words);
  };

  // Past the outgoing page's 200 ms exit animation
  timer = view.setTimeout(tick, 260);

  stopReveal = () => {
    cancelled = true;
    view.clearTimeout(timer);
    highlights(doc)?.delete(HIGHLIGHT);
  };
}

/**
 * The row on the page that shows this label: an exact text match first, then
 * any text that contains it
 */
function findSetting(root: HTMLElement, label: string) {
  const content = root.querySelector(".settings_cont");
  if (!content) return;

  const wanted = fold(label.trim());
  const walker = root.ownerDocument.createTreeWalker(
    content,
    NodeFilter.SHOW_TEXT,
  );

  let partial: Text | undefined;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = fold((node as Text).data.trim());
    if (!text) continue;

    // Skip the page title above the content
    if ((node.parentElement as HTMLElement | null)?.closest(".title")) continue;

    if (text === wanted) return rowOf(node as Text);
    if (!partial && text.includes(wanted)) partial = node as Text;
  }

  return partial ? rowOf(partial) : undefined;
}

/**
 * The first row whose text has all the words, else the first with any of them
 */
function findWords(root: HTMLElement, words: string[]) {
  const content = root.querySelector(".settings_cont");
  if (!content || !words.length) return;

  const walker = root.ownerDocument.createTreeWalker(
    content,
    NodeFilter.SHOW_TEXT,
  );

  let some: Text | undefined;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if ((node.parentElement as HTMLElement | null)?.closest(".title")) continue;

    const text = fold((node as Text).data);
    if (words.every((word) => text.includes(word))) return rowOf(node as Text);
    if (!some && words.some((word) => text.includes(word))) some = node as Text;
  }

  return some ? rowOf(some) : undefined;
}

function rowOf(node: Text) {
  const element = node.parentElement!;
  return (
    (element.closest(
      "a, button, label, [role='button'], [role='switch'], [role='checkbox'], [role='radio'], mdui-checkbox, mdui-switch, mdui-radio",
    ) as HTMLElement | null) ?? element
  );
}

type HighlightRegistry = {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
};

function highlights(doc: Document): HighlightRegistry | undefined {
  const view = doc.defaultView as
    | (Window & {
        CSS?: { highlights?: HighlightRegistry };
        Highlight?: new (...ranges: Range[]) => unknown;
      })
    | null;
  return view?.Highlight ? view.CSS?.highlights : undefined;
}

/**
 * Mark every occurrence of the words in the page content
 */
function markWords(root: HTMLElement, words: string[]) {
  const doc = root.ownerDocument;
  const registry = highlights(doc);
  const content = root.querySelector(".settings_cont");
  if (!registry || !content || !words.length) return;

  ensureHighlightStyle(doc);

  const ranges: Range[] = [];
  const walker = doc.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = fold((node as Text).data);
    for (const word of words) {
      let from = 0;
      for (;;) {
        const at = text.indexOf(word, from);
        if (at === -1) break;
        const range = doc.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + word.length);
        ranges.push(range);
        from = at + word.length;
      }
    }
  }

  const HighlightCtor = (
    doc.defaultView as unknown as {
      Highlight: new (...ranges: Range[]) => unknown;
    }
  ).Highlight;
  registry.set(HIGHLIGHT, new HighlightCtor(...ranges));
}

/**
 * `::highlight()` can only be styled from a global rule
 */
function ensureHighlightStyle(doc: Document) {
  if (doc.getElementById("settings-search-highlight")) return;
  const style = doc.createElement("style");
  style.id = "settings-search-highlight";
  style.textContent = `::highlight(${HIGHLIGHT}) { background-color: color-mix(in srgb, var(--md-sys-color-primary) 40%, transparent); color: var(--md-sys-color-on-surface); }`;
  doc.head.append(style);
}

/**
 * Wrap results so the sidebar can show them on phones only
 */
export function PhoneOnly(props: { children: JSX.Element }) {
  return <div class={phoneOnly}>{props.children}</div>;
}

export const hideOnPhone = css({ _phone: { display: "none" } });

const phoneOnly = css({ display: "none", _phone: { display: "block" } });

const field = css({
  display: "flex",
  alignItems: "center",
  gap: "8px",
  height: "38px",
  padding: "0 6px 0 14px",
  marginInlineEnd: "12px",
  // Pill
  borderRadius: "999px",
  // Always drawn, not only on focus, so the box reads as a field at rest
  border: "1px solid var(--md-sys-color-outline)",
  background: "var(--md-sys-color-surface-container-highest)",
  color: "var(--md-sys-color-on-surface-variant)",
  transition: "border-color 0.1s, box-shadow 0.1s",

  // Inset, never outside the box: the sidebar's scroll container starts
  // exactly at this box's left edge and clips anything drawn beyond it
  "&:focus-within": {
    borderColor: "var(--md-sys-color-primary)",
    boxShadow: "inset 0 0 0 1px var(--md-sys-color-primary)",
  },
});

const input = css({
  flex: 1,
  minWidth: 0,
  height: "100%",
  border: "none",
  outline: "none",
  background: "transparent",
  color: "var(--md-sys-color-on-surface)",
  fontSize: "15px",
  fontFamily: "inherit",

  "&::placeholder": {
    color: "var(--md-sys-color-outline)",
  },
});

const clear = css({
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: "26px",
  height: "26px",
  padding: 0,
  border: "none",
  borderRadius: "50%",
  background: "transparent",
  color: "inherit",
  cursor: "pointer",

  "&:hover": {
    background: "var(--md-sys-color-surface-container-high)",
  },
});

const results = css({
  display: "flex",
  flexDirection: "column",
  gap: "12px",
});

const empty = css({
  padding: "12px 4px",
  color: "var(--md-sys-color-outline)",
});

const groupBox = css({
  display: "flex",
  flexDirection: "column",
  gap: "2px",
  padding: "6px",
  borderRadius: "16px",
  background: "var(--md-sys-color-surface-container)",
});

const buttonBase = {
  display: "flex",
  alignItems: "center",
  gap: "10px",
  width: "100%",
  minWidth: 0,
  border: "none",
  borderRadius: "10px",
  background: "transparent",
  color: "var(--md-sys-color-on-surface)",
  fontFamily: "inherit",
  textAlign: "start",
  cursor: "pointer",

  "&:hover": {
    background: "var(--md-sys-color-surface-container-high)",
  },
  "&:focus-visible": {
    outline: "2px solid var(--md-sys-color-primary)",
  },
} as const;

const groupHeader = css({
  ...buttonBase,
  padding: "8px 10px",
  fontSize: "15px",
  fontWeight: 600,

  // The sidebar colours its SVG icons through its own row styles, which the
  // copies shown here do not sit under
  "& svg": {
    flexShrink: 0,
    fill: "var(--md-sys-color-on-surface)",
  },
});

const rowButton = css({
  ...buttonBase,
  padding: "8px 10px 8px 40px",
  fontSize: "14px",
  color: "var(--md-sys-color-on-surface-variant)",
});

const headerText = css({
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});

const rowText = css({
  flex: 1,
  minWidth: 0,
});

const mark = css({
  background:
    "color-mix(in srgb, var(--md-sys-color-primary) 35%, transparent)",
  color: "var(--md-sys-color-on-surface)",
  borderRadius: "3px",
  padding: "0 1px",
});
