import * as fs from 'node:fs';
import * as path from 'node:path';

export interface RenderedFile {
  path: string;
  content: string;
}

const PLACEHOLDER = /\{\{(\w+)\}\}/g;
const TEMPLATE_SUFFIX = '.tmpl';

function fill(text: string, vars: Record<string, string>, where: string): string {
  return text.replace(PLACEHOLDER, (_match, key: string) => {
    if (!Object.hasOwn(vars, key)) {
      throw new Error(`Unknown template placeholder {{${key}}} in ${where}`);
    }
    return vars[key];
  });
}

export function renderTemplate(dir: string, vars: Record<string, string>): RenderedFile[] {
  const files: RenderedFile[] = [];
  const walk = (rel: string): void => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const entryRel = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        walk(entryRel);
        continue;
      }
      if (entry.name === '.gitkeep') {
        continue;
      }
      const target = fill(entryRel, vars, entryRel);
      files.push({
        path: target.endsWith(TEMPLATE_SUFFIX) ? target.slice(0, -TEMPLATE_SUFFIX.length) : target,
        content: fill(fs.readFileSync(path.join(dir, entryRel), 'utf8'), vars, entryRel)
      });
    }
  };
  walk('');
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
