import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  dts: false,
  // Default is `.mjs` on platform node; package.json `bin` points at dist/cli.js.
  fixedExtension: false,
  external: ['@napi-rs/keyring'],
});
