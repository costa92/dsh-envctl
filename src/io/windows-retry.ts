const RETRY_FOR_MS = 5000;
const BUSY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

// On Windows, renaming over a file another process has open, or recreating a lock file deleted while someone read it,
// fails with EPERM until that reader closes it, which a concurrent dshenv command does within milliseconds.
export async function retryWhileBusy<T>(operation: () => Promise<T>): Promise<T> {
  if (process.platform !== 'win32') {
    return operation();
  }
  const deadline = Date.now() + RETRY_FOR_MS;
  for (let delay = 10; ; delay = Math.min(delay * 2, 100)) {
    try {
      return await operation();
    } catch (err: unknown) {
      if (!BUSY_CODES.has((err as NodeJS.ErrnoException).code ?? '') || Date.now() >= deadline) {
        throw err;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
