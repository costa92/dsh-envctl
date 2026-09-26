import { describe, it, expect } from 'vitest';
import { parseConfigValue, setAtPath, getAtPath } from '../../src/config/config.js';

describe('config helpers', () => {
  it('should parse JSON values and leave plain text as string', () => {
    expect(parseConfigValue('true')).toBe(true);
    expect(parseConfigValue('12')).toBe(12);
    expect(parseConfigValue('"captain"')).toBe('captain');
    expect(parseConfigValue('captain')).toBe('captain');
  });

  it('should set and get nested config paths', () => {
    const next = setAtPath({ taskPlanning: 'off' }, 'nested.key', 'on');
    expect(next.taskPlanning).toBe('off');
    expect(getAtPath(next, 'nested.key')).toBe('on');
  });
});
