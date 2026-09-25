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

export function applyPatchBlock(
  existingContent: string,
  profileName: string,
  pluginAlias: string,
  patchId: string,
  config: Record<string, unknown>
): string {
  const newBlock = renderPatchBlock(profileName, pluginAlias, patchId, config);
  const regex = new RegExp(
    `# dshenv:begin profile=${profileName} plugin=${pluginAlias}(?: digest=[^\\s]+)?\\n[\\s\\S]*?# dshenv:end profile=${profileName} plugin=${pluginAlias}\\n?`,
    'g'
  );

  if (regex.test(existingContent)) {
    return existingContent.replace(regex, `${newBlock}\n`);
  }

  const trimmed = existingContent.trimEnd();
  if (trimmed.length === 0) {
    return `${newBlock}\n`;
  }
  return `${trimmed}\n\n${newBlock}\n`;
}

export function removePatchBlock(
  existingContent: string,
  profileName: string,
  pluginAlias: string
): string {
  const regex = new RegExp(
    `# dshenv:begin profile=${profileName} plugin=${pluginAlias}(?: digest=[^\\s]+)?\\n[\\s\\S]*?# dshenv:end profile=${profileName} plugin=${pluginAlias}\\n?`,
    'g'
  );

  const cleaned = existingContent.replace(regex, '');
  return cleaned.replace(/\n{3,}/g, '\n\n');
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
