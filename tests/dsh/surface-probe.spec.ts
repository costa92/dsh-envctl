import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { probeOfficialSurfaces } from '../../src/dsh/index.js'

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
  await Promise.all(temporaryDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('probeOfficialSurfaces', () => {
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

  it('rejects a manifest larger than 1 MiB', async () => {
    const { harnessSourceDir, packageDir } = await temporaryPackageDir()
    await writeFile(join(packageDir, 'package.json'), `{"padding":"${'x'.repeat(1_048_576)}"}`)

    const evidence = await probeOfficialSurfaces({ harnessSourceDir })

    expect(evidence.operationsExport).toMatchObject({ declared: false, targetExists: false })
    expect(evidence.diagnostics).toContain('PACKAGE_MANIFEST_TOO_LARGE')
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
