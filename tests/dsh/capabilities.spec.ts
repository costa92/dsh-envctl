import { describe, expect, it } from 'vitest';
import {
  capabilityTemplateFor,
  evaluateCapabilities,
  type RuntimeCapabilityEvidence
} from '../../src/dsh/index.js';

const officialExport = '@deepseek-ai/dsh-plugin-manager/operations';

function evidence(overrides: Partial<RuntimeCapabilityEvidence> = {}): RuntimeCapabilityEvidence {
  return {
    operationsExport: { declared: true, targetExists: true, exportName: officialExport },
    liveService: { configured: false, reachable: false },
    diagnostics: [],
    ...overrides
  };
}

describe('capabilityTemplateFor', () => {
  it('describes the static 0.1.7 capability boundaries', () => {
    const template = capabilityTemplateFor('0.1.7-rc.2');
    expect(template.discovery).toMatchObject({ status: 'available', source: 'dshenv' });
    expect(template.packageOperations).toMatchObject({ status: 'available', source: 'operations-export' });
    expect(template.bundleSelection).toMatchObject({ status: 'requires-live-service', source: 'live-service' });
    expect(template.entryToggle).toMatchObject({ status: 'requires-live-service', source: 'live-service' });
    expect(template.configurationValidation.status).toBe('disabled');
    expect(template.environmentMutation).toMatchObject({ status: 'disabled', source: 'dshenv' });
    expect(template.operationsExport).toBe(officialExport);
    expect(template.mutations).toBe(false);
  });
});

describe('evaluateCapabilities', () => {
  it('keeps the known family within the static matrix when export evidence is present', () => {
    const caps = evaluateCapabilities('0.1.7-rc.2', evidence());
    expect(caps.discovery.status).toBe('available');
    expect(caps.packageOperations.status).toBe('available');
    expect(caps.bundleSelection.status).toBe('requires-live-service');
    expect(caps.entryToggle.status).toBe('requires-live-service');
    expect(caps.configurationValidation.status).toBe('disabled');
    expect(caps.environmentMutation.status).toBe('disabled');
    expect(caps.mutations).toBe(false);
  });

  it.each([
    { declared: false, targetExists: true, exportName: officialExport },
    { declared: true, targetExists: false, exportName: officialExport },
    { declared: true, targetExists: true, exportName: 'unrelated/operations' }
  ])('disables package operations without matching usable export evidence: %j', operationsExport => {
    const caps = evaluateCapabilities('0.1.7', evidence({ operationsExport }));
    expect(caps.packageOperations.status).toBe('disabled');
    expect(caps.packageOperations.source).toBe('operations-export');
    expect(caps.packageOperations.reason).toBeTruthy();
  });

  it.each(['0.0.1', '0.1.70', 'v0.1.7'])('disables every capability for unrecognized version %s', version => {
    const caps = evaluateCapabilities(version, evidence());
    for (const capability of [
      caps.discovery,
      caps.packageOperations,
      caps.bundleSelection,
      caps.entryToggle,
      caps.configurationValidation,
      caps.environmentMutation
    ]) {
      expect(capability.status).toBe('disabled');
    }
    expect(caps.operationsExport).toBeNull();
    expect(caps.mutations).toBe(false);
  });

  it('does not promote mutation when a live service is reachable', () => {
    const caps = evaluateCapabilities('0.1.7', evidence({
      liveService: { configured: true, reachable: true }
    }));
    expect(caps.bundleSelection.status).toBe('requires-live-service');
    expect(caps.entryToggle.status).toBe('requires-live-service');
    expect(caps.environmentMutation.status).toBe('disabled');
    expect(caps.mutations).toBe(false);
  });
});
