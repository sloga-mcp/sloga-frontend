import type { Plugin } from "unified";
import { visit } from "unist-util-visit";

/**
 * Inline mdast node inside a paragraph: text nodes carry a `value`, every
 * other node (strong, emphasis, mention, channel, link, ...) passes through
 */
type InlineNode = {
  type: string;
  value?: string;
  children?: InlineNode[];
};

type TextNode = InlineNode & { type: "text"; value: string };

const DELIMITER = "||";

function isText(node: InlineNode): node is TextNode {
  return node.type === "text" && typeof node.value === "string";
}

/**
 * Only Unicode whitespace (NBSP included) and zero-width characters.
 *
 * One character class, never an alternation: `\s` already matches U+FEFF,
 * and overlapping alternatives under `*` backtrack exponentially on a long
 * run of them followed by any visible character
 */
const INVISIBLE_TEXT = /^[\s\u200b-\u200d\u2060\ufeff]*$/u;

/**
 * Whether a node shows nothing a reader could reveal: a line break, or text
 * made only of whitespace and zero-width characters
 */
function isInvisible(node: InlineNode): boolean {
  return (
    node.type === "break" || (isText(node) && INVISIBLE_TEXT.test(node.value))
  );
}

/**
 * Turn `||spoiler||` syntax inside paragraphs into `spoiler` nodes
 *
 * Inline children are scanned in order. Delimiters are only recognized in
 * text nodes, may appear anywhere (and several times) within one, and a
 * spoiler may span any inline nodes between its two delimiters. Each spoiler
 * is emitted in place, so the content around it keeps its order.
 *
 * An unclosed delimiter fails closed: everything after it, up to the end of
 * the paragraph, becomes a spoiler and the delimiter itself is not shown. If
 * nothing visible follows it (only whitespace, zero-width characters or line
 * breaks), the delimiter is dropped and no empty spoiler is made; any other
 * node (bold, code, a link, a mention, ...) counts as content. The renderer
 * this replaced silently dropped the text after an unclosed delimiter, so
 * already-sent messages (for example a spoiler spanning a blank line, which
 * splits into two paragraphs) must never become more visible than they were.
 * Hiding that text rather than dropping it also loses nothing: a click
 * reveals it.
 */
export const remarkSpoiler: Plugin = () => (tree) => {
  visit(tree, "paragraph", (node: { children: InlineNode[] }) => {
    if (
      !node.children.some(
        (child) => isText(child) && child.value.includes(DELIMITER),
      )
    )
      return;

    const output: InlineNode[] = [];

    // Children of the spoiler currently open, if any
    let open: InlineNode[] | undefined;

    for (const child of node.children) {
      if (!isText(child) || !child.value.includes(DELIMITER)) {
        (open ?? output).push(child);
        continue;
      }

      const parts = child.value.split(DELIMITER);

      // The original node is kept for its first part outside a spoiler
      let reused = false;

      for (let k = 0; k < parts.length; k++) {
        // Every delimiter after the first part toggles the spoiler state
        if (k > 0) {
          if (open) {
            output.push({ type: "spoiler", children: open });
            open = undefined;
          } else {
            open = [];
          }
        }

        if (open) {
          open.push({ type: "text", value: parts[k] });
        } else if (!reused) {
          child.value = parts[k];
          output.push(child);
          reused = true;
        } else {
          output.push({ type: "text", value: parts[k] });
        }
      }
    }

    // Unclosed delimiter: fail closed by hiding the rest of the paragraph,
    // unless nothing visible follows the delimiter
    if (open) {
      if (open.some((child) => !isInvisible(child))) {
        output.push({ type: "spoiler", children: open });
      } else {
        // No empty spoiler. The first child is the text that shared the
        // delimiter's node, which the replaced renderer dropped; every later
        // child (line breaks, whitespace) it kept in place, so keep it too
        output.push(...open.slice(1));
      }
    }

    node.children.splice(0, node.children.length, ...output);
  });
};
