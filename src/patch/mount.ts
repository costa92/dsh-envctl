import * as YAML from 'yaml';
import { appendBlocks, flowArrayAsBlock, splicePluginBlocks } from './patch.js';

// A plugin package without `dsh.bundle` is not a DSH bundle: DSH skips it in the profile's bundle list, and it
// loads only through an insert row. dshenv keeps that row in its own managed block, one per plugin.
const MOUNT_PREFIX = '@mount:';
const MOUNT_BLOCK = /# dshenv:begin profile=([^\s]+) plugin=@mount:([^\s]+)\n([\s\S]*?)# dshenv:end profile=\1 plugin=@mount:\2/g;

export function mountBlockAlias(alias: string): string {
  return `${MOUNT_PREFIX}${alias}`;
}

// DSH selects a package from the bundle list only when its package.json declares dsh.bundle.
export function isBundlePackage(packageJson: Record<string, unknown>): boolean {
  const dsh = packageJson.dsh;
  return dsh !== null && typeof dsh === 'object' && !Array.isArray(dsh) && (dsh as Record<string, unknown>).bundle !== undefined;
}

function renderMountBlock(profile: string, alias: string, packageName: string): string {
  const payload = YAML.stringify([{ insert: [{ id: alias, name: packageName }] }], { indent: 2, lineWidth: 0 }).trimEnd();
  return [`# dshenv:begin profile=${profile} plugin=${MOUNT_PREFIX}${alias}`, payload, `# dshenv:end profile=${profile} plugin=${MOUNT_PREFIX}${alias}`].join('\n');
}

// alias -> package of every plugin the file mounts for the profile.
export function readMounts(content: string, profile: string): Record<string, string> {
  const mounts: Record<string, string> = {};
  for (const [, blockProfile, alias, payload] of content.matchAll(MOUNT_BLOCK)) {
    if (blockProfile !== profile) continue;
    try {
      const row = (YAML.parse(payload) as Array<{ insert?: Array<{ id?: unknown; name?: unknown }> }>)?.[0]?.insert?.[0];
      if (row?.id === alias && typeof row.name === 'string') mounts[alias] = row.name;
    } catch {
      // A block edited into invalid YAML mounts nothing; the next apply rewrites it.
    }
  }
  return mounts;
}

// Entries apply in file order, so a new mount goes before every entry: patches that target its row come after it.
function prependBlock(content: string, block: string): string {
  const base = flowArrayAsBlock(content) ?? content;
  const doc = YAML.parseDocument(base);
  const first = YAML.isSeq(doc.contents) ? doc.contents.items[0] : undefined;
  if (!YAML.isNode(first) || !first.range) {
    return appendBlocks(content, block);
  }
  const lineStart = base.lastIndexOf('\n', first.range[0] - 1) + 1;
  return `${base.slice(0, lineStart)}${block}${base.slice(lineStart)}`;
}

// Mounts the package under the alias, or unmounts it when packageName is null.
export function writeMount(content: string, profile: string, alias: string, packageName: string | null): string {
  const block = packageName === null ? '' : `${renderMountBlock(profile, alias, packageName)}\n`;
  if (packageName !== null && readMounts(content, profile)[alias] === undefined) {
    return prependBlock(content, block);
  }
  return splicePluginBlocks(content, profile, mountBlockAlias(alias), block);
}
