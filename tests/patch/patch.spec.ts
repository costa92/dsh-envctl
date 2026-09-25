import { describe, it, expect } from 'vitest';
import {
  computePatchDigest,
  renderPatchBlock,
  applyPatchBlock,
  removePatchBlock,
  extractManagedPatches
} from '../../src/patch/patch.js';

describe('Managed Patch Block Manager', () => {
  const sampleConfig = {
    taskPlanning: 'captain',
    maxIterations: 10
  };

  it('should compute deterministic patch digest', () => {
    const digest1 = computePatchDigest(sampleConfig);
    const digest2 = computePatchDigest({ maxIterations: 10, taskPlanning: 'captain' });
    expect(digest1).toBe(digest2);
    expect(digest1).toHaveLength(64);
  });

  it('should render well-formed patch block with digest marker', () => {
    const block = renderPatchBlock('web', 'agent-teams', 'agent-teams', sampleConfig);
    expect(block).toContain('# dshenv:begin profile=web plugin=agent-teams digest=');
    expect(block).toContain('- id: agent-teams');
    expect(block).toContain('# dshenv:end profile=web plugin=agent-teams');
  });

  it('should insert patch block and preserve external file content', () => {
    const originalFile = `# Header comment
unrelated_setting: true

# Another block
`;
    const updated = applyPatchBlock(originalFile, 'web', 'agent-teams', 'agent-teams', sampleConfig);
    expect(updated).toContain('# Header comment');
    expect(updated).toContain('unrelated_setting: true');
    expect(updated).toContain('# dshenv:begin profile=web plugin=agent-teams');
    expect(updated).toContain('# dshenv:end profile=web plugin=agent-teams');
  });

  it('should update existing patch block without modifying surrounding text', () => {
    const originalFile = `prefix: true
# dshenv:begin profile=web plugin=agent-teams digest=old
- id: agent-teams
  config:
    oldKey: true
# dshenv:end profile=web plugin=agent-teams
suffix: true
`;
    const updated = applyPatchBlock(originalFile, 'web', 'agent-teams', 'agent-teams', sampleConfig);
    expect(updated).toContain('prefix: true');
    expect(updated).toContain('suffix: true');
    expect(updated).not.toContain('oldKey: true');
    expect(updated).toContain('taskPlanning: captain');
  });

  it('should remove patch block cleanly and preserve outside content', () => {
    const fileWithBlock = `prefix: true
# dshenv:begin profile=web plugin=agent-teams digest=xyz
- id: agent-teams
  config:
    taskPlanning: captain
# dshenv:end profile=web plugin=agent-teams
suffix: true
`;
    const cleaned = removePatchBlock(fileWithBlock, 'web', 'agent-teams');
    expect(cleaned).toContain('prefix: true');
    expect(cleaned).toContain('suffix: true');
    expect(cleaned).not.toContain('dshenv:begin');
    expect(cleaned).not.toContain('agent-teams');
  });

  it('should extract managed patches and verify digests', () => {
    const fileContent = `
# dshenv:begin profile=web plugin=agent-teams digest=${computePatchDigest(sampleConfig)}
- id: agent-teams
  config:
    taskPlanning: captain
    maxIterations: 10
# dshenv:end profile=web plugin=agent-teams
`;
    const patches = extractManagedPatches(fileContent, 'web');
    expect(patches).toHaveLength(1);
    expect(patches[0].plugin).toBe('agent-teams');
    expect(patches[0].isDigestValid).toBe(true);
    expect(patches[0].config).toEqual(sampleConfig);
  });
});
