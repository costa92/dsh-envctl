import { knownDshFamily } from './version.js';
import type { CapabilityDetail, RuntimeCapabilityEvidence } from './capability-types.js';
import { OFFICIAL_OPERATIONS_EXPORT } from './constants.js';

const liveServiceReason = 'Requires an explicitly configured, authenticated live service adapter; Phase 2A does not enable live service operations';

// Only these fixed messages may be derived from probe diagnostics; never echo unknown evidence.
const operationsReasons = new Map<string, string>([
  ['HARNESS_SOURCE_UNAVAILABLE', 'Harness source is unavailable; provide an explicit --harness-source to verify official operations'],
  ['PACKAGE_MANIFEST_MISSING', 'Plugin manager manifest is missing; check the harness source installation'],
  ['PACKAGE_MANIFEST_NOT_REGULAR', 'Plugin manager manifest is not a verified regular file; check the harness source installation'],
  ['PACKAGE_MANIFEST_TOO_LARGE', 'Plugin manager manifest exceeds the size limit; check the harness source installation'],
  ['OPERATIONS_EXPORT_MISSING', 'Official operations export is not declared; use a supported harness source installation'],
  ['EXPORT_TARGET_OUTSIDE_PACKAGE', 'Official operations target escapes the package; check the harness source installation'],
  ['EXPORT_TARGET_MISSING', 'Official operations target is missing or not a verified regular file; build or repair the harness source installation']
]);

export interface DshCapabilities {
  discovery: CapabilityDetail;
  packageOperations: CapabilityDetail;
  bundleSelection: CapabilityDetail;
  entryToggle: CapabilityDetail;
  configurationValidation: CapabilityDetail;
  environmentMutation: CapabilityDetail;
  operationsExport: string | null;
  mutations: false;
}

export function capabilityTemplateFor(version: string): DshCapabilities {
  if (knownDshFamily(version) === '0.1.7') {
    return {
      discovery: { status: 'available', source: 'dshenv' },
      packageOperations: { status: 'available', source: 'operations-export' },
      bundleSelection: { status: 'requires-live-service', source: 'live-service', reason: liveServiceReason },
      entryToggle: { status: 'requires-live-service', source: 'live-service', reason: liveServiceReason },
      configurationValidation: {
        status: 'disabled', source: 'static-matrix',
        reason: 'Configuration validation is disabled in Phase 2A; a verified validation adapter is required before applying changes'
      },
      environmentMutation: {
        status: 'disabled', source: 'dshenv',
        reason: 'Environment mutation is disabled in Phase 2A; ownership and transaction safeguards are required before applying changes'
      },
      operationsExport: OFFICIAL_OPERATIONS_EXPORT,
      mutations: false
    };
  }

  const unsupported = (): CapabilityDetail => ({
    status: 'disabled',
    source: 'unknown-version',
    reason: 'Unsupported DSH version'
  });
  return {
    discovery: unsupported(),
    packageOperations: unsupported(),
    bundleSelection: unsupported(),
    entryToggle: unsupported(),
    configurationValidation: unsupported(),
    environmentMutation: unsupported(),
    operationsExport: null,
    mutations: false
  };
}

export function evaluateCapabilities(
  version: string,
  evidence: RuntimeCapabilityEvidence
): DshCapabilities {
  const template = capabilityTemplateFor(version);
  if (template.packageOperations.status !== 'available') return template;

  const exportEvidence = evidence.operationsExport;
  if (
    exportEvidence.declared &&
    exportEvidence.targetExists &&
    exportEvidence.exportName === template.operationsExport
  ) {
    return template;
  }

  return {
    ...template,
    packageOperations: {
      status: 'disabled',
      source: 'operations-export',
      reason: evidence.diagnostics.map(diagnostic => operationsReasons.get(diagnostic)).find(reason => reason !== undefined)
        ?? 'Official operations export was not verified'
    }
  };
}

export function capabilitiesFor(version: string): DshCapabilities {
  return evaluateCapabilities(version, {
    operationsExport: { declared: false, targetExists: false, exportName: OFFICIAL_OPERATIONS_EXPORT },
    liveService: { configured: false, reachable: false },
    diagnostics: []
  });
}
