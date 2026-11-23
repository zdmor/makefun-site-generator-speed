// A fast, dependency-free re-implementation of makefun-site 1.0.0's build, written
// from its README and reference behaviour. run(input) returns the same output tree
// (path -> text) for every input, byte for byte. Speed comes from: one fused
// Markdown pass (lexing and rendering together, no token objects), bulk HTML
// escaping instead of per-character calls, a memoised slugifier with an ASCII fast
// path, front matter parsed by slicing the header region instead of splitting the
// whole file, and templates compiled to render functions instead of walked as
// node trees at every render. No code is copied from the reference; only its semantics are.

// ---------------------------------------------------------------- text helpers

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The HTML escape table, by character code. */
const ESCAPES = [];
ESCAPES[38] = '&amp;';
ESCAPES[60] = '&lt;';
ESCAPES[62] = '&gt;';
ESCAPES[34] = '&quot;';
ESCAPES[39] = '&#39;';
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  return text.replace(ESC_RE, (c) => ESCAPES[c.charCodeAt(0)]);
}

/** Whether code `c` is a JavaScript \s whitespace character. */
function isSpaceCode(c) {
  return (
    c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 ||
    c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 ||
    c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff
  );
}

/** 1 at every JavaScript `\s` code point (the word-count split set), 0 elsewhere. */
const SPACE_TBL = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) SPACE_TBL[c] = 1;
for (let c = 0x2000; c <= 0x200a; c++) SPACE_TBL[c] = 1;

/** The words of a body: its runs of characters other than whitespace (branchless: a word char following a space starts a word). */
function countWords(text) {
  let n = 0;
  let inWord = 0;
  for (let i = 0; i < text.length; i++) {
    const w = SPACE_TBL[text.charCodeAt(i)] ^ 1;
    n += w & ~inWord;
    inWord = w;
  }
  return n;
}

const MARKS_RE = /\p{M}/gu;
const slugCache = new Map();

/** The slug of `text` (see the README's Text section), memoised: titles, tags and headings repeat a lot. */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  const out = slugOf(text);
  slugCache.set(text, out);
  return out;
}

/** The slug of `text`, computed: a tight ASCII loop, falling back to NFKD for the rest. */
function slugOf(text) {
  const codes = [];
  let gap = false;
  for (let i = 0; i < text.length; i++) {
    if (codes.length >= 64) break;
    const c = text.charCodeAt(i);
    if (c > 127) return slugUnicode(text);
    let k = -1;
    if (c >= 65 && c <= 90) k = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) k = c;
    if (k === -1) {
      if (codes.length > 0) gap = true;
      continue;
    }
    if (gap) {
      codes.push(45);
      gap = false;
    }
    codes.push(k);
  }
  while (codes.length > 0 && codes[codes.length - 1] === 45) codes.pop();
  return codes.length === 0 ? 'untitled' : String.fromCharCode(...codes);
}

/** The slug of a non-ASCII `text`: NFKD, combining marks dropped, then the same run rule. */
function slugUnicode(text) {
  const plain = text.normalize('NFKD').replace(MARKS_RE, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, slug-3 ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A quoted or bare string value: { value } or { error } (the message without the `key "...": ` prefix). */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    const inner = raw.slice(1, -1);
    if (inner.indexOf('\\') === -1 && inner.indexOf('"') === -1) return { value: inner };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** Whether `s` is only [a-z0-9-] and non-empty (a template name). */
function isName(s) {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

/** Whether `s` is a slug: [a-z0-9]+(-[a-z0-9]+)*, at most 64 characters. */
function isSlug(s) {
  if (s.length === 0 || s.length > 64) return false;
  let prevDash = true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
    else if (c === 45 && !prevDash) prevDash = true;
    else return false;
  }
  return !prevDash;
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) {
            ok = false;
            break;
          }
        }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return isName(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return isSlug(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** `line` with its trailing spaces and tabs dropped. */
function rstrip(line) {
  let e = line.length;
  while (e > 0 && (line[e - 1] === ' ' || line[e - 1] === '\t')) e--;
  return e === line.length ? line : line.slice(0, e);
}

/** Whether `line` holds only spaces and tabs (or nothing). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. Only the header region is split; the body is sliced out.
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  let closeAt = -1;
  let p = 3;
  for (;;) {
    const idx = text.indexOf('\n---', p);
    if (idx === -1) break;
    const after = idx + 4;
    if (after === text.length || text.charCodeAt(after) === 10) {
      closeAt = idx + 1;
      break;
    }
    p = idx + 1;
  }
  if (closeAt === -1) return { error: 'the front matter is not closed' };
  const region = closeAt === 4 ? '' : text.slice(4, closeAt - 1);
  const data = {};
  if (region !== '') {
    const lines = region.split('\n');
    for (let k = 0; k < lines.length; k++) {
      const line = lines[k];
      if (isBlank(line) || line.charCodeAt(0) === 35) continue;
      let j = 0;
      while (j < line.length) {
        const c = line.charCodeAt(j);
        if ((c >= 97 && c <= 122) || c === 95) j++;
        else break;
      }
      if (j === 0 || line.charCodeAt(j) !== 58) return { error: `line ${k + 2} is not "key: value"` };
      const key = line.slice(0, j);
      let raw;
      if (j + 1 === line.length) raw = '';
      else if (line.charCodeAt(j + 1) === 32) raw = rstrip(line.slice(j + 2));
      else return { error: `line ${k + 2} is not "key: value"` };
      if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  let bodyAt = closeAt + 3;
  if (text.charCodeAt(bodyAt) === 10) bodyAt++;
  return { data, body: text.slice(bodyAt) };
}

// ---------------------------------------------------------------- Markdown

/** `line` with spaces and tabs at either end dropped. */
function trimLine(line) {
  let s = 0;
  let e = line.length;
  while (s < e && (line[s] === ' ' || line[s] === '\t')) s++;
  while (e > s && (line[e - 1] === ' ' || line[e - 1] === '\t')) e--;
  return s === 0 && e === line.length ? line : line.slice(s, e);
}

/** A fence-opening line's language, or null: ``` plus a language, then spaces or tabs only. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  for (let k = j; k < line.length; k++) {
    if (line[k] !== ' ' && line[k] !== '\t') return null;
  }
  return line.slice(3, j);
}

/** Whether `line` closes a fence: ``` then spaces or tabs only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let k = 3; k < line.length; k++) {
    if (line[k] !== ' ' && line[k] !== '\t') return false;
  }
  return true;
}

/** A heading line's { depth, text }, or null (a heading's text is never empty). */
function headingOf(line) {
  let h = 0;
  while (h < line.length && line.charCodeAt(h) === 35) h++;
  if (h === 0 || h > 6) return null;
  if (line[h] !== ' ' && line[h] !== '\t') return null;
  let e = line.length;
  while (e > h && (line[e - 1] === ' ' || line[e - 1] === '\t')) e--;
  let s = h;
  while (s < e && (line[s] === ' ' || line[s] === '\t')) s++;
  if (s >= e) return null;
  return { depth: h, text: line.slice(s, e) };
}

/** Whether `line` is a thematic break: --- or ***, then spaces or tabs only. */
function isHr(line) {
  if (line.length < 3) return false;
  const a = line.charCodeAt(0);
  const b = line.charCodeAt(1);
  const c = line.charCodeAt(2);
  if (!((a === 45 && b === 45 && c === 45) || (a === 42 && b === 42 && c === 42))) return false;
  for (let k = 3; k < line.length; k++) {
    if (line[k] !== ' ' && line[k] !== '\t') return false;
  }
  return true;
}

/** An ordered-list line's { start, text }, or null: 1 to 9 digits, ". ", then text. */
function orderedOf(line) {
  let j = 0;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if (c < 48 || c > 57) break;
    j++;
  }
  if (j === 0 || j > 9) return null;
  if (line.charCodeAt(j) !== 46 || line.charCodeAt(j + 1) !== 32) return null;
  return { start: Number(line.slice(0, j)), text: line.slice(j + 2) };
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) === 32) j++;
  if (j < 2 || j >= line.length) return false;
  return !isSpaceCode(line.charCodeAt(j));
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a thematic break. */
function endsPara(line) {
  if (line.length === 0) return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return isBlank(line);
  if (c0 === 96) return fenceLang(line) !== null;
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return isHr(line);
  return false;
}

// --- inline rendering -------------------------------------------------------

/** The characters a backslash escapes, by code (all ASCII). */
const ESCAPABLE = new Uint8Array(128);
for (const ch of '\\`*_[]()#+-.!>') ESCAPABLE[ch.charCodeAt(0)] = 1;

/** The next special character for inline rendering: a mark, or one HTML escapes. */
const INLINE_SPECIAL = /[\\`*\[&<>"']/g;
const WS_RE = /\s/;

/** The first `**` in s[from, b) outside a backslash escape, or -1. */
function findStrongClose(s, from, b) {
  for (let k = from; k + 1 < b; k++) {
    if (s[k] === '\\' && k + 1 < b && ESCAPABLE[s.charCodeAt(k + 1)] === 1) {
      k++;
      continue;
    }
    if (s[k] === '*' && s[k + 1] === '*') return k;
  }
  return -1;
}

/** The first single `*` in s[from, b) (one whose run is not `**`), outside an escape, or -1. */
function findEmClose(s, from, b) {
  for (let k = from; k < b; k++) {
    const c = s[k];
    if (c === '\\' && k + 1 < b && ESCAPABLE[s.charCodeAt(k + 1)] === 1) {
      k++;
      continue;
    }
    if (c !== '*') continue;
    if (k + 1 < b && s[k + 1] === '*') {
      k++;
      continue;
    }
    return k;
  }
  return -1;
}

/** The first `]` in s[from, b) outside a backslash escape, or -1. */
function findBracketClose(s, from, b) {
  for (let k = from; k < b; k++) {
    if (s[k] === '\\' && k + 1 < b && ESCAPABLE[s.charCodeAt(k + 1)] === 1) {
      k++;
      continue;
    }
    if (s[k] === ']') return k;
  }
  return -1;
}

/** s[a, b) rendered inline, appended to `out`; links resolve from the source `src` against the build `shared`. */
function inlineRange(s, a, b, src, shared, out) {
  let i = a;
  while (i < b) {
    INLINE_SPECIAL.lastIndex = i;
    const m = INLINE_SPECIAL.exec(s);
    if (m === null || m.index >= b) break;
    const j = m.index;
    if (j > i) out.push(s.slice(i, j));
    const c = s.charCodeAt(j);
    if (c === 38) { out.push('&amp;'); i = j + 1; continue; }
    if (c === 60) { out.push('&lt;'); i = j + 1; continue; }
    if (c === 62) { out.push('&gt;'); i = j + 1; continue; }
    if (c === 34) { out.push('&quot;'); i = j + 1; continue; }
    if (c === 39) { out.push('&#39;'); i = j + 1; continue; }
    if (c === 92) {
      if (j + 1 < b && ESCAPABLE[s.charCodeAt(j + 1)] === 1) {
        const n = s[j + 1];
        out.push(n === '>' ? '&gt;' : n);
        i = j + 2;
      } else {
        out.push('\\');
        i = j + 1;
      }
      continue;
    }
    if (c === 96) {
      const k = s.indexOf('`', j + 1);
      if (k !== -1 && k < b && k > j + 1) {
        out.push('<code>', escapeHtml(s.slice(j + 1, k)), '</code>');
        i = k + 1;
      } else {
        out.push('`');
        i = j + 1;
      }
      continue;
    }
    if (c === 42) {
      if (j + 1 < b && s[j + 1] === '*') {
        const k = findStrongClose(s, j + 2, b);
        if (k > j + 2) {
          out.push('<strong>');
          inlineRange(s, j + 2, k, src, shared, out);
          out.push('</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i = j + 2;
        }
      } else {
        const k = findEmClose(s, j + 1, b);
        if (k > j + 1) {
          out.push('<em>');
          inlineRange(s, j + 1, k, src, shared, out);
          out.push('</em>');
          i = k + 1;
        } else {
          out.push('*');
          i = j + 1;
        }
      }
      continue;
    }
    // '['
    const k = findBracketClose(s, j + 1, b);
    let done = false;
    if (k !== -1 && k + 1 < b && s[k + 1] === '(') {
      const q = s.indexOf(')', k + 2);
      if (q !== -1 && q < b) {
        const target = s.slice(k + 2, q);
        if (target !== '' && !WS_RE.test(target)) {
          out.push('<a href="', escapeHtml(resolveLink(shared, src, target)), '">');
          inlineRange(s, j + 1, k, src, shared, out);
          out.push('</a>');
          i = q + 1;
          done = true;
        }
      }
    }
    if (!done) {
      out.push('[');
      i = j + 1;
    }
  }
  if (i < b) out.push(s.slice(i, b));
}

/** A fenced code block starting at lines[i] (a fence-open line with language `lang`): renders it, returns the next line. */
function fenceBlock(lines, i, n, lang, out) {
  out.push(lang === '' ? '<pre><code>' : `<pre><code class="language-${escapeHtml(lang)}">`);
  const start = ++i;
  while (i < n && !isFenceClose(lines[i])) i++;
  if (i > start) out.push(escapeHtml(lines.slice(start, i).join('\n')), '\n');
  i++;
  out.push('</code></pre>\n');
  return i;
}

/** A blockquote starting at lines[i] (a line opening on `>`): renders it, returns the next line. */
function quoteBlock(lines, i, n, s, shared, out) {
  const q = [];
  while (i < n && lines[i].charCodeAt(0) === 62) {
    let l = lines[i];
    i++;
    l = l.length > 1 && l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1);
    l = trimLine(l);
    if (l !== '') q.push(l);
  }
  if (q.length === 0) {
    out.push('<blockquote>\n</blockquote>\n');
  } else {
    const joined = q.join('\n');
    out.push('<blockquote>\n<p>');
    inlineRange(joined, 0, joined.length, s, shared, out);
    out.push('</p>\n</blockquote>\n');
  }
  return i;
}

/** A list starting at lines[i] (its first item already read as `firstItem`): renders it, returns the next line. */
function listBlock(lines, i, n, ordered, startNum, firstItem, s, shared, out) {
  const items = [];
  let cur = [trimLine(firstItem)];
  i++;
  while (i < n) {
    const l = lines[i];
    if (ordered) {
      const od = orderedOf(l);
      if (od !== null) {
        items.push(cur.join('\n'));
        cur = [trimLine(od.text)];
        i++;
        continue;
      }
    } else if ((l.charCodeAt(0) === 45 || l.charCodeAt(0) === 42) && l.charCodeAt(1) === 32) {
      items.push(cur.join('\n'));
      cur = [trimLine(l.slice(2))];
      i++;
      continue;
    }
    if (isContinued(l)) {
      cur.push(trimLine(l));
      i++;
      continue;
    }
    break;
  }
  items.push(cur.join('\n'));
  if (ordered) out.push(startNum !== 1 ? `<ol start="${startNum}">\n` : '<ol>\n');
  else out.push('<ul>\n');
  for (const item of items) {
    out.push('<li>');
    inlineRange(item, 0, item.length, s, shared, out);
    out.push('</li>\n');
  }
  out.push(ordered ? '</ol>\n' : '</ul>\n');
  return i;
}

/**
 * `src` rendered in one fused pass: its HTML (each block followed by "\n"), its
 * table of contents (every level 2 and 3 heading) and its excerpt (the first
 * paragraph's inline HTML, or ""). Blocks are dispatched on the line's first
 * character: only a blank line, a fence, a heading or a break can start one way.
 */
function renderMarkdown(src, s, shared) {
  const lines = src.split('\n');
  const n = lines.length;
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (line.length === 0) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9) {
      if (isBlank(line)) {
        i++;
        continue;
      }
    } else if (c0 === 96) {
      const lang = fenceLang(line);
      if (lang !== null) {
        i = fenceBlock(lines, i, n, lang, out);
        continue;
      }
    } else if (c0 === 35) {
      const hd = headingOf(line);
      if (hd !== null) {
        const id = uniqueSlug(slugify(hd.text), ids);
        const tmp = [];
        inlineRange(hd.text, 0, hd.text.length, s, shared, tmp);
        const html = tmp.join('');
        out.push(`<h${hd.depth} id="${id}">`, html, `</h${hd.depth}>\n`);
        if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(line)) {
        out.push('<hr>\n');
        i++;
        continue;
      }
      if (line.charCodeAt(1) === 32) {
        i = listBlock(lines, i, n, false, 1, line.slice(2), s, shared, out);
        continue;
      }
    } else if (c0 === 62) {
      i = quoteBlock(lines, i, n, s, shared, out);
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const od = orderedOf(line);
      if (od !== null) {
        i = listBlock(lines, i, n, true, od.start, od.text, s, shared, out);
        continue;
      }
    }
    const para = [trimLine(line)];
    i++;
    while (i < n && !endsPara(lines[i])) {
      para.push(trimLine(lines[i]));
      i++;
    }
    const text = para.join('\n');
    if (excerpt === null) {
      const tmp = [];
      inlineRange(text, 0, text.length, s, shared, tmp);
      excerpt = tmp.join('');
      out.push('<p>', excerpt, '</p>\n');
    } else {
      out.push('<p>');
      inlineRange(text, 0, text.length, s, shared, out);
      out.push('</p>\n');
    }
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether src[a, b) holds only spaces and tabs. */
function spacesOnly(src, a, b) {
  for (let k = a; k < b; k++) {
    if (src[k] !== ' ' && src[k] !== '\t') return false;
  }
  return true;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = [];
  const stack = [{ kind: 'root', body: root }];
  let body = root;
  let text = '';
  let i = 0;
  const n = src.length;
  const flush = () => {
    if (text !== '') {
      body.push({ kind: 'text', text });
      text = '';
    }
  };
  while (i < n) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === n - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      flush();
      body.push({ kind: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? n : nl;
    const standalone = spacesOnly(src, lineStart, open) && spacesOnly(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    flush();
    const tag = src.slice(open + 2, close).trim();
    const top = stack[stack.length - 1];
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
      body.push(node);
      stack.push(node);
      body = node.body;
    } else if ((m = IF_RE.exec(tag)) !== null) {
      const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
      body.push(node);
      stack.push(node);
      body = node.then;
    } else if (tag === 'else') {
      if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
      top.else = [];
      body = top.else;
    } else if (tag === 'endfor' || tag === 'endif') {
      if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
    } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
      body.push({ kind: 'include', name: m[1] });
    } else {
      throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
    i = standalone ? (nl === -1 ? n : nl + 1) : end;
  }
  flush();
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root;
}

/** A scope is one flat object: its bindings plus PARENT, the enclosing scope (null at the root). */
const PARENT = Symbol('parent');

/** The value of first-name `name` in the scope chain, or undefined. */
function lk1(scope, name) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s, name)) s = s[PARENT];
  return s === null ? undefined : s[name];
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * Whether rendering `nodes` in a loop's scope looks up first-name `loop` where
 * that loop binds it: references in its own nodes and in templates it includes,
 * but not ones inside a nested for's body (that loop binds `loop` there). A
 * cycle in the includes answers true, to stay safe.
 */
function bodyUsesLoop(nodes, templates, visiting) {
  for (const nd of nodes) {
    switch (nd.kind) {
      case 'var':
      case 'raw':
        if (nd.path[0] === 'loop') return true;
        break;
      case 'if':
        if (nd.path[0] === 'loop') return true;
        if (bodyUsesLoop(nd.then, templates, visiting)) return true;
        if (nd.else !== null && bodyUsesLoop(nd.else, templates, visiting)) return true;
        break;
      case 'include': {
        if (visiting.has(nd.name)) return true;
        const t = templates.get(nd.name);
        if (t !== undefined) {
          visiting.add(nd.name);
          const r = bodyUsesLoop(t, templates, visiting);
          visiting.delete(nd.name);
          if (r) return true;
        }
        break;
      }
      default:
        break;
    }
  }
  return false;
}

/**
 * `nodes` compiled to a render function (lk1, txt, tr, esc, T, PS, FC, sc, out, depth):
 * the helpers as parameters, T the map of compiled templates, PS the scope-parent
 * key, FC the fragment cache, sc the scope, out the output array, depth the
 * include depth. Every scope level resolves the paths it references once, up
 * front, into locals; each use then reads its local. A for-loop's `loop` object
 * is only built when its body can see it. Includes of fragment-cacheable
 * templates reuse a cached render when the resolved references match by
 * identity and the depth bound holds; otherwise they render and cache.
 */
function compileTemplate(selfName, nodes, templates, cacheable) {
  let uid = 0;
  const parts = ['let _t;'];
  // The first names and paths a node list references at its own level (an if's
  // branches count; a for's body is a level of its own).
  const collectLevel = (nds, firsts, paths) => {
    for (const nd of nds) {
      if (nd.kind === 'var' || nd.kind === 'raw' || nd.kind === 'if' || nd.kind === 'for') {
        firsts.add(nd.path[0]);
        paths.set(nd.path.join('\n'), nd.path);
      }
      if (nd.kind === 'if') {
        collectLevel(nd.then, firsts, paths);
        if (nd.else !== null) collectLevel(nd.else, firsts, paths);
      }
    }
  };
  // The expression resolving `path` from its first name's local, with the
  // lookup's own semantics at every step (null or a non-object, or a missing
  // own property, is undefined). Uses the shared temp _t for longer paths.
  const resolveExpr = (firstLocal, path) => {
    if (path.length === 1) return firstLocal;
    const step = (i) => {
      const seg = JSON.stringify(path[i]);
      const val = i === path.length - 1 ? `_t[${seg}]` : `(_t=_t[${seg}],${step(i + 1)})`;
      return `(_t==null||typeof _t!=="object"?undefined:Object.hasOwn(_t,${seg})?${val}:undefined)`;
    };
    return `(_t=${firstLocal},${step(1)})`;
  };
  const genNodes = (nds, sc, pathLocal) => {
    for (const nd of nds) {
      if (nd.kind === 'text') {
        parts.push(`out.push(${JSON.stringify(nd.text)});`);
      } else if (nd.kind === 'var' || nd.kind === 'raw') {
        const v = pathLocal.get(nd.path.join('\n'));
        const t = `typeof ${v}==="string"?${v}:txt(${v})`;
        parts.push(nd.kind === 'var' ? `out.push(esc(${t}));` : `out.push(${t});`);
      } else if (nd.kind === 'if') {
        parts.push(`if(tr(${pathLocal.get(nd.path.join('\n'))})!==${nd.not}){`);
        genNodes(nd.then, sc, pathLocal);
        if (nd.else !== null) {
          parts.push('}else{');
          genNodes(nd.else, sc, pathLocal);
        }
        parts.push('}');
      } else if (nd.kind === 'for') {
        const u = uid++;
        const needLoop = bodyUsesLoop(nd.body, templates, new Set([selfName]));
        parts.push(
          `{const _a${u}=${pathLocal.get(nd.path.join('\n'))};if(Array.isArray(_a${u})){for(let _k${u}=0;_k${u}<_a${u}.length;_k${u}++){const _s${u}={[${JSON.stringify(nd.name)}]:_a${u}[_k${u}]${needLoop ? `,loop:{index:_k${u}+1,first:_k${u}===0,last:_k${u}===_a${u}.length-1,length:_a${u}.length}` : ''},[PS]:${sc}};`,
        );
        genLevel(nd.body, `_s${u}`);
        parts.push('}}}');
      } else if (nd.kind === 'include') {
        const ci = cacheable.get(nd.name);
        if (ci !== undefined) {
          const u = uid++;
          const k = ci.refs.length;
          const checks = ci.refs.map((r, i) => `_c${u}[${i}]===lk1(${sc},${JSON.stringify(r)})`).join('&&');
          const vals = ci.refs.map((r) => `lk1(${sc},${JSON.stringify(r)})`).join(',');
          parts.push(
            `if(depth<8){const _c${u}=FC.get(${JSON.stringify(nd.name)});` +
              `if(_c${u}!==undefined&&depth<=${ci.bound}${checks ? `&&${checks}` : ''})out.push(_c${u}[${k}]);` +
              `else{const _o${u}=[];const _f${u}=T.get(${JSON.stringify(nd.name)});` +
              `if(_f${u}!==undefined){_f${u}(lk1,txt,tr,esc,T,PS,FC,${sc},_o${u},depth+1);const _s${u}=_o${u}.join('');` +
              `if(depth<=${ci.bound})FC.set(${JSON.stringify(nd.name)},[${vals ? `${vals},` : ''}_s${u}]);out.push(_s${u});}}}`,
          );
        } else {
          const u = uid++;
          parts.push(
            `if(depth<8){const _t${u}=T.get(${JSON.stringify(nd.name)});if(_t${u}!==undefined)_t${u}(lk1,txt,tr,esc,T,PS,FC,${sc},out,depth+1);}`,
          );
        }
      }
    }
  };
  const genLevel = (nds, sc) => {
    const firsts = new Set();
    const paths = new Map();
    collectLevel(nds, firsts, paths);
    const firstLocal = new Map();
    for (const name of firsts) firstLocal.set(name, `_f${uid++}`);
    const pathLocal = new Map();
    for (const [key, path] of paths) {
      if (path.length === 1) pathLocal.set(key, firstLocal.get(path[0]));
      else pathLocal.set(key, `_r${uid++}`);
    }
    for (const [name, local] of firstLocal) parts.push(`const ${local}=lk1(${sc},${JSON.stringify(name)});`);
    for (const [key, path] of paths) {
      if (path.length === 1) continue;
      parts.push(`const ${pathLocal.get(key)}=${resolveExpr(firstLocal.get(path[0]), path)};`);
    }
    genNodes(nds, sc, pathLocal);
  };
  genLevel(nodes, 'sc');
  return new Function('lk1', 'txt', 'tr', 'esc', 'T', 'PS', 'FC', 'sc', 'out', 'depth', parts.join(''));
}

// ---------------------------------------------------------------- the build

const RESERVED = ['posts', 'tags', 'page'];
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** Resolved link paths, by directory then relative target: resolvePath is pure, so this cache holds across cases. */
const pathCache = new Map();

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  let inner = pathCache.get(dir);
  if (inner === undefined) {
    inner = new Map();
    pathCache.set(dir, inner);
  }
  const hit = inner.get(rel);
  if (hit !== undefined) return hit;
  const parts = dir === '' ? [] : dir.split('/');
  let failed = false;
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) {
        failed = true;
        break;
      }
      parts.pop();
    } else parts.push(seg);
  }
  const out = failed ? null : parts.join('/');
  inner.set(rel, out);
  return out;
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** A link target's href, resolved from the source `s`'s directory against the build's pages and static files. */
function resolveLink(shared, s, target) {
  if (SCHEME_RE.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
  const hash = target.indexOf('#');
  const rel = hash === -1 ? target : target.slice(0, hash);
  const frag = hash === -1 ? '' : target.slice(hash);
  const path = rel === '' ? null : resolvePath(s.dir, rel);
  if (path !== null) {
    const pg = shared.bySource.get(path);
    if (pg !== undefined) return pg.url + frag;
    if (shared.staticPaths.has(path)) return `${shared.base}/${path}${frag}`;
  }
  shared.broken.add(`broken-link ${s.path} -> ${target}`);
  return target;
}

/** A page's link record as templates read it. */
function linkOf(s) {
  if (s === null) return null;
  return { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
}

/** A post's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagLinks,
  };
}

/** One site's output tree: path -> text. */
export function run(input) {
  // Templates, parsed in code-unit order of their names; one that does not parse is reported and left out.
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  // Per template: the first names it references freely (loop variables are
  // bound inside their own template, so they never count), transitively
  // through includes, and the include depth below it. Cycle-safe: a cycle
  // yields depth Infinity, which excludes the template (and anything that
  // includes it) from fragment caching below.
  const EMPTY_REFS = new Set();
  const analysis = new Map();
  const analyzing = new Set();
  const analyze = (name) => {
    if (analysis.has(name)) return analysis.get(name);
    if (analyzing.has(name)) return { refs: EMPTY_REFS, depth: Infinity };
    const nodes = templates.get(name);
    if (nodes === undefined) return { refs: EMPTY_REFS, depth: 0 };
    analyzing.add(name);
    const refs = new Set();
    let depth = 0;
    const walk = (nds, bound) => {
      for (const nd of nds) {
        if (nd.kind === 'var' || nd.kind === 'raw' || nd.kind === 'if' || nd.kind === 'for') {
          if (!bound.has(nd.path[0])) refs.add(nd.path[0]);
        }
        if (nd.kind === 'if') {
          walk(nd.then, bound);
          if (nd.else !== null) walk(nd.else, bound);
        } else if (nd.kind === 'for') {
          const inner = new Set(bound);
          inner.add(nd.name);
          inner.add('loop');
          walk(nd.body, inner);
        } else if (nd.kind === 'include') {
          const sub = analyze(nd.name);
          for (const r of sub.refs) if (!bound.has(r)) refs.add(r);
          if (sub.depth === Infinity) depth = Infinity;
          else if (depth !== Infinity && sub.depth + 1 > depth) depth = sub.depth + 1;
        }
      }
    };
    walk(nodes, new Set());
    analyzing.delete(name);
    const info = { refs, depth };
    analysis.set(name, info);
    return info;
  };
  // A template is fragment-cacheable when its output can only depend on the
  // case-level constants (site, tags, recent): its free references are a
  // subset of those, and its include depth is bounded so a depth bound can
  // guarantee every depth check inside it passes. The cache check at an
  // include site compares the resolved references by identity, so a shadowed
  // name simply misses and renders normally.
  const cacheable = new Map();
  for (const name of templates.keys()) {
    const info = analyze(name);
    if (info.depth === Infinity || info.depth > 7) continue;
    let ok = true;
    for (const r of info.refs) {
      if (r !== 'site' && r !== 'tags' && r !== 'recent') {
        ok = false;
        break;
      }
    }
    if (ok) cacheable.set(name, { refs: [...info.refs], bound: 7 - info.depth });
  }
  // Every template compiled to a render function, once per case.
  const compiled = new Map();
  for (const [name, nodes] of templates) compiled.set(name, compileTemplate(name, nodes, templates, cacheable));
  // Rendered fragments, by template name: [resolved reference values..., rendered string].
  const fragCache = new Map();

  // Sources, in code-unit order of their paths, line ends made "\n"; the rest is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      // One shape for every source, filled in as the build runs, so later stores never change it.
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text, data: null, body: '', post: false, dir: '', layout: '', slug: '', outDir: '', url: '', html: '', toc: null, excerpt: '', words: 0, newer: null, older: null, tagRefs: null, tagLinks: null, link: null });
    } else statics.push({ path: f.path, content: f.content });
  }

  // Front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : null;
    if (own !== null) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each page's slug made unique in its directory, in source order.
  const bySource = new Map();
  const taken = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, each body's links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const shared = { bySource, staticPaths, base, broken };
  for (const s of kept) {
    s.dir = dirOf(s.path);
    const md = renderMarkdown(s.body, s, shared);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = countWords(s.body);
  }

  // Collections: the posts, newest first and then by slug; each post's neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
    posts[k].link = linkOf(posts[k]);
  }

  // Tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [], link: { name, slug, url: `${base}/tags/${slug}/` } };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
    p.tagLinks = p.tagRefs.map((t) => t.link);
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const t = bySlug.get(slugify(name));
        if (t !== undefined) return t;
        const slug = slugify(name);
        return { name, slug, url: '', posts: [], link: { name, slug, url: '' } };
      });
      s.tagLinks = s.tagRefs.map((t) => t.link);
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Layouts: every page through its layout, the index pages and the tag pages through theirs.
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  const renderInto = (name, vars, out) => {
    const fn = compiled.get(name);
    if (fn === undefined) return false;
    fn(lk1, textOf, truthy, escapeHtml, compiled, PARENT, fragCache, vars, out, 0);
    return true;
  };
  for (const s of kept) {
    const card = s.post ? cards.get(s) : cardOf(s);
    const page = {
      ...card,
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: s.newer === null ? null : s.newer.link,
      older: s.older === null ? null : s.older.link,
      is_post: s.post,
    };
    const out = [];
    renderInto(s.layout, { site, tags: allTags, recent, page, [PARENT]: null }, out);
    output[`${s.outDir}/index.html`] = out.join('');
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const out = [];
    const ok = renderInto('index', {
      site,
      tags: allTags,
      recent,
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
      [PARENT]: null,
    }, out);
    if (ok) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = out.join('');
  }
  for (const t of tags) {
    const out = [];
    const ok = renderInto('tag', {
      site,
      tags: allTags,
      recent,
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
      [PARENT]: null,
    }, out);
    if (ok) output[`tags/${t.slug}/index.html`] = out.join('');
  }
  const tagsOut = [];
  if (renderInto('tags', { site, tags: allTags, recent, [PARENT]: null }, tagsOut)) output['tags/index.html'] = tagsOut.join('');
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  lines.push(`built ${kept.length - posts.length} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
