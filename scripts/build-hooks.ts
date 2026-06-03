import { build } from "esbuild";
import * as fs from "fs";
import * as path from "path";

async function run() {
  console.log("📦 Bundling Codex Logger hooks with esbuild...");

  const pkgPath = path.resolve(__dirname, "../package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));

  await build({
    entryPoints: {
      "session": "src/hooks/session.ts",
      "message": "src/hooks/message.ts",
      "tool": "src/hooks/tool.ts",
      "permission": "src/hooks/permission.ts",
      "compact": "src/hooks/compact.ts",
      "subagent": "src/hooks/subagent.ts"
    },
    bundle: true,
    platform: "node",
    format: "esm",
    minify: true,
    outdir: "dist/hooks",
    sourcemap: false,
    define: {
      "__LOGGER_VERSION__": JSON.stringify(pkg.version),
    },
  });

  console.log("✅ Hooks bundled successfully under dist/hooks/");
}

run().catch((err) => {
  console.error("❌ Bundling failed:", err);
  process.exit(1);
});
