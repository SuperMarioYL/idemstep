import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  dts: true,
  sourcemap: true,
  clean: true,
  // The CLI shebang is carried in src/index.ts and preserved by tsup.
  // Playwright is an optional peer dep; never bundle it.
  external: ["playwright"],
});
