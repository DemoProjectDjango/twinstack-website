/**
 * A quick look at a written page body for things that don't fit a phone
 * (DESIGN_RULES, "Every screen size"), with no browser: class names and inline
 * styles that fix a box wider than a phone, columns with no breakpoint, a
 * heading too big for a phone at every size, and tables with nothing to scroll
 * them. edit-page.js reports what it finds as warnings, never as problems: the
 * page is still written, and site.css and site.js soften most of these on
 * their own (main clips what sticks out sideways, wide tables are made to
 * scroll). Only what the page didn't already have is reported, so an edit
 * isn't blamed for an older page's choices.
 */

// The narrowest phone a page is written for, less a side gutter on each side.
const PHONE_ROOM = 320;
const REM = 16;
// Elements that may be wider than the screen on purpose: decoration out of the flow.
const DECORATIVE = /(^|\s)(absolute|fixed|pointer-events-none|-z-\d+)(\s|$)/;
const CAPPED = /(^|\s)max-w-(full|\[100%\]|screen|\[100vw\]|\[calc)/;
const SCROLLS = /(^|\s)(overflow-(x-)?(auto|scroll)|table-scroll)(\s|$)/;
// Inside one of these, something wider is meant to be (a carousel's track, a marquee, a wide table that scrolls).
const CONTAINS = /(^|\s)(overflow-(x-)?(auto|scroll|hidden|clip)|table-scroll)(\s|$)/;
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
// Tailwind's named container widths (w-sm, min-w-lg…), in rem.
const NAMED = { '3xs': 16, '2xs': 18, xs: 20, sm: 24, md: 28, lg: 32, xl: 36, '2xl': 42, '3xl': 48, '4xl': 56, '5xl': 64, '6xl': 72, '7xl': 80 };

/** A CSS length in px, or null when it isn't a fixed one. */
function px(value) {
  const m = /^(-?\d*\.?\d+)(px|rem|em)?$/.exec(String(value).trim());
  if (!m) return null;
  return m[2] === 'rem' || m[2] === 'em' ? Number(m[1]) * REM : Number(m[1]);
}

/** The px width a width class sets, when it's a fixed one: w-[420px], min-w-96, w-lg… */
function widthOf(token) {
  const m = /^(?:min-)?w-(?:\[([^\]]+)\]|(\d+(?:\.\d+)?)|(3xs|2xs|xs|sm|md|lg|xl|[2-7]xl))$/.exec(token);
  if (!m) return null;
  if (m[1]) return px(m[1]);
  if (m[2]) return Number(m[2]) * 4;
  return NAMED[m[3]] ? NAMED[m[3]] * REM : null;
}

/** The smallest size an unprefixed text size class gives: text-7xl, text-[5rem], text-[clamp(3.5rem,8vw,6rem)]. */
function textSizeOf(token) {
  const named = { '6xl': 60, '7xl': 72, '8xl': 96, '9xl': 128 };
  let m = /^text-(\dxl)$/.exec(token);
  if (m) return named[m[1]] ?? null;
  m = /^text-\[clamp\(([^,]+),/.exec(token);
  if (m) return px(m[1]);
  m = /^text-\[([^\]]+)\]$/.exec(token);
  return m ? px(m[1]) : null;
}

/** Leaves out what isn't markup: <script>, <style> and <textarea> contents, comments and template tags. */
function markupOnly(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|textarea|template)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/\{\{[\s\S]*?\}\}/g, '');
}

/** Each element's tag, class, style and attributes, with its ancestors' classes, from a simple tag scan. */
function elements(html) {
  const found = [];
  const stack = [];
  for (const m of markupOnly(html).matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g)) {
    const [, closing, rawTag, attrs] = m;
    const tag = rawTag.toLowerCase();
    if (closing) {
      const at = stack.map((e) => e.tag).lastIndexOf(tag);
      if (at >= 0) stack.length = at;
      continue;
    }
    const attr = (name) => new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i').exec(attrs)?.[2] ?? '';
    const element = { tag, cls: attr('class'), style: attr('style'), hidden: /aria-hidden\s*=\s*["']true/i.test(attrs), width: attr('width'), ancestors: stack.map((e) => e.cls) };
    found.push(element);
    if (!VOID.has(tag) && !/\/\s*$/.test(attrs)) stack.push(element);
  }
  return found;
}

/** What in `html` won't fit a phone: [{ key, text }], one per kind and value. */
export function responsiveFindings(html) {
  const out = new Map();
  const add = (key, text) => out.has(key) || out.set(key, text);
  for (const el of elements(html || '')) {
    const tokens = el.cls.split(/\s+/).filter(Boolean);
    const decorative = el.hidden || DECORATIVE.test(el.cls);
    const capped = CAPPED.test(el.cls) || /max-width\s*:/i.test(el.style) || el.ancestors.some((cls) => CONTAINS.test(cls));

    if (!decorative && !capped) {
      for (const token of tokens) {
        const width = widthOf(token);
        if (width !== null && width > PHONE_ROOM) add(`w:${token}`, `"${token}" fixes a box at ${Math.round(width)}px at every size, wider than a phone; use w-full with max-w-…, or set it from sm:/md: up`);
      }
      const inline = /(?:^|;)\s*(min-)?width\s*:\s*([\d.]+(?:px|rem|em))/i.exec(el.style);
      if (inline && px(inline[2]) > PHONE_ROOM) add(`style:${inline[0].trim()}`, `an inline style sets "${inline[0].replace(/^;/, '').trim()}", wider than a phone; use w-full with a max-width`);
      if (/^(iframe|video|embed|object)$/.test(el.tag) && px(el.width) > PHONE_ROOM && !tokens.includes('w-full')) {
        add(`embed:${el.tag}:${el.width}`, `${/^[aeiou]/.test(el.tag) ? 'an' : 'a'} <${el.tag}> is ${el.width}px wide, wider than a phone; give it w-full (in an aspect-* box)`);
      }
    }

    for (const token of tokens) {
      const cols = /^grid-cols-(\d+)$/.exec(token);
      if (cols && Number(cols[1]) >= 4) add(`grid:${token}`, `"${token}" puts ${cols[1]} columns side by side on a phone too; start with one or two and split from sm:/md:/lg: up`);
      const custom = /^grid-cols-\[(.+)\]$/.exec(token);
      if (custom && !/auto-(fit|fill)/.test(custom[1])) {
        const tracks = custom[1].split('_').filter(Boolean);
        const flexible = tracks.filter((t) => /fr$|^minmax/.test(t)).length;
        if (tracks.length >= 3 || flexible >= 2) add(`grid:${token}`, `"${token}" keeps its columns side by side on a phone; prefix it with md: or lg:`);
      }
      const size = textSizeOf(token);
      if (size !== null && size >= 64) add(`text:${token}`, `"${token}" is ${Math.round(size)}px text even on a phone, where a long word won't fit; start smaller and grow from sm:/md: up`);
    }

    if (el.tag === 'table' && !el.ancestors.some((cls) => SCROLLS.test(cls)) && !SCROLLS.test(el.cls)) {
      add('table', 'a <table> isn\'t inside <div class="overflow-x-auto">, so a wide one can\'t scroll on a phone');
    }
  }
  return [...out].map(([key, text]) => ({ key, text }));
}

/** Warnings for what `updated` adds that won't fit a phone, leaving out what `original` already had. */
export function responsiveWarnings(original, updated) {
  const before = new Set(responsiveFindings(original).map((f) => f.key));
  const fresh = responsiveFindings(updated).filter((f) => !before.has(f.key));
  const shown = fresh.slice(0, 5).map((f) => `on phones: ${f.text}`);
  if (fresh.length > 5) shown.push(`on phones: ${fresh.length - 5} more things are fixed wider than a phone`);
  return shown;
}
