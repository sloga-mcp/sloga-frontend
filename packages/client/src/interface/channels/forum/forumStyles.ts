import { styled } from "styled-system/jsx";

/**
 * Wrapping row of post tags. Shared by the forum card, row and table layouts.
 */
export const TagRow = styled("div", {
  base: {
    display: "flex",
    flexWrap: "wrap",
    gap: "var(--gap-sm)",
  },
});

/**
 * Single post tag pill. Shared by the forum card, row and table layouts.
 */
export const Tag = styled("span", {
  base: {
    padding: "1px var(--gap-md)",
    borderRadius: "var(--borderRadius-full)",
    background: "var(--md-sys-color-surface-container-highest)",
    fontSize: "0.75rem",
    whiteSpace: "nowrap",
  },
});

/**
 * Unread indicator dot. Shared by the forum card, row and table layouts.
 */
export const UnreadDot = styled("div", {
  base: {
    width: "8px",
    height: "8px",
    flexShrink: 0,
    borderRadius: "var(--borderRadius-circle)",
    background: "var(--md-sys-color-primary)",
  },
});

/**
 * Wraps a purely decorative avatar inside a role="link" card, row or table
 * row so it stays out of the link's accessible name. The avatar adds nothing
 * a screen reader needs: its image has no alt text, and a fallback (initials
 * or an icon ligature) would be read aloud. Render with aria-hidden="true".
 *
 * Flex keeps the slot exactly the avatar's size. Do not "simplify" it to
 * display: contents: older WebKit drops a display: contents element from the
 * accessibility tree along with its aria-hidden, which exposes the avatar
 * again. Shared by the forum card, row and table layouts.
 */
export const DecorativeSlot = styled("span", {
  base: {
    display: "flex",
    flexShrink: 0,
  },
});
