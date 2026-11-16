import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: false,
    root: './',
    include: ['**/*.integration-spec.ts'],
  },
});
