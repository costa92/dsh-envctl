import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { renderTemplate } from '../../src/scaffold/render.js';
import { templatesRoot } from '../../src/scaffold/templates.js';

describe('renderTemplate', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-render-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  };

  it('replaces placeholders in contents and paths, strips .tmpl and sorts by path', () => {
    write('package.json.tmpl', '{"name":"{{package}}"}');
    write('skills/{{name}}/SKILL.md', 'name: {{name}}\n');
    expect(renderTemplate(dir, { name: 'demo', package: '@me/demo' })).toEqual([
      { path: 'package.json', content: '{"name":"@me/demo"}' },
      { path: path.join('skills', 'demo', 'SKILL.md'), content: 'name: demo\n' }
    ]);
  });

  it('rejects unknown placeholders, including inherited object keys', () => {
    write('a.txt', '{{missing}}');
    expect(() => renderTemplate(dir, {})).toThrow('Unknown template placeholder {{missing}} in a.txt');
    write('a.txt', '{{constructor}}');
    expect(() => renderTemplate(dir, {})).toThrow('{{constructor}}');
  });

  it('leaves text that is not a placeholder untouched', () => {
    write('a.js', 'const s = `${x}`; const o = { a: { b: 1 } };\n');
    expect(renderTemplate(dir, {})[0].content).toBe('const s = `${x}`; const o = { a: { b: 1 } };\n');
  });
});

describe('templatesRoot', () => {
  it('finds the templates directory next to the package root', () => {
    const root = templatesRoot();
    expect(path.basename(root)).toBe('templates');
    expect(fs.existsSync(path.join(path.dirname(root), 'package.json'))).toBe(true);
  });
});
