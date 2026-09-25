export type CapabilityStatus = 'available' | 'requires-live-service' | 'disabled';

export type CapabilitySource =
  | 'dshenv'
  | 'operations-export'
  | 'live-service'
  | 'static-matrix'
  | 'unknown-version';

export interface CapabilityDetail {
  status: CapabilityStatus;
  source: CapabilitySource;
  reason?: string;
}

export interface RuntimeCapabilityEvidence {
  operationsExport: {
    declared: boolean
    targetExists: boolean
    exportName: string
  }
  liveService: {
    configured: boolean
    reachable: boolean
  }
  diagnostics: readonly string[]
}
