import { z } from 'zod';
import { EnvironmentConfigSchema, PackageNameRegex, PluginSourceSchema } from '../manifest/schema.js';

export const OverlayPatchSchema = z
  .object({
    id: z.string().min(1),
    config: z.record(z.string(), z.unknown()).optional(),
    enabled: z.boolean().optional()
  })
  .strict();

export const OverlayPluginSchema = z
  .object({
    package: z.string().regex(PackageNameRegex, { message: 'Invalid npm package name format' }).optional(),
    enabled: z.boolean().optional(),
    source: PluginSourceSchema.optional(),
    patches: z.array(OverlayPatchSchema).optional(),
    remove: z.literal(true).optional()
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.remove && Object.keys(val).some((key) => key !== 'remove')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'remove: true cannot be combined with other fields' });
    }
  });

export const OverlaySchema = z
  .object({
    apiVersion: z.literal('dshenv-overlay/v1'),
    environment: EnvironmentConfigSchema.optional(),
    profiles: z
      .record(z.string(), z.object({ plugins: z.record(z.string(), OverlayPluginSchema).optional() }).strict())
      .optional()
  })
  .strict();

export const OverlaySelectionFileSchema = z
  .object({
    apiVersion: z.literal('dshenv-overlay-selection/v1'),
    overlay: z.string().min(1)
  })
  .strict();
