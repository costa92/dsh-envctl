import { z } from 'zod';
import { DshError } from '../errors.js';

export type FiberPhase = 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null;

export interface RuntimeBundle {
  name: string;
  enabled: boolean;
  installed: boolean;
  version?: string;
  error?: { code: string; diagnostic?: string };
  rows: Array<{ rowId: string; moduleName: string; entryId?: string }>;
}

export interface RuntimePlugin {
  entryId: string;
  moduleName: string;
  enabled: boolean;
  fiberPhase: FiberPhase;
}

export interface DeclaredPlugin {
  alias: string;
  package: string;
  enabled: boolean;
  restartRequired: boolean;
  // Loaded through dshenv's insert row rather than the bundle list, since the package is not a DSH bundle.
  mounted?: boolean;
}

export type RuntimeResult =
  | 'loaded'
  | 'unloaded'
  | 'loading'
  | 'unverifiable'
  | 'missing'
  | 'failed'
  | 'not-loaded'
  | 'still-loaded';

export interface RuntimeCheckItem {
  alias: string;
  package: string;
  expected: 'enabled' | 'disabled';
  result: RuntimeResult;
  detail?: string;
  hint?: string;
}

export const RESTART_HINT = 'restart DSH, then run dshenv restarted';

const BundleSchema = z.object({
  name: z.string(),
  enabled: z.boolean(),
  installed: z.boolean(),
  version: z.string().optional(),
  error: z.object({ code: z.string(), diagnostic: z.string().optional() }).optional(),
  rows: z.array(z.object({ rowId: z.string(), moduleName: z.string(), entryId: z.string().optional() }))
});

const PluginSchema = z.object({
  entryId: z.string(),
  moduleName: z.string(),
  enabled: z.boolean(),
  fiberPhase: z.enum(['pending', 'loading', 'active', 'failed', 'unloading']).nullable()
});

function parseList<T>(schema: z.ZodType<T>, value: unknown, method: string, endpoint: string): T[] {
  const parsed = z.array(schema).safeParse(value);
  if (!parsed.success) {
    throw new DshError(`DSH at ${endpoint} answered ${method} with an unexpected response shape`);
  }
  return parsed.data;
}

export function parseRuntimeBundles(value: unknown, endpoint: string): RuntimeBundle[] {
  return parseList(BundleSchema, value, 'listBundles', endpoint);
}

export function parseRuntimePlugins(value: unknown, endpoint: string): RuntimePlugin[] {
  return parseList(PluginSchema, value, 'listPlugins', endpoint);
}

type Outcome = Pick<RuntimeCheckItem, 'result' | 'detail'>;

const TRANSIENT_PHASES: ReadonlySet<FiberPhase> = new Set(['pending', 'loading', 'unloading']);
const BROKEN_RESULTS: ReadonlySet<RuntimeResult> = new Set(['missing', 'failed', 'not-loaded', 'still-loaded']);

function firstLine(text: string): string {
  return text.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? '';
}

function expectLoaded(
  bundle: RuntimeBundle | undefined,
  entries: ReadonlyMap<string, RuntimePlugin>,
  restartRequired: boolean
): Outcome {
  if (!bundle) {
    return { result: 'missing' };
  }
  if (bundle.error) {
    const diagnostic = bundle.error.diagnostic === undefined ? '' : firstLine(bundle.error.diagnostic);
    return { result: 'failed', detail: diagnostic === '' ? bundle.error.code : `${bundle.error.code}: ${diagnostic}` };
  }
  // No entryId is evidence DSH has not hot-reloaded yet; an entryId listPlugins doesn't list
  // is a group row or otherwise unlisted entry, which proves nothing and is skipped like a disabled row.
  const hasLaggingRow = bundle.rows.some((row) => row.entryId === undefined);
  const listedEntries = bundle.rows
    .map((row) => (row.entryId === undefined ? undefined : entries.get(row.entryId)))
    .filter((found): found is RuntimePlugin => found !== undefined);
  // Rows the configuration switches off are meant to stay unloaded, so they say nothing about this bundle.
  const live = listedEntries.filter((found) => found.enabled);
  const failed = live.find((found) => found.fiberPhase === 'failed');
  if (failed) {
    return { result: 'failed', detail: `plugin ${failed.moduleName} failed to load` };
  }
  if (!bundle.enabled) {
    return { result: 'not-loaded' };
  }
  if (hasLaggingRow || live.some((found) => found.fiberPhase === null)) {
    // Right after apply, disk selection can outrun DSH's Loader, which only catches up once files settle (~2s).
    return restartRequired
      ? { result: 'not-loaded' }
      : { result: 'loading', detail: 'selected on disk; waiting for DSH to hot-reload it' };
  }
  // Cordis keeps a fiber pending until every injected service exists, so a lasting pending means a missing service.
  const pending = live.find((found) => found.fiberPhase === 'pending');
  if (pending) {
    return { result: 'loading', detail: `plugin ${pending.moduleName} is waiting for services it injects` };
  }
  if (live.some((found) => TRANSIENT_PHASES.has(found.fiberPhase))) {
    return { result: 'loading' };
  }
  if (bundle.rows.length === 0) {
    return { result: 'unverifiable', detail: 'bundle declares no plugin rows' };
  }
  if (live.length === 0) {
    return { result: 'unverifiable', detail: 'no plugin rows are listed as enabled by DSH' };
  }
  return { result: 'loaded' };
}

function expectUnloaded(
  bundle: RuntimeBundle | undefined,
  bundles: RuntimeBundle[],
  entries: ReadonlyMap<string, RuntimePlugin>,
  restartRequired: boolean
): Outcome {
  if (!bundle) {
    return { result: 'unloaded' };
  }
  // A row id another selected bundle declares resolves to that bundle's entry, not proof this one is still loaded.
  const shared = new Set(
    bundles.filter((other) => other !== bundle && other.enabled).flatMap((other) => other.rows.map((row) => row.rowId))
  );
  const stillLive = bundle.rows.some(
    (row) => !shared.has(row.rowId) && row.entryId !== undefined && (entries.get(row.entryId)?.fiberPhase ?? null) !== null
  );
  if (!stillLive) {
    return { result: 'unloaded' };
  }
  // Right after apply, DSH's Loader can lag the disk deselection until files settle (~2s).
  if (!bundle.enabled && !restartRequired) {
    return { result: 'loading', detail: 'deselected on disk; waiting for DSH to hot-reload it' };
  }
  return { result: 'still-loaded' };
}

// A mounted plugin is in no bundle (DSH lists its package as not-bundle); its module's entries say how it runs.
function checkMounted(plugin: DeclaredPlugin, plugins: RuntimePlugin[]): Outcome {
  const live = plugins.filter((found) => found.moduleName === plugin.package && found.enabled && found.fiberPhase !== null);
  if (!plugin.enabled) {
    if (live.length === 0) {
      return { result: 'unloaded' };
    }
    return plugin.restartRequired ? { result: 'still-loaded' } : { result: 'loading', detail: 'unmounted on disk; waiting for DSH to hot-reload it' };
  }
  const failed = live.find((found) => found.fiberPhase === 'failed');
  if (failed) {
    return { result: 'failed', detail: `plugin ${failed.moduleName} failed to load` };
  }
  if (live.length === 0) {
    return plugin.restartRequired ? { result: 'not-loaded' } : { result: 'loading', detail: 'mounted on disk; waiting for DSH to hot-reload it' };
  }
  const pending = live.find((found) => found.fiberPhase === 'pending');
  if (pending) {
    return { result: 'loading', detail: `plugin ${pending.moduleName} is waiting for services it injects` };
  }
  return live.some((found) => TRANSIENT_PHASES.has(found.fiberPhase)) ? { result: 'loading' } : { result: 'loaded' };
}

export function checkRuntime(
  declared: DeclaredPlugin[],
  bundles: RuntimeBundle[],
  plugins: RuntimePlugin[]
): RuntimeCheckItem[] {
  const entries = new Map(plugins.map((plugin) => [plugin.entryId, plugin]));
  return declared.map((plugin) => {
    const bundle = bundles.find((candidate) => candidate.name === plugin.package);
    const outcome = plugin.mounted
      ? checkMounted(plugin, plugins)
      : plugin.enabled
        ? expectLoaded(bundle, entries, plugin.restartRequired)
        : expectUnloaded(bundle, bundles, entries, plugin.restartRequired);
    const item: RuntimeCheckItem = {
      alias: plugin.alias,
      package: plugin.package,
      expected: plugin.enabled ? 'enabled' : 'disabled',
      result: outcome.result
    };
    if (outcome.detail !== undefined) {
      item.detail = outcome.detail;
    }
    if (plugin.restartRequired && outcome.result !== 'unloaded') {
      item.hint = RESTART_HINT;
    }
    return item;
  });
}

export function runtimeExitCode(items: RuntimeCheckItem[]): number {
  if (items.some((item) => BROKEN_RESULTS.has(item.result))) {
    return 5;
  }
  return items.some((item) => item.result === 'loading') ? 2 : 0;
}
