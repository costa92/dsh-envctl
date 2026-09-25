import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EnvironmentPaths } from '../environment/paths.js';

export interface JournalEntry {
  operationId: string;
  type: string;
  timestamp: string;
  details?: Record<string, unknown>;
}

export async function appendJournalEntry(
  paths: EnvironmentPaths,
  entry: JournalEntry
): Promise<void> {
  await fs.promises.mkdir(paths.logsDir, { recursive: true });
  const logFile = path.join(paths.logsDir, 'journal.jsonl');
  const line = JSON.stringify(entry) + '\n';
  await fs.promises.appendFile(logFile, line, 'utf8');
}

export async function readJournalEntries(
  paths: EnvironmentPaths
): Promise<JournalEntry[]> {
  const logFile = path.join(paths.logsDir, 'journal.jsonl');
  if (!fs.existsSync(logFile)) {
    return [];
  }
  const content = await fs.promises.readFile(logFile, 'utf8');
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  const entries: JournalEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // ignore corrupted lines
    }
  }
  return entries;
}
