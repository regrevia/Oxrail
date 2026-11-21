var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// packages/browser-control/src/types.ts
var RouteClosedError, StaleRefError;
var init_types = __esm({
  "packages/browser-control/src/types.ts"() {
    "use strict";
    RouteClosedError = class extends Error {
      name = "RouteClosedError";
    };
    StaleRefError = class extends Error {
      name = "StaleRefError";
    };
  }
});

// packages/browser-control/src/read.ts
function blocksExpression(budget) {
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
function articleExpression(budget) {
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
function undouble(word) {
  return /([b-dfglmnprst])\1$/.test(word) ? word.slice(0, -1) : word;
}
function fold(word) {
  if (word.length <= 3 || /[0-9]/.test(word) || /[^a-z]/.test(word))
    return word;
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith("sses")) return word.slice(0, -2);
  if (word.endsWith("ing") && word.length > 5)
    return undouble(word.slice(0, -3));
  if (word.endsWith("ed") && word.length > 4 && !word.endsWith("eed"))
    return undouble(word.slice(0, -2));
  if (word.endsWith("es") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("us") && !word.endsWith("is"))
    return word.slice(0, -1);
  return word;
}
function terms(text) {
  const raw = String(text ?? "").toLowerCase().match(TOKEN);
  return (raw ?? []).map(fold);
}
function sentences(text) {
  const raw = String(text ?? "").replace(/\s+/g, " ").trim();
  if (raw === "") return [];
  const out = [];
  for (const piece of raw.split(SENTENCE_BREAK)) {
    const one = piece.trim();
    if (one === "") continue;
    const continues = /^[a-z(]/.test(one) || (out[out.length - 1]?.length ?? 0) < 4;
    if (out.length > 0 && continues)
      out[out.length - 1] = `${out[out.length - 1] ?? ""} ${one}`;
    else out.push(one);
  }
  return out;
}
function trailOf(block) {
  const path2 = String(block.p ?? "");
  const near = String(block.h ?? "");
  if (path2 === "" || path2 === near || path2.length > 90) return near;
  return path2;
}
function rank(blocks, query) {
  const asked = terms(query);
  if (asked.length === 0) return [];
  const docs = blocks.map((block) => ({
    block,
    terms: terms(`${block.p ?? ""} ${block.h ?? ""} ${block.t}`)
  }));
  const average = docs.reduce((sum, one) => sum + one.terms.length, 0) / Math.max(1, docs.length);
  const seen = /* @__PURE__ */ new Map();
  for (const one of docs)
    for (const term of new Set(one.terms))
      seen.set(term, (seen.get(term) ?? 0) + 1);
  const total = Math.max(1, docs.length);
  const scored = [];
  for (const one of docs) {
    const counts = /* @__PURE__ */ new Map();
    for (const term of one.terms) counts.set(term, (counts.get(term) ?? 0) + 1);
    let score = 0;
    for (const term of asked) {
      const seenIn = seen.get(term) ?? 0;
      if (seenIn === 0) continue;
      const idf = Math.log(1 + (total - seenIn + 0.5) / (seenIn + 0.5));
      const tf = counts.get(term) ?? 0;
      if (tf === 0) continue;
      const length = one.terms.length;
      score += idf * (tf * (SATURATION + 1) / (tf + SATURATION * (1 - 0.75 + 0.75 * length / average)));
    }
    score *= 1 - 0.8 * Number(one.block.d ?? 0);
    score *= 0.85 + 0.15 * Number(one.block.q ?? 0.5);
    if (score > 0) scored.push({ block: one.block, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}
function evidence(blocks, query, options = {}) {
  const typed = terms(query);
  if (typed.length === 0) return { rows: [], total: blocks.length, matched: 0 };
  const near = rank(blocks, query).slice(
    0,
    Math.max(1, Math.min(60, Number(options.blocks ?? 40)))
  );
  const units = [];
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
        score: 0
      });
    }
  }
  if (units.length === 0) return { rows: [], total: blocks.length, matched: 0 };
  const total = Math.max(1, units.length);
  const seen = /* @__PURE__ */ new Map();
  for (const unit of units)
    for (const term of new Set(unit.terms))
      seen.set(term, (seen.get(term) ?? 0) + 1);
  const average = units.reduce((sum, unit) => sum + unit.terms.length, 0) / total;
  const weight = (term) => {
    const inHowMany = seen.get(term) ?? 0;
    return inHowMany === 0 ? 0 : Math.log(1 + (total - inHowMany + 0.5) / (inHowMany + 0.5));
  };
  const sharp = typed.filter((term) => weight(term) >= 0.5);
  const asked = sharp.length > 0 ? sharp : typed;
  const askedWeight = asked.reduce((sum, term) => sum + weight(term), 0);
  for (const unit of units) {
    const counts = /* @__PURE__ */ new Map();
    for (const term of unit.terms)
      counts.set(term, (counts.get(term) ?? 0) + 1);
    let score = 0;
    let covered = 0;
    for (const term of asked) {
      const tf = counts.get(term) ?? 0;
      if (tf === 0) continue;
      covered += weight(term);
      score += weight(term) * (tf * (SATURATION + 1) / (tf + SATURATION * (1 - 0.75 + 0.75 * unit.terms.length / average)));
    }
    score *= covered / Math.max(1e-6, askedWeight);
    const headingHit = asked.filter(
      (term) => terms(unit.heading).includes(term)
    ).length;
    const linkish = (1 - 0.8 * Number(unit.block.d ?? 0)) * (unit.block.r === 1 ? 1 : 0.9 + 0.1 * Number(unit.block.q ?? 0.5));
    unit.score = score * linkish * (1 + 0.25 * headingHit) * (1 + 0.5 * (unit.prior > 0 ? 1 : 0));
  }
  const best = units.reduce((top, unit) => Math.max(top, unit.score), 0);
  for (const unit of units) if (unit.score < best * 0.2) unit.score = 0;
  const lambda = Math.max(0, Math.min(0.9, Number(options.lambda ?? 0.35)));
  const ceiling = Math.max(
    200,
    Math.min(24e3, Number(options.maxChars ?? 4e3))
  );
  const limit = Math.max(1, Math.min(60, Number(options.limit ?? 24)));
  const chosen = [];
  let left = units.filter((unit) => unit.score > 0);
  if (left.length === 0) {
    const labels = [];
    for (const row of near) {
      const label = trailOf(row.block);
      if (label === "" || label.length > 200) continue;
      const said = terms(label);
      if (!asked.some((term) => said.includes(term))) continue;
      if (labels.some((one) => one.text === label)) continue;
      labels.push({
        text: label,
        terms: said,
        heading: "",
        at: blocks.indexOf(row.block),
        step: -1,
        prior: row.score,
        block: row.block,
        score: row.score
      });
    }
    left = labels;
  }
  const scored = left.length;
  let used = 0;
  let lastHeading = "";
  while (left.length > 0 && chosen.length < limit) {
    let at = -1;
    let bestValue = -Infinity;
    for (let i = 0; i < left.length; i += 1) {
      const candidate = left[i];
      const spoken = new Set(candidate.terms);
      let overlap = 0;
      for (const picked of chosen) {
        const other = new Set(picked.terms);
        let shared = 0;
        for (const term of spoken) if (other.has(term)) shared += 1;
        overlap = Math.max(
          overlap,
          shared / Math.max(1, spoken.size + other.size - shared)
        );
      }
      const value = candidate.score * (1 - lambda) - lambda * overlap;
      if (value > bestValue) {
        bestValue = value;
        at = i;
      }
    }
    if (at < 0 || bestValue <= 0) break;
    const pick = left.splice(at, 1)[0];
    const trail = pick.heading.length > TRAIL_CAP ? pick.heading.slice(0, TRAIL_CAP) : pick.heading;
    let heading = trail !== lastHeading && trail !== "" ? trail.length + 8 : 0;
    if (used + heading + PASSAGE_FLOOR > ceiling) {
      pick.heading = "";
      heading = 0;
    } else {
      pick.heading = trail;
    }
    const room = ceiling - used - heading;
    if (pick.text.length > room) {
      if (chosen.length > 0 || room < PASSAGE_FLOOR) break;
      pick.text = `${pick.text.slice(0, room - 1).trimEnd()}\u2026`;
    }
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
      step: one.step
    })),
    total: blocks.length,
    matched: scored
  };
}
function passagesToText(passages) {
  const lines = [];
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
function controlLines(controls) {
  const plain = (control) => `[${control.ref}] ${control.role} "${control.name}"`;
  const named = controls.filter((control) => control.name.trim() !== "");
  const out = [];
  const tail = /^(.*?)(\d+)$/;
  let at = 0;
  while (at < named.length) {
    const first = named[at];
    const head = tail.exec(first.name);
    let end = at;
    if (head !== null) {
      const base = (head[1] ?? "").trim();
      let last = Number(head[2]);
      while (end + 1 < named.length) {
        const next = named[end + 1];
        const step = tail.exec(next.name);
        if (step === null) break;
        if (next.role !== first.role) break;
        if (next.ref !== named[end].ref + 1) break;
        if ((step[1] ?? "").trim() !== base) break;
        if (Number(step[2]) !== last + 1) break;
        last = Number(step[2]);
        end += 1;
      }
    }
    const size = end - at + 1;
    if (size >= RUN_FLOOR) {
      const last = named[end];
      out.push(
        `[${first.ref}]-[${last.ref}] ${first.role} "${first.name}" .. "${last.name}" (${size} controls, one line)`
      );
      at = end + 1;
      continue;
    }
    for (let step = at; step <= end; step += 1)
      out.push(plain(named[step]));
    at = end + 1;
  }
  return out;
}
function relevant(controls, query, options = {}) {
  const named = controls.filter((control) => control.name.trim() !== "");
  const typed = terms(query);
  if (typed.length === 0 || named.length === 0)
    return { controls: [...controls], omitted: 0 };
  const asked = new Set(typed);
  const kept = named.filter(
    (control) => terms(control.name).some((term) => asked.has(term))
  );
  if (kept.length === 0) return { controls: [...controls], omitted: 0 };
  const ceiling = Math.max(
    200,
    Math.min(24e3, Number(options.maxChars ?? 4e3))
  );
  let used = 0;
  const rows = [];
  for (const control of kept) {
    const cost = control.role.length + control.name.length + 8;
    if (rows.length > 0 && used + cost > ceiling) break;
    used += cost;
    rows.push(control);
  }
  const omitted = controls.length - rows.length;
  return { controls: omitted > 0 ? rows : [...controls], omitted };
}
function deltaOf(before, after) {
  const known = new Set(
    before.controls.map((control) => `${control.ref}\0${control.name}`)
  );
  const controls = after.controls.filter(
    (control) => !known.has(`${control.ref}\0${control.name}`)
  );
  const seen = new Set(
    before.text.split("\n").map((line) => line.trim()).filter((line) => line !== "")
  );
  const lines = after.text.split("\n").filter((line) => line.trim() !== "" && !seen.has(line.trim()));
  return { text: lines.join("\n"), controls };
}
function squashUrl(url) {
  return url.length <= 2048 ? url : `${url.slice(0, 2048)}\u2026 (${url.length - 2048} more characters)`;
}
function formatSnapshot(snapshot) {
  const lines = [];
  if (snapshot.text !== "") lines.push(snapshot.text);
  for (const line of controlLines(snapshot.controls)) lines.push(line);
  if (lines.length === 0) lines.push("(blank page)");
  if (snapshot.url !== "") lines.push(`url: ${squashUrl(snapshot.url)}`);
  if (snapshot.title !== "") lines.push(`title: ${snapshot.title}`);
  if (snapshot.chars !== void 0) lines.push(`chars: ${snapshot.chars}`);
  if (snapshot.words !== void 0) lines.push(`words: ${snapshot.words}`);
  if (snapshot.matched !== void 0 && snapshot.total !== void 0)
    lines.push(`passages: ${snapshot.matched} of ${snapshot.total} blocks`);
  if ((snapshot.omitted ?? 0) > 0) {
    lines.push(
      `controls not shown: ${snapshot.omitted} (left out of this reading; their numbers still work)`
    );
  }
  if ((snapshot.blindFrames ?? 0) > 0) {
    lines.push(
      `frames not read: ${snapshot.blindFrames} (cross-origin, so the page cannot be read through here)`
    );
  }
  if (snapshot.truncated) {
    lines.push(`controls: ${snapshot.controls.length}`);
    if (snapshot.limit !== void 0) lines.push(`limit: ${snapshot.limit}`);
    lines.push("truncated: true");
  }
  return lines.join("\n");
}
var TOKEN, SATURATION, SENTENCE_BREAK, TRAIL_CAP, RUN_FLOOR, PASSAGE_FLOOR;
var init_read = __esm({
  "packages/browser-control/src/read.ts"() {
    "use strict";
    TOKEN = /[a-z0-9]+|[\u3400-\u9fff]/g;
    SATURATION = 1.5;
    SENTENCE_BREAK = /(?<=[。！？；])|(?<=[.!?;])\s+/u;
    TRAIL_CAP = 200;
    RUN_FLOOR = 8;
    PASSAGE_FLOOR = 40;
  }
});

// packages/browser-control/src/ws.ts
import { createHash, randomBytes } from "node:crypto";
import { connect } from "node:net";
function acceptKey(key) {
  return createHash("sha1").update(key + WEB_SOCKET_GUID).digest("base64");
}
function encodeFrame(opcode, payload, mask) {
  const maskKey = mask ? randomBytes(4) : null;
  const length = payload.length;
  const headerLength = length < 126 ? 2 : length < 65536 ? 4 : 10;
  const frame = Buffer.allocUnsafe(headerLength + (maskKey ? 4 : 0) + length);
  frame.writeUInt8(128 | opcode & 15, 0);
  let offset = 2;
  if (length < 126) {
    frame.writeUInt8((maskKey ? 128 : 0) | length, 1);
  } else if (length < 65536) {
    frame.writeUInt8((maskKey ? 128 : 0) | 126, 1);
    frame.writeUInt16BE(length, 2);
    offset = 4;
  } else {
    frame.writeUInt8((maskKey ? 128 : 0) | 127, 1);
    frame.writeBigUInt64BE(BigInt(length), 2);
    offset = 10;
  }
  if (!maskKey) {
    payload.copy(frame, offset);
    return frame;
  }
  maskKey.copy(frame, offset);
  offset += 4;
  for (let index = 0; index < length; index += 1) {
    const masked = payload.readUInt8(index) ^ maskKey.readUInt8(index % maskKey.length);
    frame.writeUInt8(masked, offset + index);
  }
  return frame;
}
function describeClose(payload) {
  if (payload.length < 2) return "ws: closed by the peer";
  const code = payload.readUInt16BE(0);
  const text = payload.subarray(2).toString("utf8").trim();
  return text.length > 0 ? `ws: closed by the peer (${code} ${text})` : `ws: closed by the peer (${code})`;
}
function parseLoopbackTarget(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`ws: not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "ws:") {
    throw new Error(
      `ws: only ws:// URLs are supported, got ${parsed.protocol}`
    );
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `ws: refusing to connect to ${parsed.hostname}; only 127.0.0.1 and localhost are allowed`
    );
  }
  const port = parsed.port.length > 0 ? Number.parseInt(parsed.port, 10) : 80;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`ws: invalid port in ${url}`);
  }
  return {
    host: parsed.hostname,
    port,
    path: `${parsed.pathname === "" ? "/" : parsed.pathname}${parsed.search}`
  };
}
function findHeaderEnd(buffer) {
  const crlf = buffer.indexOf("\r\n\r\n");
  if (crlf >= 0) return { index: crlf, length: 4 };
  const lf = buffer.indexOf("\n\n");
  if (lf >= 0) return { index: lf, length: 2 };
  return null;
}
function parseHandshake(head) {
  const lines = head.split("\r\n").flatMap((line) => line.split("\n"));
  const statusLine = (lines.shift() ?? "").trim();
  const statusMatch = /^HTTP\/\d\.\d\s+(\d{3})/.exec(statusLine);
  if (statusMatch === null) {
    throw new Error("ws: malformed handshake status line");
  }
  const status = Number.parseInt(statusMatch[1] ?? "", 10);
  let accept = "";
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (name === "sec-websocket-accept") {
      accept = line.slice(colon + 1).trim();
    }
  }
  return { status, accept };
}
async function connectWs(url, options = {}) {
  const target = parseLoopbackTarget(url);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const key = randomBytes(16).toString("base64");
  return await new Promise((resolve, reject) => {
    let settled = false;
    let buffer = Buffer.alloc(0);
    let timer;
    let socket;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    const onHandshakeData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = findHeaderEnd(buffer);
      if (end === null) {
        if (buffer.length > MAX_HEADER_BYTES) {
          fail(new Error("ws: handshake response headers are too large"));
        }
        return;
      }
      socket.off("data", onHandshakeData);
      socket.off("error", onHandshakeError);
      socket.off("close", onHandshakeClose);
      let handshake;
      try {
        handshake = parseHandshake(
          buffer.subarray(0, end.index).toString("latin1")
        );
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (handshake.status !== 101) {
        fail(new Error(`ws: handshake rejected with HTTP ${handshake.status}`));
        return;
      }
      const expected = acceptKey(key);
      if (handshake.accept !== expected) {
        fail(
          new Error(
            "ws: handshake returned an unexpected Sec-WebSocket-Accept"
          )
        );
        return;
      }
      settled = true;
      clearTimeout(timer);
      const wsSocket = new NetWsSocket(socket);
      wsSocket.pushData(buffer.subarray(end.index + end.length));
      resolve(wsSocket);
    };
    const onHandshakeError = (error) => {
      fail(new Error(`ws: ${error.message}`));
    };
    const onHandshakeClose = () => {
      fail(new Error("ws: socket closed during the handshake"));
    };
    socket = connect({ host: target.host, port: target.port });
    socket.on("data", onHandshakeData);
    socket.on("error", onHandshakeError);
    socket.on("close", onHandshakeClose);
    timer = setTimeout(() => {
      fail(new Error(`ws: handshake timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    socket.write(
      [
        `GET ${target.path} HTTP/1.1`,
        `Host: ${target.host}:${target.port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "",
        ""
      ].join("\r\n")
    );
  });
}
var WEB_SOCKET_GUID, DEFAULT_TIMEOUT_MS, MAX_FRAME_BYTES, MAX_HEADER_BYTES, MAX_BUFFERED_BYTES, LOOPBACK_HOSTS, CONTINUATION, TEXT, CLOSE, PING, PONG, WsProtocolError, FrameDecoder, NetWsSocket;
var init_ws = __esm({
  "packages/browser-control/src/ws.ts"() {
    "use strict";
    WEB_SOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    DEFAULT_TIMEOUT_MS = 1e4;
    MAX_FRAME_BYTES = 64 * 1024 * 1024;
    MAX_HEADER_BYTES = 64 * 1024;
    MAX_BUFFERED_BYTES = MAX_FRAME_BYTES + 14;
    LOOPBACK_HOSTS = /* @__PURE__ */ new Set(["127.0.0.1", "localhost"]);
    CONTINUATION = 0;
    TEXT = 1;
    CLOSE = 8;
    PING = 9;
    PONG = 10;
    WsProtocolError = class extends Error {
    };
    FrameDecoder = class {
      #buffered = Buffer.alloc(0);
      push(chunk) {
        this.#buffered = this.#buffered.length === 0 ? chunk : Buffer.concat([this.#buffered, chunk]);
        const frames = [];
        for (; ; ) {
          const next = this.#next();
          if (next === null) break;
          frames.push(next.frame);
          this.#buffered = next.rest;
        }
        if (this.#buffered.length > MAX_BUFFERED_BYTES) {
          throw new WsProtocolError("ws: unread frame bytes exceed the limit");
        }
        return frames;
      }
      #next() {
        const buffered = this.#buffered;
        if (buffered.length < 2) return null;
        const first = buffered.readUInt8(0);
        const second = buffered.readUInt8(1);
        const fin = (first & 128) !== 0;
        const opcode = first & 15;
        const masked = (second & 128) !== 0;
        let length = second & 127;
        let offset = 2;
        if (length === 126) {
          if (buffered.length < 4) return null;
          length = buffered.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffered.length < 10) return null;
          const declared = buffered.readBigUInt64BE(2);
          if (declared > BigInt(MAX_FRAME_BYTES)) {
            throw new WsProtocolError(
              `ws: frame of ${declared.toString()} bytes exceeds the 64 MiB limit`
            );
          }
          length = Number(declared);
          offset = 10;
        }
        if (length > MAX_FRAME_BYTES) {
          throw new WsProtocolError(
            `ws: frame of ${length} bytes exceeds the 64 MiB limit`
          );
        }
        if (masked)
          throw new WsProtocolError("ws: server frame must not be masked");
        if (buffered.length < offset + length) return null;
        return {
          frame: {
            fin,
            opcode,
            payload: buffered.subarray(offset, offset + length)
          },
          rest: buffered.subarray(offset + length)
        };
      }
    };
    NetWsSocket = class {
      #socket;
      #decoder = new FrameDecoder();
      #messageHandler = null;
      #closeHandler = null;
      #queued = [];
      #closed = false;
      #closeNotified = false;
      #closeReason = null;
      #fragments = null;
      #fragmentOpcode = 0;
      constructor(socket) {
        this.#socket = socket;
        socket.setNoDelay(true);
        socket.on("data", (chunk) => {
          this.#receive(chunk);
        });
        socket.on("error", (error) => {
          this.#shutdown(`ws: ${error.message}`);
        });
        socket.on("close", () => {
          this.#closed = true;
          this.#notifyClose(this.#closeReason ?? "ws: socket closed");
        });
      }
      pushData(chunk) {
        if (chunk.length > 0) this.#receive(chunk);
      }
      send(text) {
        if (this.#closed)
          throw new Error("ws: cannot send after the socket closed");
        this.#writeFrame(TEXT, Buffer.from(text, "utf8"));
      }
      onMessage(handler) {
        this.#messageHandler = handler;
        const queued = this.#queued;
        this.#queued = [];
        for (const text of queued) handler(text);
      }
      onClose(handler) {
        this.#closeHandler = handler;
        if (this.#closeNotified) handler(this.#closeReason ?? "ws: socket closed");
      }
      close() {
        if (this.#closed) return;
        this.#closed = true;
        try {
          this.#writeFrame(CLOSE, Buffer.alloc(0));
        } catch {
        }
        this.#socket.destroy();
        this.#notifyClose("ws: closed by the client");
      }
      #receive(chunk) {
        let frames;
        try {
          frames = this.#decoder.push(chunk);
        } catch (error) {
          this.#protocolFailure(error);
          return;
        }
        for (const frame of frames) this.#handleFrame(frame);
      }
      #handleFrame(frame) {
        if (frame.opcode >= CLOSE) {
          if (!frame.fin || frame.payload.length > 125) {
            this.#protocolFailure(new WsProtocolError("ws: bad control frame"));
            return;
          }
          if (frame.opcode === PING) {
            this.#writeFrame(PONG, frame.payload);
            return;
          }
          if (frame.opcode === PONG) return;
          if (frame.opcode !== CLOSE) {
            this.#protocolFailure(
              new WsProtocolError(`ws: unknown control opcode ${frame.opcode}`)
            );
            return;
          }
          const reason = describeClose(frame.payload);
          this.#closeReason = reason;
          try {
            this.#writeFrame(CLOSE, Buffer.alloc(0));
          } catch {
          }
          this.#shutdown(reason);
          return;
        }
        if (frame.opcode === CONTINUATION) {
          if (this.#fragments === null) {
            this.#protocolFailure(new WsProtocolError("ws: stray continuation"));
            return;
          }
          this.#fragments.push(frame.payload);
          if (frame.fin) this.#deliverFragment();
          return;
        }
        if (frame.fin) {
          this.#deliver(frame.opcode, frame.payload);
          return;
        }
        if (this.#fragments !== null) {
          this.#protocolFailure(
            new WsProtocolError("ws: fragment started inside a fragment")
          );
          return;
        }
        this.#fragments = [frame.payload];
        this.#fragmentOpcode = frame.opcode;
      }
      #deliverFragment() {
        const fragments = this.#fragments ?? [];
        const opcode = this.#fragmentOpcode;
        this.#fragments = null;
        this.#deliver(opcode, Buffer.concat(fragments));
      }
      #deliver(opcode, payload) {
        if (opcode !== TEXT) return;
        if (this.#closed) return;
        const text = payload.toString("utf8");
        if (this.#messageHandler !== null) this.#messageHandler(text);
        else this.#queued.push(text);
      }
      #writeFrame(opcode, payload) {
        this.#socket.write(encodeFrame(opcode, payload, true));
      }
      #protocolFailure(error) {
        if (this.#closed) return;
        const payload = Buffer.alloc(2);
        payload.writeUInt16BE(1002, 0);
        try {
          this.#writeFrame(CLOSE, payload);
        } catch {
        }
        this.#shutdown(
          error instanceof Error ? error.message : "ws: protocol failure"
        );
      }
      #shutdown(reason) {
        if (!this.#closed) {
          this.#closed = true;
          this.#socket.destroy();
        }
        this.#notifyClose(reason);
      }
      #notifyClose(reason) {
        if (this.#closeNotified) return;
        this.#closeNotified = true;
        this.#closeReason = reason;
        this.#closeHandler?.(reason);
      }
    };
  }
});

// packages/browser-control/src/cdp.ts
function toCdpError(error) {
  const failure3 = new Error(error.message ?? "cdp: request failed");
  if (error.code !== void 0) failure3.code = error.code;
  if (error.data !== void 0) failure3.data = error.data;
  return failure3;
}
var CLOSED_BEFORE, CdpConnection;
var init_cdp = __esm({
  "packages/browser-control/src/cdp.ts"() {
    "use strict";
    init_ws();
    CLOSED_BEFORE = "cdp: connection closed before ";
    CdpConnection = class _CdpConnection {
      #socket;
      #onError;
      #handlers = /* @__PURE__ */ new Map();
      #pending = /* @__PURE__ */ new Map();
      #nextId = 1;
      #closed = false;
      /**
       * Wraps an already-open socket. `connect` is the usual entry point; this is
       * public so the transport can be replaced in tests.
       */
      constructor(socket, options = {}) {
        this.#socket = socket;
        this.#onError = options.onError ?? (() => void 0);
        socket.onMessage((text) => {
          this.#receive(text);
        });
        socket.onClose(() => {
          this.#handleSocketClose();
        });
      }
      static async connect(wsUrl, options = {}) {
        const socket = await connectWs(
          wsUrl,
          options.timeoutMs === void 0 ? {} : { timeoutMs: options.timeoutMs }
        );
        return new _CdpConnection(socket, options);
      }
      get closed() {
        return this.#closed;
      }
      send(method, params, sessionId) {
        if (this.#closed)
          return Promise.reject(new Error("cdp: connection closed"));
        const id = this.#nextId;
        this.#nextId += 1;
        const message = { id, method };
        if (params !== void 0) message.params = params;
        if (sessionId !== void 0) message.sessionId = sessionId;
        return new Promise((resolve, reject) => {
          this.#pending.set(id, {
            method,
            resolve: (value) => {
              resolve(value);
            },
            reject
          });
          try {
            this.#socket.send(JSON.stringify(message));
          } catch (error) {
            this.#pending.delete(id);
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      }
      on(method, handler) {
        const handlers = this.#handlers.get(method);
        if (handlers === void 0) this.#handlers.set(method, [handler]);
        else handlers.push(handler);
      }
      close() {
        if (this.#closed) return;
        this.#closed = true;
        this.#rejectPending();
        try {
          this.#socket.close();
        } catch {
        }
      }
      #receive(text) {
        let message;
        try {
          message = JSON.parse(text);
        } catch (error) {
          this.#report(error);
          return;
        }
        if (typeof message.id === "number") {
          this.#settle(message.id, message);
          return;
        }
        if (typeof message.method === "string") {
          this.#dispatch(message.method, message.params ?? {});
        }
      }
      #settle(id, message) {
        const pending = this.#pending.get(id);
        if (pending === void 0) return;
        this.#pending.delete(id);
        if (message.error !== void 0) {
          pending.reject(toCdpError(message.error));
          return;
        }
        pending.resolve(message.result);
      }
      #dispatch(method, params) {
        const handlers = this.#handlers.get(method);
        if (handlers === void 0) return;
        for (const handler of handlers) {
          try {
            handler(params);
          } catch (error) {
            this.#report(error);
          }
        }
      }
      #handleSocketClose() {
        if (this.#closed) return;
        this.#closed = true;
        this.#rejectPending();
      }
      #rejectPending() {
        for (const [id, pending] of this.#pending) {
          this.#pending.delete(id);
          pending.reject(new Error(`${CLOSED_BEFORE}${pending.method} answered`));
        }
      }
      #report(error) {
        try {
          this.#onError(error);
        } catch {
        }
      }
    };
  }
});

// packages/browser-control/src/chrome.ts
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
function trimExcerpt(text) {
  return text.replace(/\s+/g, " ").trim().slice(-STDERR_EXCERPT_CHARS).trim();
}
function chromeBinary(env = process.env) {
  const override = env.OXRAIL_CHROME?.trim();
  if (override !== void 0 && override.length > 0) {
    if (!existsSync(override)) {
      throw new Error(
        `oxrail-browser: OXRAIL_CHROME points at ${override}, which does not exist`
      );
    }
    return { path: override, args: [] };
  }
  for (const candidate of MAC_BINARIES) {
    if (existsSync(candidate)) return { path: candidate, args: [] };
  }
  const searchPath = env.PATH ?? "";
  for (const directory of searchPath.split(path.delimiter)) {
    if (directory.length === 0) continue;
    for (const name of PATH_BINARIES) {
      const candidate = path.join(directory, name);
      if (existsSync(candidate)) return { path: candidate, args: [] };
    }
  }
  throw new Error(
    "oxrail-browser: no Chrome or Chromium found; install one or set OXRAIL_CHROME"
  );
}
function chromeArgs(options) {
  const windowSize = options.windowSize ?? DEFAULT_WINDOW_SIZE;
  const args = [];
  if (options.headless) args.push("--headless=new");
  args.push(
    `--user-data-dir=${options.userDataDir}`,
    "--remote-debugging-port=0",
    "--remote-allow-origins=*",
    "--no-first-run",
    "--no-default-browser-check",
    "--use-mock-keychain",
    "--disable-blink-features=AutomationControlled",
    "--disable-sync",
    "--disable-popup-blocking",
    "--hide-crash-restore-bubble",
    "--disable-session-crashed-bubble",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--disable-features=Translate,MediaRouter,OptimizationHints",
    `--window-size=${windowSize.width},${windowSize.height}`
  );
  if (options.extraFlags !== void 0) args.push(...options.extraFlags);
  return args;
}
function stateDir(env = process.env) {
  const override = env.OXRAIL_BROWSER_STATE_DIR?.trim();
  if (override !== void 0 && override.length > 0)
    return path.resolve(override);
  return path.join(homedir(), ".oxrail", "browser-control");
}
function profileName(profile) {
  const cleaned = profile.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").replace(/[.-]+$/, "");
  return cleaned.length > 0 ? cleaned.slice(0, 64) : "default";
}
function profileDir(profile, env = process.env) {
  const root = path.join(stateDir(env), "profiles");
  const directory = path.join(root, profileName(profile));
  const relative = path.relative(root, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `oxrail-browser: profile ${profile} escapes the profile root`
    );
  }
  return directory;
}
function clearStaleDevToolsPort(userDataDir) {
  rmSync(path.join(userDataDir, DEVTOOLS_PORT_FILE), { force: true });
}
function readDevToolsPort(userDataDir) {
  let text;
  try {
    text = readFileSync(path.join(userDataDir, DEVTOOLS_PORT_FILE), "utf8");
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);
  const port = Number.parseInt(lines[0]?.trim() ?? "", 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const wsPath = lines[1]?.trim() ?? "";
  return { port, path: wsPath.length > 0 ? wsPath : "/devtools/browser" };
}
function pollDelayMs(attempt) {
  if (attempt < 10) return 5;
  if (attempt < 25) return 40;
  return 100;
}
function deathMessage(death) {
  const how = death.signal !== null ? `signal ${death.signal}` : `exit code ${death.code ?? "unknown"}`;
  const stderr = trimExcerpt(death.stderr);
  const detail = stderr.length > 0 ? ` \u2014 ${stderr}` : "";
  return `oxrail-browser: Chrome ended before it opened a debugging port (${how} after ${death.ms} ms${detail})`;
}
async function waitForDevToolsPort(userDataDir, options = {}) {
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const isDead = options.isDead ?? (() => null);
  const sleep = options.sleep ?? defaultSleep;
  let elapsed = 0;
  let attempt = 0;
  for (; ; ) {
    const death = isDead();
    if (death !== null) throw new Error(deathMessage(death));
    const found = readDevToolsPort(userDataDir);
    if (found !== null) return found;
    if (elapsed >= deadlineMs) {
      throw new Error("oxrail-browser: Chrome did not open a debugging port");
    }
    const delay = Math.min(
      pollDelayMs(attempt),
      Math.max(deadlineMs - elapsed, 1)
    );
    await sleep(delay);
    elapsed += delay;
    attempt += 1;
  }
}
function stderrOffset(logPath) {
  try {
    const size = statSync(logPath).size;
    if (size > STDERR_LOG_LIMIT_BYTES) {
      truncateSync(logPath, 0);
      return 0;
    }
    return size;
  } catch {
    return 0;
  }
}
var DEVTOOLS_PORT_FILE, DEFAULT_DEADLINE_MS, DEFAULT_WINDOW_SIZE, STDERR_LOG_NAME, STDERR_LOG_LIMIT_BYTES, STDERR_EXCERPT_CHARS, GRACEFUL_EXIT_WAIT_MS, TERMINATE_WAIT_MS, KILL_WAIT_MS, MAC_BINARIES, PATH_BINARIES, ChromeProcess;
var init_chrome = __esm({
  "packages/browser-control/src/chrome.ts"() {
    "use strict";
    init_cdp();
    DEVTOOLS_PORT_FILE = "DevToolsActivePort";
    DEFAULT_DEADLINE_MS = 15e3;
    DEFAULT_WINDOW_SIZE = { width: 1280, height: 900 };
    STDERR_LOG_NAME = "browser.err.log";
    STDERR_LOG_LIMIT_BYTES = 1024 * 1024;
    STDERR_EXCERPT_CHARS = 240;
    GRACEFUL_EXIT_WAIT_MS = 400;
    TERMINATE_WAIT_MS = 2e3;
    KILL_WAIT_MS = 1e3;
    MAC_BINARIES = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium"
    ];
    PATH_BINARIES = [
      "google-chrome",
      "google-chrome-stable",
      "chromium",
      "chromium-browser",
      "chrome"
    ];
    ChromeProcess = class _ChromeProcess {
      pid;
      profile;
      headless;
      #child;
      #startedAt;
      #stderrLogPath;
      #stderrOffset;
      #wsUrl = null;
      #death = null;
      #exited = false;
      #exitWaiters = [];
      constructor(child, profile, headless, stderrLogPath, stderrOffsetBytes) {
        this.#child = child;
        this.pid = child.pid ?? null;
        this.profile = profile;
        this.headless = headless;
        this.#startedAt = Date.now();
        this.#stderrLogPath = stderrLogPath;
        this.#stderrOffset = stderrOffsetBytes;
        child.once("exit", (code, signal) => {
          this.#recordDeath(code, signal);
        });
        child.once("error", () => {
          this.#recordDeath(null, null);
        });
      }
      static async launch(options) {
        const env = options.env ?? process.env;
        const binary = options.binaryPath === void 0 ? chromeBinary(env) : { path: options.binaryPath, args: [] };
        if (!existsSync(binary.path)) {
          throw new Error(
            `oxrail-browser: Chrome binary not found at ${binary.path}`
          );
        }
        const userDataDir = profileDir(options.profile, env);
        mkdirSync(userDataDir, { recursive: true, mode: 448 });
        clearStaleDevToolsPort(userDataDir);
        const logs = stateDir(env);
        mkdirSync(logs, { recursive: true, mode: 448 });
        const logPath = path.join(logs, STDERR_LOG_NAME);
        const offset = stderrOffset(logPath);
        const args = chromeArgs({
          userDataDir,
          headless: options.headless,
          ...options.extraFlags === void 0 ? {} : { extraFlags: options.extraFlags },
          ...options.windowSize === void 0 ? {} : { windowSize: options.windowSize }
        });
        const logFd = openSync(logPath, "a", 384);
        let child;
        try {
          child = spawn(binary.path, args, {
            stdio: ["ignore", logFd, logFd],
            env
          });
        } finally {
          closeSync(logFd);
        }
        const chrome = new _ChromeProcess(
          child,
          options.profile,
          options.headless,
          logPath,
          offset
        );
        try {
          const port = await waitForDevToolsPort(userDataDir, {
            isDead: () => chrome.lastDeath()
          });
          chrome.#attachPort(port);
          return chrome;
        } catch (error) {
          await chrome.close();
          throw error;
        }
      }
      /** The browser-wide DevTools endpoint, known once the port file appeared. */
      get browserWsUrl() {
        if (this.#wsUrl === null) {
          throw new Error(
            "oxrail-browser: the debugging port was never discovered"
          );
        }
        return this.#wsUrl;
      }
      alive() {
        const child = this.#child;
        return child !== null && !this.#exited && child.exitCode === null && child.signalCode === null;
      }
      /** What the process reported when it ended, if it has ended. */
      lastDeath() {
        return this.#death;
      }
      /**
       * Releases the process. A protocol-level `Browser.close` lets Chrome flush
       * its profile; signals are only the fallback. This never throws and is safe
       * to call twice, because a leaked Chrome would outlive the route.
       */
      async close(options = {}) {
        const child = this.#child;
        if (child === null) return;
        try {
          if (this.#wsUrl !== null && this.alive()) {
            await this.#requestBrowserClose();
          }
          if (await this.#waitForExit(GRACEFUL_EXIT_WAIT_MS)) return;
          this.#signal(child, "SIGTERM");
          if (await this.#waitForExit(options.timeoutMs ?? TERMINATE_WAIT_MS)) {
            return;
          }
          this.#signal(child, "SIGKILL");
          await this.#waitForExit(KILL_WAIT_MS);
        } catch {
        } finally {
          this.#child = null;
        }
      }
      #attachPort(port) {
        const wsPath = port.path.startsWith("/") ? port.path : "/devtools/browser";
        this.#wsUrl = `ws://127.0.0.1:${port.port}${wsPath}`;
      }
      async #requestBrowserClose() {
        if (this.#wsUrl === null) return;
        let connection = null;
        try {
          connection = await CdpConnection.connect(this.#wsUrl, {
            timeoutMs: 2e3
          });
          await connection.send("Browser.close");
        } catch {
        } finally {
          connection?.close();
        }
      }
      #signal(child, signal) {
        try {
          child.kill(signal);
        } catch {
        }
      }
      async #waitForExit(ms) {
        if (!this.alive()) return true;
        return await new Promise((resolve) => {
          let settled = false;
          const finish = (exited) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(exited);
          };
          const timer = setTimeout(() => {
            finish(false);
          }, ms);
          this.#exitWaiters.push(() => {
            finish(true);
          });
          if (!this.alive()) finish(true);
        });
      }
      #recordDeath(code, signal) {
        if (this.#death !== null) return;
        this.#death = {
          code,
          signal,
          ms: Date.now() - this.#startedAt,
          // Only this run's appended bytes, and only the tail the message shows, so
          // a chatty Chrome cannot hold a megabyte of log in memory per route.
          stderr: trimExcerpt(this.#readAppendedStderr())
        };
        this.#exited = true;
        const waiters = this.#exitWaiters;
        this.#exitWaiters = [];
        for (const waiter of waiters) waiter();
      }
      #readAppendedStderr() {
        try {
          const contents = readFileSync(this.#stderrLogPath);
          if (this.#stderrOffset >= contents.length) return "";
          return contents.subarray(this.#stderrOffset).toString("utf8");
        } catch {
          return "";
        }
      }
    };
  }
});

// packages/browser-control/src/png.ts
import { inflateSync } from "node:zlib";
function decodePng(data) {
  for (let index = 0; index < SIGNATURE.length; index += 1)
    if (data[index] !== SIGNATURE[index])
      throw new Error("not a PNG: the signature does not match");
  let offset = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let interlace = 0;
  const parts = [];
  while (offset + 8 <= data.length) {
    const length = readUint32(data, offset);
    const type = String.fromCharCode(
      data[offset + 4] ?? 0,
      data[offset + 5] ?? 0,
      data[offset + 6] ?? 0,
      data[offset + 7] ?? 0
    );
    const body = data.subarray(offset + 8, offset + 8 + length);
    offset += 8 + length + 4;
    if (type === "IHDR") {
      width = readUint32(body, 0);
      height = readUint32(body, 4);
      depth = body[8] ?? 0;
      colorType = body[9] ?? 0;
      interlace = body[12] ?? 0;
    } else if (type === "IDAT") parts.push(body);
    else if (type === "IEND") break;
  }
  if (width <= 0 || height <= 0) throw new Error("PNG has no pixels");
  if (depth !== 8)
    throw new Error(`PNG bit depth ${depth} is not supported (8 only)`);
  if (interlace !== 0) throw new Error("interlaced PNG is not supported");
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (channels === 0)
    throw new Error(
      `PNG colour type ${colorType} is not supported (RGB, RGBA)`
    );
  const joined = Buffer.concat(parts.map((part) => Buffer.from(part)));
  const raw = inflateSync(joined);
  const stride = width * channels;
  const rgba = new Uint8Array(width * height * 4);
  let previous = new Uint8Array(stride);
  for (let row = 0; row < height; row += 1) {
    const start = row * (stride + 1);
    const filter = raw[start] ?? 0;
    const line = raw.subarray(start + 1, start + 1 + stride);
    const out = new Uint8Array(stride);
    for (let index = 0; index < stride; index += 1) {
      const left = index >= channels ? out[index - channels] ?? 0 : 0;
      const up = previous[index] ?? 0;
      const upLeft = index >= channels ? previous[index - channels] ?? 0 : 0;
      const value = line[index] ?? 0;
      let restored = value;
      if (filter === 1) restored = value + left;
      else if (filter === 2) restored = value + up;
      else if (filter === 3) restored = value + (left + up >> 1);
      else if (filter === 4) restored = value + paeth(left, up, upLeft);
      out[index] = restored & 255;
    }
    previous = out;
    for (let column = 0; column < width; column += 1) {
      const source = column * channels;
      const target = (row * width + column) * 4;
      rgba[target] = out[source] ?? 0;
      rgba[target + 1] = out[source + 1] ?? 0;
      rgba[target + 2] = out[source + 2] ?? 0;
      rgba[target + 3] = channels === 4 ? out[source + 3] ?? 255 : 255;
    }
  }
  return { width, height, rgba };
}
function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  if (toUp <= toUpLeft) return up;
  return upLeft;
}
function readUint32(data, at) {
  return ((data[at] ?? 0) << 24 | (data[at + 1] ?? 0) << 16 | (data[at + 2] ?? 0) << 8 | (data[at + 3] ?? 0)) >>> 0;
}
function toGrid(bitmap, cols, rows) {
  const across = Math.max(2, Math.min(64, Math.trunc(cols)));
  const down = Math.max(2, Math.min(96, Math.trunc(rows)));
  const out = [];
  const cellW = bitmap.width / across;
  const cellH = bitmap.height / down;
  for (let row = 0; row < down; row += 1) {
    const line = [];
    for (let col = 0; col < across; col += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      const x0 = Math.floor(col * cellW);
      const x1 = Math.min(
        bitmap.width,
        Math.max(x0 + 1, Math.floor((col + 1) * cellW))
      );
      const y0 = Math.floor(row * cellH);
      const y1 = Math.min(
        bitmap.height,
        Math.max(y0 + 1, Math.floor((row + 1) * cellH))
      );
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const at = (y * bitmap.width + x) * 4;
          const alpha = (bitmap.rgba[at + 3] ?? 255) / 255;
          r += (bitmap.rgba[at] ?? 0) * alpha + 255 * (1 - alpha);
          g += (bitmap.rgba[at + 1] ?? 0) * alpha + 255 * (1 - alpha);
          b += (bitmap.rgba[at + 2] ?? 0) * alpha + 255 * (1 - alpha);
          n += 1;
        }
      }
      if (n === 0) {
        line.push(" ");
        continue;
      }
      line.push(letterOf(r / n, g / n, b / n));
    }
    out.push(line);
  }
  return out;
}
function letterOf(r, g, b) {
  const light = (r * 299 + g * 587 + b * 114) / 1e3;
  if (light > 235) return " ";
  if (light > 200) return ".";
  const spread = Math.max(r, g, b) - Math.min(r, g, b);
  if (spread < 28) {
    if (light < 60) return "#";
    if (light < 120) return "+";
    return "-";
  }
  if (r >= g && r >= b) return light < 150 ? "R" : "r";
  if (g >= r && g >= b) return light < 150 ? "G" : "g";
  return light < 150 ? "B" : "b";
}
var SIGNATURE;
var init_png = __esm({
  "packages/browser-control/src/png.ts"() {
    "use strict";
    SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
  }
});

// packages/browser-control/src/route.ts
var route_exports = {};
__export(route_exports, {
  CdpBrowserRoute: () => CdpBrowserRoute,
  FRAME_BASE: () => FRAME_BASE,
  FRAME_SLOT: () => FRAME_SLOT,
  headlessFromEnv: () => headlessFromEnv,
  idleMs: () => idleMs,
  inspectBinary: () => inspectBinary,
  profileFromEnv: () => profileFromEnv,
  shotClip: () => shotClip,
  snapshotExpression: () => snapshotExpression,
  viewSize: () => viewSize
});
import {
  existsSync as existsSync2,
  mkdirSync as mkdirSync2,
  readdirSync,
  statSync as statSync2,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
function pointFrom(value) {
  const parts = value.split(",");
  if (parts.length !== 2)
    throw new Error(
      `a point must be "x,y" in pixels; got ${JSON.stringify(value)}`
    );
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y))
    throw new Error(
      `a point must be "x,y" in pixels; got ${JSON.stringify(value)}`
    );
  return { x, y };
}
function saidOf(result) {
  const first = result.content[0];
  return first === void 0 || first.type !== "text" ? "" : first.text;
}
function pointList(text) {
  const found = /* @__PURE__ */ new Set();
  for (const line of text.split("\n")) {
    const match = /^\s*(\d{1,3})[.):]\s+\S/.exec(line);
    if (match !== null) found.add(Number(match[1]));
  }
  return [...found].sort((a, b) => a - b);
}
function stateText(state) {
  return state.running ? `${state.url === "" ? "no page yet" : state.url} \u2014 ${state.title === "" ? "untitled" : state.title}` : "the browser is not running";
}
function normalizeName(value) {
  return value.replace(/\s+/gu, " ").trim().toLowerCase();
}
function idleMs(env = process.env) {
  const raw = Number(env.OXRAIL_BROWSER_IDLE_MS);
  if (!Number.isFinite(raw)) return DEFAULT_IDLE_MS;
  return Math.min(MAX_IDLE_MS, Math.max(MIN_IDLE_MS, Math.floor(raw)));
}
function headlessFromEnv(env = process.env) {
  return env.OXRAIL_BROWSER_HEADLESS === "1";
}
function shotClip(view, fullPage) {
  const width = Math.max(1, Math.round(view.width));
  if (fullPage) {
    return {
      x: 0,
      y: 0,
      width,
      height: Math.max(1, Math.round(view.documentHeight)),
      scale: 1
    };
  }
  return {
    x: Math.round(view.scrollX),
    y: Math.round(view.scrollY),
    width,
    height: Math.max(1, Math.round(view.height)),
    scale: 1
  };
}
function profileFromEnv(env = process.env) {
  const raw = env.OXRAIL_BROWSER_PROFILE;
  return raw !== void 0 && raw.trim() !== "" ? raw.trim() : "default";
}
function viewSize(env = process.env) {
  const match = /^(\d{3,4})x(\d{3,4})$/.exec(env.OXRAIL_BROWSER_VIEW ?? "");
  if (match === null) return { width: VIEW_WIDTH, height: VIEW_HEIGHT };
  return { width: Number(match[1]), height: Number(match[2]) };
}
function snapshotExpression(options) {
  const mode = JSON.stringify(options.mode);
  const maxChars = Math.max(400, Math.floor(options.maxChars));
  return `(() => {
  const MODE = ${mode};
  const MAX_CHARS = ${maxChars};
  const MAX_CONTROLS = 160;
  const MAX_NODES = 9000;

  /* An element inside a frame comes from another realm, where the main
     document's Element constructor does not match it; asking its own window
     for the constructor and for getComputedStyle is what keeps a framed
     control from being reported as invisible. */
  const visible = (el) => {
    const own = el && el.ownerDocument ? el.ownerDocument.defaultView : null;
    if (own === null) return false;
    if (!(el instanceof own.Element)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = own.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (style.opacity !== "" && Number(style.opacity) < 0.05) return false;
    return true;
  };

  const nameOf = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim() !== "") return aria.trim().slice(0, 160);
    const text = (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
    if (text !== "") return text.slice(0, 160);
    const title = el.getAttribute("title");
    if (title && title.trim() !== "") return title.trim().slice(0, 160);
    const placeholder = el.getAttribute("placeholder");
    if (placeholder && placeholder.trim() !== "") return placeholder.trim().slice(0, 160);
    const alt = el.getAttribute("alt");
    if (alt && alt.trim() !== "") return alt.trim().slice(0, 160);
    const value = el.value;
    if (typeof value === "string" && value.trim() !== "") return value.trim().slice(0, 160);
    return "";
  };

  const roleOf = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button") return "button";
      return "textbox";
    }
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    return "control";
  };

  /* A control keeps its number for as long as the element is on the page.
     Numbering a fresh list from 1 on every read would renumber the page each
     time anything above it appeared, and a delta between two reads would then
     report the renumbering as a change. The store lives on the window, so a
     navigation drops it along with the elements it points at. */
  const store = window.__oxrailRefs || {
    next: 1,
    byEl: new WeakMap(),
  };
  window.__oxrailRefs = store;
  const refOf = (el) => {
    const known = store.byEl.get(el);
    if (known !== undefined) return known;
    const ref = store.next;
    store.next += 1;
    store.byEl.set(el, ref);
    return ref;
  };

  let nodes = 0;
  let truncated = false;
  /* Which ceiling was hit, not just that one was: a caller told only
     "truncated" cannot tell a page with more controls than the read
     shows from one whose words were cut, and the two need different
     next moves. */
  let limit = "";
  const capped = (why) => { truncated = true; limit = why; };

  /* A document is not the whole page: components live in shadow roots, and a
     checkout, a player or a chat widget lives in an iframe. Reading only
     document.querySelectorAll would report such a page as having nothing to
     click, and a click tool would then be right and useless. */
  const SELECTOR = 'a[href],button,input,textarea,select,summary,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="tab"],[role="menuitem"],[contenteditable="true"],[tabindex]:not([tabindex="-1"])';

  /* Open shadow roots only. A closed one cannot be reached from here at all,
     and pretending otherwise would hide the gap instead of reporting it. */
  const rootsOf = (root, out, depth) => {
    if (depth > 4 || out.length >= 24) return out;
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) {
        out.push(el.shadowRoot);
        rootsOf(el.shadowRoot, out, depth + 1);
        if (out.length >= 24) break;
      }
    }
    return out;
  };

  const deepQuery = (root, selector) => {
    const found = [];
    const roots = [root];
    rootsOf(root, roots, 0);
    for (const one of roots) {
      for (const el of one.querySelectorAll(selector)) found.push(el);
      if (found.length >= 4000) return found;
    }
    return found;
  };

  /* Frames, in document order, same-origin only. A cross-origin frame throws on
     contentDocument; it is counted, not invented. */
  const frames = [];
  const unseen = [];
  const walkFrames = (doc, depth) => {
    if (depth > 2 || frames.length >= 8) return;
    for (const holder of doc.querySelectorAll("iframe,frame")) {
      let inside = null;
      try { inside = holder.contentDocument; } catch (error) { inside = null; }
      if (inside === null) { unseen.push(holder); continue; }
      if (frames.length >= 8) { unseen.push(holder); continue; }
      frames.push({ holder, doc: inside });
      walkFrames(inside, depth + 1);
    }
  };
  walkFrames(document, 0);
  if (unseen.length > 0) capped("frames");

  const offsetOf = (holder) => {
    let x = 0;
    let y = 0;
    let node = holder;
    let guard = 0;
    while (node !== null && node !== undefined && guard < 8) {
      const box = node.getBoundingClientRect();
      x += box.left + (node.clientLeft || 0);
      y += box.top + (node.clientTop || 0);
      const own = node.ownerDocument;
      const view = own === null ? null : own.defaultView;
      if (view === null || view === undefined) break;
      x -= view.scrollX || 0;
      y -= view.scrollY || 0;
      node = view.frameElement;
      guard += 1;
    }
    return { x, y };
  };

  const controls = [];
  const elements = [];
  /* A control inside a frame is numbered in its own document, because that is
     where the attribute has to be found again; the number a caller sees
     carries the frame, so a click knows which document to look in and which
     corner to add. */
  const collect = (root, slot) => {
    for (const el of deepQuery(root, SELECTOR)) {
      if (controls.length >= MAX_CONTROLS) { capped("controls"); return; }
      nodes += 1;
      if (nodes > MAX_NODES) { capped("nodes"); return; }
      if (!visible(el)) continue;
      const name = nameOf(el);
      if (name === "" && !el.hasAttribute("contenteditable") && el.tagName.toLowerCase() !== "input") continue;
      const local = refOf(el);
      el.setAttribute("data-oxrail-ref", String(local));
      elements.push(el);
      controls.push({
        ref: slot === 0 ? local : ${FRAME_BASE} + (slot - 1) * ${FRAME_SLOT} + local,
        role: roleOf(el),
        name,
        tag: el.tagName.toLowerCase(),
        frame: slot,
      });
    }
  };
  collect(document, 0);
  for (let slot = 1; slot <= frames.length; slot += 1) {
    if (controls.length >= MAX_CONTROLS) { capped("controls"); break; }
    collect(frames[slot - 1].doc, slot);
  }

  const body = document.body;
  let everything = body ? body.innerText || "" : "";
  /* A framed widget's words are part of the page for a reader: a price, an
     error, a login form. Frames after the first are labelled, because three
     silent paragraphs from three widgets read as one page. */
  for (let slot = 1; slot <= frames.length; slot += 1) {
    const inside = frames[slot - 1].doc;
    const said = inside.body ? (inside.body.innerText || "").replace(/\\s+/g, " ").trim() : "";
    if (said === "") continue;
    everything += "\\n\\n[frame " + slot + "] " + said.slice(0, 400);
  }
  let text = everything;
  /* Words, not characters: a page of Chinese is not four times longer than the
     same page in English, and a caller sizing a budget in characters will read
     four times too much of it. Same rule as the term counter in read.js. */
  const runs = everything.match(/[a-z0-9]+|[\\u3400-\\u9fff]/gi);
  const words = runs === null ? 0 : runs.length;
  if (text.length > MAX_CHARS) { text = text.slice(0, MAX_CHARS); capped("chars"); }
  text = text.replace(/\\n{3,}/g, "\\n\\n").trim();

  if (MODE === "links") {
    const links = [];
    const roots = [document];
    rootsOf(document, roots, 0);
    for (const root of roots) for (const el of root.querySelectorAll("a[href]")) {
      if (!visible(el)) continue;
      const name = nameOf(el);
      if (name === "") continue;
      links.push("- [" + name + "](" + el.href + ")");
      if (links.length >= 200) break;
    }
    text = links.length > 0 ? links.join("\\n") : "(no visible links)";
  }
  if (MODE === "forms") {
    const rows = [];
    for (const [at, el] of controls.entries()) {
      const node = elements[at];
      const value = node && typeof node.value === "string" ? node.value : "";
      const type = node ? (node.getAttribute("type") || "") : "";
      rows.push("[" + el.ref + "] " + el.role + (type ? ":" + type : "") + (value ? " = " + value : "") + (el.name ? " \u2014 " + el.name : ""));
    }
    text = rows.length > 0 ? rows.join("\\n") : "(no visible controls)";
  }

  /* A map is the shape of the page, not its words: the headings in order and
     the controls already numbered, so a caller can decide what to read next
     without having read anything yet. */
  if (MODE === "map") {
    const outline = [];
    const heads = [];
    const roots = [document];
    rootsOf(document, roots, 0);
    for (const root of roots) for (const el of root.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=\\"heading\\"]")) heads.push(el);
    for (const el of heads) {
      if (!visible(el)) continue;
      const depth = Number(el.tagName.slice(1)) || 2;
      const said = nameOf(el);
      if (said === "") continue;
      outline.push("#".repeat(Math.min(6, Math.max(1, depth))) + " " + said);
      if (outline.length >= 80) { capped("headings"); break; }
    }
    text = outline.length > 0 ? outline.join("\\n") : "(no headings)";
  }

  /* Every branch above builds its own text after the body budget was applied, so
     a page made of nothing but links, form values or headings would otherwise
     raise its own ceiling: the body was cut, then discarded, and the replacement
     was never measured. One guard covers every mode, and the next one too. */
  if (text.length > MAX_CHARS) { text = text.slice(0, MAX_CHARS); capped("chars"); }

  return {
    url: location.href,
    title: (document.title || "").slice(0, 200),
    text,
    controls,
    truncated,
    limit,
    blindFrames: unseen.length,
    words,
  };
})()`;
}
function capOf(raw) {
  return typeof raw === "string" && raw !== "" ? raw : void 0;
}
function inspectBinary(env = process.env) {
  const binary = (env.OXRAIL_CHROME ?? "").trim();
  if (binary !== "" && existsSync2(binary)) {
    return {
      path: binary,
      args: chromeArgs({ userDataDir: "", headless: true })
    };
  }
  throw new Error("set OXRAIL_CHROME to a Chrome or Chromium binary path");
}
var VIEW_WIDTH, VIEW_HEIGHT, DEFAULT_MAX_CHARS, DEFAULT_IDLE_MS, MAX_IDLE_MS, MIN_IDLE_MS, LOAD_TIMEOUT_MS, MARKS, FRAME_BASE, FRAME_SLOT, META_EXPRESSION, CdpBrowserRoute;
var init_route = __esm({
  "packages/browser-control/src/route.ts"() {
    "use strict";
    init_cdp();
    init_chrome();
    init_png();
    init_types();
    init_read();
    VIEW_WIDTH = 1280;
    VIEW_HEIGHT = 900;
    DEFAULT_MAX_CHARS = 6e3;
    DEFAULT_IDLE_MS = 5 * 6e4;
    MAX_IDLE_MS = 15 * 6e4;
    MIN_IDLE_MS = 6e4;
    LOAD_TIMEOUT_MS = 2e4;
    MARKS = ["fixed", "verified", "invalid", "open"];
    FRAME_BASE = 9e5;
    FRAME_SLOT = 1e5;
    META_EXPRESSION = `(() => {
  const body = document.body;
  const everything = body ? body.innerText || "" : "";
  const runs = everything.match(/[a-z0-9]+|[\\u3400-\\u9fff]/gi);
  return { url: location.href, title: (document.title || "").slice(0, 200), words: runs === null ? 0 : runs.length };
})()`;
    CdpBrowserRoute = class _CdpBrowserRoute {
      chrome = null;
      cdp = null;
      page = null;
      idleWindow;
      lastUse = 0;
      restTimer = null;
      profile;
      /* The mode of the running window, which a single `open({ headless })` can
         differ from the route's standing choice. Null when nothing is running, so
         a report never describes a window that is not there. */
      runningHeadless = null;
      /* The same for the profile: a one-shot `open({ profile })` runs a window out
         of another directory, and a report of "default" would send the next call
         looking for sign-ins that window never had. */
      runningProfile = null;
      headless;
      size;
      queue = Promise.resolve();
      closed = false;
      /** The previous read, so `mode: "changed"` can answer with a delta. */
      /** What the last `text`-shaped read said, for the `changed` mode. Only reads
       * that return the same projection update it: diffing an article against a
       * snapshot would report two different shapes as a change. It carries the
       * address because a page that navigated has nothing to diff against. */
      last = null;
      /** The numbers the last read handed out, and the page they were on.
       *
       * A write may only address a control by a number a read produced: this route
       * never takes a coordinate from a caller, and never guesses a point from a
       * picture, so the number is the whole address. Keeping the set is what makes
       * that a rule instead of a convention — an invented number, or one from a
       * page that has since navigated, is refused instead of landing on whatever
       * now happens to answer to it. */
      handed = null;
      /* What the page told us since it opened, kept here rather than in the page so
         a console line that scrolls away is still answerable. Bounded: a page that
         logs in a loop must not grow this process. */
      consoleLines = [];
      failedRequests = [];
      responses = [];
      played = [];
      dialogOpen = null;
      watching = false;
      /* A review round is a conversation that repeats, so what was already
         settled has to survive the round: otherwise the next round raises the
         same points again and the transcript grows without settling anything. */
      reviewRounds = 0;
      settled = /* @__PURE__ */ new Map();
      handoffAt = 0;
      lastGrid = null;
      constructor(options) {
        const env = options?.env ?? process.env;
        this.idleWindow = idleMs(env);
        this.profile = profileFromEnv(env);
        this.headless = headlessFromEnv(env);
        this.size = viewSize(env);
      }
      /** Tools must not interleave on one page; one queue keeps refs coherent. */
      serial(work) {
        const run = this.queue.then(work, work);
        this.queue = run.catch(() => void 0);
        return run;
      }
      touch() {
        this.lastUse = Date.now();
        this.armRest();
      }
      armRest() {
        if (this.restTimer !== null) clearTimeout(this.restTimer);
        this.restTimer = null;
        if (this.chrome === null) return;
        const wait = Math.max(1e3, this.lastUse + this.idleWindow - Date.now());
        this.restTimer = setTimeout(() => {
          this.restTimer = null;
          void this.close().catch(() => void 0);
        }, wait);
        this.restTimer.unref();
      }
      async ensure() {
        if (this.chrome === null || this.cdp === null || this.page === null) {
          throw new RouteClosedError(
            "browser is not open; call browser_open first"
          );
        }
        return { cdp: this.cdp, page: this.page };
      }
      async open(options = {}) {
        return this.serial(async () => {
          if (this.chrome !== null && this.cdp !== null && this.page !== null) {
            if (options.url !== void 0 && options.url !== "")
              await this.navigate(options.url);
            return this.state();
          }
          const profile = options.profile ?? this.profile;
          const headless = options.headless ?? this.headless;
          const dir = profileDir(profile);
          mkdirSync2(dir, { recursive: true });
          const chrome = await ChromeProcess.launch({
            headless,
            profile,
            ...process.env.OXRAIL_CHROME !== void 0 ? { binaryPath: process.env.OXRAIL_CHROME } : {},
            windowSize: this.size
          });
          this.chrome = chrome;
          this.runningHeadless = headless;
          this.runningProfile = profile;
          const cdp = await CdpConnection.connect(chrome.browserWsUrl, {
            timeoutMs: 1e4
          });
          this.cdp = cdp;
          const page = await this.attachPage(cdp);
          this.page = page;
          this.closed = false;
          this.touch();
          if (options.url !== void 0 && options.url !== "")
            await this.navigate(options.url);
          return this.state();
        });
      }
      async attachPage(cdp) {
        await cdp.send("Target.setDiscoverTargets", { discover: true });
        let targetId = null;
        for (let attempt = 0; attempt < 50 && targetId === null; attempt += 1) {
          const targets = await cdp.send("Target.getTargets");
          const page = targets.targetInfos.find((info) => info.type === "page");
          targetId = page?.targetId ?? null;
          if (targetId === null)
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        if (targetId === null) {
          const created = await cdp.send(
            "Target.createTarget",
            { url: "about:blank" }
          );
          targetId = created.targetId;
        }
        const attached = await cdp.send(
          "Target.attachToTarget",
          {
            targetId,
            flatten: true
          }
        );
        const sessionId = attached.sessionId;
        await cdp.send("Page.enable", {}, sessionId);
        await cdp.send("Runtime.enable", {}, sessionId);
        return { sessionId, targetId };
      }
      async navigate(url) {
        const { cdp, page } = await this.ensure();
        const loaded = new Promise((resolve) => {
          const timer = setTimeout(() => resolve(), LOAD_TIMEOUT_MS);
          timer.unref();
          cdp.on("Page.loadEventFired", () => {
            clearTimeout(timer);
            resolve();
          });
        });
        await cdp.send("Page.navigate", { url }, page.sessionId);
        await loaded;
      }
      async evaluate(expression) {
        const { cdp, page } = await this.ensure();
        const reply = await cdp.send(
          "Runtime.evaluate",
          {
            expression,
            returnByValue: true,
            awaitPromise: true,
            userGesture: true
          },
          page.sessionId
        );
        if (reply.exceptionDetails !== void 0) {
          const message = reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text ?? "evaluation failed";
          throw new Error(message.split("\n")[0] ?? "evaluation failed");
        }
        return reply.result?.value;
      }
      async read(options = {}) {
        return this.serial(async () => {
          await this.ensure();
          const mode = options.mode ?? "text";
          const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
          const snapshot = await this.evaluate(
            snapshotExpression({ mode, maxChars })
          );
          this.touch();
          this.last = {
            url: snapshot.url,
            text: snapshot.text,
            controls: snapshot.controls
          };
          this.hand(snapshot.url, snapshot.controls);
          return {
            url: snapshot.url,
            title: snapshot.title,
            text: snapshot.text,
            controls: snapshot.controls,
            truncated: snapshot.truncated === true,
            limit: capOf(snapshot.limit),
            /* Carried out of the page expression, or a caller counting only what it
               received would call a page with an unreadable frame complete. */
            blindFrames: snapshot.blindFrames ?? 0,
            words: snapshot.words ?? 0,
            chars: snapshot.text.length
          };
        });
      }
      /**
       * Read the page for a few hundred words instead of a whole DOM.
       *
       * `article` renders the reading column as Markdown. `map` gives the shape of
       * the page — headings, controls, how many words there are — without the words.
       * `query` returns only the passages that answer a question, ranked in this
       * process. `changed` returns only what the last read did not already say.
       *
       * The snapshot is still the same shape, so a caller that only knows how to
       * read `text` and `controls` keeps working.
       */
      async digest(options) {
        return this.serial(async () => {
          await this.ensure();
          const maxChars = options.maxChars ?? 2e3;
          if (options.mode === "article") {
            const raw = await this.evaluate(articleExpression(maxChars));
            const page2 = _CdpBrowserRoute.parseArticle(raw);
            const seen = await this.evaluate(META_EXPRESSION);
            this.touch();
            return {
              url: seen.url,
              title: seen.title,
              text: page2.text,
              controls: [],
              truncated: page2.truncated === true,
              limit: page2.truncated === true ? "chars" : void 0,
              mode: "article",
              words: seen.words,
              chars: page2.text.length
            };
          }
          if (options.mode === "map") {
            const page2 = await this.evaluate(
              snapshotExpression({ mode: "map", maxChars })
            );
            this.touch();
            this.hand(page2.url, page2.controls);
            return {
              url: page2.url,
              title: page2.title,
              text: page2.text,
              controls: page2.controls,
              truncated: page2.truncated === true,
              limit: capOf(page2.limit),
              mode: "map",
              words: page2.words ?? 0,
              chars: page2.text.length
            };
          }
          if (options.mode === "query") {
            const asked = (options.query ?? "").trim();
            if (asked === "")
              throw new Error(
                "mode query needs a query: what are you looking for?"
              );
            const blocks = await this.blocksFor(maxChars);
            const found = evidence(blocks, asked, { maxChars, limit: 24 });
            const page2 = await this.evaluate(
              snapshotExpression({ mode: "map", maxChars })
            );
            this.touch();
            this.hand(page2.url, page2.controls);
            const shown = relevant(page2.controls, asked, { maxChars });
            const text = passagesToText(found);
            return {
              url: page2.url,
              title: page2.title,
              text: text === "" ? `(nothing on this page answers ${JSON.stringify(asked)})` : text,
              controls: shown.controls,
              ...shown.omitted === 0 ? {} : { omitted: shown.omitted },
              truncated: found.rows.length < found.matched,
              limit: found.rows.length < found.matched ? "passages" : void 0,
              mode: "query",
              words: page2.words ?? 0,
              chars: text.length,
              matched: found.matched,
              total: found.total
            };
          }
          const page = await this.evaluate(
            snapshotExpression({ mode: "text", maxChars })
          );
          this.touch();
          const before = this.last !== null && this.last.url === page.url ? this.last : null;
          this.last = { url: page.url, text: page.text, controls: page.controls };
          this.hand(page.url, page.controls);
          if (before === null)
            return {
              url: page.url,
              title: page.title,
              text: page.text,
              controls: page.controls,
              truncated: page.truncated === true,
              limit: capOf(page.limit),
              mode: "changed",
              words: page.words ?? 0,
              chars: page.text.length
            };
          const delta = deltaOf(before, {
            text: page.text,
            controls: page.controls
          });
          return {
            url: page.url,
            title: page.title,
            text: delta.text === "" ? "(no change since the last read)" : delta.text,
            controls: delta.controls,
            truncated: page.truncated === true,
            limit: capOf(page.limit),
            mode: "changed",
            words: page.words ?? 0,
            chars: delta.text.length
          };
        });
      }
      /** The page's blocks, collected at six times the budget so ranking has room. */
      /** The reading column comes back as JSON text; a malformed one is empty,
       * not an exception, so a page that cannot be read does not kill the route. */
      static parseArticle(raw) {
        try {
          const parsed = JSON.parse(String(raw ?? ""));
          return {
            text: String(parsed.text ?? ""),
            chars: Number(parsed.chars ?? 0),
            linkCount: Number(parsed.linkCount ?? 0),
            truncated: parsed.truncated === true
          };
        } catch {
          return { text: "", chars: 0, linkCount: 0, truncated: false };
        }
      }
      async blocksFor(maxChars) {
        const raw = await this.evaluate(blocksExpression(maxChars * 6));
        try {
          const parsed = JSON.parse(raw);
          return Array.isArray(parsed.blocks) ? parsed.blocks : [];
        } catch {
          return [];
        }
      }
      /** Resolve a numbered control or a text match to a point that will hit it. */
      async locate(target) {
        if (target.ref !== void 0 && target.text !== void 0) {
          throw new Error("give either ref or text, not both");
        }
        if (target.ref !== void 0 && target.ref >= FRAME_BASE) {
          return this.locateInFrame(target.ref);
        }
        const expression = `(() => {
  /* A control in a shadow root is in the page and has a point; a lookup on the
     document alone would report it as gone. */
  const roots = [document];
  for (let at = 0; at < roots.length && roots.length < 24; at += 1)
    for (const node of roots[at].querySelectorAll("*"))
      if (node.shadowRoot !== null && roots.length < 24) roots.push(node.shadowRoot);
  const deepAll = (selector) => {
    const out = [];
    for (const root of roots) for (const node of root.querySelectorAll(selector)) out.push(node);
    return out;
  };
  const deepOne = (selector) => {
    for (const root of roots) {
      const node = root.querySelector(selector);
      if (node !== null) return node;
    }
    return null;
  };
  const el = ${target.ref !== void 0 ? `deepOne('[data-oxrail-ref="${target.ref}"]')` : `(() => {
    const needle = ${JSON.stringify(target.text ?? "")}.replace(/\\s+/g, " ").trim().toLowerCase();
    if (needle === "") return null;
    const all = deepAll('a[href],button,input,textarea,select,summary,[role="button"],[role="link"],[role="checkbox"],[role="tab"],[role="menuitem"]');
    let best = null, bestArea = Infinity;
    for (const node of all) {
      const text = (node.innerText || node.value || node.getAttribute("aria-label") || node.getAttribute("title") || "").replace(/\\s+/g, " ").trim().toLowerCase();
      if (text === "" || !text.includes(needle)) continue;
      const box = node.getBoundingClientRect();
      if (box.width < 2 || box.height < 2) continue;
      const area = box.width * box.height;
      if (area < bestArea) { best = node; bestArea = area; }
    }
    return best;
  })()`};
  if (!el) return { found: false };
  /* Instant, not smooth: a page with scroll-behavior:smooth animates this call,
     and the rect read one line later is the one it had before the scroll, so
     every point below would be computed against where the control used to be. */
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const label = (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || "").replace(/\\s+/g, " ").trim().slice(0, 80);
  const box = el.getBoundingClientRect();
  if (box.width < 2 || box.height < 2) return { found: true, label, blocked: "it has no area on screen to click" };
  /* Only the part of the control the viewport shows can be pressed. Clamping a
     point that lies outside it invents a place the control is not, and the
     press then lands wherever the clamp put it. */
  const seenLeft = Math.max(box.left, 0);
  const seenTop = Math.max(box.top, 0);
  const seenRight = Math.min(box.right, innerWidth);
  const seenBottom = Math.min(box.bottom, innerHeight);
  if (seenRight - seenLeft < 2 || seenBottom - seenTop < 2)
    return { found: true, label, blocked: "it is outside the visible area even after scrolling it into view" };
  /* The point must be one where a real press would reach this control: an
     overlay, a sticky header or a modal owns that pixel otherwise, and clicking
     it anyway would report success while the page never heard the press. Five
     samples, centre first, so a control covered only in the middle still gets
     clicked where it is reachable.
     A descendant counts, because the press bubbles up to the control. An
     ancestor does not: body contains every control, and an element with
     pointer-events:none is painted under the thing that really takes the
     press, so a click there is heard by the page and by nobody the caller
     asked for. */
  const within = (value, limit) => Math.min(Math.max(value, 1), Math.max(limit - 2, 1));
  /* The tree the control is in answers for its own points: an element inside a
     shadow root is not returned by document.elementFromPoint at all, so asking
     the document would report every shadow control as covered. */
  const root = el.getRootNode();
  const own = root !== null && typeof root.elementFromPoint === "function" ? root : document;
  const spread = [[0.5, 0.5], [0.3, 0.5], [0.7, 0.5], [0.5, 0.3], [0.5, 0.7]];
  for (const [fx, fy] of spread) {
    const x = within(seenLeft + (seenRight - seenLeft) * fx, innerWidth);
    const y = within(seenTop + (seenBottom - seenTop) * fy, innerHeight);
    const hit = own.elementFromPoint(x, y);
    if (hit !== null && (hit === el || el.contains(hit))) return { found: true, x, y, label };
  }
  const top = own.elementFromPoint(
    within(seenLeft + (seenRight - seenLeft) / 2, innerWidth),
    within(seenTop + (seenBottom - seenTop) / 2, innerHeight),
  );
  const owner = top === null
    ? "the page has nothing at that point"
    : "it is behind " + top.tagName.toLowerCase() + (top.id ? "#" + top.id : "") + (typeof top.className === "string" && top.className.trim() !== "" ? "." + top.className.trim().split(/\\s+/).slice(0, 2).join(".") : "") + " \\"" + (top.innerText || top.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim().slice(0, 60) + "\\"";
  return { found: true, label, blocked: owner };
})()`;
        const found = await this.evaluate(expression);
        if (found.found !== true) {
          if (target.ref !== void 0)
            throw new StaleRefError(
              `the page changed; control ${target.ref} is gone \u2014 call browser_view again`
            );
          throw new Error(
            `no visible control contains ${JSON.stringify(target.text ?? "")}`
          );
        }
        const label = found.label ?? "";
        if (found.blocked !== void 0) {
          const named = label === "" ? "control" : JSON.stringify(label);
          throw new Error(
            found.blocked.startsWith("it has no area") ? `${named} cannot be clicked: ${found.blocked}.` : `${named} cannot be clicked because ${found.blocked}. Close or dismiss what covers it, then call browser_view and retry.`
          );
        }
        if (found.x === void 0 || found.y === void 0) {
          throw new Error(
            `${label === "" ? "control" : JSON.stringify(label)} has no reachable point on screen.`
          );
        }
        return { x: found.x, y: found.y, label };
      }
      /** A ref inside a frame is found in that frame's document, and its point is
       * the frame's corner plus its own rect; the press is dispatched to the page
       * as a whole, so only the total matters. */
      async locateInFrame(ref) {
        const slot = Math.floor((ref - FRAME_BASE) / FRAME_SLOT) + 1;
        const local = ref - FRAME_BASE - (slot - 1) * FRAME_SLOT;
        const found = await this.evaluate(`(() => {
  /* The same walk the snapshot did, in the same order, or the frame number
     means a different document here than it meant there. */
  const holders = [];
  const walk = (doc, depth) => {
    if (depth > 2 || holders.length >= 8) return;
    for (const one of doc.querySelectorAll("iframe,frame")) {
      let inside = null;
      try { inside = one.contentDocument; } catch (error) { inside = null; }
      if (inside === null) continue;
      holders.push(one);
      walk(inside, depth + 1);
    }
  };
  walk(document, 0);
  const holder = holders[${slot} - 1];
  if (!holder) return { found: false, frames: holders.length };
  let inside = null;
  try { inside = holder.contentDocument; } catch (error) { inside = null; }
  if (inside === null) return { found: true, frames: holders.length, blocked: "the frame is cross-origin, so its contents cannot be read or clicked through this route" };
  const el = inside.querySelector('[data-oxrail-ref="${local}"]');
  if (!el) return { found: false, frames: holders.length };
  const label = (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || "").replace(/\\s+/g, " ").trim().slice(0, 80);
  /* Named for what it is, because 'own' already means the tree the control is
     in over in locate(); one name for two things is how the occlusion path
     came to reference a binding that had gone out of scope. */
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return { found: true, frames: holders.length, label, blocked: "it has no area on screen to click" };
  let x = 0, y = 0, node = holder, guard = 0, top = holder;
  while (node && guard < 8) {
    const box = node.getBoundingClientRect();
    x += box.left + (node.clientLeft || 0);
    y += box.top + (node.clientTop || 0);
    const view = node.ownerDocument === null ? null : node.ownerDocument.defaultView;
    if (view === null) break;
    x -= view.scrollX || 0;
    y -= view.scrollY || 0;
    node = view.frameElement;
    /* The hit test runs in this document, where the only frame element that
       exists is the outermost one: a nested frame's holder belongs to another
       document, and comparing a point with it can never match. */
    if (node) top = node;
    guard += 1;
  }
  const at = { x: x + rect.left + rect.width / 2, y: y + rect.top + rect.height / 2 };
  /* The point has to be inside the frame's own visible box, and the frame's
     box has to be on screen, or the press lands on whatever is above it. */
  const box = holder.getBoundingClientRect();
  if (at.x < box.left || at.x > box.right || at.y < box.top || at.y > box.bottom)
    return { found: true, frames: holders.length, label, blocked: "it is scrolled out of the part of the frame that is shown" };
  if (at.x < 0 || at.y < 0 || at.x > innerWidth - 1 || at.y > innerHeight - 1)
    return { found: true, frames: holders.length, label, blocked: "the frame is outside the visible area" };
  const hit = document.elementFromPoint(at.x, at.y);
  if (hit === null || !(hit === top || top.contains(hit)))
    return { found: true, frames: holders.length, label, blocked: "something is on top of the frame" };
  return { found: true, frames: holders.length, label, x: at.x, y: at.y };
})()`);
        if (found.found !== true) {
          if (found.frames < slot)
            throw new StaleRefError(
              `the page changed; control ${ref} was in frame ${slot}, and the page no longer has that frame \u2014 call browser_view again`
            );
          throw new StaleRefError(
            `the page changed; control ${ref} is gone \u2014 call browser_view again`
          );
        }
        const label = found.label ?? "";
        if (found.blocked !== void 0)
          throw new Error(
            `${label === "" ? "control" : JSON.stringify(label)} cannot be clicked: ${found.blocked}.`
          );
        if (found.x === void 0 || found.y === void 0)
          throw new Error(
            `${label === "" ? "control" : JSON.stringify(label)} has no reachable point on screen.`
          );
        return { x: found.x, y: found.y, label };
      }
      async mouseClick(x, y) {
        const { cdp, page } = await this.ensure();
        const base = {
          x: Math.round(x),
          y: Math.round(y),
          button: "left",
          clickCount: 1,
          modifiers: 0
        };
        await cdp.send(
          "Input.dispatchMouseEvent",
          { type: "mouseMoved", ...base, buttons: 0 },
          page.sessionId
        );
        await cdp.send(
          "Input.dispatchMouseEvent",
          { type: "mousePressed", ...base, buttons: 1 },
          page.sessionId
        );
        await cdp.send(
          "Input.dispatchMouseEvent",
          { type: "mouseReleased", ...base, buttons: 0 },
          page.sessionId
        );
      }
      /** Record what a read numbered, so a later write can be held to it. */
      hand(url, controls) {
        this.handed = {
          url,
          refs: new Set(controls.map((control) => control.ref)),
          /* The names this read handed out, normalised the same way a lookup is,
             so a click by text can be held to what the read actually said. */
          names: controls.map((control) => normalizeName(control.name))
        };
      }
      /** Refuse a write that does not come from a read.
       *
       * The two failures this names are different, and both are honest: nothing
       * has been read yet, or the last read of this page did not contain that
       * number. Neither is answered by trying harder — the answer is to read
       * again, which is also the only way to get a number that will work. */
      addressable(ref) {
        if (this.handed === null)
          throw new StaleRefError(
            `control ${ref} cannot be addressed: nothing has been read, so no read produced that number \u2014 call browser_view first`
          );
        if (!this.handed.refs.has(ref))
          throw new StaleRefError(
            `control ${ref} cannot be addressed: the last read of ${this.handed.url} did not contain it \u2014 call browser_view again and use a number it returns`
          );
      }
      async click(target) {
        return this.serial(async () => {
          if (target.ref !== void 0) this.addressable(target.ref);
          else {
            const needle = normalizeName(target.text ?? "");
            if (needle === "")
              throw new StaleRefError(
                `a click needs a number or some text to find the control by, and ${JSON.stringify(target.text ?? "")} has neither`
              );
            const said = this.handed?.names.some((name) => name.includes(needle));
            if (this.handed === null)
              throw new StaleRefError(
                `nothing has been read, so ${JSON.stringify(target.text ?? "")} is not known to be on this page \u2014 call browser_view first`
              );
            if (said !== true)
              throw new StaleRefError(
                `control ${JSON.stringify(target.text ?? "")} cannot be addressed: the last read of ${this.handed.url} did not name it \u2014 call browser_view again and use a number it returns`
              );
          }
          await this.ensure();
          const box = await this.locate(target);
          await this.mouseClick(box.x, box.y);
          this.touch();
          return {
            content: [
              {
                type: "text",
                text: `clicked ${box.label === "" ? "control" : JSON.stringify(box.label)}`
              }
            ]
          };
        });
      }
      keyEvent(key) {
        const table = {
          Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
          Tab: { key: "Tab", code: "Tab", keyCode: 9 },
          Escape: { key: "Escape", code: "Escape", keyCode: 27 },
          Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
          Delete: { key: "Delete", code: "Delete", keyCode: 46 },
          ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
          ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
          ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
          ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
          PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
          PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
          Home: { key: "Home", code: "Home", keyCode: 36 },
          End: { key: "End", code: "End", keyCode: 35 }
        };
        const named = table[key];
        if (named !== void 0) return named;
        if (key.length === 1) {
          const upper = key.toUpperCase();
          return { key, code: `Key${upper}`, keyCode: upper.charCodeAt(0) };
        }
        throw new Error(`unknown key ${JSON.stringify(key)}`);
      }
      async key(key) {
        return this.serial(async () => {
          await this.ensure();
          const event = this.keyEvent(key);
          const { cdp, page } = await this.ensure();
          await cdp.send(
            "Input.dispatchKeyEvent",
            {
              type: "rawKeyDown",
              key: event.key,
              code: event.code,
              windowsVirtualKeyCode: event.keyCode,
              nativeVirtualKeyCode: event.keyCode
            },
            page.sessionId
          );
          if (event.text !== void 0) {
            await cdp.send(
              "Input.dispatchKeyEvent",
              {
                type: "char",
                text: event.text,
                key: event.key,
                code: event.code,
                windowsVirtualKeyCode: event.keyCode
              },
              page.sessionId
            );
          }
          await cdp.send(
            "Input.dispatchKeyEvent",
            {
              type: "keyUp",
              key: event.key,
              code: event.code,
              windowsVirtualKeyCode: event.keyCode,
              nativeVirtualKeyCode: event.keyCode
            },
            page.sessionId
          );
          this.touch();
          return { content: [{ type: "text", text: `pressed ${key}` }] };
        });
      }
      async type(target) {
        return this.serial(async () => {
          if (target.ref !== void 0) this.addressable(target.ref);
          else if (this.handed === null)
            throw new StaleRefError(
              `nothing has been read, so there is no control to type into \u2014 call browser_view first`
            );
          await this.ensure();
          if (target.ref !== void 0) {
            const ok = await this.focus(target.ref);
            if (!ok)
              throw new StaleRefError(
                `the page changed; control ${target.ref} is gone \u2014 call browser_view again`
              );
          } else {
            const focus = await this.evaluate(`(() => {
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement)
    el = el.shadowRoot.activeElement;
  if (!el || el === document.body || el === document.documentElement)
    return { anywhere: false, ref: null };
  for (let node = el; node; node = node.parentElement || (node.getRootNode && node.getRootNode().host) || null) {
    const own = node.getAttribute && node.getAttribute("data-oxrail-ref");
    if (own !== null && own !== undefined) return { anywhere: true, ref: Number(own) };
  }
  return { anywhere: true, ref: null };
})()`);
            if (!focus.anywhere)
              throw new StaleRefError(
                `nothing on this page has focus, so there is no control to type into \u2014 read the page, then click the control you mean`
              );
            if (this.handed === null || focus.ref === null || !this.handed.refs.has(focus.ref))
              throw new StaleRefError(
                `the focused control is not one the last read of ${this.handed?.url ?? "this page"} numbered \u2014 read the page again and click the control you mean`
              );
          }
          if (target.clear === true) {
            await this.evaluate(`(() => {
  const el = document.activeElement;
  if (el && typeof el.select === "function") { el.select(); return true; }
  if (el && el.isContentEditable) { document.execCommand("selectAll"); return true; }
  return false;
})()`);
            await this.evaluate(
              `(() => { const el = document.activeElement; if (el && "value" in el) { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); } else if (el && el.isContentEditable) { document.execCommand("delete"); } return true; })()`
            );
          }
          const { cdp, page } = await this.ensure();
          await cdp.send("Input.insertText", { text: target.text }, page.sessionId);
          if (target.submit === true) {
            const event = this.keyEvent("Enter");
            await cdp.send(
              "Input.dispatchKeyEvent",
              {
                type: "rawKeyDown",
                key: event.key,
                code: event.code,
                windowsVirtualKeyCode: event.keyCode,
                nativeVirtualKeyCode: event.keyCode
              },
              page.sessionId
            );
            await cdp.send(
              "Input.dispatchKeyEvent",
              {
                type: "char",
                text: "\r",
                key: "Enter",
                code: "Enter",
                windowsVirtualKeyCode: 13
              },
              page.sessionId
            );
            await cdp.send(
              "Input.dispatchKeyEvent",
              {
                type: "keyUp",
                key: event.key,
                code: event.code,
                windowsVirtualKeyCode: event.keyCode
              },
              page.sessionId
            );
          }
          this.touch();
          return {
            content: [
              {
                type: "text",
                text: `typed ${target.text.length} characters${target.submit === true ? " and pressed Enter" : ""}`
              }
            ]
          };
        });
      }
      async focus(ref) {
        return this.evaluate(`(() => {
  const el = document.querySelector('[data-oxrail-ref="${ref}"]');
  if (!el) return false;
  el.scrollIntoView({ block: "center", inline: "center" });
  el.focus();
  return document.activeElement === el;
})()`);
      }
      async nav(options) {
        return this.serial(async () => {
          await this.ensure();
          if (options.url !== void 0 && options.url !== "") {
            await this.navigate(options.url);
          } else if (options.back === true) {
            await this.evaluate("history.back()");
            await this.waitIdle();
          } else if (options.reload === true) {
            const { cdp, page } = await this.ensure();
            await cdp.send("Page.reload", {}, page.sessionId);
            await this.waitIdle();
          }
          if (options.url !== void 0 || options.back === true || options.reload === true)
            this.handed = null;
          this.touch();
          return this.state();
        });
      }
      async waitIdle() {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const state = await this.evaluate("document.readyState");
          if (state === "complete") return;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      async shot(options = {}) {
        return this.serial(async () => {
          const { cdp, page } = await this.ensure();
          const view = await this.evaluate(`({
  width: innerWidth,
  height: innerHeight,
  scrollX: pageXOffset,
  scrollY: pageYOffset,
  documentHeight: Math.max(document.documentElement.scrollHeight, innerHeight)
})`);
          const clip = shotClip(view, options.fullPage === true);
          const reply = await cdp.send(
            "Page.captureScreenshot",
            {
              format: "png",
              clip,
              captureBeyondViewport: true
            },
            page.sessionId
          );
          const dir = join(stateDir(), "shots");
          mkdirSync2(dir, { recursive: true });
          const path2 = join(dir, `shot-${Date.now()}.png`);
          writeFileSync(path2, Buffer.from(reply.data, "base64"));
          this.touch();
          return { png: reply.data, path: path2 };
        });
      }
      stateSync() {
        const running = this.chrome !== null && this.cdp !== null && this.page !== null;
        return {
          running,
          pid: this.chrome?.pid ?? null,
          profile: running ? this.runningProfile ?? this.profile : this.profile,
          url: null,
          title: null,
          headless: running ? this.runningHeadless ?? this.headless : this.headless,
          idleMs: running ? Math.max(0, Date.now() - this.lastUse) : 0,
          closesInMs: running ? Math.max(0, this.lastUse + this.idleWindow - Date.now()) : null
        };
      }
      async state() {
        const base = this.stateSync();
        if (base.running !== true) return base;
        try {
          const page = await this.evaluate(
            `({ url: location.href, title: document.title || "" })`
          );
          return { ...base, url: page.url, title: page.title };
        } catch {
          return base;
        }
      }
      /* --- the display switch -------------------------------------------
       *
       * Whether the window is drawn cannot be changed on a browser that is
       * already running: the flag is read once, when it is launched. So a
       * change is carried out by putting the browser down and bringing it back
       * up in the other mode, on the page it was showing. Reporting the new
       * mode without doing that would leave the words and the screen
       * disagreeing, which is worse than the wait.
       */
      async mode(options = {}) {
        const wanted = options.display;
        const now = this.runningHeadless ?? this.headless;
        if (wanted === void 0) {
          const shown = !now;
          return {
            content: [
              {
                type: "text",
                text: `the window is ${shown ? "shown" : "hidden"} (${now ? "headless" : "visible"})${this.chrome === null ? ", and no browser is running" : ""}
change it with display: "visible" or "headless"`
              }
            ]
          };
        }
        const next = wanted === "headless";
        const changed = next !== now;
        this.headless = next;
        let where = "";
        const profile = this.runningProfile ?? this.profile;
        if (changed && this.chrome !== null) {
          try {
            where = await this.evaluate("location.href");
          } catch {
            where = "";
          }
          await this.close();
          if (where !== "" && where !== "about:blank") {
            await this.open({ url: where, profile });
            where = ` on ${where}`;
          } else {
            where = "";
          }
        }
        return {
          content: [
            {
              type: "text",
              text: next ? `the window is hidden now${where}` : `the window is shown now${where}` + (changed ? "" : " (it already was)")
            }
          ]
        };
      }
      /* --- the conversation tools ---------------------------------------
       *
       * A chat that is open in the page keeps the answer behind a "send" that
       * is a click and a wait, and the wait has no fixed length: the reply
       * grows while it is produced. These two do that sequence here so the
       * caller does not have to guess how long to wait between steps.
       */
      async ask(options) {
        return this.serial(async () => {
          await this.ensure();
          if (options.text === void 0 && options.ref === void 0) {
            throw new Error("browser_ask needs a ref or the name of the box");
          }
          const said = options.said ?? "";
          if (options.ref === void 0) {
            await this.click({ text: options.text });
          } else {
            await this.focus(options.ref);
          }
          await this.type({
            text: said,
            clear: true,
            ...options.submit === false ? {} : { submit: true }
          });
          const limit = options.timeoutMs ?? 45e3;
          const started = Date.now();
          let previous = "";
          let steadyFor = 0;
          let answer = "";
          while (Date.now() - started < limit) {
            await new Promise((resolve) => setTimeout(resolve, 400));
            answer = await this.evaluate(
              "document.body ? document.body.innerText : ''"
            );
            if (answer === previous) {
              steadyFor += 400;
              if (steadyFor >= 1600 && answer.trim() !== "") break;
            } else {
              steadyFor = 0;
            }
            previous = answer;
          }
          const waited = Date.now() - started;
          const body = answer.trim();
          return {
            content: [
              {
                type: "text",
                text: `${body === "" ? "the page stayed empty" : body}

(reply settled after ${waited} ms; ${limit - waited > 0 ? "it stopped growing" : "it was still growing when the wait ran out"})`
              }
            ]
          };
        });
      }
      /* A review round is the same send-and-wait, with the shapes of a review
         on top: the message is built from the repository, and what was said is
         kept so the next round can leave settled points out. */
      async review(options = {}) {
        return this.serial(async () => {
          await this.ensure();
          const round = this.reviewRounds + 1;
          const open = this.settled;
          const body = `Review this repository. Round ${round}.` + (open.size === 0 ? " Nothing has been settled yet, so raise every point you see." : ` Points already settled and to be left out: ${[...open.keys()].sort((a, b) => a - b).join(", ")}.`);
          const answer = await this.ask({
            ...options.ref === void 0 ? {} : { ref: options.ref },
            ...options.text === void 0 ? {} : { text: options.text },
            said: options.said ?? body,
            submit: true,
            ...options.timeoutMs === void 0 ? {} : { timeoutMs: options.timeoutMs }
          });
          this.reviewRounds = round;
          const said = saidOf(answer);
          const points = pointList(said);
          return {
            content: [
              {
                type: "text",
                text: `round ${round}: ${points.length === 0 ? "no numbered points came back" : points.map((point) => `${point}.`).join(" ")}

${said}`
              }
            ]
          };
        });
      }
      reviewVerdict(options = {}) {
        const marks = options.marks ?? [];
        if (marks.length === 0) {
          const known = [...this.settled.entries()].sort((a, b) => a[0] - b[0]);
          return Promise.resolve({
            content: [
              {
                type: "text",
                text: known.length === 0 ? "no point has been settled yet" : known.map(([point, mark]) => `${point}: ${mark}`).join("\n")
              }
            ]
          });
        }
        for (const mark of marks) {
          if (!MARKS.includes(mark.verdict)) {
            throw new Error(
              `mark ${mark.point}: "${mark.verdict}" is not one of ${MARKS.join(", ")}`
            );
          }
          this.settled.set(mark.point, mark.verdict);
        }
        return Promise.resolve({
          content: [
            {
              type: "text",
              text: marks.map((mark) => `${mark.point}: ${mark.verdict}`).join("\n") + `

${this.settled.size} point${this.settled.size === 1 ? "" : "s"} settled, and left out of the next round`
            }
          ]
        });
      }
      async resume() {
        return this.serial(async () => {
          await this.ensure();
          const held = this.handoffAt;
          this.handoffAt = 0;
          const state = await this.state();
          return {
            content: [
              {
                type: "text",
                text: `${held === 0 ? "nothing was holding the page" : "the page is back in hand"}
${stateText(state)}`
              }
            ]
          };
        });
      }
      async login() {
        const dir = profileDir(this.profile);
        const cookies = join(dir, "Default", "Cookies");
        let saved = false;
        try {
          saved = existsSync2(cookies) && statSync2(cookies).size > 1024;
        } catch {
          saved = false;
        }
        return {
          profile: this.profile,
          saved,
          text: `profile ${this.profile}: ${saved ? "saved sign-ins present" : "no saved sign-ins yet"} (${dir})`
        };
      }
      /* ---------------------------------------------------------------------
       * The tools beyond the first eleven.
       *
       * Each one exists because a page cannot answer the question through the
       * numbered controls alone: a grid for what draws itself, a wait instead of a
       * read loop, the console for a click that seemed to do nothing. None of them
       * invents a coordinate — a point still has to come from a read, and the
       * screenshot tools are the only place pixels are interpreted.
       * ------------------------------------------------------------------- */
      /** Watch for the things that are not on the page any more once it redraws. */
      async startWatching() {
        if (this.watching || this.cdp === null) return;
        this.watching = true;
        const cdp = this.cdp;
        const { page } = await this.ensure();
        cdp.on("Runtime.consoleAPICalled", (params) => {
          const typed = params;
          const text = (typed.args ?? []).map(
            (arg) => arg.value !== void 0 ? typeof arg.value === "string" ? arg.value : JSON.stringify(arg.value) : arg.description ?? ""
          ).join(" ");
          this.remember(`[${typed.type ?? "log"}] ${text}`);
        });
        cdp.on("Runtime.exceptionThrown", (params) => {
          const typed = params;
          const detail = typed.exceptionDetails;
          this.remember(
            `[error] ${detail?.exception?.description ?? detail?.text ?? "exception"}`
          );
        });
        cdp.on("Network.responseReceived", (params) => {
          const typed = params;
          const url = typed.response?.url ?? "";
          const kind = typed.type ?? "";
          const status = typed.response?.status ?? 0;
          const method = "GET";
          if (url !== "")
            this.responses.unshift({ url, method, status, type: kind });
          if (this.responses.length > 400) this.responses.length = 400;
          if ((kind === "Media" || kind === "XHR" || kind === "Fetch") && url !== "") {
            const played = this.played.find((item) => item.url === url);
            if (played === void 0) this.played.unshift({ url, kind, bytes: 0 });
            if (this.played.length > 200) this.played.length = 200;
          }
        });
        cdp.on("Network.loadingFailed", (params) => {
          const typed = params;
          const known = this.responses.find(
            (item) => item.type === (typed.type ?? "")
          );
          this.failedRequests.unshift({
            url: known?.url ?? "",
            method: "GET",
            status: 0,
            type: typed.type ?? "",
            error: typed.blockedReason ?? typed.errorText ?? "failed"
          });
          if (this.failedRequests.length > 200) this.failedRequests.length = 200;
        });
        cdp.on("Page.javascriptDialogOpening", (params) => {
          const typed = params;
          this.dialogOpen = {
            type: typed.type ?? "alert",
            message: typed.message ?? "",
            defaultValue: typed.defaultPrompt ?? ""
          };
        });
        cdp.on("Page.javascriptDialogClosed", () => {
          this.dialogOpen = null;
        });
        cdp.on("Page.downloadWillBegin", (params) => {
          const typed = params;
          this.remember(
            `downloaded ${typed.suggestedFilename ?? typed.url ?? "a file"}`
          );
        });
        await cdp.send("Network.enable", {}, page.sessionId);
        await cdp.send("Page.enable", {}, page.sessionId);
      }
      remember(line) {
        this.consoleLines.push(line);
        if (this.consoleLines.length > 400)
          this.consoleLines.splice(0, this.consoleLines.length - 400);
      }
      async find(options) {
        return this.serial(async () => {
          await this.ensure();
          await this.startWatching();
          const asked = options.query.trim();
          if (asked === "")
            throw new Error("browser_find needs a query: what should it look for?");
          const limit = Math.max(1, Math.min(options.limit ?? 40, 200));
          const raw = await this.evaluate(`(() => {
  const pattern = ${options.regex === true ? "true" : "false"}
    ? new RegExp(${JSON.stringify(asked)}, "i")
    : null;
  const needle = ${JSON.stringify(asked)}.toLowerCase();
  const hits = (text) => pattern ? pattern.test(text) : text.toLowerCase().includes(needle);
  const controls = [];
  const seen = new Set();
  for (const el of document.querySelectorAll("a[href],button,input,textarea,select,summary,[role=button],[role=link],[role=tab],[role=checkbox]")) {
    const box = el.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    const label = (el.innerText || el.value || el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\\s+/g, " ");
    if (label === "" || !hits(label)) continue;
    const ref = Number(el.getAttribute("data-oxrail-ref"));
    if (!Number.isFinite(ref)) continue;
    const onScreen = box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth;
    controls.push({ ref, role: el.getAttribute("role") || el.tagName.toLowerCase(), name: label.slice(0, 160), onScreen });
    if (controls.length >= ${limit}) break;
  }
  const lines = [];
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node && lines.length < ${limit}; node = walker.nextNode()) {
    const text = (node.nodeValue || "").trim().replace(/\\s+/g, " ");
    if (text.length < 3 || !hits(text)) continue;
    const holder = node.parentElement;
    if (!holder) continue;
    const box = holder.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    const key = Math.round(box.left) + ":" + Math.round(box.top);
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push({
      text: text.slice(0, 200),
      x: Math.round(box.left + box.width / 2),
      y: Math.round(box.top + box.height / 2),
      onScreen: box.bottom > 0 && box.top < innerHeight,
    });
  }
  return JSON.stringify({ controls, lines });
})()`);
          const found = JSON.parse(raw);
          this.touch();
          const rows = [];
          for (const control of found.controls)
            rows.push(
              `[${control.ref}] ${control.role} ${JSON.stringify(control.name)}${control.onScreen ? "" : " (off screen)"}`
            );
          for (const line of found.lines)
            rows.push(
              `${JSON.stringify(line.text)} at ${line.x},${line.y}${line.onScreen ? "" : " (off screen)"}`
            );
          return {
            content: [
              {
                type: "text",
                text: rows.length === 0 ? `(nothing on this page matches ${JSON.stringify(asked)})` : rows.join("\n")
              }
            ]
          };
        });
      }
      async extract(options) {
        return this.serial(async () => {
          await this.ensure();
          const select = options.select.trim();
          if (select === "")
            throw new Error(
              "browser_extract needs a selector: what should each row be?"
            );
          const limit = Math.max(1, Math.min(options.limit ?? 60, 400));
          const raw = await this.evaluate(`(() => {
  const scope = ${options.ref === void 0 ? "document" : `document.querySelector('[data-oxrail-ref="${options.ref}"]') || document`};
  let nodes;
  try { nodes = Array.from(scope.querySelectorAll(${JSON.stringify(select)})); }
  catch (error) { return JSON.stringify({ error: String(error && error.message ? error.message : error) }); }
  const rows = [];
  for (const node of nodes.slice(0, ${limit})) {
    const text = (node.innerText || node.textContent || "").trim().replace(/\\s+/g, " ");
    const link = node.querySelector ? node.querySelector("a[href]") : null;
    const own = node.tagName === "A" && node.getAttribute("href") ? node.href : null;
    rows.push({ text: text.slice(0, 300), href: (link ? link.href : own) || null });
  }
  return JSON.stringify({ rows, total: nodes.length });
})()`);
          const page = JSON.parse(raw);
          this.touch();
          if (page.error !== void 0)
            throw new Error(`that selector is not valid: ${page.error}`);
          const rows = page.rows ?? [];
          const total = page.total ?? 0;
          const body = rows.length === 0 ? `(nothing on this page matches ${JSON.stringify(select)})` : rows.map(
            (row) => row.href === null || row.href === "" ? row.text : `${row.text} -> ${row.href}`
          ).join("\n");
          return {
            content: [
              {
                type: "text",
                text: rows.length < total ? `${body}
\u2026 ${total - rows.length} more not shown` : body
              }
            ]
          };
        });
      }
      async look(options) {
        return this.serial(async () => {
          await this.ensure();
          const { cdp, page } = await this.ensure();
          const view = await this.evaluate(
            "({ width: innerWidth, height: innerHeight })"
          );
          let clip = { x: 0, y: 0, width: view.width, height: view.height };
          const region = (options.region ?? "").trim();
          if (region !== "") {
            const parts = region.split(",").map((part) => Number(part.trim()));
            if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value)))
              throw new Error(
                `region must be "x,y,width,height" in pixels; got ${JSON.stringify(region)}`
              );
            const [x, y, width, height] = parts;
            clip = { x, y, width, height };
          }
          const cols = Math.max(2, Math.min(options.cols ?? 12, 64));
          const rows = Math.max(2, Math.min(options.cols ?? 12, 64));
          const shot = await cdp.send(
            "Page.captureScreenshot",
            { format: "png", clip, captureBeyondViewport: false },
            page.sessionId
          );
          this.touch();
          const bitmap = decodePng(Buffer.from(shot.data, "base64"));
          const grid = toGrid(bitmap, cols, rows);
          const key = `${clip.x},${clip.y},${clip.width},${clip.height}`;
          const previous = this.lastGrid?.key === key ? this.lastGrid : null;
          this.lastGrid = { key, rows: grid };
          if (options.diff === false || previous === null) {
            const glyphs = grid.map((row) => row.join("")).join("\n");
            return {
              content: [
                {
                  type: "text",
                  text: `grid ${cols}x${rows} of ${clip.width}x${clip.height} at ${clip.x},${clip.y}
${glyphs}`
                }
              ]
            };
          }
          const changed = [];
          for (let row = 0; row < grid.length; row += 1) {
            const now = grid[row] ?? [];
            const before = previous.rows[row] ?? [];
            for (let column = 0; column < now.length; column += 1)
              if (now[column] !== before[column])
                changed.push(
                  `${row},${column}: ${before[column] ?? "."} -> ${now[column] ?? "."}`
                );
          }
          return {
            content: [
              {
                type: "text",
                text: changed.length === 0 ? "no change since the last look" : `${changed.length} cells changed
${changed.join("\n")}`
              }
            ]
          };
        });
      }
      async wait(options) {
        return this.serial(async () => {
          await this.ensure();
          const budget = Math.max(
            50,
            Math.min(options.timeoutMs ?? 8e3, 12e4)
          );
          const started = Date.now();
          const expression = `(() => {
  const text = document.body ? document.body.innerText : "";
  return { text, url: location.href };
})()`;
          const wanted = (options.text ?? "").trim();
          const gone = (options.gone ?? "").trim();
          const url = (options.url ?? "").trim();
          if (wanted === "" && gone === "" && url === "" && options.quiet !== true)
            throw new Error(
              "browser_wait needs something to wait for: text, gone, url, or quiet"
            );
          let last = "";
          while (Date.now() - started < budget) {
            const now = await this.evaluate(
              expression
            );
            const hitText = wanted === "" ? true : now.text.toLowerCase().includes(wanted.toLowerCase());
            const hitGone = gone === "" ? true : !now.text.toLowerCase().includes(gone.toLowerCase());
            const hitUrl = url === "" ? true : now.url.includes(url);
            if (hitText && hitGone && hitUrl) {
              this.touch();
              const waited = Date.now() - started;
              return {
                content: [
                  {
                    type: "text",
                    text: options.quiet === true && wanted === "" && gone === "" && url === "" ? `the page is quiet (${waited} ms)` : `reached after ${waited} ms`
                  }
                ]
              };
            }
            if (options.quiet === true && now.text === last && Date.now() - started > 500) {
              const still = await this.evaluate(
                expression
              );
              if (still.text === now.text) {
                this.touch();
                return {
                  content: [
                    {
                      type: "text",
                      text: `the page stopped changing after ${Date.now() - started} ms`
                    }
                  ]
                };
              }
            }
            last = now.text;
            await new Promise((resolve) => setTimeout(resolve, 150));
          }
          const current = await this.evaluate(
            expression
          );
          const said = wanted !== "" ? `${JSON.stringify(wanted)} had not appeared` : gone !== "" ? `${JSON.stringify(gone)} was still showing` : url !== "" ? `the address did not reach ${url}` : "the page did not go quiet";
          throw new Error(
            `waited ${budget} ms and ${said}; the page is at ${current.url} and says ${JSON.stringify(current.text.slice(0, 200))}`
          );
        });
      }
      async scroll(options) {
        return this.serial(async () => {
          await this.ensure();
          const dy = options.dy ?? 0;
          const dx = options.dx ?? 0;
          if (dy === 0 && dx === 0)
            throw new Error("browser_scroll needs a dy (negative goes up)");
          const { cdp, page } = await this.ensure();
          const view = await this.evaluate(
            "({ x: innerWidth / 2, y: innerHeight / 2 })"
          );
          await cdp.send(
            "Input.dispatchMouseEvent",
            {
              type: "mouseWheel",
              x: Math.round(view.x),
              y: Math.round(view.y),
              deltaX: dx,
              deltaY: dy,
              button: "none",
              modifiers: 0
            },
            page.sessionId
          );
          this.touch();
          await this.waitIdle();
          if (options.read === false)
            return {
              content: [
                {
                  type: "text",
                  text: `scrolled ${dy === 0 ? "" : `${dy > 0 ? "down" : "up"} ${Math.abs(dy)}`}${dx === 0 ? "" : `${dx > 0 ? " right" : " left"} ${Math.abs(dx)}`}`.trim()
                }
              ]
            };
          const snapshot = await this.read({ maxChars: 2e3 });
          return { content: [{ type: "text", text: formatSnapshot(snapshot) }] };
        });
      }
      async hover(options) {
        return this.serial(async () => {
          await this.ensure();
          if (options.ref !== void 0) this.addressable(options.ref);
          const point = await this.locate({
            ...options.ref !== void 0 ? { ref: options.ref } : {},
            ...options.text !== void 0 ? { text: options.text } : {}
          });
          const { cdp, page } = await this.ensure();
          await cdp.send(
            "Input.dispatchMouseEvent",
            {
              type: "mouseMoved",
              x: Math.round(point.x),
              y: Math.round(point.y),
              buttons: 0,
              modifiers: 0
            },
            page.sessionId
          );
          this.touch();
          await this.waitIdle();
          if (options.read === false)
            return {
              content: [
                {
                  type: "text",
                  text: `pointed at ${point.label === "" ? `${point.x},${point.y}` : JSON.stringify(point.label)}`
                }
              ]
            };
          const snapshot = await this.read({ maxChars: 2e3 });
          return { content: [{ type: "text", text: formatSnapshot(snapshot) }] };
        });
      }
      async check(options) {
        return this.serial(async () => {
          await this.ensure();
          this.addressable(options.ref);
          const state = await this.evaluate(`(() => {
  const el = document.querySelector('[data-oxrail-ref="${options.ref}"]');
  if (!el) return { found: false, checked: false, kind: "gone" };
  const kind = el.tagName === "INPUT" ? (el.type || "checkbox") : (el.getAttribute("role") || el.tagName.toLowerCase());
  return { found: true, checked: el.checked === true || el.getAttribute("aria-checked") === "true", kind };
})()`);
          if (!state.found)
            throw new StaleRefError(
              `the page changed; control ${options.ref} is gone \u2014 call browser_view again`
            );
          if (options.checked === void 0) {
            this.touch();
            return {
              content: [
                {
                  type: "text",
                  text: `control ${options.ref} (${state.kind}) is ${state.checked ? "checked" : "not checked"}`
                }
              ]
            };
          }
          if (state.checked !== options.checked) {
            const point = await this.locate({ ref: options.ref });
            await this.mouseClick(point.x, point.y);
          }
          const after = await this.evaluate(`(() => {
  const el = document.querySelector('[data-oxrail-ref="${options.ref}"]');
  return { checked: el ? el.checked === true || el.getAttribute("aria-checked") === "true" : false };
})()`);
          this.touch();
          await this.waitIdle();
          const took = after.checked === options.checked;
          const said = took ? `control ${options.ref} is now ${options.checked ? "checked" : "not checked"}` : `control ${options.ref} did not take the change: it is ${after.checked ? "checked" : "not checked"}`;
          if (options.read === false)
            return {
              content: [{ type: "text", text: said }],
              ...took ? {} : { isError: true }
            };
          const snapshot = await this.read({ maxChars: 1500 });
          return {
            content: [
              { type: "text", text: said },
              { type: "text", text: formatSnapshot(snapshot) }
            ],
            ...took ? {} : { isError: true }
          };
        });
      }
      async select(options) {
        return this.serial(async () => {
          await this.ensure();
          if (options.ref !== void 0) this.addressable(options.ref);
          const value = options.value;
          const outcome = await this.evaluate(`(() => {
  let el = null;
  if (${options.ref === void 0 ? "false" : "true"}) el = document.querySelector('[data-oxrail-ref="${options.ref}"]');
  if (!el && ${JSON.stringify(options.field ?? "")} !== "") {
    const needle = ${JSON.stringify(options.field ?? "")}.toLowerCase();
    for (const node of document.querySelectorAll("select,[role=combobox],[role=listbox]")) {
      const label = (node.getAttribute("aria-label") || node.name || node.id || "").toLowerCase();
      if (label.includes(needle)) { el = node; break; }
    }
  }
  if (!el) return JSON.stringify({ error: "no dropdown matched" });
  if (el.tagName === "SELECT") {
    const wanted = ${JSON.stringify(value)};
    const option = Array.from(el.options).find((o) => o.value === wanted || (o.textContent || "").trim() === wanted);
    if (!option) return JSON.stringify({ error: "no option matched", options: Array.from(el.options).map((o) => (o.textContent || "").trim()).slice(0, 20) });
    el.value = option.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return JSON.stringify({ ok: true, value: option.value });
  }
  el.setAttribute("data-oxrail-select", "1");
  return JSON.stringify({ ok: true, custom: true });
})()`);
          const parsed = JSON.parse(outcome);
          this.touch();
          if (parsed.error !== void 0) {
            const known = parsed.options === void 0 || parsed.options.length === 0 ? "" : `; it offers ${parsed.options.map((item) => JSON.stringify(item)).join(", ")}`;
            throw new Error(`${parsed.error}${known}`);
          }
          if (parsed.custom === true) {
            const point = await this.locate({
              ...options.ref !== void 0 ? { ref: options.ref } : {},
              ...options.field !== void 0 ? { text: options.field } : {}
            });
            await this.mouseClick(point.x, point.y);
            await this.waitIdle();
            const picked = await this.locate({ text: value });
            await this.mouseClick(picked.x, picked.y);
            this.touch();
            await this.waitIdle();
          } else await this.waitIdle();
          if (options.read === false)
            return {
              content: [
                {
                  type: "text",
                  text: `chose ${JSON.stringify(value)}${parsed.value === void 0 ? "" : ` (value ${JSON.stringify(parsed.value)})`}`
                }
              ]
            };
          const snapshot = await this.read({ maxChars: 1500 });
          return { content: [{ type: "text", text: formatSnapshot(snapshot) }] };
        });
      }
      async drag(options) {
        return this.serial(async () => {
          await this.ensure();
          if (options.fromRef !== void 0) this.addressable(options.fromRef);
          if (options.toRef !== void 0) this.addressable(options.toRef);
          const from = await this.locate({
            ...options.fromRef !== void 0 ? { ref: options.fromRef } : {},
            ...options.fromPoint !== void 0 ? { text: "" } : {}
          });
          const start = options.fromPoint !== void 0 ? pointFrom(options.fromPoint) : { x: from.x, y: from.y };
          let end;
          if (options.toPoint !== void 0) end = pointFrom(options.toPoint);
          else {
            const to = await this.locate({
              ...options.toRef !== void 0 ? { ref: options.toRef } : {}
            });
            end = { x: to.x, y: to.y };
          }
          const { cdp, page } = await this.ensure();
          const base = { button: "left", clickCount: 1, modifiers: 0 };
          await cdp.send(
            "Input.dispatchMouseEvent",
            {
              type: "mouseMoved",
              x: Math.round(start.x),
              y: Math.round(start.y),
              buttons: 0,
              modifiers: 0
            },
            page.sessionId
          );
          await cdp.send(
            "Input.dispatchMouseEvent",
            {
              type: "mousePressed",
              x: Math.round(start.x),
              y: Math.round(start.y),
              ...base,
              buttons: 1
            },
            page.sessionId
          );
          const steps = 12;
          for (let step = 1; step <= steps; step += 1) {
            const x = start.x + (end.x - start.x) * step / steps;
            const y = start.y + (end.y - start.y) * step / steps;
            await cdp.send(
              "Input.dispatchMouseEvent",
              {
                type: "mouseMoved",
                x: Math.round(x),
                y: Math.round(y),
                ...base,
                buttons: 1
              },
              page.sessionId
            );
            await new Promise((resolve) => setTimeout(resolve, 16));
          }
          await cdp.send(
            "Input.dispatchMouseEvent",
            {
              type: "mouseReleased",
              x: Math.round(end.x),
              y: Math.round(end.y),
              ...base,
              buttons: 0
            },
            page.sessionId
          );
          this.touch();
          await this.waitIdle();
          if (options.read === false)
            return {
              content: [
                {
                  type: "text",
                  text: `dragged ${Math.round(start.x)},${Math.round(start.y)} to ${Math.round(end.x)},${Math.round(end.y)}`
                }
              ]
            };
          const snapshot = await this.read({ maxChars: 1500 });
          return { content: [{ type: "text", text: formatSnapshot(snapshot) }] };
        });
      }
      async upload(options) {
        return this.serial(async () => {
          await this.ensure();
          if (options.ref !== void 0) this.addressable(options.ref);
          if (options.files.length === 0)
            throw new Error("browser_upload needs at least one absolute file path");
          for (const file of options.files)
            if (!file.startsWith("/"))
              throw new Error(
                `browser_upload takes absolute paths; ${JSON.stringify(file)} is not one`
              );
          const { cdp, page } = await this.ensure();
          let nodeId = null;
          if (options.ref !== void 0) {
            const handle = await cdp.send(
              "Runtime.evaluate",
              {
                expression: `document.querySelector('[data-oxrail-ref="${options.ref}"]')`
              },
              page.sessionId
            );
            const described = await cdp.send(
              "DOM.describeNode",
              { objectId: handle.object.objectId },
              page.sessionId
            );
            nodeId = described.node.backendNodeId;
          }
          if (nodeId === null) {
            const doc = await cdp.send(
              "DOM.getDocument",
              { depth: -1 },
              page.sessionId
            );
            const queried = await cdp.send(
              "DOM.querySelector",
              { nodeId: doc.root.nodeId, selector: 'input[type="file"]' },
              page.sessionId
            );
            if (queried.nodeId === 0)
              throw new Error(
                "this page has no file input; pass a ref if the input is inside a frame"
              );
            nodeId = queried.nodeId;
          }
          await cdp.send(
            "DOM.setFileInputFiles",
            {
              files: [...options.files],
              ...nodeId === null ? {} : { backendNodeId: nodeId }
            },
            page.sessionId
          );
          this.touch();
          await this.waitIdle();
          if (options.read === false)
            return {
              content: [
                {
                  type: "text",
                  text: `put ${options.files.length} file${options.files.length === 1 ? "" : "s"} into the input`
                }
              ]
            };
          const snapshot = await this.read({ maxChars: 1500 });
          return { content: [{ type: "text", text: formatSnapshot(snapshot) }] };
        });
      }
      async grab(options) {
        return this.serial(async () => {
          await this.ensure();
          const found = await this.evaluate(`(() => {
  const scope = ${options.ref === void 0 ? "document" : `document.querySelector('[data-oxrail-ref="${options.ref}"]') || document`};
  const images = [];
  for (const node of scope.querySelectorAll("img,canvas,svg,video")) {
    const box = node.getBoundingClientRect();
    if (box.width < 8 || box.height < 8) continue;
    const src = node.currentSrc || node.src || (node.tagName === "CANVAS" ? "canvas" : "");
    images.push({ tag: node.tagName.toLowerCase(), src: src || "", width: Math.round(box.width), height: Math.round(box.height), area: Math.round(box.width * box.height) });
  }
  if (images.length === 0 && scope !== document) {
    const box = scope.getBoundingClientRect();
    images.push({ tag: "element", src: "", width: Math.round(box.width), height: Math.round(box.height), area: Math.round(box.width * box.height) });
  }
  images.sort((a, b) => b.area - a.area);
  return JSON.stringify(images.slice(0, Math.max(1, ${Math.max(1, Math.min(options.count ?? 1, 20))})));
})()`);
          const candidates = JSON.parse(found);
          this.touch();
          if (candidates.length === 0)
            throw new Error("this page is not showing a picture to save");
          const dir = join(stateDir(), "images");
          mkdirSync2(dir, { recursive: true });
          const saved = [];
          let index = 0;
          for (const candidate of candidates) {
            index += 1;
            const stamp = `${options.name ?? "image"}-${Date.now()}-${index}`;
            if (candidate.src === "" || candidate.src === "canvas") {
              const { cdp, page } = await this.ensure();
              const shot = await cdp.send(
                "Page.captureScreenshot",
                { format: "png", captureBeyondViewport: false },
                page.sessionId
              );
              const path3 = join(dir, `${stamp}.png`);
              writeFileSync(path3, Buffer.from(shot.data, "base64"));
              saved.push(
                `${path3} (from the screen, ${candidate.width}x${candidate.height})`
              );
              continue;
            }
            if (candidate.src.startsWith("data:")) {
              const comma = candidate.src.indexOf(",");
              const header = candidate.src.slice(5, comma);
              const body = candidate.src.slice(comma + 1);
              const binary = header.includes("base64") ? body : Buffer.from(decodeURIComponent(body)).toString("base64");
              const path3 = join(dir, `${stamp}.png`);
              writeFileSync(path3, Buffer.from(binary, "base64"));
              saved.push(
                `${path3} (inline, ${candidate.width}x${candidate.height})`
              );
              continue;
            }
            const fetched = await this.evaluate(`(async () => {
  try {
    const reply = await fetch(${JSON.stringify(candidate.src)});
    const buffer = await reply.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
    return btoa(binary);
  } catch (error) { return "ERROR " + String(error && error.message ? error.message : error); }
})()`);
            if (fetched.startsWith("ERROR ")) {
              saved.push(
                `${candidate.src} \u2014 could not be read: ${fetched.slice(6)}`
              );
              continue;
            }
            const path2 = join(dir, `${stamp}.png`);
            writeFileSync(path2, Buffer.from(fetched, "base64"));
            saved.push(`${path2} (${candidate.width}x${candidate.height})`);
          }
          return { content: [{ type: "text", text: saved.join("\n") }] };
        });
      }
      async evaluatePage(options) {
        return this.serial(async () => {
          await this.ensure();
          const code = options.code.trim();
          if (code === "") throw new Error("browser_eval needs code to run");
          const { cdp, page } = await this.ensure();
          const reply = await cdp.send(
            "Runtime.evaluate",
            {
              expression: options.awaitPromise === false ? code : `(async () => (${code}))()`,
              returnByValue: true,
              awaitPromise: options.awaitPromise !== false,
              userGesture: true
            },
            page.sessionId
          );
          this.touch();
          if (reply.exceptionDetails !== void 0) {
            const detail = reply.exceptionDetails;
            throw new Error(
              detail.exception?.description ?? detail.text ?? "the page threw"
            );
          }
          const value = reply.result?.value;
          const text = value === void 0 ? reply.result?.description ?? "undefined" : typeof value === "string" ? value : JSON.stringify(value, null, 2);
          return { content: [{ type: "text", text }] };
        });
      }
      async run(steps) {
        return this.serial(async () => {
          await this.ensure();
          if (steps.length === 0)
            throw new Error("browser_do needs at least one step");
          const done = [];
          for (let index = 0; index < steps.length; index += 1) {
            const step = steps[index];
            const at = `step ${index + 1}`;
            try {
              if (step.waitText !== void 0) {
                await this.awaitText(step.waitText, true);
                done.push(`${at}: saw ${JSON.stringify(step.waitText)}`);
                continue;
              }
              if (step.waitGone !== void 0) {
                await this.awaitText(step.waitGone, false);
                done.push(`${at}: ${JSON.stringify(step.waitGone)} went away`);
                continue;
              }
              if (step.waitUrl !== void 0) {
                await this.awaitUrl(step.waitUrl);
                done.push(`${at}: reached ${step.waitUrl}`);
                continue;
              }
              if (step.scroll !== void 0) {
                await this.scroll({ dy: step.scroll, read: false });
                done.push(`${at}: scrolled ${step.scroll}`);
                continue;
              }
              if (step.key !== void 0) {
                await this.key(step.key);
                done.push(`${at}: pressed ${step.key}`);
                continue;
              }
              if (step.field !== void 0 && step.text !== void 0) {
                const point = await this.locate({ text: step.field });
                await this.mouseClick(point.x, point.y);
                await this.type({
                  text: step.text,
                  clear: true,
                  ...step.submit === true ? { submit: true } : {}
                });
                done.push(`${at}: typed into ${JSON.stringify(step.field)}`);
                continue;
              }
              if (step.tap !== void 0) {
                const split = step.tap.split(",");
                if (split.length === 2 && split.every((part) => Number.isFinite(Number(part)))) {
                  await this.mouseClick(Number(split[0]), Number(split[1]));
                  done.push(`${at}: tapped ${step.tap}`);
                } else {
                  const point = await this.locate({ text: step.tap });
                  await this.mouseClick(point.x, point.y);
                  done.push(`${at}: tapped ${JSON.stringify(step.tap)}`);
                }
                continue;
              }
              if (step.ref !== void 0) {
                this.addressable(step.ref);
                const point = await this.locate({ ref: step.ref });
                await this.mouseClick(point.x, point.y);
                done.push(`${at}: tapped control ${step.ref}`);
                continue;
              }
              if (step.text !== void 0) {
                await this.type({
                  text: step.text,
                  ...step.submit === true ? { submit: true } : {}
                });
                done.push(`${at}: typed ${step.text.length} characters`);
                continue;
              }
              throw new Error(
                "a step needs one of: ref, tap, field+text, text, key, scroll, wait_text, wait_gone, wait_url"
              );
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              throw new Error(
                `${at} could not proceed: ${reason}${done.length === 0 ? "" : ` (after ${done.join("; ")})`}`
              );
            }
          }
          this.touch();
          return {
            content: [
              {
                type: "text",
                text: `${done.length} step${done.length === 1 ? "" : "s"} done
${done.join("\n")}`
              }
            ]
          };
        });
      }
      async awaitText(needle, present) {
        const started = Date.now();
        while (Date.now() - started < 8e3) {
          const text = await this.evaluate(
            "document.body ? document.body.innerText : ''"
          );
          const there = text.toLowerCase().includes(needle.toLowerCase());
          if (there === present) return;
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        throw new Error(
          `${JSON.stringify(needle)} ${present ? "never appeared" : "never went away"} within 8000 ms`
        );
      }
      async awaitUrl(part) {
        const started = Date.now();
        while (Date.now() - started < 8e3) {
          const url = await this.evaluate("location.href");
          if (url.includes(part)) return;
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        throw new Error(`the address never reached ${part} within 8000 ms`);
      }
      async dialog(options) {
        return this.serial(async () => {
          await this.ensure();
          await this.startWatching();
          const open = this.dialogOpen;
          if (open === null) {
            this.touch();
            return {
              content: [{ type: "text", text: "no dialog is open" }]
            };
          }
          if (options.accept === void 0 && options.text === void 0) {
            this.touch();
            return {
              content: [
                {
                  type: "text",
                  text: `${open.type}: ${JSON.stringify(open.message)}${open.defaultValue === "" ? "" : ` (default ${JSON.stringify(open.defaultValue)})`}`
                }
              ]
            };
          }
          const { cdp, page } = await this.ensure();
          await cdp.send(
            "Page.handleJavaScriptDialog",
            {
              accept: options.accept !== false,
              ...options.text === void 0 ? {} : { promptText: options.text }
            },
            page.sessionId
          );
          this.dialogOpen = null;
          this.touch();
          return {
            content: [
              {
                type: "text",
                text: options.accept === false ? "dismissed the dialog" : "accepted the dialog"
              }
            ]
          };
        });
      }
      async cookie(options) {
        return this.serial(async () => {
          await this.ensure();
          const { cdp, page } = await this.ensure();
          if (options.clear === true) {
            await cdp.send("Network.clearBrowserCookies", {}, page.sessionId);
            this.touch();
            return {
              content: [{ type: "text", text: "cleared the browser's cookies" }]
            };
          }
          if (options.set !== void 0 && options.set !== "") {
            const url2 = options.url ?? await this.evaluate("location.href");
            for (const pair of options.set.split(";")) {
              const cut = pair.indexOf("=");
              if (cut <= 0) continue;
              const name = pair.slice(0, cut).trim();
              const value = pair.slice(cut + 1).trim();
              if (name === "") continue;
              const sent = await cdp.send(
                "Network.setCookie",
                {
                  name,
                  value,
                  ...options.domain === void 0 ? { url: url2 } : { domain: options.domain }
                },
                page.sessionId
              );
              if (sent.success === false)
                throw new Error(`the browser refused the cookie ${name}`);
            }
            this.touch();
            return {
              content: [{ type: "text", text: `set ${options.set}` }]
            };
          }
          const url = options.url;
          const listed = await cdp.send(
            "Network.getCookies",
            url === void 0 || url === "" ? {} : { urls: [url] },
            page.sessionId
          );
          this.touch();
          if (listed.cookies.length === 0)
            return {
              content: {
                type: "text",
                text: "(this browser is keeping no cookies for that address)"
              }
            };
          const rows = listed.cookies.map(
            (item) => `${item.name}=${item.value} \u2014 ${item.domain}${item.path}${item.httpOnly ? " httpOnly" : ""}${item.secure ? " secure" : ""}${item.expires > 0 ? ` until ${new Date(item.expires * 1e3).toISOString()}` : ""}`
          );
          return { content: [{ type: "text", text: rows.join("\n") }] };
        });
      }
      async clipboard(options) {
        return this.serial(async () => {
          await this.ensure();
          if (options.set !== void 0) {
            const wrote = await this.evaluate(`(async () => {
  try { await navigator.clipboard.writeText(${JSON.stringify(options.set)}); return true; }
  catch (error) { return false; }
})()`);
            this.touch();
            if (!wrote) throw new Error("the page refused the clipboard write");
            return {
              content: [
                {
                  type: "text",
                  text: `put ${options.set.length} characters on the clipboard; send a key to paste`
                }
              ]
            };
          }
          const read = await this.evaluate(`(async () => {
  try { return await navigator.clipboard.readText(); }
  catch (error) { return "ERROR " + String(error && error.message ? error.message : error); }
})()`);
          this.touch();
          if (read.startsWith("ERROR "))
            throw new Error(
              `the page would not hand over the clipboard: ${read.slice(6)}`
            );
          return { content: [{ type: "text", text: read }] };
        });
      }
      async console(options) {
        return this.serial(async () => {
          await this.ensure();
          await this.startWatching();
          const limit = Math.max(1, Math.min(options.limit ?? 50, 400));
          this.touch();
          const lines = this.consoleLines.slice(-limit);
          return {
            content: [
              {
                type: "text",
                text: lines.length === 0 ? "(this page has produced no console output since it opened)" : lines.join("\n")
              }
            ]
          };
        });
      }
      async network(options) {
        return this.serial(async () => {
          await this.ensure();
          await this.startWatching();
          const limit = Math.max(1, Math.min(options.limit ?? 40, 200));
          const filter = (options.filter ?? "").toLowerCase();
          this.touch();
          const rows = this.responses.filter(
            (item) => filter === "" || item.url.toLowerCase().includes(filter)
          ).slice(0, limit);
          return {
            content: [
              {
                type: "text",
                text: rows.length === 0 ? filter === "" ? "(this page has received no responses since it opened)" : `(no response matches ${JSON.stringify(filter)})` : rows.map(
                  (item) => `${item.method} ${item.status === 0 ? "\u2014" : String(item.status)} ${item.type} ${squashUrl(item.url)}`
                ).join("\n")
              }
            ]
          };
        });
      }
      async failed(options) {
        return this.serial(async () => {
          await this.ensure();
          await this.startWatching();
          const limit = Math.max(1, Math.min(options.limit ?? 40, 200));
          this.touch();
          const rows = this.failedRequests.slice(0, limit);
          return {
            content: [
              {
                type: "text",
                text: rows.length === 0 ? "(nothing this page asked for has failed since it opened)" : rows.map(
                  (item) => `${item.type} ${item.error} ${item.url === "" ? "(address unknown)" : squashUrl(item.url)}`
                ).join("\n")
              }
            ]
          };
        });
      }
      async tabs(options) {
        return this.serial(async () => {
          await this.ensure();
          const { cdp, page } = await this.ensure();
          const listed = await cdp.send("Target.getTargets");
          const pages = listed.targetInfos.filter((info) => info.type === "page");
          const action = options.action ?? "list";
          if (action === "switch" || action === "close") {
            const index = options.index ?? 0;
            const target = pages[index];
            if (target === void 0)
              throw new Error(
                `there ${pages.length === 1 ? "is" : "are"} ${pages.length} page${pages.length === 1 ? "" : "s"}; ${index} is not one of them`
              );
            if (action === "close") {
              await cdp.send("Target.closeTarget", { targetId: target.targetId });
              this.touch();
              return {
                content: [
                  { type: "text", text: `closed ${target.title || target.url}` }
                ]
              };
            }
            const attached = await cdp.send(
              "Target.attachToTarget",
              { targetId: target.targetId, flatten: true },
              void 0
            );
            this.page = {
              sessionId: attached.sessionId,
              targetId: target.targetId
            };
            await cdp.send("Page.enable", {}, attached.sessionId);
            await cdp.send("Runtime.enable", {}, attached.sessionId);
            this.watching = false;
            await this.startWatching();
            this.touch();
            return {
              content: [
                { type: "text", text: `switched to ${target.title || target.url}` }
              ]
            };
          }
          this.touch();
          const rows = pages.map(
            (info, index) => `${index === 0 ? "" : " "}[${index}] ${info.title === "" ? "(untitled)" : info.title} \u2014 ${squashUrl(info.url)}${info.targetId === page.targetId ? " (this one)" : ""}`
          );
          return {
            content: [
              {
                type: "text",
                text: rows.length === 0 ? "(no pages are open)" : rows.join("\n")
              }
            ]
          };
        });
      }
      async downloads() {
        return this.serial(async () => {
          await this.ensure();
          const dir = profileDir(this.profile);
          const rows = [];
          const candidates = [
            join(dir, "Downloads"),
            join(stateDir(), "downloads")
          ];
          for (const where of candidates) {
            if (!existsSync2(where)) continue;
            for (const entry2 of readdirSync(where)) {
              const path2 = join(where, entry2);
              const stat = statSync2(path2);
              if (!stat.isFile()) continue;
              rows.push(
                `${entry2} \u2014 ${stat.size} bytes, ${new Date(stat.mtimeMs).toISOString()}`
              );
            }
          }
          this.touch();
          return {
            content: [
              {
                type: "text",
                text: rows.length === 0 ? "(this profile has downloaded nothing)" : rows.join("\n")
              }
            ]
          };
        });
      }
      async media(options) {
        return this.serial(async () => {
          await this.ensure();
          await this.startWatching();
          const items = this.played.filter(
            (item) => options.all === true || item.kind === "Media"
          );
          this.touch();
          if (options.save !== void 0 && options.save !== "") {
            const wanted = options.save;
            const picked = wanted === "main" ? items[0] : /^\d+$/.test(wanted) ? items[Number(wanted)] : items.find((item) => item.url.includes(wanted));
            if (picked === void 0)
              throw new Error(
                `nothing this page played matches ${JSON.stringify(wanted)}`
              );
            const dir = join(stateDir(), "media");
            mkdirSync2(dir, { recursive: true });
            const name = picked.url.split("/").pop() ?? "media";
            const path2 = join(
              dir,
              `${Date.now()}-${name.replace(/[^\w.-]/g, "_")}`
            );
            const fetched = await this.evaluate(`(async () => {
  const reply = await fetch(${JSON.stringify(picked.url)});
  const buffer = await reply.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
})()`);
            writeFileSync(path2, Buffer.from(fetched, "base64"));
            return {
              content: [{ type: "text", text: `${path2} (${picked.url})` }]
            };
          }
          const rows = items.map(
            (item, index) => `${index}. ${item.kind} ${squashUrl(item.url)}`
          );
          return {
            content: [
              {
                type: "text",
                text: rows.length === 0 ? "(this page has not asked for any media since it opened)" : rows.join("\n")
              }
            ]
          };
        });
      }
      async pdf() {
        return this.serial(async () => {
          await this.ensure();
          const { cdp, page } = await this.ensure();
          const printed = await cdp.send(
            "Page.printToPDF",
            { printBackground: true },
            page.sessionId
          );
          const dir = join(stateDir(), "pdf");
          mkdirSync2(dir, { recursive: true });
          const path2 = join(dir, `page-${Date.now()}.pdf`);
          writeFileSync(path2, Buffer.from(printed.data, "base64"));
          this.touch();
          return { content: [{ type: "text", text: path2 }] };
        });
      }
      async prepare(options) {
        return this.serial(async () => {
          await this.ensure();
          await this.startWatching();
          const seconds = Math.max(1, Math.min(options.seconds ?? 2, 30));
          if (options.focus !== false) {
            await this.evaluate(`(() => {
  const el = document.querySelector("canvas,video,embed,object,[tabindex]") || document.body;
  if (el && typeof el.focus === "function") el.focus();
  if (el) el.click && el.click();
  return true;
})()`);
          }
          const frames = await this.evaluate(`(async () => {
  let count = 0;
  const until = performance.now() + ${seconds * 1e3};
  await new Promise((resolve) => {
    const tick = () => { count += 1; if (performance.now() >= until) resolve(null); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    setTimeout(resolve, ${seconds * 1e3 + 500});
  });
  return count;
})()`);
          const surface = await this.evaluate(`(() => {
  const found = [];
  for (const node of document.querySelectorAll("canvas,embed,object,video,[tabindex]")) {
    const box = node.getBoundingClientRect();
    if (box.width < 40 || box.height < 40) continue;
    found.push({ tag: node.tagName.toLowerCase(), width: Math.round(box.width), height: Math.round(box.height) });
  }
  const flash = document.querySelector("object[type*='flash'],embed[type*='flash']");
  return JSON.stringify({ surfaces: found.slice(0, 6), flash: flash !== null });
})()`);
          const state = JSON.parse(surface);
          const fps = Math.round(frames / seconds * 10) / 10;
          this.touch();
          const lines = [
            `frame rate ${fps}/s over ${seconds}s`,
            state.surfaces.length === 0 ? "no input surface larger than 40px was found" : `input surfaces: ${state.surfaces.map((item) => `${item.tag} ${item.width}x${item.height}`).join(", ")}`,
            state.flash ? "this page embeds a Flash player, which this browser cannot render" : "no Flash player is embedded"
          ];
          return { content: [{ type: "text", text: lines.join("\n") }] };
        });
      }
      async close() {
        if (this.restTimer !== null) clearTimeout(this.restTimer);
        this.restTimer = null;
        const chrome = this.chrome;
        const cdp = this.cdp;
        this.chrome = null;
        this.cdp = null;
        this.page = null;
        this.runningHeadless = null;
        this.runningProfile = null;
        this.closed = true;
        if (cdp !== null) cdp.close();
        if (chrome !== null) await chrome.close().catch(() => void 0);
        return this.stateSync();
      }
    };
  }
});

// packages/browser-control/src/main.ts
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// packages/browser-control/src/tools.ts
init_types();
init_read();
var ArgumentError = class extends Error {
  name = "ArgumentError";
};
var TOOLS = [
  {
    name: "browser_open",
    title: "Open the browser",
    description: "Start this route's own Chrome, or reuse the one already running, and return its state. Call it before any other browser tool and after browser_close. This browser is not the person's browser: it has its own profile, windows and sign-ins. The first open of a profile pays a cold start.",
    properties: {
      url: {
        kind: "string",
        description: "Page to open. Defaults to a blank page."
      },
      headless: {
        kind: "boolean",
        description: "Hide the window. Defaults to false: the browser is visible unless this call says otherwise.",
        extras: { default: false }
      },
      profile: {
        kind: "string",
        description: 'Named profile to use. Defaults to "default"; sign-ins are kept per profile directory.',
        extras: { default: "default" }
      }
    },
    async run(route, args) {
      const url = stringValue(args, "url");
      const headless = booleanValue(args, "headless");
      const profile = stringValue(args, "profile");
      const options = {
        ...url === void 0 ? {} : { url },
        ...headless === void 0 ? {} : { headless },
        ...profile === void 0 ? {} : { profile }
      };
      return textResult(formatState(await route.open(options)));
    }
  },
  {
    name: "browser_view",
    title: "Read the page",
    description: 'Read the current page as text. This is the cheap way to see the words and the controls: each control sits on its own line as [12] button "Sign in", and 12 is the ref that browser_click and browser_type take. A run of near-identical controls is folded onto one line as [0]-[39] button "Item 0" .. "Item 39" (40 controls, one line), and every number in that range still works. Use browser_shot only when layout or appearance matters. mode narrows the read to links or form controls; maxChars stops it early.',
    properties: {
      mode: {
        kind: "enum",
        values: ["text", "links", "forms"],
        description: "What to read: page text (default), links only, or form controls only."
      },
      maxChars: {
        kind: "integer",
        description: "Stop reading after this many characters.",
        extras: { minimum: 1 }
      }
    },
    async run(route, args) {
      const mode = stringValue(args, "mode");
      const maxChars = integerValue(args, "maxChars");
      const options = {
        ...mode === void 0 ? {} : { mode },
        ...maxChars === void 0 ? {} : { maxChars }
      };
      return textResult(formatSnapshot(await route.read(options)));
    }
  },
  {
    name: "browser_read",
    title: "Read only what you need",
    description: 'Read the page without taking the whole DOM. mode:"article" gives the reading column as Markdown; mode:"map" gives the headings and the numbered controls with no body text, to decide what to read next; mode:"query" plus a query gives only the passages that answer it, ranked locally, so a long page costs a few hundred words; mode:"changed" gives only what appeared since the last read. Prefer this over browser_view on any page longer than a few screens.',
    properties: {
      mode: {
        kind: "enum",
        values: ["article", "map", "query", "changed"],
        description: "article: the text. map: the shape. query: the passages that answer a query. changed: only what is new."
      },
      query: {
        kind: "string",
        description: "What you are looking for, for mode query."
      },
      maxChars: {
        kind: "integer",
        description: "Stop after this many characters. Default 2000.",
        extras: { minimum: 200 }
      }
    },
    async run(route, args) {
      const mode = stringValue(args, "mode") ?? "article";
      if (mode !== "article" && mode !== "map" && mode !== "query" && mode !== "changed")
        return failure(
          `unknown mode ${JSON.stringify(mode)}: use article, map, query or changed`
        );
      const query = stringValue(args, "query");
      if (mode === "query" && (query ?? "").trim() === "")
        return failure("mode query needs a query: what are you looking for?");
      const maxChars = integerValue(args, "maxChars");
      const options = {
        mode,
        ...query === void 0 ? {} : { query },
        ...maxChars === void 0 ? {} : { maxChars }
      };
      return textResult(formatSnapshot(await route.digest(options)));
    }
  },
  {
    name: "browser_click",
    title: "Click a control",
    description: "Activate one control: give its ref from the last browser_view, or its visible text. Pass exactly one of the two. There is no way to click a coordinate: the ref a read returned is the whole address, so a number no read produced is refused. A click usually changes the page, so read again before the next ref-based call.",
    properties: {
      ref: {
        kind: "integer",
        description: "Number of a control from the last browser_view."
      },
      text: {
        kind: "string",
        description: "Visible text of the control to click."
      }
    },
    async run(route, args) {
      const ref = integerValue(args, "ref");
      const text = stringValue(args, "text");
      if (ref !== void 0 && text !== void 0) {
        return failure('pass either "ref" or "text", not both.');
      }
      if (ref !== void 0) return route.click({ ref });
      if (text !== void 0) return route.click({ text });
      return failure('pass "ref" from the last browser_view, or "text".');
    }
  },
  {
    name: "browser_type",
    title: "Type into a control",
    description: "Type text into a control: give the text and, when known, the ref of the field from the last browser_view. A ref comes from a read; a number no read produced is refused. clear empties the field first; submit presses Enter afterwards. For a bare key press use browser_key.",
    properties: {
      ref: {
        kind: "integer",
        description: "Number of the field from the last browser_view."
      },
      text: {
        kind: "string",
        description: "Text to type."
      },
      clear: {
        kind: "boolean",
        description: "Empty the field before typing.",
        extras: { default: false }
      },
      submit: {
        kind: "boolean",
        description: "Press Enter after typing.",
        extras: { default: false }
      }
    },
    required: ["text"],
    async run(route, args) {
      const text = stringValue(args, "text");
      if (text === void 0) return failure('"text" is required.');
      const ref = integerValue(args, "ref");
      const clear = booleanValue(args, "clear");
      const submit = booleanValue(args, "submit");
      return route.type({
        text,
        ...ref === void 0 ? {} : { ref },
        ...clear === void 0 ? {} : { clear },
        ...submit === void 0 ? {} : { submit }
      });
    }
  },
  {
    name: "browser_key",
    title: "Press a key",
    description: "Press a single key on the page, such as Enter, Tab, Escape or ArrowDown. Use it when the key matters and no control needs a ref; type text with browser_type instead.",
    properties: {
      key: {
        kind: "string",
        description: "Key name, for example Enter or Tab."
      }
    },
    required: ["key"],
    async run(route, args) {
      const key = stringValue(args, "key");
      if (key === void 0) return failure('"key" is required.');
      return route.key(key);
    }
  },
  {
    name: "browser_nav",
    title: "Navigate",
    description: "Move the browser to a url, back one page, or reload. Use browser_click for a link already on the page; use this when the destination is known.",
    properties: {
      url: {
        kind: "string",
        description: "Page to open."
      },
      back: {
        kind: "boolean",
        description: "Go back one history entry.",
        extras: { default: false }
      },
      reload: {
        kind: "boolean",
        description: "Reload the current page.",
        extras: { default: false }
      }
    },
    async run(route, args) {
      const url = stringValue(args, "url");
      const back = booleanValue(args, "back");
      const reload = booleanValue(args, "reload");
      if (url === void 0 && back !== true && reload !== true) {
        return failure("pass url, back or reload.");
      }
      return textResult(
        formatState(
          await route.nav({
            ...url === void 0 ? {} : { url },
            ...back === void 0 ? {} : { back },
            ...reload === void 0 ? {} : { reload }
          })
        )
      );
    }
  },
  {
    name: "browser_shot",
    title: "Take a screenshot",
    description: "Capture the page as a PNG: the viewport by default, or the full page with fullPage. Use it when layout, color or an image matters; browser_view is cheaper for text. Returns the image plus the saved file path.",
    properties: {
      fullPage: {
        kind: "boolean",
        description: "Capture the whole page instead of the viewport.",
        extras: { default: false }
      }
    },
    async run(route, args) {
      const fullPage = booleanValue(args, "fullPage");
      const options = fullPage === void 0 ? {} : { fullPage };
      const shot = await route.shot(options);
      return {
        content: [
          {
            type: "image",
            data: shot.png,
            mimeType: "image/png"
          },
          { type: "text", text: `saved ${shot.path}` }
        ]
      };
    }
  },
  {
    name: "browser_state",
    title: "Browser state",
    description: "Report the browser: running or closed, profile, current url and title, headless, and the idle clock (idleMs, closesInMs). Cheap; use it to decide whether browser_open is needed and how long the browser will stay.",
    properties: {},
    async run(route) {
      return textResult(formatState(await route.state()));
    }
  },
  {
    name: "browser_login",
    title: "Saved sign-in",
    description: "Report the saved sign-in for the current profile. Sign-ins persist per profile directory, so this says whether a sign-in already exists; it does not read, fill or submit login forms.",
    properties: {},
    async run(route) {
      return textResult(formatLogin(await route.login()));
    }
  },
  {
    name: "browser_find",
    title: "Search the page",
    description: 'Search the controls and the words on the page and get back only the hits, each with the number a click takes. Use it when the page is too long to read: browser_view answers "what is here", this answers "where is this". Matches a lowercased substring unless regex is true; limit caps the rows.',
    properties: {
      query: {
        kind: "string",
        description: "What to look for, in a control name or in the page text."
      },
      regex: {
        kind: "boolean",
        description: "Treat query as a regular expression.",
        extras: { default: false }
      },
      limit: {
        kind: "integer",
        description: "Stop after this many hits. Defaults to 40.",
        extras: { minimum: 1, maximum: 200 }
      }
    },
    required: ["query"],
    async run(route, args) {
      const query = stringValue(args, "query");
      if (query === void 0)
        throw new ArgumentError('browser_find: "query" is required.');
      const regex = booleanValue(args, "regex");
      const limit = integerValue(args, "limit");
      return route.find({
        query,
        ...regex === void 0 ? {} : { regex },
        ...limit === void 0 ? {} : { limit }
      });
    }
  },
  {
    name: "browser_extract",
    title: "Extract by selector",
    description: "Pull the rows that one CSS selector describes \u2014 every link in a list, every price in a grid \u2014 without reading the rest of the page. Scope it to one control with ref, which is the number browser_view printed; any element on the page is only reachable that way.",
    properties: {
      select: { kind: "string", description: "CSS selector to read." },
      ref: {
        kind: "integer",
        description: "Read only inside this control, by the number browser_view printed."
      },
      limit: {
        kind: "integer",
        description: "Stop after this many rows. Defaults to 50.",
        extras: { minimum: 1, maximum: 500 }
      }
    },
    required: ["select"],
    async run(route, args) {
      const select = stringValue(args, "select");
      if (select === void 0)
        throw new ArgumentError('browser_extract: "select" is required.');
      const ref = integerValue(args, "ref");
      const limit = integerValue(args, "limit");
      return route.extract({
        select,
        ...ref === void 0 ? {} : { ref },
        ...limit === void 0 ? {} : { limit }
      });
    }
  },
  {
    name: "browser_look",
    title: "Look at the page as a grid",
    description: 'See the page without image tokens: it comes back as a grid of letters, one letter per cell, so a colour or a layout can be read as text. Use it for a canvas, a chart, a game or a page that draws itself, where there are no words to read. region crops to "x,y,width,height"; items adds more cells; diff reports only the cells that changed since the last look.',
    properties: {
      cols: {
        kind: "integer",
        description: "Cells across. Defaults to 12.",
        extras: { minimum: 2, maximum: 64 }
      },
      region: {
        kind: "string",
        description: 'Crop to this box in pixels: "x,y,width,height".'
      },
      items: {
        kind: "integer",
        description: "Cells down. Defaults to the height the grid implies.",
        extras: { minimum: 2, maximum: 96 }
      },
      diff: {
        kind: "boolean",
        description: "Report only the cells that changed since the last look.",
        extras: { default: true }
      }
    },
    async run(route, args) {
      const cols = integerValue(args, "cols");
      const region = stringValue(args, "region");
      const items = integerValue(args, "items");
      const diff = booleanValue(args, "diff");
      return route.look({
        ...cols === void 0 ? {} : { cols },
        ...region === void 0 ? {} : { region },
        ...items === void 0 ? {} : { items },
        ...diff === void 0 ? {} : { diff }
      });
    }
  },
  {
    name: "browser_wait",
    title: "Wait for the page",
    description: "Block until the page settles instead of reading it over and over: wait for text to appear, for text to go away, for the address to reach something, or for the page to stop changing. Returns as soon as the condition holds, and says what the page looks like when it does not. Every wait is bounded, so a page that never gets there reports that rather than hanging.",
    properties: {
      text: {
        kind: "string",
        description: "Wait until this text is on the page."
      },
      gone: {
        kind: "string",
        description: "Wait until this text is off the page."
      },
      url: {
        kind: "string",
        description: "Wait until the address contains this."
      },
      quiet: {
        kind: "boolean",
        description: "Wait until the page stops changing.",
        extras: { default: false }
      },
      timeoutMs: {
        kind: "integer",
        description: "Give up after this many milliseconds. Defaults to 8000.",
        extras: { minimum: 50, maximum: 12e4 }
      }
    },
    async run(route, args) {
      const timeoutMs = integerValue(args, "timeoutMs");
      const text = stringValue(args, "text");
      const gone = stringValue(args, "gone");
      const url = stringValue(args, "url");
      const quiet = booleanValue(args, "quiet");
      return route.wait({
        ...text === void 0 ? {} : { text },
        ...gone === void 0 ? {} : { gone },
        ...url === void 0 ? {} : { url },
        ...quiet === void 0 ? {} : { quiet },
        ...timeoutMs === void 0 ? {} : { timeoutMs }
      });
    }
  },
  {
    name: "browser_scroll",
    title: "Scroll",
    description: "Scroll the page by a number of pixels. Negative goes up. This is what brings a lazy-loaded list into being; read after scrolling rather than reading the whole page first.",
    properties: {
      dy: {
        kind: "integer",
        description: "Pixels down. Negative goes up."
      },
      dx: {
        kind: "integer",
        description: "Pixels right. Negative goes left."
      },
      read: {
        kind: "boolean",
        description: "Read the page after scrolling. Defaults to true.",
        extras: { default: true }
      }
    },
    async run(route, args) {
      const dy = integerValue(args, "dy");
      const dx = integerValue(args, "dx");
      const read = booleanValue(args, "read");
      return route.scroll({
        ...dy === void 0 ? {} : { dy },
        ...dx === void 0 ? {} : { dx },
        ...read === void 0 ? {} : { read }
      });
    }
  },
  {
    name: "browser_hover",
    title: "Hover",
    description: "Move the mouse onto a control and hold it there, which is how a menu that only opens on hover opens. Address it by ref, or by its name. Read after hovering when the menu is what you came for.",
    properties: {
      ref: {
        kind: "integer",
        description: "Control to hover, by the number browser_view printed."
      },
      text: { kind: "string", description: "Control to hover, by its name." },
      read: {
        kind: "boolean",
        description: "Read the page after hovering. Defaults to true.",
        extras: { default: true }
      }
    },
    async run(route, args) {
      const ref = integerValue(args, "ref");
      const text = stringValue(args, "text");
      const read = booleanValue(args, "read");
      return route.hover({
        ...ref === void 0 ? {} : { ref },
        ...text === void 0 ? {} : { text },
        ...read === void 0 ? {} : { read }
      });
    }
  },
  {
    name: "browser_check",
    title: "Check or uncheck",
    description: "Clicking blindly flips a control that is already right. This one reads the control first: checked true asks for checked and false asks for unchecked, and a call with neither only reports what it is. It says so when the box did not take the change.",
    properties: {
      ref: {
        kind: "integer",
        description: "The box or switch, by the number browser_view printed."
      },
      checked: {
        kind: "boolean",
        description: "The state wanted. Leave it out to only report."
      },
      read: {
        kind: "boolean",
        description: "Read the page afterwards. Defaults to true.",
        extras: { default: true }
      }
    },
    required: ["ref"],
    async run(route, args) {
      const ref = integerValue(args, "ref");
      if (ref === void 0)
        throw new ArgumentError('browser_check: "ref" is required.');
      const checked = booleanValue(args, "checked");
      const read = booleanValue(args, "read");
      return route.check({
        ref,
        ...checked === void 0 ? {} : { checked },
        ...read === void 0 ? {} : { read }
      });
    }
  },
  {
    name: "browser_select",
    title: "Pick from a dropdown",
    description: "Choose an option in a dropdown by its value or by the words it shows. A native select is set directly; a custom listbox is opened and the option picked, which is why a plain click on the closed control was not enough.",
    properties: {
      ref: {
        kind: "integer",
        description: "The dropdown, by the number browser_view printed."
      },
      field: {
        kind: "string",
        description: "The dropdown, by the label or name next to it."
      },
      value: {
        kind: "string",
        description: "Option to choose, by value or by its visible text."
      },
      read: {
        kind: "boolean",
        description: "Read the page afterwards. Defaults to true.",
        extras: { default: true }
      }
    },
    required: ["value"],
    async run(route, args) {
      const value = stringValue(args, "value");
      if (value === void 0)
        throw new ArgumentError('browser_select: "value" is required.');
      const ref = integerValue(args, "ref");
      const field = stringValue(args, "field");
      const read = booleanValue(args, "read");
      return route.select({
        value,
        ...ref === void 0 ? {} : { ref },
        ...field === void 0 ? {} : { field },
        ...read === void 0 ? {} : { read }
      });
    }
  },
  {
    name: "browser_drag",
    title: "Drag",
    description: "Drag one thing onto another: a slider handle, a card into a column, a file onto a drop zone. Give each end by ref or by a point that came from a read, and the move is sent as a real press, a series of moves and a release, which is what the page listens for.",
    properties: {
      fromRef: {
        kind: "integer",
        description: "Where the drag starts, by number."
      },
      fromPoint: {
        kind: "string",
        description: 'Where the drag starts, as "x,y" in pixels.'
      },
      toRef: {
        kind: "integer",
        description: "Where the drag ends, by number."
      },
      toPoint: {
        kind: "string",
        description: 'Where the drag ends, as "x,y" in pixels.'
      },
      read: {
        kind: "boolean",
        description: "Read the page afterwards. Defaults to true.",
        extras: { default: true }
      }
    },
    async run(route, args) {
      const fromRef = integerValue(args, "fromRef");
      const fromPoint = stringValue(args, "fromPoint");
      const toRef = integerValue(args, "toRef");
      const toPoint = stringValue(args, "toPoint");
      const read = booleanValue(args, "read");
      return route.drag({
        ...fromRef === void 0 ? {} : { fromRef },
        ...fromPoint === void 0 ? {} : { fromPoint },
        ...toRef === void 0 ? {} : { toRef },
        ...toPoint === void 0 ? {} : { toPoint },
        ...read === void 0 ? {} : { read }
      });
    }
  },
  {
    name: "browser_upload",
    title: "Upload files",
    description: "Give files to a file input. The file chooser never opens: the files are handed to the input directly, so this is the only way an upload can be driven from here. Paths must be absolute.",
    properties: {
      ref: {
        kind: "integer",
        description: "The file input, by the number browser_view printed."
      },
      files: { kind: "strings", description: "Absolute paths to upload." },
      read: {
        kind: "boolean",
        description: "Read the page afterwards. Defaults to true.",
        extras: { default: true }
      }
    },
    required: ["files"],
    async run(route, args) {
      const files = coerce(
        "browser_upload",
        "files",
        { kind: "strings", description: "" },
        args.files
      );
      const ref = integerValue(args, "ref");
      const read = booleanValue(args, "read");
      return route.upload({
        files,
        ...ref === void 0 ? {} : { ref },
        ...read === void 0 ? {} : { read }
      });
    }
  },
  {
    name: "browser_grab",
    title: "Save an image",
    description: "Save the picture on the page \u2014 the largest image, a canvas, or the one a ref names \u2014 as a file, so it can be opened rather than described. Reach for it when the thing you want is pixels.",
    properties: {
      ref: { kind: "integer", description: "The image or canvas, by number." },
      name: { kind: "string", description: "File name to save it under." },
      count: {
        kind: "integer",
        description: "Save this many of the largest pictures. Defaults to 1.",
        extras: { minimum: 1, maximum: 20 }
      }
    },
    async run(route, args) {
      const ref = integerValue(args, "ref");
      const name = stringValue(args, "name");
      const count = integerValue(args, "count");
      return route.grab({
        ...ref === void 0 ? {} : { ref },
        ...name === void 0 ? {} : { name },
        ...count === void 0 ? {} : { count }
      });
    }
  },
  {
    name: "browser_eval",
    title: "Run JavaScript in the page",
    description: "Run an expression in the page and get its value back, for a fact no reading exposes: a computed style, a scroll height, a property on a global. Nothing is clicked and nothing is typed, and the page is not navigated. Prefer a reading when a reading answers it.",
    properties: {
      code: {
        kind: "string",
        description: "The expression to run. Its value is returned."
      },
      awaitPromise: {
        kind: "boolean",
        description: "Wait for a promise the expression returns. Defaults to true.",
        extras: { default: true }
      }
    },
    required: ["code"],
    async run(route, args) {
      const code = stringValue(args, "code");
      if (code === void 0)
        throw new ArgumentError('browser_eval: "code" is required.');
      const awaitPromise = booleanValue(args, "awaitPromise");
      return route.evaluatePage({
        code,
        ...awaitPromise === void 0 ? {} : { awaitPromise }
      });
    }
  },
  {
    name: "browser_do",
    title: "Run a batch of steps",
    description: "Do a whole sequence in one call \u2014 open a menu, type into a field, press Enter, wait for the result \u2014 instead of one round trip per action. Each step names one thing: ref, tap, field with text, text, key, scroll, wait_text, wait_gone, wait_url. The batch stops at the first step that cannot proceed and says which one, so a half-done sequence is never reported as done.",
    properties: {
      steps: { kind: "steps", description: "The steps, in order." }
    },
    required: ["steps"],
    async run(route, args) {
      const steps = coerce(
        "browser_do",
        "steps",
        { kind: "steps", description: "" },
        args.steps
      );
      return route.run(steps);
    }
  },
  {
    name: "browser_dialog",
    title: "Answer a dialog",
    description: "A confirm, an alert or a prompt stops the page until it is answered. With accept it is accepted and with text a prompt is filled in; with neither it only reports what is open. Use it when a click seemed to do nothing \u2014 an unhandled dialog is the usual reason.",
    properties: {
      accept: {
        kind: "boolean",
        description: "Accept the dialog. Leave it out to only report."
      },
      text: { kind: "string", description: "Text for a prompt." }
    },
    async run(route, args) {
      const accept = booleanValue(args, "accept");
      const text = stringValue(args, "text");
      return route.dialog({
        ...accept === void 0 ? {} : { accept },
        ...text === void 0 ? {} : { text }
      });
    }
  },
  {
    name: "browser_cookie",
    title: "Cookies",
    description: "Read the cookies for the page, set one, or clear them all. Use it to keep a sign-in that a page stores in a cookie, or to see what the page was told to remember.",
    properties: {
      url: {
        kind: "string",
        description: "Read only the cookies this address sends."
      },
      set: {
        kind: "string",
        description: 'Set one cookie as "name=value; path=/".'
      },
      domain: {
        kind: "string",
        description: "Domain for the cookie being set."
      },
      clear: {
        kind: "boolean",
        description: "Clear every cookie first.",
        extras: { default: false }
      }
    },
    async run(route, args) {
      const url = stringValue(args, "url");
      const set = stringValue(args, "set");
      const domain = stringValue(args, "domain");
      const clear = booleanValue(args, "clear");
      return route.cookie({
        ...url === void 0 ? {} : { url },
        ...set === void 0 ? {} : { set },
        ...domain === void 0 ? {} : { domain },
        ...clear === void 0 ? {} : { clear }
      });
    }
  },
  {
    name: "browser_clipboard",
    title: "Clipboard",
    description: "Read what the page put on the clipboard, or put text there for a page that pastes. With set it writes; with nothing it reads.",
    properties: {
      set: { kind: "string", description: "Text to put on the clipboard." }
    },
    async run(route, args) {
      const set = stringValue(args, "set");
      return route.clipboard({ ...set === void 0 ? {} : { set } });
    }
  },
  {
    name: "browser_console",
    title: "Console",
    description: "What the page logged, newest last. A click that seemed to do nothing usually left a reason here, and so does a page that half-loaded.",
    properties: {
      limit: {
        kind: "integer",
        description: "Return this many of the newest lines. Defaults to 50.",
        extras: { minimum: 1, maximum: 400 }
      }
    },
    async run(route, args) {
      const limit = integerValue(args, "limit");
      return route.console({ ...limit === void 0 ? {} : { limit } });
    }
  },
  {
    name: "browser_network",
    title: "Network",
    description: "The requests the page made, with their status. Use it when a page is empty or a submission seemed to vanish: a failed request and a request that was never made look the same on the page and different here.",
    properties: {
      filter: {
        kind: "string",
        description: "Only rows whose address contains this."
      },
      limit: {
        kind: "integer",
        description: "Return this many of the newest rows. Defaults to 50.",
        extras: { minimum: 1, maximum: 400 }
      }
    },
    async run(route, args) {
      const filter = stringValue(args, "filter");
      const limit = integerValue(args, "limit");
      return route.network({
        ...filter === void 0 ? {} : { filter },
        ...limit === void 0 ? {} : { limit }
      });
    }
  },
  {
    name: "browser_failed",
    title: "Failed requests",
    description: "Only the requests that never finished, with the reason. This is the short list behind a page that looks broken.",
    properties: {
      limit: {
        kind: "integer",
        description: "Return this many of the newest. Defaults to 50.",
        extras: { minimum: 1, maximum: 200 }
      }
    },
    async run(route, args) {
      const limit = integerValue(args, "limit");
      return route.failed({ ...limit === void 0 ? {} : { limit } });
    }
  },
  {
    name: "browser_tabs",
    title: "Tabs",
    description: "List the open tabs, switch to one by index, or close one. A page that opened a second window to sign in or to show a document is reachable only through here.",
    properties: {
      action: {
        kind: "enum",
        values: ["list", "switch", "close"],
        description: "What to do. Defaults to list."
      },
      index: {
        kind: "integer",
        description: "Which tab, as the list printed it. Needed by switch and close.",
        extras: { minimum: 0 }
      }
    },
    async run(route, args) {
      const action = stringValue(args, "action");
      const index = integerValue(args, "index");
      return route.tabs({
        ...action === void 0 ? {} : { action },
        ...index === void 0 ? {} : { index }
      });
    }
  },
  {
    name: "browser_downloads",
    title: "Downloads",
    description: "The files this profile has downloaded, newest last, with their size and where they landed. A download that never appeared is a click that never started one.",
    properties: {},
    async run(route) {
      return route.downloads();
    }
  },
  {
    name: "browser_media",
    title: "Media",
    description: 'The streams the page played, and a way to save one: save "main" takes the one the page was really playing, an index takes that row, and a piece of its address matches. Use it for a video or audio file the page will not hand over as a link.',
    properties: {
      all: {
        kind: "boolean",
        description: "Include request streams, not only media. Defaults to false.",
        extras: { default: false }
      },
      save: {
        kind: "string",
        description: 'Save this stream: "main", an index, or part of its address.'
      },
      watch: {
        kind: "boolean",
        description: "Only report, without saving.",
        extras: { default: false }
      }
    },
    async run(route, args) {
      const all = booleanValue(args, "all");
      const save = stringValue(args, "save");
      const watch = booleanValue(args, "watch");
      return route.media({
        ...all === void 0 ? {} : { all },
        ...save === void 0 ? {} : { save },
        ...watch === void 0 ? {} : { watch }
      });
    }
  },
  {
    name: "browser_pdf",
    title: "Print to PDF",
    description: "Print the page to a PDF file and say where it landed. Use it for a receipt, an invoice or a document the page renders but does not offer to download.",
    properties: {},
    async run(route) {
      return route.pdf();
    }
  },
  {
    name: "browser_prepare",
    title: "Prepare for animation",
    description: "Get a canvas, a game or a video ready and measure it: it takes the focus, counts the frames the page actually draws over a few seconds, and reports the input surfaces it found. Use it before reading a page that draws itself, so a still frame is not mistaken for a page that is running.",
    properties: {
      seconds: {
        kind: "integer",
        description: "How long to count frames. Defaults to 2.",
        extras: { minimum: 1, maximum: 30 }
      },
      focus: {
        kind: "boolean",
        description: "Take the focus first. Defaults to true.",
        extras: { default: true }
      }
    },
    async run(route, args) {
      const seconds = integerValue(args, "seconds");
      const focus = booleanValue(args, "focus");
      return route.prepare({
        ...seconds === void 0 ? {} : { seconds },
        ...focus === void 0 ? {} : { focus }
      });
    }
  },
  {
    name: "browser_mode",
    title: "Show or hide the window",
    description: "Say whether the browser draws a window you can watch, and get the mode it is in now. Visible is the default: a page nobody can see makes a wrong reading look like a right one. Changing it means the browser is put down and brought back up in the other mode on the same page, so it takes a moment. This does not change how clicks are delivered; leave the display out to ask.",
    properties: {
      display: {
        kind: "enum",
        description: "visible to show the window, headless to hide it. Leave it out to ask which is in force.",
        values: ["visible", "headless"]
      }
    },
    async run(route, args) {
      const display = args.display;
      if (display !== void 0 && display !== "visible" && display !== "headless")
        throw new ArgumentError(
          'browser_mode: display has to be "visible" or "headless"'
        );
      return route.mode(display === void 0 ? {} : { display });
    }
  },
  {
    name: "browser_ask",
    title: "Ask the chat in the page",
    description: "Say something to a chat that is open in the page \u2014 a model, a support window, a search box \u2014 and read its answer back in the same call. Types into the box, presses Enter, then waits until the answer stops growing. Use it to get an answer without a read between every step.",
    properties: {
      text: {
        kind: "string",
        description: "The name of the box, when no ref names it."
      },
      ref: {
        kind: "integer",
        description: "The number of the box, from browser_view.",
        extras: { minimum: 0 }
      },
      said: {
        kind: "string",
        description: "What to say. Defaults to nothing sent."
      },
      submit: {
        kind: "boolean",
        description: "Press Enter after typing. Defaults to true.",
        extras: { default: true }
      },
      timeoutMs: {
        kind: "integer",
        description: "How long to wait for the reply to settle. Defaults to 45000.",
        extras: { minimum: 1, maximum: 6e5 }
      }
    },
    async run(route, args) {
      const text = stringValue(args, "text");
      const ref = integerValue(args, "ref");
      const said = stringValue(args, "said");
      const submit = booleanValue(args, "submit");
      const timeoutMs = integerValue(args, "timeoutMs");
      return route.ask({
        ...text === void 0 ? {} : { text },
        ...ref === void 0 ? {} : { ref },
        ...said === void 0 ? {} : { said },
        ...submit === void 0 ? {} : { submit },
        ...timeoutMs === void 0 ? {} : { timeoutMs }
      });
    }
  },
  {
    name: "browser_review",
    title: "Ask for a review round",
    description: "Ask the chat in the page to review a repository and take its review back as a list: builds the message, sends it, waits for the answer, and writes the round down so the next round knows what was already said. Use it for a review round, not for a one-off question (that is browser_ask).",
    properties: {
      text: {
        kind: "string",
        description: "The name of the box, when no ref names it."
      },
      ref: {
        kind: "integer",
        description: "The number of the box, from browser_view.",
        extras: { minimum: 0 }
      },
      said: {
        kind: "string",
        description: "What to send instead of the built message."
      },
      timeoutMs: {
        kind: "integer",
        description: "How long to wait for the reply to settle. Defaults to 45000.",
        extras: { minimum: 1, maximum: 6e5 }
      }
    },
    async run(route, args) {
      const text = stringValue(args, "text");
      const ref = integerValue(args, "ref");
      const said = stringValue(args, "said");
      const timeoutMs = integerValue(args, "timeoutMs");
      return route.review({
        ...text === void 0 ? {} : { text },
        ...ref === void 0 ? {} : { ref },
        ...said === void 0 ? {} : { said },
        ...timeoutMs === void 0 ? {} : { timeoutMs }
      });
    }
  },
  {
    name: "browser_review_verdict",
    title: "Record a review verdict",
    description: "Record what happened to each point of the last review round, so the next round leaves settled points out: point numbers are the ones browser_review printed, and each mark is fixed, verified (checked in the code and the point does not apply), invalid, or open. With no marks, lists what is settled.",
    properties: {
      marks: {
        kind: "marks",
        description: "One {point, verdict} per point. verdict is fixed, verified, invalid or open."
      }
    },
    async run(route, args) {
      const raw = args.marks;
      const marks = raw === void 0 ? [] : raw.map((mark) => {
        if (typeof mark !== "object" || mark === null)
          throw new ArgumentError(
            "browser_review_verdict: each mark is {point, verdict}"
          );
        const point = mark.point;
        const verdict = mark.verdict;
        if (typeof point !== "number" || !Number.isInteger(point))
          throw new ArgumentError(
            "browser_review_verdict: point has to be a whole number"
          );
        if (!VERDICTS.includes(verdict))
          throw new ArgumentError(
            "browser_review_verdict: verdict has to be fixed, verified, invalid or open"
          );
        return { point, verdict };
      });
      return route.reviewVerdict({ marks });
    }
  },
  {
    name: "browser_resume",
    title: "Take the page back",
    description: "Take the page back: clears the hold so the next action is sent at once instead of waiting it out, and ends a takeover. Reports the page it is now holding.",
    properties: {},
    async run(route) {
      return route.resume();
    }
  },
  {
    name: "browser_close",
    title: "Close the browser",
    description: "Close the browser now and release its process. Do it when the work is done; the next browser_open cold-starts Chrome again. The browser also closes by itself after the idle window.",
    properties: {},
    async run(route) {
      return textResult(formatState(await route.close()));
    }
  }
];
var TOOL_DEFINITIONS = TOOLS.map(toDefinition);
var VERDICTS = ["fixed", "verified", "invalid", "open"];
var TOOL_BY_NAME = new Map(
  TOOLS.map((tool) => [tool.name, tool])
);
async function dispatch(route, name, args) {
  const tool = TOOL_BY_NAME.get(name);
  if (tool === void 0) return unknownTool(name);
  try {
    const validated = validate(tool, args);
    return await tool.run(route, validated);
  } catch (error) {
    return failure(describeError(error));
  }
}
function unknownTool(name) {
  return failure(`unknown tool: ${name}`);
}
function validate(tool, raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ArgumentError(`${tool.name}: arguments must be an object.`);
  }
  const input = raw;
  for (const key of Object.keys(input)) {
    if (!Object.prototype.hasOwnProperty.call(tool.properties, key)) {
      throw new ArgumentError(`${tool.name}: unexpected argument "${key}".`);
    }
  }
  const output = {};
  for (const [key, property] of Object.entries(tool.properties)) {
    const value = input[key];
    if (value === void 0 || value === null) continue;
    output[key] = coerce(tool.name, key, property, value);
  }
  for (const key of tool.required ?? []) {
    if (!Object.prototype.hasOwnProperty.call(output, key)) {
      throw new ArgumentError(`${tool.name}: "${key}" is required.`);
    }
  }
  return output;
}
function coerce(tool, key, property, value) {
  switch (property.kind) {
    case "string":
      if (typeof value !== "string") {
        throw new ArgumentError(`${tool}: "${key}" must be a string.`);
      }
      return value;
    case "boolean":
      if (typeof value !== "boolean") {
        throw new ArgumentError(`${tool}: "${key}" must be a boolean.`);
      }
      return value;
    case "integer": {
      if (typeof value === "number" && Number.isSafeInteger(value)) {
        return value;
      }
      if (typeof value === "string" && /^-?\d+$/.test(value)) {
        const parsed = Number(value);
        if (Number.isSafeInteger(parsed)) return parsed;
      }
      throw new ArgumentError(`${tool}: "${key}" must be an integer.`);
    }
    case "enum": {
      const values = property.values ?? [];
      if (typeof value !== "string" || !values.includes(value)) {
        throw new ArgumentError(
          `${tool}: "${key}" must be one of ${values.join(", ")}.`
        );
      }
      return value;
    }
    case "strings": {
      if (!Array.isArray(value)) {
        throw new ArgumentError(`${tool}: "${key}" must be a list of strings.`);
      }
      const out = [];
      for (const item of value) {
        if (typeof item !== "string") {
          throw new ArgumentError(
            `${tool}: "${key}" must be a list of strings.`
          );
        }
        out.push(item);
      }
      return out;
    }
    case "marks": {
      if (!Array.isArray(value)) {
        throw new ArgumentError(`${tool}: "${key}" must be a list of marks.`);
      }
      return value;
    }
    case "steps": {
      if (!Array.isArray(value)) {
        throw new ArgumentError(`${tool}: "${key}" must be a list of steps.`);
      }
      return value.map((item) => stepOf(tool, key, item));
    }
  }
}
function stepOf(tool, key, value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ArgumentError(`${tool}: every "${key}" entry must be an object.`);
  }
  const from = value;
  const take = (name, check) => {
    const raw = from[name];
    if (raw === void 0) return void 0;
    const done = check(raw);
    if (done === void 0) {
      throw new ArgumentError(`${tool}: step "${name}" has the wrong type.`);
    }
    return done;
  };
  const asText = (input) => typeof input === "string" ? input : void 0;
  const asInt = (input) => typeof input === "number" && Number.isSafeInteger(input) ? input : void 0;
  const asBool = (input) => typeof input === "boolean" ? input : void 0;
  const step = {
    ...take("ref", asInt) === void 0 ? {} : { ref: take("ref", asInt) },
    ...take("tap", asText) === void 0 ? {} : { tap: take("tap", asText) },
    ...take("text", asText) === void 0 ? {} : { text: take("text", asText) },
    ...take("field", asText) === void 0 ? {} : { field: take("field", asText) },
    ...take("key", asText) === void 0 ? {} : { key: take("key", asText) },
    ...take("scroll", asInt) === void 0 ? {} : { scroll: take("scroll", asInt) },
    ...take("submit", asBool) === void 0 ? {} : { submit: take("submit", asBool) },
    ...take("wait_text", asText) === void 0 ? {} : { waitText: take("wait_text", asText) },
    ...take("wait_gone", asText) === void 0 ? {} : { waitGone: take("wait_gone", asText) },
    ...take("wait_url", asText) === void 0 ? {} : { waitUrl: take("wait_url", asText) }
  };
  return step;
}
function describeError(error) {
  if (error instanceof RouteClosedError) {
    return "no browser is running. Call browser_open first.";
  }
  if (error instanceof StaleRefError) {
    return "the page changed since the last read. Call browser_view and use the new refs.";
  }
  if (error instanceof Error) {
    return error.message === "" ? "browser tool failed." : error.message;
  }
  return "browser tool failed.";
}
function stringValue(args, key) {
  const value = args[key];
  return typeof value === "string" ? value : void 0;
}
function integerValue(args, key) {
  const value = args[key];
  return typeof value === "number" ? value : void 0;
}
function booleanValue(args, key) {
  const value = args[key];
  return typeof value === "boolean" ? value : void 0;
}
function textResult(text) {
  return { content: [{ type: "text", text }] };
}
function failure(text) {
  return { content: [{ type: "text", text }], isError: true };
}
function formatState(state) {
  if (!state.running) {
    return [`running: false`, `profile: ${state.profile}`].join("\n");
  }
  return [
    `running: ${state.running}`,
    `pid: ${state.pid === null ? "null" : state.pid}`,
    `profile: ${state.profile}`,
    `url: ${state.url === null ? "null" : state.url}`,
    `title: ${state.title === null ? "null" : state.title}`,
    `headless: ${state.headless}`,
    `idleMs: ${state.idleMs}`,
    `closesInMs: ${state.closesInMs === null ? "null" : state.closesInMs}`
  ].join("\n");
}
function formatLogin(state) {
  const lines = [`profile: ${state.profile}`, `saved: ${state.saved}`];
  if (state.text !== "") lines.push(state.text);
  return lines.join("\n");
}
function toDefinition(tool) {
  const properties = {};
  for (const [key, property] of Object.entries(tool.properties)) {
    properties[key] = toPropertySchema(property);
  }
  const inputSchema = {
    type: "object",
    properties,
    additionalProperties: false
  };
  if (tool.required !== void 0 && tool.required.length > 0) {
    inputSchema.required = [...tool.required];
  }
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema
  };
}
function toPropertySchema(property) {
  const type = property.kind === "enum" ? "string" : property.kind === "strings" || property.kind === "steps" || property.kind === "marks" ? "array" : property.kind;
  const schema = {
    type,
    description: property.description
  };
  if (property.kind === "strings") {
    schema.items = { type: "string" };
  }
  if (property.kind === "steps") {
    schema.items = {
      type: "object",
      properties: {
        ref: { type: "integer" },
        tap: { type: "string" },
        text: { type: "string" },
        field: { type: "string" },
        key: { type: "string" },
        scroll: { type: "integer" },
        submit: { type: "boolean" },
        wait_text: { type: "string" },
        wait_gone: { type: "string" },
        wait_url: { type: "string" }
      },
      additionalProperties: false
    };
  }
  if (property.kind === "marks") {
    schema.items = {
      type: "object",
      properties: {
        point: { type: "integer" },
        verdict: {
          type: "string",
          enum: ["fixed", "verified", "invalid", "open"]
        }
      },
      required: ["point", "verdict"],
      additionalProperties: false
    };
  }
  if (property.values !== void 0) schema.enum = [...property.values];
  if (property.extras !== void 0) Object.assign(schema, property.extras);
  return schema;
}

// packages/browser-control/src/mcp.ts
var SERVER_NAME = "oxrail-browser-control";
var MODERN_VERSION = "2026-07-28";
var LEGACY_VERSION = "2025-11-25";
var SUPPORTED_VERSIONS = [MODERN_VERSION];
var LEGACY_VERSIONS = [MODERN_VERSION, LEGACY_VERSION];
var RESULT_TYPE = "complete";
var TOOLS_TTL_MS = 0;
var TOOLS_CACHE_SCOPE = "private";
var PROTOCOL_META_KEY = "io.modelcontextprotocol/protocolVersion";
var SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";
var PARSE_ERROR = -32700;
var INVALID_REQUEST = -32600;
var METHOD_NOT_FOUND = -32601;
var INVALID_PARAMS = -32602;
var UNSUPPORTED_PROTOCOL_VERSION = -32022;
function serveMcp(options) {
  const { stdin, stdout, stderr, route, version } = options;
  const instructions = options.instructions;
  let closed = false;
  let finishing = false;
  let buffer = "";
  let writeQueue = Promise.resolve();
  let resolveClosed = () => {
  };
  const closedPromise = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const inFlight = /* @__PURE__ */ new Set();
  const cancelled = /* @__PURE__ */ new Set();
  function write(payload) {
    if (closed) return;
    let line;
    try {
      line = `${JSON.stringify(payload)}
`;
    } catch (error) {
      note(stderr, "could not serialise a reply", error);
      return;
    }
    writeQueue = writeQueue.then(
      () => new Promise((resolve) => {
        if (closed) {
          resolve();
          return;
        }
        try {
          stdout.write(line, () => resolve());
        } catch (error) {
          note(stderr, "could not write a reply", error);
          resolve();
        }
      })
    ).catch((error) => {
      note(stderr, "the reply queue failed", error);
    });
  }
  function sendError(id, code, message, data) {
    const error = { code, message };
    if (data !== void 0) error.data = data;
    write({ jsonrpc: "2.0", id, error });
  }
  function handleLine(line) {
    if (line.trim() === "") return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      sendError(null, PARSE_ERROR, "parse error");
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      sendError(null, INVALID_REQUEST, "invalid request");
      return;
    }
    handleMessage(parsed);
  }
  function handleMessage(message) {
    const method = message.method;
    const id = message.id;
    const params = message.params;
    const hasId = id !== void 0;
    if (typeof method !== "string") {
      if (hasId) sendError(id, INVALID_REQUEST, "invalid request");
      return;
    }
    if (!hasId) {
      handleNotification(method, params);
      return;
    }
    switch (method) {
      case "server/discover":
        sendDiscover(id, params);
        return;
      case "initialize":
        sendInitialize(id, params);
        return;
      case "tools/list":
        write({
          jsonrpc: "2.0",
          id,
          result: {
            resultType: RESULT_TYPE,
            ttlMs: TOOLS_TTL_MS,
            cacheScope: TOOLS_CACHE_SCOPE,
            tools: TOOL_DEFINITIONS
          }
        });
        return;
      case "tools/call":
        startToolCall(id, params);
        return;
      case "ping":
        write({ jsonrpc: "2.0", id, result: { resultType: RESULT_TYPE } });
        return;
      default:
        sendError(id, METHOD_NOT_FOUND, `method not found: ${method}`);
    }
  }
  function handleNotification(method, params) {
    if (method === "notifications/cancelled") {
      const requestId = readCancelledId(params);
      if (requestId !== void 0) {
        const key = idKey(requestId);
        if (key !== null && inFlight.has(key)) cancelled.add(key);
      }
    }
  }
  function sendDiscover(id, params) {
    const requested = readRequestedVersion(params);
    if (requested !== void 0 && !SUPPORTED_VERSIONS.includes(requested)) {
      sendError(
        id,
        UNSUPPORTED_PROTOCOL_VERSION,
        "Unsupported protocol version",
        {
          supported: [...SUPPORTED_VERSIONS]
        }
      );
      return;
    }
    const result = {
      resultType: RESULT_TYPE,
      supportedVersions: [...SUPPORTED_VERSIONS],
      capabilities: { tools: {} },
      _meta: {
        [SERVER_INFO_META_KEY]: { name: SERVER_NAME, version }
      }
    };
    if (instructions !== void 0) result.instructions = instructions;
    write({ jsonrpc: "2.0", id, result });
  }
  function sendInitialize(id, params) {
    const requested = readProtocolVersion(params);
    const protocolVersion = requested !== void 0 && LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSION;
    write({
      jsonrpc: "2.0",
      id,
      result: {
        resultType: RESULT_TYPE,
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version }
      }
    });
  }
  function startToolCall(id, params) {
    const name = readToolName(params);
    if (name === null) {
      sendError(id, INVALID_PARAMS, "invalid params: tool name is required");
      return;
    }
    const key = idKey(id);
    if (key !== null) inFlight.add(key);
    const args = readToolArguments(params);
    void (async () => {
      let result;
      try {
        result = await dispatch(route, name, args);
      } catch (error) {
        result = failure2(error);
      }
      const wasCancelled = key !== null && cancelled.delete(key);
      if (key !== null) inFlight.delete(key);
      if (wasCancelled) return;
      write({ jsonrpc: "2.0", id, result: toCallResult(result) });
    })();
  }
  function handleData(chunk) {
    if (closed) return;
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      handleLine(line);
      index = buffer.indexOf("\n");
    }
  }
  async function finish() {
    if (finishing) return;
    finishing = true;
    try {
      await route.close();
    } catch (error) {
      note(stderr, "closing the browser route failed", error);
    }
    const drained = writeQueue;
    await drained.catch(() => void 0);
    if (!closed) {
      closed = true;
      resolveClosed();
    }
  }
  function close() {
    if (closed) return;
    closed = true;
    stdin.removeListener("data", handleData);
    resolveClosed();
  }
  stdin.setEncoding?.("utf8");
  stdin.on("data", handleData);
  stdin.on("error", (error) => {
    note(stderr, "stdin failed", error);
  });
  stdin.on("end", () => {
    void finish();
  });
  return { closed: closedPromise, close };
}
function idKey(id) {
  if (typeof id === "number") return `n:${id}`;
  if (typeof id === "string") return `s:${id}`;
  return null;
}
function readObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value;
}
function readProtocolVersion(params) {
  const object = readObject(params);
  if (object === null) return void 0;
  const value = object.protocolVersion;
  return typeof value === "string" ? value : void 0;
}
function readRequestedVersion(params) {
  const object = readObject(params);
  if (object === null) return void 0;
  const meta = readObject(object._meta);
  if (meta !== null && typeof meta[PROTOCOL_META_KEY] === "string") {
    return meta[PROTOCOL_META_KEY];
  }
  return readProtocolVersion(object);
}
function readCancelledId(params) {
  const object = readObject(params);
  if (object === null) return void 0;
  return object.requestId;
}
function readToolName(params) {
  const object = readObject(params);
  if (object === null) return null;
  return typeof object.name === "string" ? object.name : null;
}
function readToolArguments(params) {
  const object = readObject(params);
  if (object === null) return {};
  return object.arguments ?? {};
}
function toCallResult(result) {
  const content = result.content.map(
    (block) => block.type === "text" ? { type: "text", text: block.text } : { type: "image", data: block.data, mimeType: block.mimeType }
  );
  const payload = {
    resultType: RESULT_TYPE,
    content
  };
  if (result.isError === true) payload.isError = true;
  return payload;
}
function failure2(error) {
  const message = error instanceof Error && error.message !== "" ? error.message : "browser tool failed.";
  return { content: [{ type: "text", text: message }], isError: true };
}
function note(stderr, message, error) {
  const detail = error === void 0 ? "" : error instanceof Error ? error.message : String(error);
  const line = detail === "" ? `browser-control: ${message}
` : `browser-control: ${message}: ${detail}
`;
  try {
    stderr.write(line);
  } catch {
  }
}

// packages/browser-control/src/main.ts
var VERSION = "0.1.0-alpha.8";
var USAGE = "usage: oxrail-browser-control [--version|--help]  (stdio MCP server for the Browser Control route)";
var INSTRUCTIONS = "This server drives its own headless Chrome through the Browser Control route. It is opt-in and separate from the person's browser: call browser_open before any other browser tool, and browser_close when the work is done.";
async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--version")) {
    process.stdout.write(`oxrail-browser-control ${VERSION}
`);
    return 0;
  }
  if (argv.includes("--help")) {
    process.stdout.write(`${USAGE}
`);
    return 0;
  }
  for (const argument of argv) {
    if (!argument.startsWith("-")) continue;
    process.stderr.write(
      `browser-control: ignoring unknown argument ${argument}
`
    );
  }
  const { CdpBrowserRoute: CdpBrowserRoute2 } = await Promise.resolve().then(() => (init_route(), route_exports));
  const route = new CdpBrowserRoute2();
  const server = serveMcp({
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    route,
    version: VERSION,
    instructions: INSTRUCTIONS
  });
  let shutdown = null;
  const stop = () => {
    shutdown ??= (async () => {
      try {
        await route.close();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        process.stderr.write(
          `browser-control: closing the browser route failed: ${detail}
`
        );
      }
      server.close();
    })();
    return shutdown;
  };
  const onSignal = () => {
    void stop();
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  await server.closed;
  await stop();
  process.exit(0);
}
function samePath(left, right) {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return left === right;
  }
}
var entry = process.argv[1];
if (entry !== void 0 && samePath(entry, fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
export {
  VERSION,
  main
};
