import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  // `es2020` rather than the Node wrapper's `node18`: this ships into someone
  // else's bundle and then into a browser, so the floor is what browsers
  // support, not what a Node release supports.
  target: 'es2020',
  platform: 'browser',
  splitting: false,
  shims: false,
});
