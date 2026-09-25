export interface RuntimeCapabilityEvidence {
  operationsExport: {
    declared: boolean
    targetExists: boolean
    exportName: string
  }
  liveService: {
    configured: false
    reachable: false
  }
  diagnostics: readonly string[]
}
