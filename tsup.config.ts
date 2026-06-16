import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  platform: "node",
  // Preserve the executable shebang on the bin entry.
  banner: { js: "#!/usr/bin/env node" },
  dts: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  // Zero runtime dependencies — nothing to bundle from node_modules.
  external: [],
});
