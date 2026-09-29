import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    globalSetup: ['tests/setup/no-real-dsh.ts'],
    isolate: true,
    // Starting processes (git, node) costs several times more on Windows runners.
    testTimeout: process.platform === 'win32' ? 20_000 : 5_000
  }
});
