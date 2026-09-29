import { describe, it, expect } from 'vitest';
import { renderRuntimeReport } from '../../src/output/render.js';

describe('renderRuntimeReport', () => {
  it('aligns results and aliases, shows detail and hint, and ends with the version note', () => {
    const text = renderRuntimeReport('web', '127.0.0.1:3080', [
      { alias: 'agent-teams', package: '@nanmicoder/dsh-agent-teams', expected: 'enabled', result: 'loaded' },
      { alias: 'foo', package: '@acme/foo', expected: 'enabled', result: 'failed', detail: 'incompatible-version: needs dsh ^0.2' },
      { alias: 'bar', package: '@acme/bar', expected: 'enabled', result: 'not-loaded', hint: 'restart DSH, then run dshenv mark-restarted' },
      { alias: 'baz', package: '@acme/baz', expected: 'enabled', result: 'failed', detail: 'not-bundle', hint: 'restart DSH, then run dshenv mark-restarted' }
    ]);
    expect(text).toBe(
      [
        'Runtime check for profile web (127.0.0.1:3080)',
        '  loaded      agent-teams  @nanmicoder/dsh-agent-teams',
        '  failed      foo          @acme/foo (incompatible-version: needs dsh ^0.2)',
        '  not-loaded  bar          @acme/bar (restart DSH, then run dshenv mark-restarted)',
        '  failed      baz          @acme/baz (not-bundle; restart DSH, then run dshenv mark-restarted)',
        'Versions are not checked: DSH reports the version on disk, not the one loaded in memory.',
        ''
      ].join('\n')
    );
  });

  it('says when the profile declares no plugins', () => {
    expect(renderRuntimeReport('web', '127.0.0.1:3080', [])).toBe('No plugins declared for profile web.\n');
  });
});
