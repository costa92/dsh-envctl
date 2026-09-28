import { describe, it, expect } from 'vitest';
import { listTools, locateTool, parseComposedProfile, toolCategory, toolPatch } from '../../src/tools/catalog.js';

// Shaped like `dsh --profile web --dump-config`: tools live in agent presets, the top-level rows are switched off.
const WEB_DUMP = `# == @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: true
- id: timeout-policy
  name: '@deepseek-ai/dsh-tool-call-timeout-policy'
- id: mcp-resources
  name: '@deepseek-ai/dsh-mcp-resources'
- id: agent-preset-registry
  name: '@deepseek-ai/dsh-agent-preset-registry'
  config:
    default: standard
- id: preset-standard
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: standard
    order: 1
    plugins:
      - id: tool-bash
        name: '@deepseek-ai/dsh-tool-bash'
        disabled: !!js process.platform === 'win32'
      - id: tool-web
        name: '@deepseek-ai/dsh-tool-web'
        config:
          fetchMaxOutputChars: 1000
      - id: delegation
        name: cordis:group
        group: true
        config:
          - id: tool-ralph
            name: '@deepseek-ai/dsh-tool-ralph'
            disabled: true
- id: preset-ptc
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: ptc
    plugins:
      - id: tool-web
        name: '@deepseek-ai/dsh-tool-web'
`;

const HEADLESS_DUMP = `- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: !!js process.platform === 'win32'
- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  config:
    fetchMaxOutputChars: 1000
- id: tools
  name: '@deepseek-ai/dsh-tools'
`;

describe('tool catalog', () => {
  it('sorts packages into the categories of the architecture diagram and skips non-tool rows', () => {
    expect(toolCategory('@deepseek-ai/dsh-tool-bash-persistent')).toBe('terminal');
    expect(toolCategory('@deepseek-ai/dsh-tool-str-replace-editor')).toBe('filesystem');
    expect(toolCategory('@deepseek-ai/dsh-tool-subagent-control/list-agents')).toBe('orchestration');
    expect(toolCategory('@deepseek-ai/dsh-plan-mode')).toBe('interaction');
    expect(toolCategory('@deepseek-ai/dsh-plugin-manager/tools')).toBe('extend');
    expect(toolCategory('@deepseek-ai/dsh-experimental-tool-agent-team')).toBe('other');
    expect(toolCategory('@deepseek-ai/dsh-tool-call-timeout-policy')).toBeNull();
    expect(toolCategory('@deepseek-ai/dsh-tool-cordis/host')).toBeNull();
    expect(toolCategory('@deepseek-ai/dsh-tools')).toBeNull();
  });

  it('lists the tools of the default preset and the profile-wide ones, with their switch state', () => {
    const tree = parseComposedProfile(WEB_DUMP);
    const tools = listTools(tree);
    expect(tools.map((tool) => [tool.id, tool.state, tool.location])).toEqual([
      ['mcp-resources', 'on', { kind: 'top' }],
      ['tool-bash', { offWhen: "process.platform === 'win32'" }, { kind: 'preset', entry: 'preset-standard', preset: 'standard' }],
      ['tool-web', 'on', { kind: 'preset', entry: 'preset-standard', preset: 'standard' }],
      ['tool-ralph', 'off', { kind: 'preset', entry: 'preset-standard', preset: 'standard', group: 'delegation' }]
    ]);
    expect(listTools(tree, { preset: 'ptc' }).map((tool) => [tool.id, tool.state])).toEqual([['tool-bash', 'off'], ['mcp-resources', 'on'], ['tool-web', 'on']]);
    expect(listTools(tree, { all: true }).filter((tool) => tool.id === 'tool-bash')).toHaveLength(2);
    expect(listTools(parseComposedProfile(HEADLESS_DUMP)).map((tool) => tool.id)).toEqual(['tool-bash', 'tool-web']);
  });

  it('turns a top-level tool off with a small patch that keeps an existing one', () => {
    const tree = parseComposedProfile(HEADLESS_DUMP);
    const target = locateTool(tree, 'tool-web');
    expect(toolPatch(tree, [], target, { kind: 'disable' })).toEqual({ id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', disabled: true });
    const existing = [{ id: 'tool-web', config: { fetchMaxOutputChars: 5 } }];
    expect(toolPatch(tree, existing, target, { kind: 'enable' })).toEqual({ id: 'tool-web', config: { fetchMaxOutputChars: 5 }, disabled: false });
  });

  it('restates the whole config when setting a key, since a patch replaces it', () => {
    const tree = parseComposedProfile(HEADLESS_DUMP);
    expect(toolPatch(tree, [], locateTool(tree, 'tool-web'), { kind: 'set', path: 'search.maxResults', value: 3 })).toEqual({
      id: 'tool-web',
      name: '@deepseek-ai/dsh-tool-web',
      config: { fetchMaxOutputChars: 1000, search: { maxResults: 3 } }
    });
  });

  it('changes a preset tool by copying the whole preset, keeping !!js values and the edits already declared', () => {
    const tree = parseComposedProfile(WEB_DUMP);
    const ralph = locateTool(tree, 'tool-ralph');
    const enabled = toolPatch(tree, [], ralph, { kind: 'enable' });
    expect(enabled.id).toBe('preset-standard');
    expect(enabled.name).toBe('@deepseek-ai/dsh-agent-preset');
    const plugins = (enabled.config as { plugins: Record<string, unknown>[] }).plugins;
    expect(plugins[0].disabled).toEqual({ __jsExpr: "process.platform === 'win32'" });
    expect((plugins[2].config as Record<string, unknown>[])[0]).toMatchObject({ id: 'tool-ralph', disabled: false });

    const web = toolPatch(tree, [enabled], locateTool(tree, 'tool-web'), { kind: 'disable' });
    const next = (web.config as { plugins: Record<string, unknown>[] }).plugins;
    expect(next[1]).toMatchObject({ id: 'tool-web', disabled: true });
    expect((next[2].config as Record<string, unknown>[])[0]).toMatchObject({ id: 'tool-ralph', disabled: false });
  });

  it('targets the preset asked for, and explains a tool that is not in the composition', () => {
    const tree = parseComposedProfile(WEB_DUMP);
    expect(locateTool(tree, 'tool-web', 'ptc').location).toEqual({ kind: 'preset', entry: 'preset-ptc', preset: 'ptc' });
    expect(locateTool(tree, 'tool-web', 'preset-ptc').location).toMatchObject({ entry: 'preset-ptc' });
    expect(() => locateTool(tree, 'tool-ralph', 'ptc')).toThrow(/not in preset 'ptc'.*standard/);
    expect(() => locateTool(tree, 'tool-lsp')).toThrow(/not part of this profile/);
    expect(() => locateTool(tree, 'tool-web', 'nope')).toThrow(/No agent preset 'nope'.*standard, ptc/);
  });
});
