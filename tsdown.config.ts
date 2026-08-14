import { defineConfig } from 'tsdown'

// Minimal multi-entry build matching the package.json `exports` map:
//   .            -> lib/index.js      (host plugin)
//   ./invariant  -> lib/invariant.js  (optional invariant companion)
//   ./client     -> lib/client.js     (browser client plugin)
//
// This is a starting point: the exact bundling (dsh.client platform:web) may
// need the shared client preset from the DeepSeek Harness repo — verify against
// your installed dsh version before publishing.
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    invariant: 'src/invariant.ts',
    client: 'src/client/index.tsx',
  },
  format: ['esm'],
  dts: true,
  clean: true,
})
