import { isProfileOperation, type EnvironmentPlan, type ProfileOperation } from '../planner/plan.js';
import { PROFILE_PATCHES_ALIAS } from '../profile-patches/entries.js';
import type { HmrStatus } from '../dsh/hmr.js';

export type RestartReason = 'hmr-on' | 'package-update' | 'hmr-off' | 'hmr-unknown';
export type RestartOperationKind = 'install' | 'update' | 'enable' | 'disable' | 'configure' | 'remove';

export interface RestartItem {
  profile: string;
  package: string;
  kind: RestartOperationKind;
  reason: RestartReason;
  detail?: string;
}

export interface RestartSummary {
  notRequired: RestartItem[];
  required: RestartItem[];
}

const RESTART_KINDS: ReadonlySet<string> = new Set(['install', 'update', 'enable', 'disable', 'configure', 'remove']);

function isRestartKind(kind: string): kind is RestartOperationKind {
  return RESTART_KINDS.has(kind);
}

// Profiles whose operations need an HMR verdict, in plan order.
export function profilesToProbe(plan: EnvironmentPlan): string[] {
  return [...new Set(plan.operations.filter(isProfileOperation).filter((op) => isRestartKind(op.kind)).map((op) => op.profile))];
}

// Restart items name profile patches by their block alias.
export function restartPackage(operation: ProfileOperation): string {
  return operation.resource === 'profile-patch' ? PROFILE_PATCHES_ALIAS : operation.package;
}

export function restartItemFor(operation: ProfileOperation, hmr: HmrStatus): RestartItem | null {
  if (!isRestartKind(operation.kind)) {
    return null;
  }
  const base = { profile: operation.profile, package: restartPackage(operation), kind: operation.kind };
  // HMR only re-composes the bundle list; an upgraded package keeps its old module in memory.
  if (operation.kind === 'update') {
    return { ...base, reason: 'package-update' };
  }
  switch (hmr.state) {
    case 'on':
      return { ...base, reason: 'hmr-on' };
    case 'off':
      return { ...base, reason: 'hmr-off' };
    case 'unknown':
      return { ...base, reason: 'hmr-unknown', detail: hmr.reason };
  }
}

export function buildRestartSummary(
  plan: EnvironmentPlan,
  hmrByProfile: ReadonlyMap<string, HmrStatus>
): RestartSummary {
  const summary: RestartSummary = { notRequired: [], required: [] };
  for (const operation of plan.operations.filter(isProfileOperation)) {
    const hmr = hmrByProfile.get(operation.profile) ?? { state: 'unknown', reason: 'hot reload was not probed' };
    const item = restartItemFor(operation, hmr);
    if (!item) {
      continue;
    }
    (item.reason === 'hmr-on' ? summary.notRequired : summary.required).push(item);
  }
  return summary;
}

export function describeRestartReason(item: RestartItem): string {
  switch (item.reason) {
    case 'hmr-on':
      return 'hot reloaded';
    case 'package-update':
      return 'package updates are not hot-reloaded';
    case 'hmr-off':
      return `hot reload is off for profile ${item.profile}`;
    case 'hmr-unknown':
      return `hot reload state of profile ${item.profile} is unknown: ${item.detail ?? 'no detail'}`;
  }
}
