import { execa } from 'execa';
import { parseDocument, type ScalarTag } from 'yaml';
import type { CommandSpec } from './command.js';

export type HmrStatus = { state: 'on' } | { state: 'off' } | { state: 'unknown'; reason: string };

export interface ProbeHmrOptions {
  command: CommandSpec | null;
  dshHome: string;
  timeoutMs?: number;
}

export const HMR_PROBE_TIMEOUT_MS = 15_000;

// The default bundle ships the hmr row as `disabled: !!js "!ctx.get('profileContext')"`.
const PROFILE_CONTEXT_EXPRESSION = "!ctx.get('profileContext')";

class JsExpression {
  constructor(readonly source: string) {}
}

// --dump-config prints cordis `!!js` expressions; keep them as opaque values instead of failing the parse.
const jsTag: ScalarTag = {
  tag: 'tag:yaml.org,2002:js',
  resolve: (source: string) => new JsExpression(source)
};

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isProfileContextExpression(source: string): boolean {
  return source.replace(/\s+/g, '').replace(/["`]/g, "'") === PROFILE_CONTEXT_EXPRESSION;
}

export function parseHmrFromDump(yaml: string): HmrStatus {
  const doc = parseDocument(yaml, { customTags: [jsTag] });
  if (doc.errors.length > 0) {
    return { state: 'unknown', reason: firstLine(doc.errors[0].message) };
  }
  const rows: unknown = doc.toJS();
  if (!Array.isArray(rows)) {
    return { state: 'unknown', reason: 'dump-config output is not a list of plugin rows' };
  }
  const row = rows.find((candidate): candidate is Record<string, unknown> => isRecord(candidate) && candidate.id === 'hmr');
  if (!row) {
    return { state: 'off' };
  }
  if (!('disabled' in row) || row.disabled === false) {
    return { state: 'on' };
  }
  if (row.disabled === true) {
    return { state: 'off' };
  }
  // dshenv only manages profile-scoped runs, where profileContext is always set.
  if (row.disabled instanceof JsExpression && isProfileContextExpression(row.disabled.source)) {
    return { state: 'on' };
  }
  return { state: 'unknown', reason: 'unrecognized hmr disabled value' };
}

export async function probeProfileHmr(profile: string, options: ProbeHmrOptions): Promise<HmrStatus> {
  const { command } = options;
  if (!command) {
    return { state: 'unknown', reason: 'DSH CLI was not found' };
  }
  const timeoutMs = options.timeoutMs ?? HMR_PROBE_TIMEOUT_MS;
  const result = await execa(command.file, [...command.args, '--profile', profile, '--dump-config'], {
    cwd: command.cwd,
    env: { ...process.env, DSH_HOME: options.dshHome },
    shell: false,
    reject: false,
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.timedOut) {
    return { state: 'unknown', reason: `dsh --dump-config timed out after ${timeoutMs} ms` };
  }
  if (result.failed) {
    const detail = firstLine(String(result.stderr ?? '')) || firstLine(result.shortMessage ?? '');
    return { state: 'unknown', reason: detail || `dsh --dump-config exited with code ${String(result.exitCode)}` };
  }
  return parseHmrFromDump(String(result.stdout));
}
