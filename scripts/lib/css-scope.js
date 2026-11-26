/**
 * Scopes an imported page's CSS to that page (scripts/edit-page.js
 * --from-html --keep-styles). Zero dependencies.
 *
 * Every selector is put under one scope class (the wrapper the imported body
 * sits in), html/body/:root rules apply to the wrapper itself, and every class
 * name gets the same prefix the imported HTML's classes were given, so the
 * site's own classes and Tailwind utilities never match imported markup and
 * the imported rules never reach the site's header, footer or other pages.
 * Rules whose classes or ids no longer exist in the imported body (the old
 * header and footer, unused framework classes) are dropped. Keyframes and
 * cascade layers are renamed with the prefix so they can't collide with the
 * site's, rem values are rescaled when the page changed the root font size,
 * and zero-specificity `all: initial` / `all: revert` rules keep the site's
 * own base styles out of the scope.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './content.js';

// At-rules whose blocks hold rules (scoped recursively); any other block is copied as-is.
const NESTING_AT_RULES = /^@(media|supports|layer|container|document|-moz-document|scope|starting-style)\b/i;
const ROOT_COMPOUND = /^(?:html|body|:root)(?![\w-])(?:[.#:[][^\s>+~]*)?/i;
// Functional pseudo-classes whose arguments may name classes that aren't there (":not(.x)" still matches).
const FUNCTIONAL_PSEUDO = /:(?:not|is|where|has|matches|-webkit-any|-moz-any)\(/gi;

/** Removes comments, leaving strings alone. */
function stripComments(css) {
  let out = '';
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '"' || c === "'") {
      const end = stringEnd(css, i);
      out += css.slice(i, end);
      i = end - 1;
    } else if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? css.length : end + 1;
    } else {
      out += c;
    }
  }
  return out;
}

function stringEnd(css, start) {
  const quote = css[start];
  let i = start + 1;
  while (i < css.length && css[i] !== quote) i += css[i] === '\\' ? 2 : 1;
  return Math.min(i + 1, css.length);
}

/** Index just past the "}" matching the "{" at `open`. */
function blockEnd(css, open) {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    const c = css[i];
    if (c === '"' || c === "'") i = stringEnd(css, i) - 1;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return css.length;
}

/** [{ type: 'statement', text } | { type: 'block', prelude, body }] at one level. */
function parse(css) {
  const nodes = [];
  let i = 0;
  while (i < css.length) {
    while (i < css.length && /[\s;]/.test(css[i])) i++;
    if (i >= css.length) break;
    if (css[i] === '}') {
      i++; // stray closer
      continue;
    }
    let j = i;
    let parens = 0;
    while (j < css.length) {
      const c = css[j];
      if (c === '"' || c === "'") j = stringEnd(css, j) - 1;
      else if (c === '(') parens++;
      else if (c === ')') parens--;
      else if (parens <= 0 && (c === '{' || c === ';')) break;
      j++;
    }
    const prelude = css.slice(i, j).trim();
    if (css[j] === '{') {
      const end = blockEnd(css, j);
      nodes.push({ type: 'block', prelude, body: css.slice(j + 1, end - 1) });
      i = end;
    } else {
      if (prelude) nodes.push({ type: 'statement', text: prelude });
      i = j + 1;
    }
  }
  return nodes;
}

/** Splits on commas outside parentheses, brackets and strings. */
function splitList(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") i = stringEnd(text, i) - 1;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Applies `fn` to the parts of a selector outside quoted strings. */
function outsideStrings(selector, fn) {
  let out = '';
  let last = 0;
  for (let i = 0; i < selector.length; i++) {
    if (selector[i] === '"' || selector[i] === "'") {
      const end = stringEnd(selector, i);
      out += fn(selector.slice(last, i)) + selector.slice(i, end);
      last = end;
      i = end - 1;
    }
  }
  return out + fn(selector.slice(last));
}

/** The selector with the arguments of :not(), :is(), :where() and :has() taken out. */
function withoutFunctionalArgs(selector) {
  let out = '';
  let last = 0;
  for (const m of selector.matchAll(FUNCTIONAL_PSEUDO)) {
    if (m.index < last) continue;
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < selector.length && depth; i++) {
      if (selector[i] === '(') depth++;
      else if (selector[i] === ')') depth--;
    }
    out += selector.slice(last, m.index);
    last = i;
  }
  return out + selector.slice(last);
}

const unescape = (name) => name.replace(/\\([0-9a-f]{1,6}\s?|.)/gi, (_, c) => (/^[0-9a-f]/i.test(c) && c.length > 1 ? String.fromCodePoint(parseInt(c, 16)) : c));

/** [class^="x"], [class~="x"], [class|="x"], [class*=" x"] and [class="a b"] with the prefix added. */
function prefixClassAttributes(selector, prefix) {
  return selector.replace(/\[\s*class\s*([~|^*]?=)\s*(["']?)([^"'\]]*)\2(\s+[is])?\s*\]/gi, (whole, op, quote, value, flag = '') => {
    const q = quote || '"';
    if (op === '=') return `[class=${q}${value.split(/\s+/).filter(Boolean).map((v) => prefix + v).join(' ')}${q}${flag}]`;
    if (op === '*=') return value.startsWith(' ') ? `[class*=${q} ${prefix}${value.slice(1)}${q}${flag}]` : whole;
    return `[class${op}${q}${prefix}${value}${q}${flag}]`;
  });
}

/** The class a copied header's or footer's wrapper carries for an outer box's id it stands in for. */
export const wrapperIdClass = (prefix, id) => `${prefix}id-${id.replace(/[^\w-]/g, '_')}`;

/** The scoped selector, or null if it refers to a class or id that isn't in the page. */
function scopeSelector(selector, options) {
  const { scope, prefix, classes, ids, rootClasses, rootIds, scripted, dropClasses, dropIds, mentioned, wrapperClasses, wrapperIds } = options;
  // Without scripts a class or id that isn't in the page never will be, so its rule goes. With
  // scripts it may be added later (an "is-open", a library's "aos-animate"), so only the removed
  // header's and footer's go; with `mentioned`, only names the page's HTML or scripts contain
  // somewhere (an attribute, a settings object, a script's string) can be added later.
  const maybeLater = (name, dropped) => scripted && !dropped.has(name) && (!mentioned || mentioned.has(name));
  const known = (name) => classes.has(name) || rootClasses.has(name) || maybeLater(name, dropClasses);
  const knownId = (id) => ids.has(id) || rootIds.has(id) || maybeLater(id, dropIds);
  let missing = false;
  outsideStrings(withoutFunctionalArgs(selector), (part) => {
    for (const m of part.matchAll(/\.((?:\\.|[\w-])+)/g)) if (!known(unescape(m[1]))) missing = true;
    for (const m of part.matchAll(/#((?:\\.|[\w-])+)/g)) if (!knownId(unescape(m[1]))) missing = true;
    return part;
  });
  if (missing) return null;

  // Attribute selectors are rewritten on the whole selector: their values are quoted strings.
  let rest = prefixClassAttributes(outsideStrings(selector, (part) => part.replace(/\.((?:\\.|[\w-])+)/g, `.${prefix}$1`)), prefix);
  // Classes and ids the old <html> and <body> carried (and the class a reveal script adds there)
  // now belong to the scope: "body.home .x", ".js .x" and "#page .x" all start from the wrapper.
  // Classes and ids, with any attribute conditions and :not()s on them ("#header-outer[data-format=x]").
  const rootToken = /^(?:\.(?:\\.|[\w-])+|#(?:\\.|[\w-])+|\[[^\]]*\]|:not\([^()]*\))+(?=[\s>+~]|$)/;
  // A leading class that's on no element (".js .reveal", ".menu-open .nav") is one a script adds,
  // usually to <html> or <body>, which are the wrapper now, but maybe to an element inside. Both
  // are matched.
  const leading = scripted && !ROOT_COMPOUND.test(rest) ? rootToken.exec(rest)?.[0] : null;
  const state = leading && !leading.includes('#') ? [...leading.matchAll(/\.((?:\\.|[\w-])+)/g)].map((m) => unescape(m[1]).slice(prefix.length)) : [];
  if (state.length && state.every((c) => !classes.has(c) && !rootClasses.has(c)) && rest.slice(leading.length).trim()) {
    const asRoot = [scopeSelector(selector, { ...options, rootClasses: new Set([...rootClasses, ...state]) })].flat().filter(Boolean);
    return asRoot.length ? { selector: `${asRoot.map((s) => s.selector).join(',\n')},\n${scope} ${rest}`, root: null } : null;
  }
  const everyToken = (compound, isClass, isId) =>
    [...compound.matchAll(/([.#])((?:\\.|[\w-])+)/g)].every(([, kind, name]) =>
      kind === '.' ? isClass(unescape(name).slice(prefix.length)) : isId(unescape(name)));
  const isRootCompound = (compound) => everyToken(compound, (c) => rootClasses.has(c), (id) => rootIds.has(id));
  // A class on the old <html> or <body> that elements inside the page carry too (<html
  // class="w-full"> and <svg class="w-full">) matched them all, so the rule must as well.
  const inContent = (compound) => everyToken(compound, (c) => classes.has(c), (id) => ids.has(id));
  const descendant = `${scope} ${rest}`;
  let shared = false;
  let scoped = scope;
  let rooted = false;
  let kind = null;
  let pseudo = '';
  let idWeight = 0;
  for (;;) {
    const m = ROOT_COMPOUND.exec(rest);
    const bare = !m && rootToken.exec(rest);
    const compound = m ? m[0] : bare && isRootCompound(bare[0]) ? bare[0] : null;
    if (!compound) break;
    if (!m && inContent(compound)) shared = true;
    // "html:not(.js)" is a condition on the wrapper's classes, never a class it must have: each
    // :not(…) goes onto the wrapper as it is (its classes were prefixed with the rest), and only the
    // classes outside it are required. (Reading them all as required turned "no js" into "js".)
    const negations = [];
    // Attribute conditions on the old <html>/<body> ("body[data-header-format=left-header] .x")
    // stay conditions: the wrapper carries those attributes (rootAttributes in html-source.js).
    const conditions = [];
    const positive = compound
      .replace(/:not\(([^()]*)\)/gi, (whole) => {
        negations.push(whole);
        return '';
      })
      .replace(/\[[^\]]*\]/g, (whole) => {
        conditions.push(whole);
        return '';
      });
    // Every class stays a condition, the old <body>'s own and the rest alike: "body.no-header-template
    // #header-outer" applies only while the wrapper has that class (a script may add it), never always.
    for (const [, sign, name] of positive.matchAll(/([.#])((?:\\.|[\w-])+)/g)) {
      if (sign === '.' && !scoped.includes(`.${name}`)) scoped += `.${name}`;
    }
    for (const not of [...conditions, ...negations]) if (!scoped.includes(not)) scoped += not;
    // An id the old wrapper had ("#header-outer .logo img") ranked the rule above class-only rules
    // (".row .col img"). The wrapper is a class now, so the rule keeps that rank with an always-true
    // id-weight condition (no element has that id): the cascade stays the original's.
    for (const [, sign] of positive.matchAll(/([#])((?:\\.|[\w-])+)/g)) if (sign === '#') { idWeight += 1; }
    // An outer box a copied header sat in (wrapperIds, `around` in html-source.js) is one part's
    // wrapper, never the other's: its id is that wrapper's class (wrapperIdClass).
    for (const [, name] of positive.matchAll(/#((?:\\.|[\w-])+)/g)) {
      const own = `.${wrapperIdClass(prefix, unescape(name))}`;
      if (wrapperIds?.has(unescape(name)) && !scoped.includes(own)) scoped += own;
    }
    // A rule for such a box keeps all of it (its position, height, background): it's the header's
    // own box, not the old <body>.
    const boxed = [...positive.matchAll(/([.#])((?:\\.|[\w-])+)/g)].some(([, sign, name]) =>
      sign === '#' ? wrapperIds?.has(unescape(name)) : wrapperClasses?.has(unescape(name).slice(prefix.length)));
    // "body::before" is the wrapper's ::before, not the wrapper.
    pseudo = /::?(?:before|after|selection|first-line|first-letter|marker|backdrop)\b/i.exec(compound)?.[0] || pseudo;
    kind = /^(html|:root)/i.test(compound) ? 'html' : boxed ? 'wrapper' : kind || 'body';
    rest = rest.slice(compound.length).trimStart();
    rooted = true;
  }
  if (idWeight) scoped += `:not(${Array.from({ length: idWeight }, () => `#${prefix}none`).join('')})`;
  // A copied header's or footer's own element (by its id, which nothing else has) that a theme's
  // script moves into the page (an off-canvas menu moved into the content wrapper) keeps its
  // styles there too (`alsoIn`, the page's scope).
  if (options.alsoIn && rest && scoped === scope && [...rest.matchAll(/#((?:\\.|[\w-])+)/g)].some(([, id]) => ids.has(unescape(id)) && !wrapperIds?.has(unescape(id)))) {
    scoped = `:is(${scope}, ${options.alsoIn})`;
  }
  // "body > .x" becomes ".scope > .x", and a plain selector becomes a descendant of the scope.
  const result = rooted && !rest ? { selector: scoped + pseudo, root: pseudo ? null : kind } : { selector: `${scoped} ${rest}`, root: null };
  return shared ? [result, { selector: descendant, root: null }] : result;
}

/**
 * The selector list with "*" (and "*::before"…) also applied to the old <body>:
 * on the original page a universal selector matched <body> too, and <body> is
 * now the wrapper, which ".scope *" alone doesn't reach. The extra selector
 * is marked `universal`, so it keeps the zero specificity "*" had.
 */
function withRootUniversal(selectors) {
  const out = [];
  for (const s of selectors) {
    out.push({ selector: s });
    const m = /^\*((?:::?[\w-]+(?:\([^)]*\))?)*)$/.exec(s.trim());
    if (m && !/:(?:hover|focus|active|not|is|where|has|nth|first-child|last-child)/i.test(m[1])) out.push({ selector: `body${m[1]}`, universal: true });
  }
  return out;
}

function urlWarnings(text, warnings) {
  for (const m of text.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi)) {
    const ref = m[2].trim();
    if (/^(https?:|data:|#)/i.test(ref)) continue;
    // Root-relative, or relative to where the page's stylesheet is written (assets/css/imported/).
    const file = ref.split(/[?#]/)[0];
    const resolved = file.startsWith('/') ? file.slice(1) : path.posix.normalize(path.posix.join('assets/css/imported', file));
    const exists = !resolved.startsWith('../') && fs.existsSync(path.join(ROOT, resolved));
    if (!exists) warnings.add(`the CSS refers to ${ref}, which isn't in this site, so that background, font or image won't load`);
  }
}

const scaleRem = (text, factor) =>
  factor === 1 ? text : text.replace(/(-?\d*\.?\d+)rem\b/g, (_, n) => `${+(Number(n) * factor).toFixed(4)}rem`);

/**
 * What the page's own <html> rules set, property by property (the last
 * plain html/:root rule wins, as it would on most pages). <html> and <body>
 * are both the wrapper in the copy, so "inherit" on a body rule would reach
 * the site's page around it instead of the old <html>: Tailwind's preflight
 * (html { line-height: 1.5 } then body { line-height: inherit }) would give
 * every line the site's line height. Body rules use these values instead.
 */
function htmlDeclarations(sheets) {
  const values = new Map();
  for (const { css } of sheets) {
    for (const node of parse(stripComments(css))) {
      if (node.type !== 'block' || node.prelude.startsWith('@') || node.body.includes('{')) continue;
      if (!splitList(node.prelude).some((s) => /^(html|:root)$/i.test(s))) continue;
      for (const decl of node.body.split(';')) {
        const m = /^\s*([\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(decl);
        if (m && !m[1].startsWith('--')) values.set(m[1].toLowerCase(), m[2].replace(/\s*!important$/i, ''));
      }
    }
  }
  return values;
}

/** Declarations with renamed keyframes and rescaled rem values; root rules get absolute font sizes. */
function rewriteDeclarations(body, options, root) {
  let out = body;
  // "inherit" on the old <body> took the old <html>'s value (or, if it set none, the initial one).
  if (root === 'body') {
    out = out.replace(/(^|;)(\s*)([\w-]+)(\s*:\s*)inherit\b/gi, (_, lead, space, prop, colon) => {
      let value = options.htmlValues.get(prop.toLowerCase()) ?? 'initial';
      // A relative root font size is relative to the browser's 16px; the body rule below would rescale it.
      const relative = prop.toLowerCase() === 'font-size' && /^(-?\d*\.?\d+)(%|em)$/i.exec(value);
      if (relative) value = `${+((Number(relative[1]) / (relative[2] === '%' ? 100 : 1)) * 16).toFixed(3)}px`;
      return `${lead}${space}${prop}${colon}${value}`;
    });
  }
  out = scaleRem(out, options.remFactor);
  if (options.keyframes.size) {
    // Custom properties too: Tailwind 4 keeps an animation in one ("--animate-spin: spin 1s
    // linear infinite") that "animation: var(--animate-spin)" reads.
    out = out.replace(/((?:animation(?:-name)?|--[\w-]*anim[\w-]*)\s*:\s*)([^;}]+)/gi, (_, prop, value) =>
      prop + value.replace(/[\w-]+/g, (word) => (options.keyframes.has(word) ? options.prefix + word : word)));
  }
  if (root) {
    // The wrapper sits inside the site's page, so sizes relative to "the parent" must be made absolute.
    const base = root === 'html' ? 16 : 16 * options.remFactor;
    out = out.replace(/(font-size\s*:\s*)(-?\d*\.?\d+)(%|em)(?![\w-])/gi, (_, prop, n, unit) => `${prop}${+((Number(n) / (unit === '%' ? 100 : 1)) * base).toFixed(3)}px`);
    // On a real page body's overflow belongs to the viewport; on the wrapper "hidden" would make it a
    // scroll container and break position: sticky inside it. "clip" crops without that.
    out = out.replace(/(overflow(?:-[xy])?\s*:\s*)hidden\b/gi, '$1clip');
  }
  return out;
}

/** A rule body that may contain nested rules (CSS nesting): their class names get the prefix too. */
function rewriteBody(body, options, root, warnings) {
  if (!body.includes('{')) return rewriteDeclarations(body, options, root);
  return parse(body)
    .map((node) => {
      if (node.type === 'statement') return `${rewriteDeclarations(node.text, options, root)};`;
      const prelude = node.prelude.startsWith('@')
        ? node.prelude
        : prefixClassAttributes(outsideStrings(node.prelude, (part) => part.replace(/\.((?:\\.|[\w-])+)/g, `.${options.prefix}$1`)), options.prefix);
      return `${prelude} { ${rewriteBody(node.body, options, null, warnings)} }`;
    })
    .join(' ');
}

const layerName = (name, options) => {
  const renamed = name.split('.').map((part) => options.prefix + part.trim()).join('.');
  if (!options.layers.includes(renamed)) options.layers.push(renamed);
  return renamed;
};

// Properties an element passes to its children, and custom properties.
const INHERITED = /^(--[\w-]+|color|font(-[\w-]+)?|line-height|letter-spacing|word-spacing|text-(align|indent|transform|shadow|rendering|decoration[\w-]*|underline-offset|wrap)|white-space|direction|visibility|cursor|list-style(-[\w-]+)?|quotes|tab-size|hyphens|overflow-wrap|word-break|caret-color|accent-color|color-scheme|-webkit-font-smoothing|-moz-osx-font-smoothing|-webkit-text-size-adjust|text-size-adjust)$/i;

/** Declarations with only the inherited properties kept. */
function inheritedOnly(text) {
  return text
    .split(';')
    .filter((decl) => INHERITED.test((/^\s*([\w-]+)\s*:/.exec(decl)?.[1] || '').trim()))
    .map((decl) => decl.trim())
    .join(';');
}

function scopeNodes(nodes, options, imports, warnings) {
  const out = [];
  for (const node of nodes) {
    if (node.type === 'statement') {
      if (/^@import\b/i.test(node.text)) {
        if (/^@import\s+(?:url\(\s*)?["']?https?:/i.test(node.text)) imports.push(`${node.text};`);
        else warnings.add(`dropped ${node.text.slice(0, 120)}: upload that stylesheet as well to include it`);
      } else if (/^@layer\b/i.test(node.text)) {
        // "@layer a, b;" only fixes the order; it's folded into the order statement at the top.
        for (const name of node.text.replace(/^@layer\s*/i, '').split(',')) if (name.trim()) layerName(name.trim(), options);
      }
      continue; // @charset, @namespace and stray statements
    }
    const { prelude, body } = node;
    if (/^@layer\b/i.test(prelude)) {
      const name = prelude.replace(/^@layer\s*/i, '').trim() || `anonymous-${options.layers.length + 1}`;
      const inner = scopeNodes(parse(body), options, imports, warnings);
      if (inner.length) out.push(`@layer ${layerName(name, options)} {\n${inner.join('\n')}\n}`);
    } else if (NESTING_AT_RULES.test(prelude)) {
      const inner = scopeNodes(parse(body), options, imports, warnings);
      if (inner.length) out.push(`${prelude} {\n${inner.join('\n')}\n}`);
    } else if (/^@(-\w+-)?keyframes\b/i.test(prelude)) {
      const name = prelude.replace(/^@(-\w+-)?keyframes\s*/i, '').trim().replace(/^["']|["']$/g, '');
      out.push(`${prelude.replace(/keyframes\s+.*/i, `keyframes ${options.prefix}${name}`)} {${scaleRem(body, options.remFactor)}}`);
    } else if (prelude.startsWith('@')) {
      // @font-face, @page, @property: not tied to any element.
      urlWarnings(body, warnings);
      out.push(`${prelude} {${body}}`);
    } else {
      const scoped = withRootUniversal(splitList(prelude))
        .flatMap(({ selector, universal }) => {
          const results = [scopeSelector(selector, options)].flat().filter(Boolean);
          if (universal) for (const r of results) r.selector = r.selector.replace(options.scope, `:where(${options.scope})`);
          return results;
        });
      if (!scoped.length) continue;
      urlWarnings(body, warnings);
      const root = scoped.every((s) => s.root) ? scoped[0].root : null;
      // A copied header's own outer box ('wrapper') is styled like any element.
      const bodyRoot = root === 'wrapper' ? null : root;
      let text = rewriteBody(body.trim(), options, bodyRoot, warnings);
      // A copied header or footer is only part of the old <body>: it takes what the body passed
      // down (font, colour…), not its box (a min-height, padding for a fixed bar, a background).
      if (options.chrome && bodyRoot && !text.includes('{')) text = inheritedOnly(text);
      if (options.chrome && bodyRoot && !text) continue;
      out.push(`${scoped.map((s) => s.selector).join(',\n')} {${text ? ` ${text} ` : ''}}`);
    }
  }
  return out;
}

/** Every plain style rule in the stylesheets, at any @media depth: { selectors, body }. */
function flatRules(css) {
  const rules = [];
  const visit = (nodes) => {
    for (const node of nodes) {
      if (node.type !== 'block') continue;
      if (NESTING_AT_RULES.test(node.prelude)) visit(parse(node.body));
      else if (!node.prelude.startsWith('@')) rules.push({ selectors: splitList(node.prelude), body: node.body });
    }
  };
  visit(parse(stripComments(css)));
  return rules;
}

/**
 * A scroll-reveal effect driven by the page's own script, recognised from its
 * CSS: ".R .T { opacity: 0 }" hides elements until a script puts R on <html>
 * (typically "js"), and ".R .T.S" shows them once the script adds S as they
 * scroll into view. R and S appear on no element, T does. Returns { root,
 * target, state } or null. The site's own script (assets/js/site.js) plays it
 * back; without it the rules never apply and everything stays visible.
 */
export function detectReveal(sheets, classes) {
  const rules = sheets.flatMap(({ css }) => flatRules(css));
  // A switch on the page (".js", ".aos-ready") has no look of its own. A class some rule gives a
  // size, a position or a display of its own (".close-indicator { position: fixed; width: 90px }")
  // is a component: putting it on the whole page would turn the page into that component.
  const LOOK = /(^|;)\s*(position|width|height|top|left|right|bottom|display|float|margin|padding|font-size|line-height)\s*:/i;
  const styledAsElement = (name) =>
    rules.some(({ selectors, body }) => LOOK.test(body) && selectors.some((sel) => new RegExp(`(^|[\\s>+~])\\.${name}(?![\\w-])[^\\s>+~]*$`).test(sel.trim())));
  for (const { selectors, body } of rules) {
    if (!/(^|;)\s*opacity\s*:\s*0(?![.\d])/.test(body)) continue;
    for (const selector of selectors) {
      const hidden = /^(?:html)?\.([\w-]+)\s+\.([\w-]+)$/.exec(selector.trim());
      if (!hidden || classes.has(hidden[1]) || !classes.has(hidden[2])) continue;
      const [, root, target] = hidden;
      if (styledAsElement(root)) continue;
      for (const other of rules) {
        for (const s of other.selectors) {
          const shown = new RegExp(`^(?:html)?\\.${root}\\s+\\.${target}\\.([\\w-]+)$`).exec(s.trim());
          if (shown && !classes.has(shown[1]) && /opacity\s*:\s*1|transform\s*:\s*none/.test(other.body)) return { root, target, state: shown[1] };
        }
      }
    }
  }
  return null;
}

/** How much the page's rem differs from 16px: html { font-size: 62.5% } gives 0.625. */
function rootFontFactor(sheets) {
  let factor = 1;
  for (const { css } of sheets) {
    for (const node of parse(stripComments(css))) {
      if (node.type !== 'block' || node.prelude.startsWith('@')) continue;
      if (!splitList(node.prelude).some((s) => /^(html|:root)$/i.test(s))) continue;
      // "(?![\w-])", not "\b": there's no word boundary between "%" and ";".
      const m = /(?:^|;)\s*font-size\s*:\s*(-?\d*\.?\d+)(px|%|em|rem)(?![\w-])/i.exec(node.body);
      if (m) factor = m[2].toLowerCase() === 'px' ? Number(m[1]) / 16 : m[2] === '%' ? Number(m[1]) / 100 : Number(m[1]);
    }
  }
  return factor;
}

/** Names of every @keyframes in the stylesheets. */
function keyframeNames(sheets) {
  const names = new Set();
  for (const { css } of sheets) {
    for (const m of stripComments(css).matchAll(/@(?:-\w+-)?keyframes\s+["']?([\w-]+)/gi)) names.add(m[1]);
  }
  return names;
}

/**
 * Scopes stylesheets (in cascade order) to `scope`, prefixing class names
 * with `prefix` and keeping only rules for `classes`/`ids` that exist.
 * `rootClasses`/`rootIds` are what the old <html> and <body> carried (they
 * now describe the wrapper); `reveal` (from detectReveal) keeps that effect's
 * script-added classes. With `scripted` (the page's scripts are kept) rules
 * for classes and ids that aren't in the page stay, since a script may add
 * them, except `dropClasses`/`dropIds` (the removed header's and footer's), and with `mentioned`
 * (a Set, mentionedNames) only those the page names somewhere: for very large frameworks.
 * Returns { css, warnings, rules, remFactor }.
 */
/**
 * Every name-like word in `texts` (a page's whole HTML and its scripts' code): what a class or id
 * a script adds later must be among, since the script or the markup it reads has to name it.
 */
export function mentionedNames(texts) {
  const names = new Set();
  for (const text of texts) for (const m of String(text ?? '').matchAll(/[A-Za-z_][\w-]*/g)) names.add(m[0]);
  return names;
}

export function scopeCss(sheets, { scope, prefix, classes, ids, rootClasses = new Set(), rootIds = new Set(), reveal = null, hints = [], scripted = false, dropClasses = [], dropIds = [], chrome = false, mentioned = null, wrapperClasses = null, wrapperIds = null, alsoIn = null }) {
  const imports = [];
  const warnings = new Set();
  const out = [];
  const roots = new Set(rootClasses);
  if (reveal) {
    roots.add(reveal.root);
    classes = new Set([...classes, reveal.state]);
  }
  const options = {
    scope, prefix, classes, ids, rootClasses: roots, rootIds,
    scripted, dropClasses: new Set(dropClasses), dropIds: new Set(dropIds), chrome, mentioned, wrapperClasses, wrapperIds, alsoIn,
    remFactor: rootFontFactor(sheets), keyframes: keyframeNames(sheets), layers: [], htmlValues: htmlDeclarations(sheets),
  };
  let rules = 0;
  for (const { name, css } of sheets) {
    const scoped = scopeNodes(parse(stripComments(css)), options, imports, warnings);
    if (scoped.length) out.push(`/* ${name.replace(/\*\//g, '')} */`, ...scoped);
    rules += scoped.length;
  }
  // Makes the scope behave like the old page's own <body>: the wrapper starts from initial
  // values (so it doesn't inherit the site body's font size, colour or font) with the browser's
  // default body margin, and inside it the site's own styles (Tailwind's preflight and base
  // layer: heading colours, text-wrap, img/svg display, border-box pseudo-elements…) roll back
  // to browser defaults. Zero specificity: imported rules win. When the imported CSS uses cascade
  // layers these rules go in a layer ordered before them, so the imported layers still win.
  // SVG is left out of "all: revert": its geometry (r, cx, d, width…) comes from attributes that
  // count as styling, which revert would wipe, so every shape would draw at size zero. The <svg>
  // element itself only rolls back what the site's base layer changes (display, vertical-align).
  const isolateRules = [
    // A copied header or footer (`chrome`) is part of the old body, not all of it: no body margin.
    `:where(${scope}) { all: initial; display: block; margin: ${chrome ? 0 : '8px'}; }`,
    `:where(${scope} *:not(svg, svg *)) { all: revert; }`,
    `:where(${scope} svg) { display: revert; vertical-align: revert; box-sizing: revert; }`,
    `:where(${scope}, ${scope} *)::before, :where(${scope}, ${scope} *)::after { all: revert; }`,
    `:where(${scope} *)::marker { all: revert; }`,
    `:where(${scope} *)::placeholder { all: revert; }`,
    `:where(${scope}, ${scope} *)::selection { all: revert; }`,
  ];
  // Old HTML attribute styling (<font color>, <table border>…) as rules, right after the isolation
  // that would otherwise revert it (see presentationalHints in html-source.js).
  const hintComment = `/* Styling the old HTML gave through attributes (font color, table border, image width…). */`;
  const resetLayer = `${prefix}reset`;
  const hintLayer = `${prefix}attributes`;
  const isolate = options.layers.length
    ? [
        `@layer ${[resetLayer, ...(hints.length ? [hintLayer] : []), ...options.layers].join(', ')};`,
        `/* The site's own styles don't apply inside ${scope}. */`,
        `@layer ${resetLayer} {\n${isolateRules.join('\n')}\n}`,
        ...(hints.length ? [hintComment, `@layer ${hintLayer} {\n${hints.join('\n')}\n}`] : []),
      ]
    : [`/* The site's own styles don't apply inside ${scope}. */`, ...isolateRules, ...(hints.length ? [hintComment, ...hints] : [])];
  if (options.remFactor !== 1) warnings.add(`the page set its root font size to ${options.remFactor * 16}px, so its rem values were rescaled to match`);
  // The page as a whole is never hidden: themes hide <body> (now the wrapper) until a script fades
  // it in (page transitions, "loading" screens), and a converted page may have no such script.
  const shown = `/* The page itself always shows (themes hide it until a script fades it in). */\n${scope} { opacity: 1 !important; visibility: visible !important; }`;
  const css = [...new Set(imports), ...isolate, ...out, shown].join('\n');
  return { css: `${css}\n`, warnings: [...warnings], rules, remFactor: options.remFactor };
}

/** Rescales rem values in an inline style attribute the same way as the stylesheet. */
export function scaleInlineRem(html, factor) {
  if (factor === 1) return html;
  return html.replace(/(\sstyle\s*=\s*)(["'])(.*?)\2/gi, (_, attr, q, value) => `${attr}${q}${scaleRem(value, factor)}${q}`);
}
