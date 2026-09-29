import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EnvironmentPaths } from '../environment/paths.js';
import { parseDshWebUrl } from './web-client.js';

// What `dshenv web start` left running. The URL is the login credential, so the file is readable by the owner only.
export interface DshWebRecord {
  profile: string;
  pid: number;
  url: string;
  logFile: string;
  startedAt: string;
  // Tells this dsh web apart from a later process that reuses its pid.
  leaderStart: string;
}

export function webLogFile(paths: EnvironmentPaths, profile: string): string {
  return path.join(paths.runDir, `${profile}.log`);
}

function recordFile(paths: EnvironmentPaths, profile: string): string {
  return path.join(paths.runDir, `${profile}.json`);
}

function isRecord(value: unknown, profile: string): value is DshWebRecord {
  const record = value as Partial<DshWebRecord> | null;
  return (
    record !== null &&
    typeof record === 'object' &&
    record.profile === profile &&
    Number.isInteger(record.pid) &&
    (record.pid ?? 0) > 0 &&
    typeof record.url === 'string' &&
    typeof record.logFile === 'string' &&
    typeof record.startedAt === 'string' &&
    typeof record.leaderStart === 'string' &&
    validUrl(record.url)
  );
}

function validUrl(url: string): boolean {
  try {
    parseDshWebUrl(url);
    return true;
  } catch {
    return false;
  }
}

// A missing or unreadable record means dshenv started nothing for the profile.
export function readWebRecord(paths: EnvironmentPaths, profile: string): DshWebRecord | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(recordFile(paths, profile), 'utf8'));
    return isRecord(value, profile) ? value : null;
  } catch {
    return null;
  }
}

export function listWebRecords(paths: EnvironmentPaths): DshWebRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(paths.runDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith('.json'))
    .sort()
    .flatMap((name) => readWebRecord(paths, name.slice(0, -'.json'.length)) ?? []);
}

export function writeWebRecord(paths: EnvironmentPaths, record: DshWebRecord): void {
  fs.mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
  const file = recordFile(paths, record.profile);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

export function removeWebRecord(paths: EnvironmentPaths, profile: string): void {
  fs.rmSync(recordFile(paths, profile), { force: true });
}
