import { defineConfig } from 'tsdown'

// The official two-stage package build: `tsc` emits JS + declarations into
// lib/types (rewriting explicit .ts relative specifiers to .js), then tsdown
// bundles the emitted entry into the single published runtime artifact
// lib/index.js. Declarations and their maps stay in lib/types; the published
// `files` whitelist ships lib/index.js plus lib/types/**/*.d.ts only.
export default defineConfig({
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
