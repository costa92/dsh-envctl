import { describe, it, expect } from 'vitest';
import {
  checkRuntime,
  parseRuntimeBundles,
  parseRuntimePlugins,
  runtimeExitCode,
  RESTART_HINT,
  type DeclaredPlugin,
  type FiberPhase,
  type RuntimeBundle,
  type RuntimeCheckItem,
  type RuntimePlugin
} from '../../src/runtime/compare.js';
import { DshError } from '../../src/errors.js';

const PKG = '@acme/demo';

const declared = (overrides: Partial<DeclaredPlugin> = {}): DeclaredPlugin => ({
  alias: 'demo',
  package: PKG,
  enabled: true,
  restartRequired: false,
  ...overrides
});

const bundle = (overrides: Partial<RuntimeBundle> = {}): RuntimeBundle => ({
  name: PKG,
  enabled: true,
  installed: true,
  rows: [{ rowId: 'demo', moduleName: PKG, entryId: 'include:demo' }],
  ...overrides
});

const entry = (fiberPhase: FiberPhase, overrides: Partial<RuntimePlugin> = {}): RuntimePlugin => ({
  entryId: 'include:demo',
  moduleName: PKG,
  enabled: true,
  fiberPhase,
  ...overrides
});

const one = (plugin: DeclaredPlugin, bundles: RuntimeBundle[], plugins: RuntimePlugin[]): RuntimeCheckItem =>
  checkRuntime([plugin], bundles, plugins)[0];

describe('checkRuntime for a plugin the manifest enables', () => {
  it('reports loaded when every enabled row is active', () => {
    expect(one(declared(), [bundle()], [entry('active')])).toEqual({
      alias: 'demo',
      package: PKG,
      expected: 'enabled',
      result: 'loaded'
    });
  });

  it('ignores rows the configuration disables', () => {
    const rows = [
      { rowId: 'demo', moduleName: PKG, entryId: 'include:demo' },
      { rowId: 'demo-tools', moduleName: `${PKG}/tools`, entryId: 'include:demo-tools' }
    ];
    const plugins = [entry('active'), entry(null, { entryId: 'include:demo-tools', moduleName: `${PKG}/tools`, enabled: false })];
    expect(one(declared(), [bundle({ rows })], plugins).result).toBe('loaded');
  });

  it('reports missing when the bundle is absent', () => {
    expect(one(declared(), [], []).result).toBe('missing');
  });

  it('reports failed with the management error code and first diagnostic line', () => {
    const item = one(declared(), [bundle({ error: { code: 'incompatible-version', diagnostic: '\nneeds dsh ^0.2\nmore' } })], []);
    expect(item).toMatchObject({ result: 'failed', detail: 'incompatible-version: needs dsh ^0.2' });
  });

  it('reports failed with only the code when there is no diagnostic', () => {
    expect(one(declared(), [bundle({ error: { code: 'not-bundle' } })], []).detail).toBe('not-bundle');
  });

  it('reports failed when an enabled entry failed to load', () => {
    expect(one(declared(), [bundle()], [entry('failed')])).toMatchObject({
      result: 'failed',
      detail: `plugin ${PKG} failed to load`
    });
  });

  it('checks failed before not-loaded', () => {
    expect(one(declared(), [bundle({ enabled: false, error: { code: 'not-bundle' } })], []).result).toBe('failed');
  });

  it('reports not-loaded when the bundle is not selected, restart owed or not', () => {
    expect(one(declared(), [bundle({ enabled: false })], [entry('active')]).result).toBe('not-loaded');
    expect(one(declared({ restartRequired: true }), [bundle({ enabled: false })], [entry('active')]).result).toBe('not-loaded');
  });

  it.each([
    ['a row has no entry id', [bundle({ rows: [{ rowId: 'demo', moduleName: PKG }] })], []],
    ['the entry is not listed', [bundle()], []],
    ['an enabled entry has no fiber', [bundle()], [entry(null)]]
  ])('reports not-loaded when %s and a restart is owed', (_name, bundles, plugins) => {
    expect(one(declared({ restartRequired: true }), bundles, plugins).result).toBe('not-loaded');
  });

  it.each([
    ['a row has no entry id', [bundle({ rows: [{ rowId: 'demo', moduleName: PKG }] })], []],
    ['the entry is not listed', [bundle()], []],
    ['an enabled entry has no fiber', [bundle()], [entry(null)]]
  ])('reports loading when %s and no restart is owed', (_name, bundles, plugins) => {
    expect(one(declared({ restartRequired: false }), bundles, plugins)).toMatchObject({
      result: 'loading',
      detail: 'selected on disk; waiting for DSH to hot-reload it'
    });
  });

  it.each(['pending', 'loading', 'unloading'] as const)('reports loading while an entry is %s', (phase) => {
    expect(one(declared(), [bundle()], [entry(phase)]).result).toBe('loading');
  });

  it('reports unverifiable for a bundle without rows', () => {
    expect(one(declared(), [bundle({ rows: [] })], [])).toMatchObject({
      result: 'unverifiable',
      detail: 'bundle declares no plugin rows'
    });
  });

  it('reports not-loaded rather than unverifiable for an unselected bundle without rows', () => {
    expect(one(declared(), [bundle({ enabled: false, rows: [] })], []).result).toBe('not-loaded');
  });

  it('reports unverifiable when configuration disables every row', () => {
    expect(one(declared(), [bundle()], [entry(null, { enabled: false })])).toMatchObject({
      result: 'unverifiable',
      detail: 'all plugin rows are disabled by configuration'
    });
  });
});

describe('checkRuntime for a plugin the manifest disables', () => {
  const off = declared({ enabled: false });

  it('reports unloaded when no row has a live entry', () => {
    expect(one(off, [bundle({ enabled: false, rows: [{ rowId: 'demo', moduleName: PKG }] })], [])).toEqual({
      alias: 'demo',
      package: PKG,
      expected: 'disabled',
      result: 'unloaded'
    });
  });

  it('reports unloaded when the bundle is absent', () => {
    expect(one(off, [], []).result).toBe('unloaded');
  });

  it('reports still-loaded when an own row has a live entry and the bundle is still selected on disk', () => {
    expect(one(off, [bundle({ enabled: true })], [entry('active')]).result).toBe('still-loaded');
  });

  it('reports still-loaded when an own row has a live entry and a restart is owed', () => {
    expect(one(declared({ enabled: false, restartRequired: true }), [bundle({ enabled: false })], [entry('active')]).result).toBe('still-loaded');
  });

  it('reports loading when an own row has a live entry, deselected on disk, and no restart is owed', () => {
    expect(one(off, [bundle({ enabled: false })], [entry('active')])).toMatchObject({
      result: 'loading',
      detail: 'deselected on disk; waiting for DSH to hot-reload it'
    });
  });

  it('treats an entry without a fiber as unloaded', () => {
    expect(one(off, [bundle({ enabled: false })], [entry(null)]).result).toBe('unloaded');
  });

  it('ignores a row whose id an enabled bundle also declares', () => {
    const base = bundle({ name: '@acme/base', rows: [{ rowId: 'demo', moduleName: PKG, entryId: 'include:demo' }] });
    expect(one(off, [base, bundle({ enabled: false })], [entry('active')]).result).toBe('unloaded');
  });
});

describe('restart hint', () => {
  it('adds the hint when a restart is owed and the plugin is not in the expected state', () => {
    expect(one(declared({ restartRequired: true }), [bundle({ enabled: false })], []).hint).toBe(RESTART_HINT);
  });

  it.each([
    ['loaded', declared({ restartRequired: true }), [bundle()], [entry('active')]],
    ['unloaded', declared({ restartRequired: true, enabled: false }), [], []],
    ['unverifiable', declared({ restartRequired: true }), [bundle({ rows: [] })], []]
  ])('leaves out the hint for %s', (_name, plugin, bundles, plugins) => {
    expect(one(plugin, bundles, plugins).hint).toBeUndefined();
  });
});

describe('runtimeExitCode', () => {
  const item = (result: RuntimeCheckItem['result']): RuntimeCheckItem => ({ alias: 'a', package: 'p', expected: 'enabled', result });

  it('is 0 when everything matches or cannot be verified', () => {
    expect(runtimeExitCode([item('loaded'), item('unloaded'), item('unverifiable')])).toBe(0);
    expect(runtimeExitCode([])).toBe(0);
  });

  it('is 2 while a plugin is still loading', () => {
    expect(runtimeExitCode([item('loaded'), item('loading')])).toBe(2);
  });

  it.each(['missing', 'failed', 'not-loaded', 'still-loaded'] as const)('is 5 for %s, even with loading items', (result) => {
    expect(runtimeExitCode([item('loading'), item(result)])).toBe(5);
  });
});

describe('response parsing', () => {
  it('keeps the fields the check needs and drops the rest', () => {
    const bundles = parseRuntimeBundles(
      [{ name: PKG, version: '1.0.0', enabled: true, installed: true, optional: false, rows: [{ rowId: 'demo', moduleName: PKG, entryId: 'include:demo', meta: {} }], overrides: [] }],
      '127.0.0.1:3080'
    );
    expect(bundles).toEqual([{ name: PKG, version: '1.0.0', enabled: true, installed: true, rows: [{ rowId: 'demo', moduleName: PKG, entryId: 'include:demo' }] }]);
    expect(
      parseRuntimePlugins([{ entryId: 'include:demo', moduleName: PKG, enabled: true, fiberPhase: 'active', patchId: 'demo' }], '127.0.0.1:3080')
    ).toEqual([{ entryId: 'include:demo', moduleName: PKG, enabled: true, fiberPhase: 'active' }]);
  });

  it('rejects a response that does not match with a DshError naming the endpoint', () => {
    expect(() => parseRuntimeBundles([{ name: 1 }], '127.0.0.1:3080')).toThrow(DshError);
    expect(() => parseRuntimePlugins({}, '127.0.0.1:3080')).toThrow(/DSH at 127\.0\.0\.1:3080 answered listPlugins with an unexpected response shape/);
  });
});
