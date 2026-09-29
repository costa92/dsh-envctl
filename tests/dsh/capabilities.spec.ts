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
  it.each([
    ['HARNESS_SOURCE_UNAVAILABLE', 'Harness source is unavailable; provide an explicit --harness-source to verify official operations'],
    ['PACKAGE_MANIFEST_MISSING', 'Plugin manager manifest is missing; check the harness source installation'],
    ['PACKAGE_MANIFEST_NOT_REGULAR', 'Plugin manager manifest is not a verified regular file; check the harness source installation'],
    ['PACKAGE_MANIFEST_TOO_LARGE', 'Plugin manager manifest exceeds the size limit; check the harness source installation'],
    ['OPERATIONS_EXPORT_MISSING', 'Official operations export is not declared; use a supported harness source installation'],
    ['EXPORT_TARGET_OUTSIDE_PACKAGE', 'Official operations target escapes the package; check the harness source installation'],
    ['EXPORT_TARGET_MISSING', 'Official operations target is missing or not a verified regular file; build or repair the harness source installation'],
  ])('maps safe diagnostic %s to an actionable package reason', (diagnostic, reason) => {
    const caps = evaluateCapabilities('0.1.7', evidence({
      operationsExport: { declared: false, targetExists: false, exportName: officialExport },
      diagnostics: ['Authorization: Bearer doctor-secret /private/source', diagnostic, 'LIVE_SERVICE_NOT_CONFIGURED']
    }));
    expect(caps.packageOperations).toEqual({ status: 'disabled', source: 'operations-export', reason });
    expect(JSON.stringify(caps)).not.toMatch(/doctor-secret|Authorization|\/private/);
    expect(caps.mutations).toBe(false);
  });

  it('uses a fixed package diagnostic when evidence contains only untrusted text', () => {
    const caps = evaluateCapabilities('0.1.7', evidence({
      operationsExport: { declared: false, targetExists: false, exportName: officialExport },
      diagnostics: ['Authorization: Bearer doctor-secret /private/source', 'toString', '__proto__']
    }));
    expect(caps.packageOperations.reason).toBe('Official operations export was not verified');
    expect(JSON.stringify(caps)).not.toMatch(/doctor-secret|Authorization|\/private/);
  });

  it('explains every unavailable capability without promoting it', () => {
    const caps = evaluateCapabilities('0.1.7', evidence({ liveService: { configured: true, reachable: true } }));
    const liveReason = 'Requires an explicitly configured, authenticated live service adapter; dshenv has none, so apply edits Profile bundles instead';
    expect(caps.bundleSelection).toEqual({ status: 'requires-live-service', source: 'live-service', reason: liveReason });
    expect(caps.entryToggle).toEqual({ status: 'requires-live-service', source: 'live-service', reason: liveReason });
    expect(caps.configurationValidation).toEqual({
      status: 'disabled', source: 'static-matrix',
      reason: 'No verified DSH configuration validation adapter; dshenv only checks managed patch digests, not plugin config schemas'
    });
    expect(caps.environmentMutation).toEqual({
      status: 'disabled', source: 'dshenv',
      reason: 'General environment mutation is not exposed; apply performs only planned install/update/enable/disable/remove/configure steps'
    });
    expect(caps.mutations).toBe(false);
  });
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
    expect(caps.packageOperations.reason).toMatch(/operations/);
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
