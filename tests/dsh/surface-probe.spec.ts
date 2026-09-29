import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { closeSync, constants, openSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { probeOfficialSurfaces } from '../../src/dsh/index.js'

const manifestRace = vi.hoisted(() => ({
  path: '',
  oversizedContent: '',
  symlinkTarget: '',
  swapParentAtOpenPath: '',
  swapParentCanonicalPath: '',
  parentLink: '',
  replacementBootDir: '',
  fifoAtOpenPath: '',
  fifoRescued: false,
}))

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const stat = await actual.lstat(...args)
      if (String(args[0]) === manifestRace.path) {
        manifestRace.path = ''
        if (manifestRace.oversizedContent) {
          await actual.writeFile(args[0], manifestRace.oversizedContent)
        } else if (manifestRace.symlinkTarget) {
          await actual.rm(args[0])
          await actual.symlink(manifestRace.symlinkTarget, args[0])
        }
      }
      return stat
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      if (String(args[0]) === manifestRace.fifoAtOpenPath) {
        const fifoPath = manifestRace.fifoAtOpenPath
        manifestRace.fifoAtOpenPath = ''
        await actual.rm(fifoPath)
        execFileSync('mkfifo', [fifoPath])
        // Release an unsafe blocking open so the RED test fails without hanging the suite.
        const rescue = setTimeout(() => {
          manifestRace.fifoRescued = true
          const writer = openSync(fifoPath, constants.O_WRONLY | constants.O_NONBLOCK)
          closeSync(writer)
        }, 250)
        try {
          return await actual.open(...args)
        } finally {
          clearTimeout(rescue)
        }
      }
      if (
        String(args[0]) === manifestRace.swapParentAtOpenPath ||
        String(args[0]) === manifestRace.swapParentCanonicalPath
      ) {
        manifestRace.swapParentAtOpenPath = ''
        manifestRace.swapParentCanonicalPath = ''
        await actual.rm(manifestRace.parentLink)
        await actual.symlink(manifestRace.replacementBootDir, manifestRace.parentLink, 'dir')
      }
      return actual.open(...args)
    },
  }
})

const fixtureDir = fileURLToPath(new URL('../fixtures/harness-source', import.meta.url))
const temporaryDirs: string[] = []

async function temporaryPackageDir(): Promise<{ harnessSourceDir: string; packageDir: string }> {
  const harnessSourceDir = await mkdtemp(join(tmpdir(), 'dshenv-surface-probe-'))
  temporaryDirs.push(harnessSourceDir)
  const packageDir = join(harnessSourceDir, 'packages/boot/plugin-manager')
  await mkdir(packageDir, { recursive: true })
  return { harnessSourceDir, packageDir }
}

afterEach(async () => {
  manifestRace.path = ''
  manifestRace.oversizedContent = ''
  manifestRace.symlinkTarget = ''
  manifestRace.swapParentAtOpenPath = ''
  manifestRace.swapParentCanonicalPath = ''
  manifestRace.parentLink = ''
  manifestRace.replacementBootDir = ''
  manifestRace.fifoAtOpenPath = ''
  manifestRace.fifoRescued = false
  await Promise.all(temporaryDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('probeOfficialSurfaces', () => {
  // Windows has no FIFOs.
  it.skipIf(process.platform === 'win32').each([
    ['package.json', false, 'PACKAGE_MANIFEST_NOT_REGULAR'],
    ['operations.js', true, 'EXPORT_TARGET_MISSING'],
  ] as const)('rejects %s replaced by a FIFO immediately before open without blocking', async (file, declared, diagnostic) => {
    const { harnessSourceDir, packageDir } = await temporaryPackageDir()
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({ exports: { './operations': { default: './operations.js' } } }))
    await writeFile(join(packageDir, 'operations.js'), 'throw new Error("must not execute")')
    manifestRace.fifoAtOpenPath = await realpath(join(packageDir, file))

    const evidence = await probeOfficialSurfaces({ harnessSourceDir })

    expect(manifestRace.fifoRescued).toBe(false)
    expect(evidence.operationsExport).toMatchObject({ declared, targetExists: false })
    expect(evidence.diagnostics).toEqual([diagnostic, 'LIVE_SERVICE_NOT_CONFIGURED'])
  })
  it('finds the declared official operations export without executing its target', async () => {
    const evidence = await probeOfficialSurfaces({ harnessSourceDir: fixtureDir })

    expect(evidence).toEqual({
      operationsExport: {
        declared: true,
        targetExists: true,
        exportName: '@deepseek-ai/dsh-plugin-manager/operations',
      },
      liveService: { configured: false, reachable: false },
      diagnostics: ['LIVE_SERVICE_NOT_CONFIGURED'],
    })
  })

  it('reports a missing manifest', async () => {
    const { harnessSourceDir } = await temporaryPackageDir()

    const evidence = await probeOfficialSurfaces({ harnessSourceDir })

    expect(evidence.operationsExport).toMatchObject({ declared: false, targetExists: false })
    expect(evidence.diagnostics).toContain('PACKAGE_MANIFEST_MISSING')
  })

  it('rejects a symlink manifest', async () => {
    const { harnessSourceDir, packageDir } = await temporaryPackageDir()
    const linkedManifest = join(harnessSourceDir, 'linked-package.json')
    await writeFile(linkedManifest, JSON.stringify({ exports: { './operations': { default: './operations.js' } } }))
    await symlink(linkedManifest, join(packageDir, 'package.json'))

    const evidence = await probeOfficialSurfaces({ harnessSourceDir })

    expect(evidence.operationsExport).toMatchObject({ declared: false, targetExists: false })
    expect(evidence.diagnostics).toContain('PACKAGE_MANIFEST_NOT_REGULAR')
  })

  it('rejects a parent directory symlink pointing outside the harness source', async () => {
    const harnessSourceDir = await mkdtemp(join(tmpdir(), 'dshenv-surface-probe-'))
    const outsideBootDir = await mkdtemp(join(tmpdir(), 'dshenv-external-boot-'))
    temporaryDirs.push(harnessSourceDir, outsideBootDir)
    const outsidePackageDir = join(outsideBootDir, 'plugin-manager')
    await mkdir(join(harnessSourceDir, 'packages'), { recursive: true })
    await mkdir(outsidePackageDir)
    await writeFile(join(outsidePackageDir, 'package.json'), JSON.stringify({ exports: { './operations': { default: './operations.js' } } }))
    await writeFile(join(outsidePackageDir, 'operations.js'), 'export {}')
    await symlink(outsideBootDir, join(harnessSourceDir, 'packages/boot'), 'dir')

    const evidence = await probeOfficialSurfaces({ harnessSourceDir })

    expect(evidence.operationsExport).toMatchObject({ declared: false, targetExists: false })
    expect(evidence.diagnostics).toContain('PACKAGE_MANIFEST_NOT_REGULAR')
  })

  it('rejects a manifest larger than 1 MiB', async () => {
    const { harnessSourceDir, packageDir } = await temporaryPackageDir()
    await writeFile(join(packageDir, 'package.json'), `{"padding":"${'x'.repeat(1_048_576)}"}`)

    const evidence = await probeOfficialSurfaces({ harnessSourceDir })

    expect(evidence.operationsExport).toMatchObject({ declared: false, targetExists: false })
    expect(evidence.diagnostics).toContain('PACKAGE_MANIFEST_TOO_LARGE')
  })

  it('rejects a manifest that grows after the initial path check', async () => {
    const { harnessSourceDir, packageDir } = await temporaryPackageDir()
    const manifestPath = join(packageDir, 'package.json')
    await writeFile(manifestPath, JSON.stringify({ exports: { './operations': { default: './operations.js' } } }))
    await writeFile(join(packageDir, 'operations.js'), 'export {}')
    manifestRace.path = manifestPath
    manifestRace.oversizedContent = JSON.stringify({
      exports: { './operations': { default: './operations.js' } },
      padding: 'x'.repeat(1_048_576),
    })

    const evidence = await probeOfficialSurfaces({ harnessSourceDir })

    expect(evidence.operationsExport).toMatchObject({ declared: false, targetExists: false })
    expect(evidence.diagnostics).toContain('PACKAGE_MANIFEST_TOO_LARGE')
  })

  it('rejects a manifest replaced by a symlink after the initial path check', async () => {
    const { harnessSourceDir, packageDir } = await temporaryPackageDir()
    const manifestPath = join(packageDir, 'package.json')
    const alternateManifest = join(packageDir, 'alternate-package.json')
    await writeFile(manifestPath, '{}')
    await writeFile(alternateManifest, JSON.stringify({ exports: { './operations': { default: './operations.js' } } }))
    await writeFile(join(packageDir, 'operations.js'), 'export {}')
    manifestRace.path = manifestPath
    manifestRace.symlinkTarget = alternateManifest

    const evidence = await probeOfficialSurfaces({ harnessSourceDir })

    expect(evidence.operationsExport).toMatchObject({ declared: false, targetExists: false })
    expect(evidence.diagnostics).toContain('PACKAGE_MANIFEST_NOT_REGULAR')
  })

  it('keeps the canonical package when its original parent symlink changes before opening', async () => {
    const harnessSourceDir = await mkdtemp(join(tmpdir(), 'dshenv-surface-probe-'))
    const outsideBootDir = await mkdtemp(join(tmpdir(), 'dshenv-external-boot-'))
    temporaryDirs.push(harnessSourceDir, outsideBootDir)
    const canonicalPackageDir = join(harnessSourceDir, 'real-boot/plugin-manager')
    const outsidePackageDir = join(outsideBootDir, 'plugin-manager')
    const parentLink = join(harnessSourceDir, 'packages/boot')
    await mkdir(canonicalPackageDir, { recursive: true })
    await mkdir(outsidePackageDir)
    await mkdir(join(harnessSourceDir, 'packages'))
    await symlink(join(harnessSourceDir, 'real-boot'), parentLink, 'dir')
    await writeFile(join(canonicalPackageDir, 'package.json'), JSON.stringify({ exports: { './operations': { default: './operations.js' } } }))
    await writeFile(join(canonicalPackageDir, 'operations.js'), 'export {}')
    await writeFile(join(outsidePackageDir, 'package.json'), JSON.stringify({ exports: {} }))
    manifestRace.swapParentAtOpenPath = join(parentLink, 'plugin-manager/package.json')
    manifestRace.swapParentCanonicalPath = join(canonicalPackageDir, 'package.json')
    manifestRace.parentLink = parentLink
    manifestRace.replacementBootDir = outsideBootDir

    const evidence = await probeOfficialSurfaces({ harnessSourceDir })

    expect(evidence.operationsExport).toMatchObject({ declared: true, targetExists: true })
    expect(evidence.diagnostics).toEqual(['LIVE_SERVICE_NOT_CONFIGURED'])
  })

  it('reports an undeclared operations export', async () => {
    const { harnessSourceDir, packageDir } = await temporaryPackageDir()
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({ exports: {} }))

    const evidence = await probeOfficialSurfaces({ harnessSourceDir })

    expect(evidence.operationsExport).toMatchObject({ declared: false, targetExists: false })
    expect(evidence.diagnostics).toContain('OPERATIONS_EXPORT_MISSING')
  })

  it('reports a declared export whose target is missing', async () => {
    const { harnessSourceDir, packageDir } = await temporaryPackageDir()
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({ exports: { './operations': { default: './missing.js' } } }))

    const evidence = await probeOfficialSurfaces({ harnessSourceDir })

    expect(evidence.operationsExport).toMatchObject({ declared: true, targetExists: false })
    expect(evidence.diagnostics).toContain('EXPORT_TARGET_MISSING')
  })

  it('rejects an operations target outside the package directory', async () => {
    const { harnessSourceDir, packageDir } = await temporaryPackageDir()
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({ exports: { './operations': { default: '../outside.js' } } }))
    await writeFile(join(harnessSourceDir, 'packages/boot/outside.js'), 'export {}')

    const evidence = await probeOfficialSurfaces({ harnessSourceDir })

    expect(evidence.operationsExport).toMatchObject({ declared: true, targetExists: false })
    expect(evidence.diagnostics).toContain('EXPORT_TARGET_OUTSIDE_PACKAGE')
  })

  it('rejects an operations target reached through a symlinked directory', async () => {
    const { harnessSourceDir, packageDir } = await temporaryPackageDir()
    const outsideDir = join(harnessSourceDir, 'outside')
    await mkdir(outsideDir)
    await writeFile(join(outsideDir, 'operations.js'), 'export {}')
    await symlink(outsideDir, join(packageDir, 'linked'), 'dir')
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({ exports: { './operations': { default: './linked/operations.js' } } }))

    const evidence = await probeOfficialSurfaces({ harnessSourceDir })

    expect(evidence.operationsExport).toMatchObject({ declared: true, targetExists: false })
    expect(evidence.diagnostics).toContain('EXPORT_TARGET_OUTSIDE_PACKAGE')
  })
})
