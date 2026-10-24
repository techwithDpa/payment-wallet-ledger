import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // All test files share one database, and the reconciliation test corrupts it on purpose
    // for a moment. Running files one after another stops other files from seeing that.
    fileParallelism: false,
  },
});
