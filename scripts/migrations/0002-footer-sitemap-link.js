import fs from 'node:fs';
import path from 'node:path';

export const description = 'take the "Sitemap" link out of the footer';

// The template's footer used to list "Sitemap" (/sitemap.xml) next to Privacy and Terms. The file
// is for search engines (robots.txt points them at it), and visitors who clicked it saw raw XML;
// on sites without Privacy and Terms pages it sat alone in the footer's corner. Removes only that
// exact default link, keeping every other one and the file's line endings.
export default async function migrate(root) {
  const file = path.join(root, 'content/data/navigation.json');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  const nav = JSON.parse(text);
  if (!Array.isArray(nav.legal)) return false;
  const kept = nav.legal.filter((link) => !(link && link.url === '/sitemap.xml' && String(link.label ?? '').trim().toLowerCase() === 'sitemap'));
  if (kept.length === nav.legal.length) return false;
  nav.legal = kept;
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  fs.writeFileSync(file, `${JSON.stringify(nav, null, 2)}\n`.replace(/\n/g, newline));
  return true;
}
