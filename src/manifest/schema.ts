import { z } from 'zod';
import * as path from 'node:path';

// A leading dot is refused so '.' and '..' can never name a directory outside the package's own.
export const PackageNameRegex = /^(?:@[a-z0-9_-][a-z0-9._-]*\/)?[a-z0-9_-][a-z0-9._-]*$/;

// dshenv pins exact npm versions; ranges and tags would never compare equal to an installed version.
export const ExactVersionRegex = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

const isAbsolutePath = (val: string) => path.isAbsolute(val);

export const NpmSourceSchema = z
  .object({
    type: z.literal('npm'),
    version: z.string().regex(ExactVersionRegex, { message: 'npm version must be an exact version such as 1.2.3' }),
    registry: z.string().url().optional()
  })
  .strict();

export const GitSourceSchema = z
  .object({
    type: z.literal('git'),
    url: z.string().min(1),
    ref: z.string().optional(),
    commit: z.string().optional()
  })
  .strict();

export const LocalLinkSourceSchema = z
  .object({
    type: z.literal('local-link'),
    path: z.string().refine(isAbsolutePath, {
      message: 'Local link path must be absolute'
    })
  })
  .strict();

export const LocalFileSourceSchema = z
  .object({
    type: z.literal('local-file'),
    path: z.string().refine(isAbsolutePath, {
      message: 'Local file path must be absolute'
    })
  })
  .strict();

export const InBoxSourceSchema = z
  .object({
    type: z.literal('in-box')
  })
  .strict();

export const PluginSourceSchema = z.discriminatedUnion('type', [
  NpmSourceSchema,
  GitSourceSchema,
  LocalLinkSourceSchema,
  LocalFileSourceSchema,
  InBoxSourceSchema
]);

// Aliases appear in single-line patch markers, so whitespace would break or inject into them.
export const PluginAliasSchema = z.string().regex(/^\S+$/, { message: 'Plugin alias must not contain whitespace' });

export const PatchEntrySchema = z
  .object({
    id: z.string().min(1),
    config: z.record(z.string(), z.unknown()),
    enabled: z.boolean().optional()
  })
  .strict();

export const PluginManifestEntrySchema = z
  .object({
    package: z.string().regex(PackageNameRegex, {
      message: 'Invalid npm package name format'
    }),
    enabled: z.boolean().optional().default(true),
    source: PluginSourceSchema,
    patches: z.array(PatchEntrySchema).optional()
  })
  .strict();

export const ProfileManifestEntrySchema = z
  .object({
    plugins: z.record(PluginAliasSchema, PluginManifestEntrySchema).default({})
  })
  .strict()
  .superRefine((val, ctx) => {
    const seenPackages = new Map<string, string>();
    for (const [key, plugin] of Object.entries(val.plugins)) {
      const existingKey = seenPackages.get(plugin.package);
      if (existingKey) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate package "${plugin.package}" in profile (used in keys "${existingKey}" and "${key}")`
        });
      } else {
        seenPackages.set(plugin.package, key);
      }
    }
  });

export const EnvironmentConfigSchema = z
  .object({
    sourceRoot: z.string().refine(isAbsolutePath, 'sourceRoot must be absolute').optional(),
    harness: z
      .object({
        sourceDir: z.string().refine(isAbsolutePath, 'sourceDir must be absolute').optional(),
        allowUntestedVersion: z.boolean().optional()
      })
      .strict()
      .optional()
  })
  .strict();

export const ManifestSchema = z
  .object({
    apiVersion: z.literal('dshenv/v1'),
    environment: EnvironmentConfigSchema.optional(),
    profiles: z.record(z.string(), ProfileManifestEntrySchema).default({})
  })
  .strict();

export const NpmLockSourceSchema = z
  .object({
    type: z.literal('npm'),
    resolvedVersion: z.string().min(1),
    integrity: z.string().optional(),
    resolvedFrom: z.string().optional()
  })
  .strict();

export const GitLockSourceSchema = z
  .object({
    type: z.literal('git'),
    url: z.string().min(1),
    commit: z.string().min(1)
  })
  .strict();

export const LocalLinkLockSourceSchema = z
  .object({
    type: z.literal('local-link'),
    path: z.string().refine(isAbsolutePath, 'Path must be absolute'),
    digest: z.string().optional()
  })
  .strict();

export const LocalFileLockSourceSchema = z
  .object({
    type: z.literal('local-file'),
    path: z.string().refine(isAbsolutePath, 'Path must be absolute'),
    digest: z.string().optional()
  })
  .strict();

export const InBoxLockSourceSchema = z
  .object({
    type: z.literal('in-box')
  })
  .strict();

export const PluginLockSourceSchema = z.discriminatedUnion('type', [
  NpmLockSourceSchema,
  GitLockSourceSchema,
  LocalLinkLockSourceSchema,
  LocalFileLockSourceSchema,
  InBoxLockSourceSchema
]);

export const PluginLockEntrySchema = z
  .object({
    package: z.string().regex(PackageNameRegex),
    source: PluginLockSourceSchema
  })
  .strict();

export const ProfileLockEntrySchema = z
  .object({
    plugins: z.record(z.string(), PluginLockEntrySchema).default({})
  })
  .strict();

export const LockSchema = z
  .object({
    apiVersion: z.literal('dshenv-lock/v1'),
    profiles: z.record(z.string(), ProfileLockEntrySchema).default({})
  })
  .strict();

export const PluginStateEntrySchema = z
  .object({
    package: z.string().regex(PackageNameRegex),
    status: z.string(),
    installedVersion: z.string().optional(),
    lastVerified: z.string().optional()
  })
  .strict();

export const ProfileStateEntrySchema = z
  .object({
    plugins: z.record(z.string(), PluginStateEntrySchema).default({})
  })
  .strict();

export const PluginOwnershipRecordSchema = z
  .object({
    package: z.string().regex(PackageNameRegex),
    alias: z.string().min(1),
    sourceType: z.enum(['npm', 'git', 'local-link', 'local-file', 'in-box', 'unknown']),
    lockedVersion: z.string().optional(),
    adoptedAt: z.string().min(1),
    adoptedBy: z.string().min(1)
  })
  .strict();

export const StateSchema = z
  .object({
    apiVersion: z.literal('dshenv-state/v1'),
    lastApplied: z.string(),
    appliedLockHash: z.string(),
    profiles: z.record(z.string(), ProfileStateEntrySchema).default({}),
    ownership: z.record(z.string(), z.record(z.string(), PluginOwnershipRecordSchema)).optional(),
    appliedOverlay: z.string().min(1).optional()
  })
  .strict();

export const CaptureDocumentSchema = z
  .object({
    apiVersion: z.literal('dshenv-capture/v1'),
    manifest: ManifestSchema,
    lock: LockSchema,
    warnings: z.array(z.string()).default([])
  })
  .strict();
