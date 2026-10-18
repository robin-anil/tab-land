import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.js'],
    environment: 'node',
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/lib/**', 'src/bg/**'],
      reporter: ['text-summary', 'text', 'html'],
      thresholds: { lines: 80, functions: 80, branches: 70, statements: 80 },
    },
  },
});
