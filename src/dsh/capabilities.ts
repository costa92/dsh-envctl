import { knownDshFamily } from './version.js';
import type { CapabilityDetail, RuntimeCapabilityEvidence } from './capability-types.js';

const officialOperationsExport = '@deepseek-ai/dsh-plugin-manager/operations';

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
      bundleSelection: { status: 'requires-live-service', source: 'live-service' },
      entryToggle: { status: 'requires-live-service', source: 'live-service' },
      configurationValidation: { status: 'disabled', source: 'static-matrix' },
      environmentMutation: { status: 'disabled', source: 'static-matrix' },
      operationsExport: officialOperationsExport,
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
      reason: 'Official operations export was not verified'
    }
  };
}

export function capabilitiesFor(version: string): DshCapabilities {
  return evaluateCapabilities(version, {
    operationsExport: { declared: false, targetExists: false, exportName: officialOperationsExport },
    liveService: { configured: false, reachable: false },
    diagnostics: []
  });
}
