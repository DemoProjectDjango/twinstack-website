// The site agent's knowledge of the site (agent-index.json, written by build.js when
// site.config.json → agent has a key): every published page's visible text, as built, so the
// Twinstack web app's agent can answer from anything on any page, not only its first lines.
// Keep the shape in step with the web app (server/src/site-agent.js reads it).

// Per page, enough for a long page; the web app picks the passages a question needs.
export const AGENT_TEXT_MAX = 12_000;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', pound: '£', euro: '€', copy: '©', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

/** The text a visitor reads in `html` (a page's main part): no scripts, styles, drawings or menus. */
export function visibleText(html, max = AGENT_TEXT_MAX) {
  const text = String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|svg|noscript|template|nav|iframe|select)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/blockquote|\/dt|\/dd)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
      if (code[0] === '#') {
        const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' ';
      }
      return ENTITIES[code.toLowerCase()] ?? match;
    })
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ *\n[\n ]*/g, '\n')
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, text.lastIndexOf(' ', max)).trim()}…`;
}
