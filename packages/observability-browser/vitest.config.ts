import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // jsdom, not node: this package is almost entirely interaction with browser
    // globals — document.visibilityState, window error events, fetch — and a
    // node environment would let a broken listener registration pass.
    environment: 'jsdom',
    include: ['test/**/*.test.ts'],
    globals: false,
    clearMocks: true,
  },
});
