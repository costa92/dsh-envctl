import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    globalSetup: ['tests/setup/no-real-dsh.ts'],
    isolate: true
  }
});
