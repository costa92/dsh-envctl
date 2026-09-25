import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { RuntimeCapabilityEvidence } from './capability-types.js'

const manifestLimit = 1_048_576
const operationsExportName = '@deepseek-ai/dsh-plugin-manager/operations'

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function operationsTarget(manifest: unknown): string | null {
  if (typeof manifest !== 'object' || manifest === null || !('exports' in manifest)) return null
  const exports = manifest.exports
  if (typeof exports !== 'object' || exports === null || !('./operations' in exports)) return null
  const operations = exports['./operations']
  if (typeof operations !== 'object' || operations === null || !('default' in operations)) return null
  return typeof operations.default === 'string' && operations.default.length > 0
    ? operations.default
    : null
}

function isWithinPackage(packageDir: string, targetPath: string): boolean {
  const target = relative(packageDir, targetPath)
  return target !== '' && target !== '..' && !target.startsWith(`..${sep}`) && !isAbsolute(target)
}

export async function probeOfficialSurfaces(input: {
  harnessSourceDir: string
}): Promise<RuntimeCapabilityEvidence> {
  const packageDir = resolve(input.harnessSourceDir, 'packages/boot/plugin-manager')
  const manifestPath = resolve(packageDir, 'package.json')
  const diagnostics: string[] = []
  const operationsExport = {
    declared: false,
    targetExists: false,
    exportName: operationsExportName,
  }

  try {
    const stat = await lstat(manifestPath)
    if (!stat.isFile()) {
      diagnostics.push('PACKAGE_MANIFEST_NOT_REGULAR')
    } else if (stat.size > manifestLimit) {
      diagnostics.push('PACKAGE_MANIFEST_TOO_LARGE')
    } else {
      let manifest: unknown
      try {
        manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      } catch {
        manifest = null
      }

      const target = operationsTarget(manifest)
      if (target === null) {
        diagnostics.push('OPERATIONS_EXPORT_MISSING')
      } else {
        operationsExport.declared = true
        const targetPath = resolve(packageDir, target)
        if (!isWithinPackage(packageDir, targetPath)) {
          diagnostics.push('EXPORT_TARGET_OUTSIDE_PACKAGE')
        } else {
          try {
            if ((await lstat(targetPath)).isFile()) {
              const actualPackageDir = await realpath(packageDir)
              const actualTargetPath = await realpath(targetPath)
              if (isWithinPackage(actualPackageDir, actualTargetPath)) {
                operationsExport.targetExists = true
              } else {
                diagnostics.push('EXPORT_TARGET_OUTSIDE_PACKAGE')
              }
            } else {
              diagnostics.push('EXPORT_TARGET_MISSING')
            }
          } catch {
            diagnostics.push('EXPORT_TARGET_MISSING')
          }
        }
      }
    }
  } catch (error) {
    diagnostics.push(isMissing(error) ? 'PACKAGE_MANIFEST_MISSING' : 'PACKAGE_MANIFEST_NOT_REGULAR')
  }

  diagnostics.push('LIVE_SERVICE_NOT_CONFIGURED')
  return {
    operationsExport,
    liveService: { configured: false, reachable: false },
    diagnostics,
  }
}
