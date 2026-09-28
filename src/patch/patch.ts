import * as crypto from 'node:crypto';
import * as YAML from 'yaml';
import { ValidationError } from '../errors.js';

export interface ExtractedPatch {
  profile: string;
  plugin: string;
  digest?: string;
  isDigestValid: boolean;
  id?: string;
  config: Record<string, unknown>;
}

function sortKeys(val: unknown): unknown {
  if (Array.isArray(val)) {
    return val.map(sortKeys);
  }
  if (val !== null && typeof val === 'object') {
    const sortedObj: Record<string, unknown> = {};
    const keys = Object.keys(val as Record<string, unknown>).sort();
    for (const k of keys) {
      sortedObj[k] = sortKeys((val as Record<string, unknown>)[k]);
    }
    return sortedObj;
  }
  return val;
}

export function computePatchDigest(config: Record<string, unknown>): string {
  const sorted = sortKeys(config);
  const canonicalString = YAML.stringify(sorted, { indent: 2, lineWidth: 0 }).trimEnd();
  return crypto.createHash('sha256').update(canonicalString).digest('hex');
}

export function renderPatchBlock(
  profileName: string,
  pluginAlias: string,
  patchId: string,
  config: Record<string, unknown>
): string {
  const digest = computePatchDigest(config);
  const patchPayload = [
    {
      id: patchId,
      config: sortKeys(config)
    }
  ];

  const payloadYaml = YAML.stringify(patchPayload, { indent: 2, lineWidth: 0 }).trimEnd();

  return [
    `# dshenv:begin profile=${profileName} plugin=${pluginAlias} digest=${digest}`,
    payloadYaml,
    `# dshenv:end profile=${profileName} plugin=${pluginAlias}`
  ].join('\n');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pluginBlockRegex(profileName: string, pluginAlias: string): RegExp {
  const profile = escapeRegExp(profileName);
  const plugin = escapeRegExp(pluginAlias);
  return new RegExp(
    `# dshenv:begin profile=${profile} plugin=${plugin}(?: digest=[^\\s]+)?\\n[\\s\\S]*?# dshenv:end profile=${profile} plugin=${plugin}\\n?`,
    'g'
  );
}

// The managed blocks of one plugin exactly as written, so they can be spliced back without re-rendering.
export function extractPluginBlocks(content: string, profileName: string, pluginAlias: string): string {
  return [...content.matchAll(pluginBlockRegex(profileName, pluginAlias))]
    .map(([block]) => (block.endsWith('\n') ? block : `${block}\n`))
    .join('');
}

function emptyFlowArrayRange(content: string): [number, number] | null {
  const doc = YAML.parseDocument(content);
  const root = doc.contents;
  if (doc.errors.length > 0 || !YAML.isSeq(root) || !root.flow || root.items.length > 0 || !root.range) {
    return null;
  }
  return [root.range[0], root.range[1]];
}

function flowArrayAsBlock(content: string): string | null {
  const doc = YAML.parseDocument(content);
  const root = doc.contents;
  if (doc.errors.length > 0 || !YAML.isSeq(root) || !root.flow) {
    return null;
  }
  root.flow = false;
  return doc.toString();
}

// DSH reads cordis.patch.yml as one top-level array; anything else would be written out broken.
export function assertPatchFileArray(content: string, file: string): void {
  const docs = YAML.parseAllDocuments(content);
  const root = docs[0]?.contents;
  if (docs.length > 1 || docs.some((doc) => doc.errors.length > 0) || (root !== null && root !== undefined && !YAML.isSeq(root))) {
    throw new ValidationError(`${file} must hold a single top-level YAML array of patch entries`);
  }
}

// Replaces every managed block of one plugin with one block per patch, written where the first old block was.
export function replacePluginBlocks(
  existingContent: string,
  profileName: string,
  pluginAlias: string,
  patches: Array<{ id: string; config: Record<string, unknown> }>
): string {
  const blocks = patches.map((patch) => `${renderPatchBlock(profileName, pluginAlias, patch.id, patch.config)}\n`).join('');
  return splicePluginBlocks(existingContent, profileName, pluginAlias, blocks);
}

// Surrounding bytes are spliced rather than passed through String.replace, which would expand `$` patterns in values.
export function splicePluginBlocks(existingContent: string, profileName: string, pluginAlias: string, blocks: string): string {
  const matches = [...existingContent.matchAll(pluginBlockRegex(profileName, pluginAlias))];
  if (matches.length === 0) {
    if (blocks.length === 0) return existingContent;
    if (existingContent.length === 0) return blocks;
    // A fresh profile's cordis.patch.yml is a single top-level `[]`. Appending a block
    // sequence after it would start a second YAML document, which DSH's parser rejects.
    const emptyArray = emptyFlowArrayRange(existingContent);
    if (emptyArray) {
      const [start, end] = emptyArray;
      const lineEnd = existingContent.indexOf('\n', end);
      const restOfLine = existingContent.slice(end, lineEnd === -1 ? undefined : lineEnd).trim();
      const after = lineEnd === -1 ? '' : existingContent.slice(lineEnd + 1);
      return `${existingContent.slice(0, start)}${restOfLine ? `${restOfLine}\n` : ''}${blocks}${after}`;
    }
    // A block sequence cannot follow a flow array either, so a non-empty one is rewritten in block style first.
    const base = flowArrayAsBlock(existingContent) ?? existingContent;
    return `${base}${base.endsWith('\n') ? '\n' : '\n\n'}${blocks}`;
  }

  let result = '';
  let cursor = 0;
  matches.forEach((match, index) => {
    let before = existingContent.slice(cursor, match.index);
    const replacement = index === 0 ? blocks : '';
    // Dropping a block also drops the blank line that appending it introduced.
    if (replacement === '' && before.endsWith('\n\n')) before = before.slice(0, -1);
    result += before + replacement;
    cursor = match.index + match[0].length;
  });
  result += existingContent.slice(cursor);
  // DSH refuses a patch file that is not a top-level array, so a file left with only comments gets its `[]` back.
  if (blocks.length === 0 && result.replace(/^\s*#.*$/gm, '').trim() === '') {
    return `${result}${result === '' || result.endsWith('\n') ? '' : '\n'}[]\n`;
  }
  return result;
}

export function applyPatchBlock(
  existingContent: string,
  profileName: string,
  pluginAlias: string,
  patchId: string,
  config: Record<string, unknown>
): string {
  return replacePluginBlocks(existingContent, profileName, pluginAlias, [{ id: patchId, config }]);
}

export function removePatchBlock(
  existingContent: string,
  profileName: string,
  pluginAlias: string
): string {
  return replacePluginBlocks(existingContent, profileName, pluginAlias, []);
}

export function extractManagedPatches(
  fileContent: string,
  targetProfile?: string
): ExtractedPatch[] {
  const regex = /# dshenv:begin profile=([^\s]+) plugin=([^\s]+)(?: digest=([^\s]+))?\n([\s\S]*?)# dshenv:end profile=\1 plugin=\2/g;
  const results: ExtractedPatch[] = [];

  let match: RegExpExecArray | null;
  while ((match = regex.exec(fileContent)) !== null) {
    const profile = match[1];
    const plugin = match[2];
    const declaredDigest = match[3];
    const payloadYaml = match[4];

    if (targetProfile && profile !== targetProfile) {
      continue;
    }

    try {
      const parsed = YAML.parse(payloadYaml);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const first = parsed[0];
        const id = typeof first.id === 'string' ? first.id : undefined;
        const config = (first.config && typeof first.config === 'object') ? (first.config as Record<string, unknown>) : {};
        const computedDigest = computePatchDigest(config);
        const isDigestValid = Boolean(declaredDigest && declaredDigest === computedDigest);

        results.push({
          profile,
          plugin,
          digest: declaredDigest,
          isDigestValid,
          id,
          config
        });
      }
    } catch {
      // invalid YAML inside managed block
    }
  }

  return results;
}
