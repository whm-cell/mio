import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'compute/tests/**/*.test.ts'],
    setupFiles: ['./tests/providers-setup.ts'],
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
