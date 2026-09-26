import type { EnvironmentPlan, PlanOperation, EnvironmentStatusSummary } from '../planner/plan.js';
import type { DshCapabilities } from '../dsh/capabilities.js';

export function renderPlan(plan: EnvironmentPlan): string {
  const lines: string[] = [];

  if (!plan.hasChanges && plan.unmanaged.length === 0) {
    return 'Environment is in sync with manifest. No changes planned.\n';
  }

  if (plan.operations.length > 0) {
    lines.push('Planned operations:');
    for (const op of plan.operations) {
      const symbol = getOpSymbol(op.kind);
      let details = '';
      if (op.kind === 'install') {
        details = `-> ${op.targetVersion ?? 'latest'}`;
      } else if (op.kind === 'update') {
        details = `${op.currentVersion ?? '?'} -> ${op.targetVersion ?? '?'}`;
      } else if (op.kind === 'enable' || op.kind === 'disable') {
        details = `enabled: ${op.targetEnabled}`;
      } else if (op.kind === 'remove') {
        details = 'uninstall';
      } else if (op.kind === 'blocked') {
        details = `[BLOCKED: ${op.blockedReason ?? op.reason}]`;
      }
      lines.push(`  ${symbol} [${op.profile}] ${op.package} (${op.alias}) ${details}`.trimEnd());
      if (op.reason) {
        lines.push(`      Reason: ${op.reason}`);
      }
    }
  }

  if (plan.unmanaged.length > 0) {
    lines.push('');
    lines.push('Unmanaged plugins (not in manifest):');
    for (const u of plan.unmanaged) {
      lines.push(`  ? [${u.profile}] ${u.package}`);
    }
  }

  return lines.join('\n') + '\n';
}

function getOpSymbol(kind: string): string {
  switch (kind) {
    case 'install':
      return '+';
    case 'update':
      return '~';
    case 'enable':
      return '^';
    case 'disable':
      return 'v';
    case 'remove':
      return '-';
    case 'configure':
      return '*';
    case 'blocked':
      return '!';
    default:
      return ' ';
  }
}

export function renderStatus(status: EnvironmentStatusSummary): string {
  const lines: string[] = [];
  lines.push(`Environment Status: ${status.status}`);
  lines.push(`Profiles monitored: ${status.profilesCount}`);
  lines.push(`Pending operations: ${status.hasChanges ? 'Yes' : 'None'}`);

  if (status.hasChanges) {
    lines.push('Operation breakdown:');
    for (const [kind, count] of Object.entries(status.operationCounts)) {
      if (count > 0) {
        lines.push(`  - ${kind}: ${count}`);
      }
    }
  }

  if (status.unmanagedCount > 0) {
    lines.push(`Unmanaged plugins: ${status.unmanagedCount}`);
  }

  return lines.join('\n') + '\n';
}

export interface DoctorReport {
  runtime: {
    command: string;
    version: string;
    discoverySupported: boolean;
    mutationsSupported: boolean;
    capabilities: DshCapabilities;
  };
  paths: {
    home: string;
    managerDir: string;
    manifestExists: boolean;
    lockExists: boolean;
    stateExists: boolean;
  };
}

export function renderDoctor(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push('=== DSH Environment Doctor ===');
  lines.push(`DSH Runtime Version: ${report.runtime.version}`);
  lines.push(`DSH Command: ${report.runtime.command}`);
  lines.push(`Discovery Capability: ${report.runtime.discoverySupported ? 'Supported (✓)' : 'Unsupported (✗)'}`);
  lines.push(`Mutation Capability: ${report.runtime.mutationsSupported ? 'Supported (✓)' : 'Not enabled in prototype (read-only mode)'}`);
  lines.push('');
  lines.push('Capability details:');
  for (const name of [
    'discovery',
    'packageOperations',
    'bundleSelection',
    'entryToggle',
    'configurationValidation',
    'environmentMutation'
  ] as const) {
    const detail = report.runtime.capabilities[name];
    lines.push(`  ${name}: ${detail.status} (source: ${detail.source}; reason: ${detail.reason ?? 'none'})`);
  }
  lines.push('');
  lines.push('Paths:');
  lines.push(`  Home: ${report.paths.home}`);
  lines.push(`  Manager Dir: ${report.paths.managerDir}`);
  lines.push(`  Manifest: ${report.paths.manifestExists ? 'Found' : 'Not created'}`);
  lines.push(`  Lockfile: ${report.paths.lockExists ? 'Found' : 'Not created'}`);
  lines.push(`  State: ${report.paths.stateExists ? 'Found' : 'Not created'}`);

  return lines.join('\n') + '\n';
}
