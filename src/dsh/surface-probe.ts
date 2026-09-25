import { constants } from 'node:fs'
import { lstat, open, realpath, stat } from 'node:fs/promises'
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

function isWithinDirectory(directory: string, targetPath: string): boolean {
  const target = relative(directory, targetPath)
  return target !== '' && target !== '..' && !target.startsWith(`..${sep}`) && !isAbsolute(target)
}

type FileIdentity = { dev: number; ino: number }

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

async function openedFileMatchesCanonicalPath(path: string, openedStat: FileIdentity): Promise<boolean> {
  const checkedPath = await realpath(path)
  if (checkedPath !== path) return false
  return sameFile(await stat(path), openedStat)
}

async function readBoundedManifest(
  canonicalPath: string,
  initialStat: FileIdentity,
): Promise<{ content: string } | { diagnostic: string }> {
  const file = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const openedStat = await file.stat()
    if (!openedStat.isFile()) return { diagnostic: 'PACKAGE_MANIFEST_NOT_REGULAR' }
    if (!sameFile(initialStat, openedStat) || !await openedFileMatchesCanonicalPath(canonicalPath, openedStat)) {
      return { diagnostic: 'PACKAGE_MANIFEST_NOT_REGULAR' }
    }
    if (openedStat.size > manifestLimit) return { diagnostic: 'PACKAGE_MANIFEST_TOO_LARGE' }

    const buffer = Buffer.alloc(manifestLimit + 1)
    let total = 0
    while (total < buffer.length) {
      const { bytesRead } = await file.read(buffer, total, buffer.length - total, null)
      if (bytesRead === 0) break
      total += bytesRead
    }
    if (total > manifestLimit) return { diagnostic: 'PACKAGE_MANIFEST_TOO_LARGE' }
    return { content: buffer.subarray(0, total).toString('utf8') }
  } finally {
    await file.close()
  }
}

async function canonicalTargetIsRegularFile(canonicalPath: string, initialStat: FileIdentity): Promise<boolean> {
  const file = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const openedStat = await file.stat()
    return openedStat.isFile() &&
      sameFile(initialStat, openedStat) &&
      await openedFileMatchesCanonicalPath(canonicalPath, openedStat)
  } finally {
    await file.close()
  }
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
    const actualHarnessDir = await realpath(input.harnessSourceDir)
    const actualPackageDir = await realpath(packageDir)
    if (!isWithinDirectory(actualHarnessDir, actualPackageDir)) {
      diagnostics.push('PACKAGE_MANIFEST_NOT_REGULAR')
    } else {
      const manifestStat = await lstat(manifestPath)
      if (!manifestStat.isFile()) {
        diagnostics.push('PACKAGE_MANIFEST_NOT_REGULAR')
      } else {
        const actualManifestPath = await realpath(manifestPath)
        if (!isWithinDirectory(actualHarnessDir, actualManifestPath) || !isWithinDirectory(actualPackageDir, actualManifestPath)) {
          diagnostics.push('PACKAGE_MANIFEST_NOT_REGULAR')
        } else {
          const readResult = await readBoundedManifest(actualManifestPath, manifestStat)
          if ('diagnostic' in readResult) {
            diagnostics.push(readResult.diagnostic)
          } else {
            let manifest: unknown
            try {
              manifest = JSON.parse(readResult.content)
            } catch {
              manifest = null
            }

            const target = operationsTarget(manifest)
            if (target === null) {
              diagnostics.push('OPERATIONS_EXPORT_MISSING')
            } else {
              operationsExport.declared = true
              const targetPath = resolve(actualPackageDir, target)
              if (!isWithinDirectory(actualPackageDir, targetPath)) {
                diagnostics.push('EXPORT_TARGET_OUTSIDE_PACKAGE')
              } else {
                try {
                  const targetStat = await lstat(targetPath)
                  if (targetStat.isFile()) {
                    const actualTargetPath = await realpath(targetPath)
                    if (isWithinDirectory(actualHarnessDir, actualTargetPath) && isWithinDirectory(actualPackageDir, actualTargetPath)) {
                      operationsExport.targetExists = await canonicalTargetIsRegularFile(actualTargetPath, targetStat)
                      if (!operationsExport.targetExists) diagnostics.push('EXPORT_TARGET_MISSING')
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
