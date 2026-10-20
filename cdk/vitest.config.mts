import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Synthesising bundles two Lambdas with esbuild.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
