import { describe, it, expect } from 'vitest';
import * as YAML from 'yaml';
import { assertPatchFileArray, renderPatchBlock } from '../../src/patch/patch.js';
import { readMounts, writeMount } from '../../src/patch/mount.js';

const PKG = '@dsh-external/dsh-session-search';
const rows = (content: string) => YAML.parse(content) as Array<Record<string, unknown>>;

describe('plugin mount blocks', () => {
  it('mounts a plugin into a fresh patch file as an insert row, and reads it back', () => {
    const content = writeMount('# header\n[]\n', 'web', 'session-search', PKG);
    assertPatchFileArray(content, 'cordis.patch.yml');
    expect(content.startsWith('# header\n')).toBe(true);
    expect(rows(content)).toEqual([{ insert: [{ id: 'session-search', name: PKG }] }]);
    expect(readMounts(content, 'web')).toEqual({ 'session-search': PKG });
    expect(readMounts(content, 'other')).toEqual({});
  });

  it('puts a new mount before every other entry, so patches that target the row find it', () => {
    const existing = `# header\n- id: user-entry\n  config: {}\n${renderPatchBlock('web', 'session-search', 'session-search', { maxResults: 3 })}\n`;
    const content = writeMount(existing, 'web', 'session-search', PKG);
    assertPatchFileArray(content, 'cordis.patch.yml');
    expect(rows(content).map((row) => row.id ?? 'insert')).toEqual(['insert', 'user-entry', 'session-search']);
    expect(writeMount('[{ id: a }]\n', 'web', 'x', PKG)).toMatch(/plugin=@mount:x[\s\S]*- \{ id: a \}/);
  });

  it('rewrites a mount in place and unmounts it, leaving an empty array', () => {
    const mounted = writeMount('- id: a\n', 'web', 'x', PKG);
    const again = writeMount(`${mounted}- id: b\n`, 'web', 'x', PKG);
    expect(rows(again).map((row) => row.id ?? 'insert')).toEqual(['insert', 'a', 'b']);
    expect(readMounts(writeMount(mounted, 'web', 'x', null), 'web')).toEqual({});
    expect(rows(writeMount(writeMount('[]\n', 'web', 'x', PKG), 'web', 'x', null))).toEqual([]);
  });
});
