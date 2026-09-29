import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    globalSetup: ['tests/setup/no-real-dsh.ts'],
    isolate: true,
    // Starting processes (git, node) costs several times more on Windows runners, in setup hooks too.
    testTimeout: process.platform === 'win32' ? 30_000 : 5_000,
    hookTimeout: process.platform === 'win32' ? 30_000 : 10_000
  }
});
