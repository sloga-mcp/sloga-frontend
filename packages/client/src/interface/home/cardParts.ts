import { styled } from "styled-system/jsx";

/**
 * Shared pieces of the Home cards. String tags only: wrapping an imported
 * component in `styled()` at module scope can boot the app to a blank page.
 */

/** One card on Home */
export const Panel = styled("section", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    minWidth: 0,
    padding: "12px 10px 10px",
    borderRadius: "16px",
    background: "var(--md-sys-color-surface-container)",
    color: "var(--md-sys-color-on-surface)",
  },
});

/** Title row of a card; leaves room on the right for the card's move/hide controls */
export const PanelHead = styled("div", {
  base: {
    minHeight: "32px",
    padding: "0 84px 0 6px",
    display: "flex",
    alignItems: "center",
    gap: "8px",
  },
});

export const PanelTitle = styled("h2", {
  base: {
    flex: 1,
    minWidth: 0,
    margin: 0,
    display: "flex",
    alignItems: "center",
    gap: "8px",
    fontSize: "15px",
    fontWeight: 700,
    color: "var(--md-sys-color-on-surface)",

    "& svg": {
      width: "18px",
      height: "18px",
      flexShrink: 0,
      fill: "currentColor",
    },
  },
});

/** Small text button in a card's title row, e.g. "See all" */
export const PanelLink = styled("button", {
  base: {
    flexShrink: 0,
    padding: "4px 6px",
    border: 0,
    borderRadius: "var(--borderRadius-sm)",
    background: "none",
    font: "inherit",
    fontSize: "12px",
    fontWeight: 600,
    color: "var(--md-sys-color-primary)",
    cursor: "pointer",

    "&:hover": { textDecoration: "underline" },
    "&:focus-visible": {
      outline: "2px solid var(--md-sys-color-primary)",
      outlineOffset: "2px",
    },
  },
});

export const List = styled("ul", {
  base: {
    margin: 0,
    padding: 0,
    listStyle: "none",
    display: "flex",
    flexDirection: "column",
  },
});

export const RowLink = styled("a", {
  base: {
    minHeight: "44px",
    padding: "6px 8px",
    display: "flex",
    alignItems: "center",
    gap: "10px",
    borderRadius: "10px",
    color: "inherit",
    textDecoration: "none",
    cursor: "pointer",

    "&:hover": {
      background: "var(--md-sys-color-surface-container-high)",
    },
    "&:focus-visible": {
      outline: "2px solid var(--md-sys-color-primary)",
      outlineOffset: "-2px",
    },
  },
});

/** A row that holds its own buttons, so it cannot itself be a link */
export const Row = styled("div", {
  base: {
    minHeight: "48px",
    padding: "6px 8px",
    display: "flex",
    alignItems: "center",
    gap: "10px",
    borderRadius: "10px",
  },
});

export const RowText = styled("div", {
  base: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
  },
});

export const RowName = styled("span", {
  base: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "14px",
    fontWeight: 600,
  },
});

export const RowMeta = styled("span", {
  base: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "12px",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

/** Message text under a mention; up to two lines */
export const RowQuote = styled("span", {
  base: {
    lineClamp: 2,
    fontSize: "13px",
    lineHeight: 1.4,
    color: "var(--md-sys-color-on-surface)",
    overflowWrap: "anywhere",
  },
});

/** Faces overlapping one another */
export const Faces = styled("div", {
  base: {
    display: "flex",
    flexShrink: 0,

    "& > * + *": { marginInlineStart: "-8px" },
  },
});

/** Round icon button inside a row, e.g. "Message" */
export const RowButton = styled("button", {
  base: {
    width: "36px",
    height: "36px",
    flexShrink: 0,
    display: "grid",
    placeItems: "center",
    border: 0,
    borderRadius: "var(--borderRadius-full)",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface-variant)",
    cursor: "pointer",

    "& svg": { fill: "currentColor" },
    "&:hover": {
      background: "var(--md-sys-color-surface-container-highest)",
      color: "var(--md-sys-color-on-surface)",
    },
    "&:focus-visible": {
      outline: "2px solid var(--md-sys-color-primary)",
      outlineOffset: "2px",
    },
  },
});

/** What a card says when it has nothing, with room for one action */
export const Empty = styled("div", {
  base: {
    padding: "4px 8px 6px",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "10px 16px",
    fontSize: "14px",
    lineHeight: 1.4,
    color: "var(--md-sys-color-on-surface-variant)",

    "& > span": { flex: "1 1 200px" },
  },
});
