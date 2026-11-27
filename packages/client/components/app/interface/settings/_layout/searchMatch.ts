/**
 * Matching for the settings search box.
 *
 * Pure on purpose: no Solid, no DOM, no i18n. The caller hands in labels that
 * are already translated, so the same code matches in every language.
 */

/**
 * One searchable thing: a whole page, or one setting on a page
 */
export type SettingsSearchItem = {
  /**
   * Sidebar entry id the item lives on
   */
  page: string;

  /**
   * Text shown in the results (already translated)
   */
  label: string;

  /**
   * True for the page itself rather than a setting on it
   */
  isPage?: boolean;

  /**
   * Extra words that should find this item but are never shown
   */
  keywords?: string;
};

/**
 * Highlighted spans of a label, as [start, end) offsets into the label
 */
export type SearchRanges = [number, number][];

export type SearchRow = {
  label: string;
  ranges: SearchRanges;
};

export type SearchGroup = {
  page: string;

  /**
   * The page's own label, when the index has one
   */
  header?: SearchRow;

  /**
   * Settings on the page that matched (never the page item itself)
   */
  rows: SearchRow[];

  score: number;
};

/**
 * Lowercase and strip accents one UTF-16 unit at a time, so the result has
 * exactly the length of the input and offsets found in it are offsets into
 * the original label too. ("é" → "e", "Ü" → "u"; anything that would change
 * length is kept as it is.)
 */
export function fold(text: string): string {
  let out = "";
  for (const unit of text.split("")) {
    const folded = unit.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    out += folded.length === 1 ? folded : unit.toLowerCase().charAt(0) || unit;
  }
  return out;
}

/**
 * Split a query into folded words
 */
export function queryWords(query: string): string[] {
  return fold(query.trim())
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

/**
 * Every place any of the words occurs in the label, merged
 */
export function findRanges(label: string, words: string[]): SearchRanges {
  const folded = fold(label);
  const ranges: SearchRanges = [];

  for (const word of words) {
    let from = 0;
    for (;;) {
      const at = folded.indexOf(word, from);
      if (at === -1) break;
      ranges.push([at, at + word.length]);
      from = at + word.length;
    }
  }

  ranges.sort((a, b) => a[0] - b[0]);

  const merged: SearchRanges = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) {
      last[1] = Math.max(last[1], range[1]);
    } else {
      merged.push([range[0], range[1]]);
    }
  }

  return merged;
}

/**
 * Cut a label into plain and highlighted pieces
 */
export function splitByRanges(
  label: string,
  ranges: SearchRanges,
): { text: string; hit: boolean }[] {
  const parts: { text: string; hit: boolean }[] = [];
  let at = 0;

  for (const [start, end] of ranges) {
    if (start > at) parts.push({ text: label.slice(at, start), hit: false });
    parts.push({ text: label.slice(start, end), hit: true });
    at = end;
  }

  if (at < label.length) parts.push({ text: label.slice(at), hit: false });
  return parts;
}

/**
 * How well one word matches the label; 0 if it does not occur there
 */
function labelScore(folded: string, word: string): number {
  const at = folded.indexOf(word);
  if (at === -1) return 0;
  if (at === 0) return 30;

  // Start of a later word in the label
  if (/[\s\-/(]/.test(folded.charAt(at - 1))) return 20;
  return 10;
}

/**
 * Search the index and group the hits by page.
 *
 * An item matches when every word of the query occurs in its label, its
 * page's label or its keywords. Groups come back best first; inside a group,
 * rows keep the order of the index (which is the order on the page) unless
 * one is a clearly better match.
 */
export function searchSettings(
  items: SettingsSearchItem[],
  query: string,
  isVisible: (page: string) => boolean = () => true,
): SearchGroup[] {
  const words = queryWords(query);
  if (!words.length) return [];

  const pageLabels = new Map<string, string>();
  for (const item of items) {
    if (item.isPage && !pageLabels.has(item.page)) {
      pageLabels.set(item.page, item.label);
    }
  }

  const groups = new Map<string, SearchGroup>();
  const order: string[] = [];

  items.forEach((item, index) => {
    if (!isVisible(item.page)) return;

    const label = fold(item.label);
    const pageLabel = fold(pageLabels.get(item.page) ?? "");
    const keywords = fold(item.keywords ?? "");

    let score = 0;
    for (const word of words) {
      const inLabel = labelScore(label, word);
      if (inLabel) {
        score += inLabel;
      } else if (pageLabel.includes(word)) {
        score += 5;
      } else if (keywords.includes(word)) {
        score += 3;
      } else {
        return;
      }
    }

    if (label === words.join(" ")) score += 50;

    let group = groups.get(item.page);
    if (!group) {
      const header = pageLabels.get(item.page);
      group = {
        page: item.page,
        header:
          header === undefined
            ? undefined
            : { label: header, ranges: findRanges(header, words) },
        rows: [],
        score: 0,
      };
      groups.set(item.page, group);
      order.push(item.page);
    }

    group.score = Math.max(group.score, score);

    if (!item.isPage) {
      // Duplicate labels on one page (the same text in two sections) would
      // only show twice and lead to the same place
      if (!group.rows.some((row) => row.label === item.label)) {
        (group.rows as (SearchRow & { score: number; index: number })[]).push({
          label: item.label,
          ranges: findRanges(item.label, words),
          score,
          index,
        });
      }
    }
  });

  const result = order.map((page) => groups.get(page)!);

  for (const group of result) {
    const rows = group.rows as (SearchRow & { score: number; index: number })[];
    rows.sort((a, b) =>
      Math.abs(a.score - b.score) >= 20 ? b.score - a.score : a.index - b.index,
    );
    group.rows = rows.map(({ label, ranges }) => ({ label, ranges }));
  }

  // Stable: equal scores keep sidebar order
  return result
    .map((group, index) => ({ group, index }))
    .sort((a, b) => b.group.score - a.group.score || a.index - b.index)
    .map(({ group }) => group);
}
