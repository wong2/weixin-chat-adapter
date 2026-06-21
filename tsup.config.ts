import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  // silk-wasm is an optional dependency loaded via dynamic import at runtime;
  // keep it external so the import resolves from node_modules (and can fail
  // gracefully when absent) instead of being bundled with its .wasm loader.
  external: ["silk-wasm"],
});
