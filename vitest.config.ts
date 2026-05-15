import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10_000,
    server: {
      deps: {
        // @coral-xyz/anchor and the @pump-fun SDKs are CJS packages whose
        // named exports (e.g. `BN` from anchor) Vitest's loader can't
        // resolve directly. Inlining routes them through Vitest's transform,
        // which handles the CJS/ESM interop. The bot runs via ts-node and
        // resolves them natively, so this is a test-runner-only need.
        inline: [/@coral-xyz\/anchor/, /@pump-fun\//],
      },
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
      reporter: ['text', 'html'],
    },
  },
});
