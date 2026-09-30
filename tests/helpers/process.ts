export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// A stopped process can still answer kill(pid, 0) for a moment: Node reaps its own exited children asynchronously
// (seen on macOS), and an orphan waits for init to reap it. Poll until it is gone or the deadline passes.
export const reaped = async (pid: number, timeoutMs = 5_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (alive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  return !alive(pid);
};
