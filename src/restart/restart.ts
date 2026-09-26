import * as fs from 'node:fs';
import type { EnvironmentPaths } from '../environment/paths.js';
import { ValidationError } from '../errors.js';
import { writeAtomic } from '../io/atomic-file.js';
import { withEnvironmentLock } from '../io/lock.js';
import { readEnvironmentInventory } from '../inventory/profile-reader.js';
import { loadState, serializeState } from '../manifest/files.js';

export interface RestartedResult {
  cleared: Array<{ profile: string; package: string }>;
}

// dshenv cannot observe a DSH restart, so the user confirms it; entries of plugins that are gone are dropped.
export async function markRestarted(paths: EnvironmentPaths, profileName?: string): Promise<RestartedResult> {
  return withEnvironmentLock(paths, async () => {
    if (!fs.existsSync(paths.stateFile)) {
      throw new ValidationError(`State file not found: ${paths.stateFile}`);
    }
    const state = loadState(fs.readFileSync(paths.stateFile, 'utf8'));
    const inventory = await readEnvironmentInventory(paths);
    const now = new Date().toISOString();
    const cleared: RestartedResult['cleared'] = [];

    for (const [profile, entry] of Object.entries(state.profiles)) {
      if (profileName && profile !== profileName) continue;
      for (const [pkg, plugin] of Object.entries(entry.plugins)) {
        if (plugin.status !== 'restart-required') continue;
        cleared.push({ profile, package: pkg });
        if (inventory.profiles[profile]?.plugins[pkg]?.installed) {
          entry.plugins[pkg] = { ...plugin, status: 'healthy', lastVerified: now };
        } else {
          delete entry.plugins[pkg];
        }
      }
    }

    if (cleared.length > 0) {
      await writeAtomic(paths.stateFile, serializeState(state), 'overwrite');
    }
    return { cleared };
  });
}
