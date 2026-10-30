import { defineConfig } from 'vitest/config';

// Database integration suite: real PostgreSQL (isolated *_test database), no mocks.
// Files run sequentially because they share one database and reset it between tests.
export default defineConfig({
  test: {
    globals: true,
    include: ['test/db/**/*.db-spec.ts'],
    globalSetup: ['test/db/support/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
