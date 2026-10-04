// Specs for the `||spoiler||` syntax plugin — run with Node's built-in
// runner:
//   node --conditions=browser --test components/markdown/plugins/spoilerSyntax.test.ts
//
// Each case parses real markdown with remark-parse, runs `remarkSpoiler` over
// the tree and compares a compact rendering of the single paragraph: text
// renders as its value, `strong` as <B>…</B>, `emphasis` as <I>…</I>,
// `spoiler` as <S>…</S>, `inlineCode` in backticks, `break` as <BR> and
// `link` as <A url>…</A>.
//
// An unclosed `||` fails closed: the rest of its paragraph becomes a spoiler
// and the delimiter is not shown. If nothing visible follows it (only
// whitespace including NBSP, the zero-width characters U+200B, U+200C,
// U+200D, U+2060 and U+FEFF, or line breaks), the delimiter is dropped and
// no spoiler is made.
//
// Known limitations, documented here and deliberately NOT asserted:
// - `||||` yields an empty spoiler: the second delimiter closes the first.
// - An escaped `\|\|` still delimits. mdast resolves the escape while
//   parsing, so the text node the plugin sees holds a plain `||`.
// - An unclosed `||` followed only by invisible characters outside that set
//   (for example U+2800) still yields an empty-looking spoiler. It fails
//   closed, so the cost is cosmetic.
// The first two behave the same as the implementation this replaced.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { unified } from "unified";

import { remarkSpoiler } from "./spoilerSyntax.ts";

// Under --conditions=browser, micromark's entity decoder
// (decode-named-character-reference) resolves to its DOM build, which calls
// `document.createElement` at import time. Node has no DOM, so the parsers are
// imported only after a stub element is installed whose textContent echoes
// innerHTML: every named character reference then reads as invalid and stays
// literal text. No case below uses one.
const installedDocumentStub = typeof document === "undefined";
if (installedDocumentStub) {
  Object.assign(globalThis, {
    document: {
      createElement: () => ({
        innerHTML: "",
        get textContent() {
          return this.innerHTML;
        },
      }),
    },
  });
}

const { default: remarkParse } = await import("remark-parse");
const { default: remarkBreaks } = await import("remark-breaks");
const { default: remarkGfm } = await import("remark-gfm");

// The decoder keeps the element it created at import, so the stub can go now;
// leaving it would leak into other specs under --test-isolation=none.
if (installedDocumentStub) {
  delete (globalThis as { document?: unknown }).document;
}

/** Loose mdast node: only the fields these specs read */
type MdNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
};

/**
 * Parse markdown into an mdast tree.
 * @param markdown Source text
 * @param options `spoiler` runs `remarkSpoiler` (default true); `app` adds
 *   remark-breaks and remark-gfm, as the app's pipeline does
 */
function parse(
  markdown: string,
  options: { spoiler?: boolean; app?: boolean } = {},
): MdNode {
  const processor = unified().use(remarkParse);
  if (options.app) processor.use(remarkBreaks).use(remarkGfm);
  if (options.spoiler ?? true) processor.use(remarkSpoiler);
  return processor.runSync(processor.parse(markdown)) as unknown as MdNode;
}

/**
 * Parse markdown that must produce exactly one paragraph and return its
 * inline children.
 * @param markdown Source text
 * @param app Also use the app's remark-breaks + remark-gfm parser stack
 */
function paragraph(markdown: string, app = false): MdNode[] {
  const root = parse(markdown, { app });
  assert.equal(root.children?.length, 1, "expected a single block");
  const [block] = root.children!;
  assert.equal(block.type, "paragraph");
  return block.children!;
}

/**
 * Compact rendering of inline nodes, see the header comment.
 * @param nodes Inline nodes
 */
function render(nodes: MdNode[]): string {
  return nodes
    .map((node) => {
      const inner = () => render(node.children ?? []);
      switch (node.type) {
        case "text":
          return node.value;
        case "strong":
          return `<B>${inner()}</B>`;
        case "emphasis":
          return `<I>${inner()}</I>`;
        case "spoiler":
          return `<S>${inner()}</S>`;
        case "inlineCode":
          return `\`${node.value}\``;
        case "break":
          return "<BR>";
        case "link":
          return `<A ${node.url}>${inner()}</A>`;
        default:
          return `<${node.type}?>`;
      }
    })
    .join("");
}

/**
 * Count nodes of a type anywhere below the given nodes.
 * @param nodes Inline nodes
 * @param type Node type to count
 */
function count(nodes: MdNode[], type: string): number {
  return nodes.reduce(
    (total, node) =>
      total + (node.type === type ? 1 : 0) + count(node.children ?? [], type),
    0,
  );
}

/**
 * Assert no text node anywhere below the given nodes still holds a `||`.
 * @param nodes Inline nodes
 */
function assertNoDelimiterText(nodes: MdNode[]) {
  for (const node of nodes) {
    if (node.type === "text") {
      assert.ok(
        !node.value?.includes("||"),
        `stray delimiter in text node ${JSON.stringify(node.value)}`,
      );
    }
    assertNoDelimiterText(node.children ?? []);
  }
}

describe("remarkSpoiler", () => {
  it("hides a single spoiler", () => {
    const nodes = paragraph("a ||x|| b");
    assert.equal(render(nodes), "a <S>x</S> b");
    assert.deepEqual(
      nodes.map((node) => node.type),
      ["text", "spoiler", "text"],
    );
    assertNoDelimiterText(nodes);
  });

  it("hides two spoilers in one text node", () => {
    const nodes = paragraph("||a|| and ||b||");
    assert.equal(render(nodes), "<S>a</S> and <S>b</S>");
    assert.equal(count(nodes, "spoiler"), 2);
    assertNoDelimiterText(nodes);
  });

  it("keeps a spoiler after a formatted spoiler hidden and in order", () => {
    const nodes = paragraph("a ||**x**|| b ||secret|| c");
    assert.equal(render(nodes), "a <S><B>x</B></S> b <S>secret</S> c");
    assert.deepEqual(
      nodes
        .filter((node) => node.type !== "text" || node.value !== "")
        .map((node) => node.type),
      ["text", "spoiler", "text", "spoiler", "text"],
    );
    assertNoDelimiterText(nodes);
  });

  it("spans a spoiler across formatted and plain nodes", () => {
    const nodes = paragraph("||**a** b|| c");
    assert.equal(render(nodes), "<S><B>a</B> b</S> c");
    assert.equal(count(nodes, "spoiler"), 1);
    assertNoDelimiterText(nodes);
  });

  it("hides three spoilers with mixed nodes", () => {
    const nodes = paragraph("||*i*|| x ||**b** and `c`|| y ||z||");
    assert.equal(
      render(nodes),
      "<S><I>i</I></S> x <S><B>b</B> and `c`</S> y <S>z</S>",
    );
    assert.equal(count(nodes, "spoiler"), 3);
    assertNoDelimiterText(nodes);
  });

  it("handles spoilers at the start and end of a line", () => {
    const start = paragraph("||start|| tail");
    assert.equal(render(start), "<S>start</S> tail");
    assertNoDelimiterText(start);

    const end = paragraph("head ||end||");
    assert.equal(render(end), "head <S>end</S>");
    assertNoDelimiterText(end);

    const whole = paragraph("||**whole** line||");
    assert.equal(render(whole), "<S><B>whole</B> line</S>");
    assertNoDelimiterText(whole);
  });

  it("fails closed on an unclosed delimiter, hiding the rest", () => {
    const plain = paragraph("a || b");
    assert.equal(render(plain), "a <S> b</S>");
    assert.equal(count(plain, "spoiler"), 1);
    assertNoDelimiterText(plain);

    const formatted = paragraph("a || **b** c");
    assert.equal(render(formatted), "a <S> <B>b</B> c</S>");
    assert.equal(count(formatted, "spoiler"), 1);
    assertNoDelimiterText(formatted);
  });

  it("fails closed on a trailing unclosed delimiter after a spoiler", () => {
    const plain = paragraph("||a|| b ||c");
    assert.equal(render(plain), "<S>a</S> b <S>c</S>");
    assert.equal(count(plain, "spoiler"), 2);
    assertNoDelimiterText(plain);

    const formatted = paragraph("||a|| b ||**c** d");
    assert.equal(render(formatted), "<S>a</S> b <S><B>c</B> d</S>");
    assert.equal(count(formatted, "spoiler"), 2);
    assertNoDelimiterText(formatted);
  });

  it("fails closed per paragraph when a spoiler spans a blank line", () => {
    const blocks = parse("||line1\n\nline2||").children!;
    assert.deepEqual(
      blocks.map((block) => block.type),
      ["paragraph", "paragraph"],
    );

    const [first, second] = blocks.map((block) => block.children!);
    assert.equal(render(first), "<S>line1</S>");
    assert.equal(count(first, "spoiler"), 1);
    assertNoDelimiterText(first);

    assert.equal(render(second), "line2");
    assert.equal(count(second, "spoiler"), 0);
    assertNoDelimiterText(second);
  });

  it("drops an unclosed delimiter with nothing visible after it", () => {
    const bare = paragraph("x ||");
    assert.equal(render(bare), "x ");
    assert.equal(count(bare, "spoiler"), 0);
    assertNoDelimiterText(bare);

    const nbsp = paragraph("a ||\u00a0");
    assert.equal(render(nbsp), "a ");
    assert.equal(count(nbsp, "spoiler"), 0);
    assertNoDelimiterText(nbsp);

    const zeroWidth = paragraph("a ||\u200b");
    assert.equal(render(zeroWidth), "a ");
    assert.equal(count(zeroWidth, "spoiler"), 0);
    assertNoDelimiterText(zeroWidth);
  });

  it("hides visible text after an unclosed delimiter and NBSP", () => {
    const nodes = paragraph("a ||\u00a0b");
    assert.equal(render(nodes), "a <S>\u00a0b</S>");
    assert.equal(count(nodes, "spoiler"), 1);
    assertNoDelimiterText(nodes);
  });

  it("never splits inline code containing ||", () => {
    const alone = paragraph("`x||y`");
    assert.equal(render(alone), "`x||y`");
    assert.equal(count(alone, "spoiler"), 0);

    const inside = paragraph("||`a||b`|| c");
    assert.equal(render(inside), "<S>`a||b`</S> c");
    assert.equal(count(inside, "spoiler"), 1);

    const outside = paragraph("`p||q` ||s||");
    assert.equal(render(outside), "`p||q` <S>s</S>");
    assert.equal(count(outside, "spoiler"), 1);
  });

  it("leaves a link whose URL contains || untouched", () => {
    const beside = paragraph("[l](https://e.com/a||b) ||s||");
    assert.equal(render(beside), "<A https://e.com/a||b>l</A> <S>s</S>");

    const autolink = paragraph("<https://e.com/a||b>");
    assert.equal(
      render(autolink),
      "<A https://e.com/a||b>https://e.com/a||b</A>",
    );

    const markdown = "see [l](https://e.com/?q=a||b)";
    assert.deepEqual(parse(markdown), parse(markdown, { spoiler: false }));
  });

  it("returns a paragraph without || unchanged", () => {
    const markdown = "plain **bold** _em_ `code` [l](https://e.com) a | b";
    assert.deepEqual(parse(markdown), parse(markdown, { spoiler: false }));
    assert.deepEqual(
      parse(markdown, { app: true }),
      parse(markdown, { app: true, spoiler: false }),
    );
  });

  it("works under the app's parser stack (breaks + gfm)", () => {
    const inline = paragraph("a ||**x**|| b ||secret|| c", true);
    assert.equal(render(inline), "a <S><B>x</B></S> b <S>secret</S> c");
    assertNoDelimiterText(inline);

    const multiline = paragraph("||a\nb|| c ||d||", true);
    assert.equal(render(multiline), "<S>a<BR>b</S> c <S>d</S>");
    assertNoDelimiterText(multiline);
  });
});

// The plugin runs on every rendered message, including text nobody trusted,
// so no input may make it slow. An earlier INVISIBLE_TEXT regex overlapped
// `\s` with U+FEFF under `*`, and "hi ||" followed by about 40 U+FEFF and
// one visible character froze the renderer for hours.

/** Upper bound for one plugin pass over an adversarial input, in ms */
const TIME_BOUND_MS = 50;

const BOM = String.fromCodePoint(0xfeff);
const ZWSP = String.fromCodePoint(0x200b);
const WORD_JOINER = String.fromCodePoint(0x2060);
const NBSP = String.fromCodePoint(0xa0);

/**
 * Parse markdown, then time `remarkSpoiler` alone over the tree. Parsing is
 * left out of the timing so the bound measures the plugin, not remark-parse.
 * The plugin runs three times on fresh copies and the fastest run counts:
 * backtracking is slow on every run, a GC pause or a busy machine is not.
 * @param markdown Source text
 * @param app Also use the app's remark-breaks + remark-gfm parser stack
 */
function timedSpoiler(
  markdown: string,
  app = false,
): { root: MdNode; ms: number } {
  const parser = unified().use(remarkParse);
  if (app) parser.use(remarkBreaks).use(remarkGfm);
  const tree = parser.runSync(parser.parse(markdown));

  const spoiler = unified().use(remarkSpoiler);
  let root: MdNode | undefined;
  let ms = Infinity;
  for (let run = 0; run < 3; run++) {
    // The plugin rewrites the tree in place
    const copy = structuredClone(tree);
    const start = performance.now();
    root = spoiler.runSync(copy) as unknown as MdNode;
    ms = Math.min(ms, performance.now() - start);
  }
  return { root: root!, ms };
}

const ADVERSARIAL: { name: string; markdown: string; app?: boolean }[] = [
  {
    name: "2000 U+FEFF then visible text after an unclosed ||",
    markdown: "hi ||" + BOM.repeat(2000) + "x",
  },
  {
    name: "2000 U+FEFF and nothing visible after an unclosed ||",
    markdown: "hi ||" + BOM.repeat(2000),
  },
  {
    name: "a mixed whitespace and zero-width run then text",
    markdown:
      "||" + (BOM + ZWSP + WORD_JOINER + " " + NBSP + "\t").repeat(2000) + "x",
  },
  {
    name: "20000 spaces then text after an unclosed ||",
    markdown: "||" + " ".repeat(20000) + "x",
  },
  {
    name: "U+FEFF lines joined by line breaks after an unclosed ||",
    markdown: "||" + (BOM.repeat(50) + "\n").repeat(200) + BOM.repeat(50) + "x",
    app: true,
  },
  {
    name: "2001 delimiters, the last one unclosed",
    markdown: "||a ".repeat(2001),
  },
  {
    name: "4001 pipes in a row",
    markdown: "|".repeat(4001),
  },
  {
    name: "an unclosed || after every U+FEFF",
    markdown: (BOM + "||").repeat(3001) + "x",
    app: true,
  },
];

describe("remarkSpoiler on adversarial input", () => {
  // Compile the plugin's code paths before anything is timed
  timedSpoiler("a ||b|| c ||" + BOM + "d");

  for (const { name, markdown, app } of ADVERSARIAL) {
    it(`stays under ${TIME_BOUND_MS} ms: ${name}`, () => {
      const { root, ms } = timedSpoiler(markdown, app);
      assert.ok(
        ms < TIME_BOUND_MS,
        `took ${ms.toFixed(1)} ms (bound ${TIME_BOUND_MS} ms)`,
      );
      for (const block of root.children ?? []) {
        assertNoDelimiterText(block.children ?? []);
      }
    });
  }

  it("still hides the text after a long U+FEFF run", () => {
    const { root } = timedSpoiler("hi ||" + BOM.repeat(2000) + "x");
    const inline = root.children![0].children!;
    assert.equal(render(inline), "hi <S>" + BOM.repeat(2000) + "x</S>");
  });

  it("still makes no spoiler from a U+FEFF run alone", () => {
    const { root } = timedSpoiler("hi ||" + BOM.repeat(2000));
    const inline = root.children![0].children!;
    assert.equal(count(inline, "spoiler"), 0);
    assert.equal(render(inline), "hi ");
  });
});
