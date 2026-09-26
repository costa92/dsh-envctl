import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execa } from 'execa';
import * as YAML from 'yaml';
import { renderTemplate, type RenderedFile } from '../../src/scaffold/render.js';
import { PEER_RANGE, templateDir, type TemplateVariant } from '../../src/scaffold/templates.js';

const vars = { name: 'hello-world', package: '@me/hello-world', toolName: 'hello_world', peerRange: PEER_RANGE };
const render = (variant: TemplateVariant) => renderTemplate(templateDir(variant), vars);
const file = (files: RenderedFile[], rel: string): string => {
  const found = files.find((entry) => entry.path === rel);
  if (!found) throw new Error(`missing ${rel}`);
  return found.content;
};
// DSH patches use `!!js` for expressions evaluated at load time.
const jsTag = { tag: 'tag:yaml.org,2002:js', resolve: (source: string) => ({ js: source }) };
const insertedRows = (files: RenderedFile[]) => {
  const doc = YAML.parse(file(files, 'cordis.patch.yml'), { customTags: [jsTag] }) as Array<{ insert: Array<Record<string, any>> }>;
  return doc.flatMap((op) => op.insert);
};
const variants: TemplateVariant[] = ['skill', 'agent', 'tool', 'tool-ts', 'mcp'];

describe('component templates', () => {
  it.each(variants)('%s renders a bundle package with no leftover placeholders', (variant) => {
    const files = render(variant);
    for (const entry of files) {
      expect(entry.content, entry.path).not.toContain('{{');
      expect(entry.path).not.toContain('{{');
    }
    const pkg = JSON.parse(file(files, 'package.json'));
    expect(pkg.name).toBe('@me/hello-world');
    expect(pkg.type).toBe('module');
    expect(pkg.private).toBe(true);
    expect(pkg.dsh.bundle.patch).toBe('./cordis.patch.yml');
    expect(pkg.exports['./package.json']).toBe('./package.json');
    expect(file(files, 'README.md')).toContain('dshenv');
    expect(insertedRows(files).length).toBeGreaterThan(0);
  });

  it('skill mounts its own skills directory and ships a valid SKILL.md', () => {
    const files = render('skill');
    const [row] = insertedRows(files);
    expect(row.name).toBe('@deepseek-ai/dsh-skill-filesystem');
    expect(row.config.providerName).toBe('@me/hello-world');
    expect(row.config.includeDefaultRoots).toBe(false);
    expect(row.config.customSkillDirs[0].js).toContain("resolve('@me/hello-world/package.json')");
    const skill = file(files, path.join('skills', 'hello-world', 'SKILL.md'));
    const frontmatter = YAML.parse(skill.split('---')[1]);
    expect(frontmatter.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(frontmatter.name).toBe('hello-world');
    expect(String(frontmatter.description).length).toBeGreaterThan(0);
  });

  it('agent inserts a preset with a persona', () => {
    const [row] = insertedRows(render('agent'));
    expect(row.name).toBe('@deepseek-ai/dsh-agent-preset');
    expect(row.config.id).toBe('hello-world');
    expect(row.config.plugins[0].name).toBe('@deepseek-ai/dsh-persona');
  });

  it.each(['tool', 'tool-ts'] as const)('%s loads the package itself and peers on dsh-tools only', (variant) => {
    const files = render(variant);
    expect(insertedRows(files)).toEqual([{ id: 'hello-world', name: '@me/hello-world' }]);
    const pkg = JSON.parse(file(files, 'package.json'));
    expect(pkg.peerDependencies).toEqual({ '@deepseek-ai/dsh-tools': PEER_RANGE });
    expect(pkg.devDependencies['@deepseek-ai/dsh-tools']).toBe(PEER_RANGE);
  });

  it('tool index.js is valid JavaScript registering the snake_case tool', async () => {
    const source = file(render('tool'), 'index.js');
    expect(source).toContain("name: 'hello_world'");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-tpl-'));
    try {
      fs.writeFileSync(path.join(dir, 'index.mjs'), source);
      expect((await execa('node', ['--check', path.join(dir, 'index.mjs')], { reject: false })).exitCode).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tool-ts builds to lib/', () => {
    const files = render('tool-ts');
    const pkg = JSON.parse(file(files, 'package.json'));
    expect(pkg.exports['.']).toBe('./lib/index.js');
    expect(pkg.scripts).toEqual({ build: 'tsc', prepare: 'tsc' });
    expect(pkg.devDependencies).toEqual({ '@deepseek-ai/dsh-tools': PEER_RANGE, '@deepseek-ai/cordis': '^4.0.0', typescript: '^6.0.0' });
    expect(file(files, path.join('src', 'index.ts'))).toContain("name: 'hello_world'");
    expect(JSON.parse(file(files, 'tsconfig.json')).compilerOptions.outDir).toBe('lib');
  });

  it('mcp inserts an mcp-client row named after the component', () => {
    const [row] = insertedRows(render('mcp'));
    expect(row.name).toBe('@deepseek-ai/dsh-mcp-client');
    expect(row.config).toMatchObject({ serverName: 'hello-world', transport: 'streamable-http', url: 'http://127.0.0.1:3000/mcp' });
  });
});
