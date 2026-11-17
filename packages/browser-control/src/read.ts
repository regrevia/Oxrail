/* The reading half of Browser Control: how a page becomes a few hundred words
 * instead of its whole DOM.
 *
 * Three shapes, one cost rule. `blocks` cuts the page into paragraphs that read
 * like prose (with the heading trail they sit under, their link density and a
 * quality score); `article` renders the reading column as Markdown; `evidence`
 * picks the sentences that answer a question using BM25, an inverse-document
 * frequency floor, a heading prior and maximal-marginal-relevance, so a second
 * sentence has to add something the first did not say.
 *
 * Everything that touches a page is an injectable expression string, kept as a
 * string on purpose: the same shape as `snapshotExpression` in `route.ts`, and a
 * pure expression can be unit-tested without a browser. Everything after that is
 * plain functions over the returned blocks — no model, no network, no new
 * dependency, and no second process.
 *
 * Provenance: the algorithms are absorbed from the person's own
 * `dsh-inner-browser-use` package (MIT, Copyright (c) 2026 regrevia) and adapted
 * to this package's types and naming. See `docs/adr/ADR-BROWSERCTL-002.md`.
 */

import type { Control } from "./types.js";

/** A paragraph, list item, table row or quote as the reader sees it. */
export interface Block {
  /** The nearest heading. */
  readonly h: string;
  /** The trail of headings: "Pricing › Refunds". */
  readonly p: string;
  /** The text itself, whitespace collapsed. */
  readonly t: string;
  /** How much of the text is link text, 0–1. */
  readonly d: number;
  /** How much it reads like prose, 0–1. */
  readonly q: number;
  /** 1 for a table row: data, not a sentence to distrust. */
  readonly r?: number;
}

/** One sentence that answers part of the query. */
export interface Passage {
  readonly text: string;
  readonly heading: string;
  readonly at: number;
  readonly step: number;
}

export interface PassageSet {
  readonly rows: readonly Passage[];
  readonly total: number;
  readonly matched: number;
}

/**
 * Cut the reading column into blocks, bounded by a character budget.
 * @param budget - how many characters of block text to collect at most; the
 * expression over-collects by a factor and the caller trims by quality.
 * @returns a page expression that returns JSON.
 */
export function blocksExpression(budget: number): string {
  return `(() => {
  const root = document.querySelector('article, main, [role="main"]') || document.body
  if (!root) return JSON.stringify({ blocks: [] })
  const limit = ${Math.max(200, Math.trunc(budget) || 200)}
  const guard = limit * 6
  const BLOCK = new Set(['P', 'LI', 'BLOCKQUOTE', 'PRE', 'FIGCAPTION', 'DD', 'DT', 'SUMMARY'])
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'IFRAME', 'CANVAS', 'VIDEO', 'HEADER', 'FOOTER', 'NAV', 'ASIDE', 'FORM', 'BUTTON', 'SELECT', 'TEXTAREA'])
  const out = []
  const seen = new Set()
  const stack = []
  let chars = 0
  const flatten = (text) => String(text ?? '').replace(/\\s+/g, ' ').trim()
  const trail = () => stack.filter((one) => one !== '').join(' \\u203a ')
  const said = () => stack.filter((one) => one !== '').pop() ?? ''
  /* How much of a block reads like prose rather than a list of links: ends of
     sentences per word, plus a length floor. One number, no dictionary. */
  const written = (text) => {
    const words = text.toLowerCase().match(/[a-z0-9]+|[\\u3400-\\u9fff]/g) ?? []
    if (words.length === 0) return 0
    const ends = text.match(/[.!?\\u3002\\uff01\\uff1f;\\uff1b]/g) ?? []
    return Math.min(1, (ends.length / words.length) * 12)
  }
  const quality = (text, density) => Math.round((0.45 * (1 - density) + 0.35 * written(text) + 0.2 * Math.min(1, text.length / 180)) * 100) / 100
  const push = (el) => {
    if (chars >= guard) return
    const text = flatten(el.innerText ?? el.textContent ?? '')
    if (text === '' || text.length > 4000) return
    let linkChars = 0
    for (const link of el.querySelectorAll('a')) linkChars += flatten(link.innerText ?? '').length
    if (el.tagName === 'A') linkChars += text.length
    const density = Math.min(1, linkChars / text.length)
    /* A block that is almost all link and short is a menu item, not a sentence;
       carrying it only spends the budget. */
    if (density >= 0.8 && text.length < 80) return
    out.push({ h: said(), p: trail(), t: text, d: Math.round(density * 100) / 100, q: quality(text, density) })
    chars += text.length
  }
  const row = (tr) => {
    if (chars >= guard) return
    const cells = Array.from(tr.children).filter((cell) => cell.tagName === 'TD' || cell.tagName === 'TH')
    const words = cells.map((cell) => flatten(cell.innerText ?? ''))
    if (words.filter((one) => one !== '').length < 2) return
    const table = tr.closest('table')
    const first = table === null ? null : table.querySelector('tr')
    const head = first === null || first === tr ? [] : Array.from(first.children).map((cell) => flatten(cell.innerText ?? ''))
    const line = words.map((one, at) => (head[at] === undefined || head[at] === '' || head[at] === one ? one : head[at] + ': ' + one)).join(' | ')
    out.push({ h: said(), p: trail(), t: line, d: 0, q: 0.95, r: 1 })
    chars += line.length
  }
  const walk = (el) => {
    if (el === null || chars >= guard) return
    const tag = el.tagName
    if (SKIP.has(tag) || el.hidden === true || el.getAttribute?.('aria-hidden') === 'true') return
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') return
    if (/^H[1-6]$/.test(tag)) {
      const level = Number(tag.slice(1))
      stack.length = level
      stack[level - 1] = flatten(el.innerText ?? '')
      return
    }
    if (tag === 'TR') {
      if (!seen.has(el)) { seen.add(el); row(el) }
      return
    }
    if (BLOCK.has(tag)) {
      if (!seen.has(el)) { seen.add(el); push(el) }
      return
    }
    for (const child of el.children) walk(child)
  }
  walk(root)
  const title = document.title
  /* The page arrives in document order, so a menu at the top would spend the
     whole budget before the article starts. Keep the blocks that read like
     content, still in page order, until the budget is spent. */
  let kept = out
  const total = out.reduce((sum, block) => sum + block.t.length, 0)
  if (total > limit) {
    const byQuality = out.map((block, at) => ({ block, at })).sort((a, b) => b.block.q - a.block.q || a.at - b.at)
    const keep = new Set()
    let used = 0
    for (const one of byQuality) {
      if (used + one.block.t.length > limit) continue
      keep.add(one.at)
      used += one.block.t.length
    }
    kept = out.filter((block, at) => keep.has(at))
  }
  return JSON.stringify({ title, blocks: kept })
})()`;
}

/**
 * The reading column as Markdown: headings, paragraphs, list items, links and
 * code, with no markup and no controls to number.
 * @param budget - character ceiling for the returned text.
 * @returns a page expression that returns JSON.
 */
export function articleExpression(budget: number): string {
  const limit = Math.max(400, Math.trunc(budget) || 400);
  return `(() => {
  const limit = ${limit}
  const pick = document.querySelector('article, main, [role="main"]') || document.body
  if (!pick) return JSON.stringify({ text: '', chars: 0, linkCount: 0, truncated: false })
  const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'IFRAME', 'CANVAS', 'VIDEO', 'HEADER', 'FOOTER', 'NAV', 'ASIDE'])
  const lines = []
  let length = 0
  let truncated = false
  let linkCount = 0
  const walk = (node) => {
    if (truncated || node === null || node === undefined) return
    if (node.nodeType === 3) {
      const text = String(node.textContent ?? '').replace(/\\s+/g, ' ').trim()
      if (text !== '') { lines.push(text); length += text.length + 1 }
      if (length >= limit) truncated = true
      return
    }
    if (node.nodeType !== 1) return
    const tag = node.tagName
    if (skip.has(tag) || node.hidden === true || node.getAttribute?.('aria-hidden') === 'true') return
    const style = getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden') return
    if (/^H[1-6]$/.test(tag)) {
      const text = String(node.innerText ?? '').replace(/\\s+/g, ' ').trim()
      if (text !== '') { lines.push('#'.repeat(Number(tag.slice(1))) + ' ' + text); length += text.length + Number(tag.slice(1)) + 2 }
      if (length >= limit) truncated = true
      return
    }
    if (tag === 'A') {
      linkCount += 1
      const text = String(node.innerText ?? '').replace(/\\s+/g, ' ').trim()
      const href = String(node.href ?? '')
      if (text !== '' && /^https?:/.test(href)) {
        const line = '[' + text.slice(0, 120) + '](' + href + ')'
        lines.push(line); length += line.length + 1
      } else if (text !== '') { lines.push(text); length += text.length + 1 }
      if (length >= limit) truncated = true
      return
    }
    if (tag === 'LI') {
      const text = String(node.innerText ?? '').replace(/\\s+/g, ' ').trim()
      if (text !== '') { lines.push('- ' + text); length += text.length + 3 }
      if (length >= limit) truncated = true
      return
    }
    if (tag === 'PRE' || tag === 'CODE') {
      const text = String(node.innerText ?? '').slice(0, 1200)
      if (text !== '') { lines.push('~~~'); lines.push(text); lines.push('~~~'); length += text.length + 8 }
      if (length >= limit) truncated = true
      return
    }
    for (const child of node.childNodes) walk(child)
  }
  walk(pick)
  let text = lines.filter((one) => one !== '').join(String.fromCharCode(10)).trim()
  if (text.length > limit) { text = text.slice(0, limit); truncated = true }
  return JSON.stringify({ text, chars: text.length, linkCount: document.querySelectorAll('a[href]').length, truncated })
})()`;
}

/** Words as the ranker sees them: ASCII runs, and every CJK character alone. */
const TOKEN = /[a-z0-9]+|[\u3400-\u9fff]/g;

/** How often a term may occur before it stops adding meaning. */
const SATURATION = 1.5;

/** A sentence ends at a full stop, a question mark, an exclamation or a
 * semicolon, including the CJK equivalents. */
const SENTENCE_BREAK = /(?<=[。！？；])|(?<=[.!?;])\s+/u;

/** "shipp" and "ship" are the same word; "class" and "clas" are not, so only a
 * consonant that was doubled can lose one letter. */
function undouble(word: string): string {
  return /([b-dfglmnprst])\1$/.test(word) ? word.slice(0, -1) : word;
}

/**
 * "refunds" and "refund" are the same idea; a light fold lets a question that
 * says one word find a page that says the other. Deliberately not a stemmer:
 * no dictionary, no suffix table beyond plurals and a trailing -ing/-ed.
 */
function fold(word: string): string {
  if (word.length <= 3 || /[0-9]/.test(word) || /[^a-z]/.test(word))
    return word;
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith("sses")) return word.slice(0, -2);
  /* "shipping" loses -ing and keeps a doubled consonant; "ship" does not, and
     the two must land on the same term or a question never finds its answer. */
  if (word.endsWith("ing") && word.length > 5)
    return undouble(word.slice(0, -3));
  if (word.endsWith("ed") && word.length > 4 && !word.endsWith("eed"))
    return undouble(word.slice(0, -2));
  if (word.endsWith("es") && word.length > 4) return word.slice(0, -2);
  if (
    word.endsWith("s") &&
    !word.endsWith("ss") &&
    !word.endsWith("us") &&
    !word.endsWith("is")
  )
    return word.slice(0, -1);
  return word;
}

/**
 * Cut text into comparable terms.
 * @param text - any text.
 * @returns lower-case terms.
 */
export function terms(text: string): string[] {
  const raw = String(text ?? "")
    .toLowerCase()
    .match(TOKEN);
  return (raw ?? []).map(fold);
}

/**
 * @param text - a paragraph.
 * @returns its sentences, trimmed.
 */
export function sentences(text: string): string[] {
  const raw = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (raw === "") return [];
  const out: string[] = [];
  for (const piece of raw.split(SENTENCE_BREAK)) {
    const one = piece.trim();
    if (one === "") continue;
    /* A full stop inside "e.g." leaves a fragment whose continuation starts
       lowercase; that is the one case where the break was not real. */
    const continues =
      /^[a-z(]/.test(one) || (out[out.length - 1]?.length ?? 0) < 4;
    if (out.length > 0 && continues)
      out[out.length - 1] = `${out[out.length - 1] ?? ""} ${one}`;
    else out.push(one);
  }
  return out;
}

/**
 * A passage short enough to show when nothing answers: one sentence or so,
 * whitespace collapsed, with an ellipsis saying it was cut.
 */
export function brief(value: unknown): string {
  const body = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return body.length > 260
    ? `${body.slice(0, 260).replace(/\s+\S*$/, "")}…`
    : body;
}

/**
 * The trail of headings a block sits under, when it says more than the nearest
 * one: "Pricing › Refunds" tells a caller where a fact lives, which a bare
 * sentence cannot.
 */
export function trailOf(block: { h?: string; p?: string }): string {
  const path = String(block.p ?? "");
  const near = String(block.h ?? "");
  if (path === "" || path === near || path.length > 90) return near;
  return path;
}

/**
 * Rank blocks against a query the way a search engine ranks a passage: BM25,
 * with the heading counted as a place a term can match.
 */
export function rank(
  blocks: readonly Block[],
  query: string,
): { block: Block; score: number }[] {
  const asked = terms(query);
  if (asked.length === 0) return [];
  const docs = blocks.map((block) => ({
    block,
    terms: terms(`${block.p ?? ""} ${block.h ?? ""} ${block.t}`),
  }));
  const average =
    docs.reduce((sum, one) => sum + one.terms.length, 0) /
    Math.max(1, docs.length);
  const seen = new Map<string, number>();
  for (const one of docs)
    for (const term of new Set(one.terms))
      seen.set(term, (seen.get(term) ?? 0) + 1);
  const total = Math.max(1, docs.length);
  const scored: { block: Block; score: number }[] = [];
  for (const one of docs) {
    const counts = new Map<string, number>();
    for (const term of one.terms) counts.set(term, (counts.get(term) ?? 0) + 1);
    let score = 0;
    for (const term of asked) {
      const seenIn = seen.get(term) ?? 0;
      if (seenIn === 0) continue;
      const idf = Math.log(1 + (total - seenIn + 0.5) / (seenIn + 0.5));
      const tf = counts.get(term) ?? 0;
      if (tf === 0) continue;
      const length = one.terms.length;
      score +=
        idf *
        ((tf * (SATURATION + 1)) /
          (tf + SATURATION * (1 - 0.75 + (0.75 * length) / average)));
    }
    /* A block that is nearly all link is a menu: it matches words without
       saying anything about them. */
    score *= 1 - 0.8 * Number(one.block.d ?? 0);
    /* Prose that answers a question outranks a fragment of navigation that
       happens to contain the same words; the quality number says which. */
    score *= 0.85 + 0.15 * Number(one.block.q ?? 0.5);
    if (score > 0) scored.push({ block: one.block, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * The sentences that answer a query, chosen the way a retriever picks evidence:
 * BM25 over sentences, a prior for the paragraph and heading they sit in, and
 * maximal-marginal-relevance so the second sentence adds something the first
 * did not say. Purely local — no model, no network.
 */
export function evidence(
  blocks: readonly Block[],
  query: string,
  options: {
    maxChars?: number;
    limit?: number;
    blocks?: number;
    lambda?: number;
  } = {},
): PassageSet {
  const typed = terms(query);
  if (typed.length === 0) return { rows: [], total: blocks.length, matched: 0 };
  const near = rank(blocks, query).slice(
    0,
    Math.max(1, Math.min(60, Number(options.blocks ?? 40))),
  );
  const units: {
    text: string;
    terms: string[];
    heading: string;
    at: number;
    step: number;
    prior: number;
    block: Block;
    score: number;
  }[] = [];
  for (const row of near) {
    const heading = trailOf(row.block);
    const parts = sentences(String(row.block.t ?? ""));
    for (let step = 0; step < parts.length; step += 1) {
      const spoken = terms(parts[step] ?? "");
      if (spoken.length === 0) continue;
      units.push({
        text: parts[step] ?? "",
        terms: spoken,
        heading,
        at: blocks.indexOf(row.block),
        step,
        prior: row.score,
        block: row.block,
        score: 0,
      });
    }
  }
  if (units.length === 0) return { rows: [], total: blocks.length, matched: 0 };
  const total = Math.max(1, units.length);
  const seen = new Map<string, number>();
  for (const unit of units)
    for (const term of new Set(unit.terms))
      seen.set(term, (seen.get(term) ?? 0) + 1);
  const average =
    units.reduce((sum, unit) => sum + unit.terms.length, 0) / total;
  /* A word the page says everywhere cannot point at anything: "to" is in every
     paragraph of a long article. Keep the terms that actually narrow the page;
     if the question is all common words, keep them all. */
  const weight = (term: string): number => {
    const inHowMany = seen.get(term) ?? 0;
    return inHowMany === 0
      ? 0
      : Math.log(1 + (total - inHowMany + 0.5) / (inHowMany + 0.5));
  };
  const sharp = typed.filter((term) => weight(term) >= 0.5);
  const asked = sharp.length > 0 ? sharp : typed;
  const askedWeight = asked.reduce((sum, term) => sum + weight(term), 0);
  for (const unit of units) {
    const counts = new Map<string, number>();
    for (const term of unit.terms)
      counts.set(term, (counts.get(term) ?? 0) + 1);
    let score = 0;
    let covered = 0;
    for (const term of asked) {
      const tf = counts.get(term) ?? 0;
      if (tf === 0) continue;
      covered += weight(term);
      score +=
        weight(term) *
        ((tf * (SATURATION + 1)) /
          (tf +
            SATURATION * (1 - 0.75 + (0.75 * unit.terms.length) / average)));
    }
    /* Matching one frequent word of a nine-word question is not evidence; the
       share of the question's weight the sentence actually answers is. */
    score *= covered / Math.max(1e-6, askedWeight);
    const headingHit = asked.filter((term) =>
      terms(unit.heading).includes(term),
    ).length;
    /* A menu sentence can match the words without saying anything about them;
       the paragraph's link density and how much it reads like prose tell the
       two apart, and a table row is data rather than a sentence to distrust. */
    const linkish =
      (1 - 0.8 * Number(unit.block.d ?? 0)) *
      (unit.block.r === 1 ? 1 : 0.9 + 0.1 * Number(unit.block.q ?? 0.5));
    unit.score =
      score *
      linkish *
      (1 + 0.25 * headingHit) *
      (1 + 0.5 * (unit.prior > 0 ? 1 : 0));
  }
  /* Below a fifth of the best sentence, a match is coincidence rather than
     evidence; carrying it only costs tokens. */
  const best = units.reduce((top, unit) => Math.max(top, unit.score), 0);
  for (const unit of units) if (unit.score < best * 0.2) unit.score = 0;
  const lambda = Math.max(0, Math.min(0.9, Number(options.lambda ?? 0.35)));
  const ceiling = Math.max(
    200,
    Math.min(24_000, Number(options.maxChars ?? 4_000)),
  );
  const limit = Math.max(1, Math.min(60, Number(options.limit ?? 24)));
  const chosen: typeof units = [];
  const left = units.filter((unit) => unit.score > 0);
  let used = 0;
  let lastHeading = "";
  while (left.length > 0 && chosen.length < limit) {
    let at = -1;
    let bestValue = -Infinity;
    for (let i = 0; i < left.length; i += 1) {
      const candidate = left[i] as (typeof units)[number];
      const spoken = new Set(candidate.terms);
      let overlap = 0;
      for (const picked of chosen) {
        const other = new Set(picked.terms);
        let shared = 0;
        for (const term of spoken) if (other.has(term)) shared += 1;
        overlap = Math.max(
          overlap,
          shared / Math.max(1, spoken.size + other.size - shared),
        );
      }
      const value = candidate.score * (1 - lambda) - lambda * overlap;
      if (value > bestValue) {
        bestValue = value;
        at = i;
      }
    }
    /* Once the best sentence left is no better than nothing — or is simply a
       repeat of one already picked — the answer is complete. */
    if (at < 0 || bestValue <= 0) break;
    const pick = left.splice(at, 1)[0] as (typeof units)[number];
    const heading =
      pick.heading !== lastHeading && pick.heading !== ""
        ? pick.heading.length + 8
        : 0;
    if (used + pick.text.length + heading > ceiling && chosen.length > 0) break;
    lastHeading = pick.heading;
    used += pick.text.length + heading;
    chosen.push(pick);
  }
  chosen.sort((a, b) => a.at - b.at || a.step - b.step);
  return {
    rows: chosen.map((one) => ({
      text: one.text,
      heading: one.heading,
      at: one.at,
      step: one.step,
    })),
    total: blocks.length,
    matched: chosen.length,
  };
}

/**
 * Markdown for the passages, with the heading trail printed once per group so
 * location costs one line instead of one per sentence.
 */
export function passagesToText(passages: PassageSet): string {
  const lines: string[] = [];
  let heading = "";
  for (const row of passages.rows) {
    if (row.heading !== "" && row.heading !== heading) {
      heading = row.heading;
      lines.push(`## ${heading}`);
    }
    lines.push(row.text);
  }
  return lines.join("\n");
}

/**
 * The difference between two reads, as the lines a caller has not seen yet.
 * Refs are stable across reads (see `snapshotExpression`), so an unchanged
 * control keeps its number and a delta is a delta rather than a renumbering.
 */
export function deltaOf(
  before: { text: string; controls: readonly Control[] },
  after: { text: string; controls: readonly Control[] },
): { text: string; controls: Control[] } {
  const known = new Set(
    before.controls.map((control) => `${control.ref}\u0000${control.name}`),
  );
  const controls = after.controls.filter(
    (control) => !known.has(`${control.ref}\u0000${control.name}`),
  );
  const seen = new Set(
    before.text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
  );
  const lines = after.text
    .split("\n")
    .filter((line) => line.trim() !== "" && !seen.has(line.trim()));
  return { text: lines.join("\n"), controls };
}
