import { describe, it, expect } from 'vitest';
import * as YAML from 'yaml';
import {
  PROFILE_PATCHES_ALIAS,
  containsLocalPath,
  diffProfilePatches,
  digestProfilePatches,
  mergeDshPatches,
  mergeProfilePatches,
  readProfilePatchState,
  removeUnmanagedEntries,
  replaceProfileBlock
} from '../../src/profile-patches/entries.js';
import { applyPatchBlock, assertPatchFileArray } from '../../src/patch/patch.js';

const HEADER = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries.
`;

describe('profile patch entries', () => {
  it('reads entries outside every managed block as unmanaged, including !!js expressions', () => {
    const content = `${HEADER}- id: locale
  name: "@deepseek-ai/dsh-client-locale"
  config:
    preference: zh
- id: expr
  disabled: !!js "env.X === '1'"
`;
    const withPlugin = applyPatchBlock(content, 'web', 'teams', 'teams', { a: 1 });
    const state = readProfilePatchState(withPlugin, 'web');
    expect(state.block).toBeNull();
    expect(state.unmanaged).toEqual([
      { id: 'locale', name: '@deepseek-ai/dsh-client-locale', config: { preference: 'zh' } },
      { id: 'expr', disabled: { __jsExpr: "env.X === '1'" } }
    ]);
  });

  it('round-trips the profile block, with a digest that detects edits made in DSH', () => {
    const entries = [
      { id: 'locale', config: { preference: 'zh' } },
      { id: 'expr', disabled: { __jsExpr: 'true' } }
    ];
    const written = replaceProfileBlock(`${HEADER}[]\n`, 'web', entries);
    assertPatchFileArray(written, 'cordis.patch.yml');
    expect(written).toContain(`# dshenv:begin profile=web plugin=${PROFILE_PATCHES_ALIAS} digest=${digestProfilePatches(entries)}`);
    expect(written).toContain('disabled: !!js true');

    const state = readProfilePatchState(written, 'web');
    expect(state.unmanaged).toEqual([]);
    expect(state.block).toEqual({ entries, digest: digestProfilePatches(entries), isDigestValid: true });

    const edited = readProfilePatchState(written.replace('preference: zh', 'preference: en'), 'web');
    expect(edited.block?.isDigestValid).toBe(false);
    expect(edited.block?.entries[0]).toEqual({ id: 'locale', config: { preference: 'en' } });
  });

  it('drops the block and restores [] when no profile patch is left', () => {
    const written = replaceProfileBlock(`${HEADER}[]\n`, 'web', [{ id: 'a', config: {} }]);
    expect(replaceProfileBlock(written, 'web', [])).toBe(`${HEADER}[]\n`);
  });

  it('removes unmanaged entries but keeps managed blocks and comments', () => {
    const managed = applyPatchBlock(`${HEADER}- id: before\n  config: { a: 1 }\n`, 'web', 'teams', 'teams', { b: 2 });
    const content = `${managed}- id: after
  name: x
  config:
    c: 3
`;
    const cleaned = removeUnmanagedEntries(content);
    expect(cleaned).toContain(HEADER);
    expect(cleaned).toContain('# dshenv:begin profile=web plugin=teams');
    expect(YAML.parse(cleaned)).toEqual([{ id: 'teams', config: { b: 2 } }]);
  });

  it('leaves a file with only comments as an empty array', () => {
    expect(removeUnmanagedEntries(`${HEADER}- id: a\n  config: {}\n`)).toBe(`${HEADER}[]\n`);
    expect(removeUnmanagedEntries(`[{id: a, config: {}}, {id: b, config: {}}]\n`)).toBe('[]\n');
  });

  it('folds entries DSH appended after the block into the block the way DSH composes them', () => {
    const block = [
      { id: 'model', name: 'm', config: { model: 'a' } },
      { id: 'locale', config: { preference: 'zh' } }
    ];
    const unmanaged = [
      { id: 'model', name: 'm', config: { model: 'b' } },
      { insert: [{ id: 'x', name: 'y' }] },
      { id: 'new', config: {} }
    ];
    expect(mergeDshPatches(block, unmanaged)).toEqual([
      { id: 'model', name: 'm', config: { model: 'b' } },
      { id: 'locale', config: { preference: 'zh' } },
      { insert: [{ id: 'x', name: 'y' }] },
      { id: 'new', config: {} }
    ]);
  });

  it('finds machine-local paths anywhere in an entry', () => {
    expect(containsLocalPath({ id: 's', config: { customSkillDirs: ['/home/me/skills'] } })).toBe(true);
    expect(containsLocalPath({ id: 's', config: { dir: '~/skills' } })).toBe(true);
    expect(containsLocalPath({ id: 'm', config: { model: 'MiniMax-M3', url: 'http://127.0.0.1:3000/mcp' } })).toBe(false);
  });

  it('diffs a desired list against a base into overlay entries that merge back to it', () => {
    const base = [
      { id: 'a', config: { v: 1 } },
      { id: 'b', config: { v: 1 } },
      { id: 'c', config: { v: 1 } }
    ];
    const desired = [
      { id: 'a', config: { v: 1 } },
      { id: 'b', config: { v: 2 } },
      { id: 'd', config: { v: 1 } }
    ];
    const overlay = diffProfilePatches(base, desired);
    expect(overlay).toEqual([
      { id: 'b', config: { v: 2 } },
      { id: 'd', config: { v: 1 } },
      { id: 'c', remove: true }
    ]);
    expect(mergeProfilePatches(base, overlay)).toEqual(desired);
  });

  it('ignores an overlay removal of an entry the base no longer has', () => {
    expect(mergeProfilePatches([{ id: 'a', config: {} }], [{ id: 'gone', remove: true }])).toEqual([{ id: 'a', config: {} }]);
  });

  it('writes id and name first in the block whatever order the manifest keeps', () => {
    const written = replaceProfileBlock('[]\n', 'web', [{ config: { a: 1 }, id: 'x', name: 'n' }]);
    expect(written).toContain('- id: x\n  name: n\n  config:');
  });
});
