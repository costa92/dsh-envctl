import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { FileExistsError } from '../errors.js';

// Profile files may be symlinks (e.g. managed by dotfiles) and may be shared; replacing them by rename
// must neither turn the link into a plain file nor tighten the permissions of an existing file.
async function resolveOverwriteTarget(targetPath: string): Promise<{ target: string; fileMode: number }> {
  try {
    const target = await fs.promises.realpath(targetPath);
    const stat = await fs.promises.stat(target);
    return { target, fileMode: stat.mode & 0o7777 };
  } catch {
    return { target: targetPath, fileMode: 0o600 };
  }
}

export async function writeAtomic(
  requestedPath: string,
  contents: string | Uint8Array,
  mode: 'create' | 'overwrite' = 'overwrite'
): Promise<void> {
  const { target: targetPath, fileMode } = mode === 'overwrite'
    ? await resolveOverwriteTarget(requestedPath)
    : { target: requestedPath, fileMode: 0o600 };
  const dir = path.dirname(targetPath);
  await fs.promises.mkdir(dir, { recursive: true });

  if (mode === 'create') {
    try {
      await fs.promises.access(targetPath, fs.constants.F_OK);
      throw new FileExistsError(targetPath);
    } catch (err: unknown) {
      if (err instanceof FileExistsError) {
        throw err;
      }
      // target does not exist, proceed
    }
  }

  const randomSuffix = crypto.randomBytes(8).toString('hex');
  const tempPath = path.join(dir, `.tmp-${path.basename(targetPath)}-${randomSuffix}`);

  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(tempPath, 'wx', 0o600);
    const data = typeof contents === 'string' ? Buffer.from(contents, 'utf8') : contents;
    await handle.writeFile(data);
    if (fileMode !== 0o600) {
      await handle.chmod(fileMode);
    }
    await handle.sync();
    await handle.close();
    handle = null;

    if (mode === 'create') {
      // Use link + unlink for atomic create-if-not-exists on POSIX, or check-then-rename
      // In Node.js, fs.promises.link fails if target already exists with EEXIST
      try {
        await fs.promises.link(tempPath, targetPath);
        await fs.promises.unlink(tempPath);
      } catch (linkErr: unknown) {
        if ((linkErr as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new FileExistsError(targetPath);
        }
        // Fallback for filesystems that don't support hardlinks
        try {
          await fs.promises.access(targetPath, fs.constants.F_OK);
          throw new FileExistsError(targetPath);
        } catch (accErr: unknown) {
          if (accErr instanceof FileExistsError) throw accErr;
          await fs.promises.rename(tempPath, targetPath);
        }
      }
    } else {
      await fs.promises.rename(tempPath, targetPath);
    }

    // sync parent dir
    try {
      const dirHandle = await fs.promises.open(dir, 'r');
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    } catch {
      // dir sync is optional/ignored if not supported by OS/filesystem
    }
  } catch (err) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // ignore
      }
    }
    try {
      await fs.promises.unlink(tempPath);
    } catch {
      // ignore
    }
    throw err;
  }
}
