import { build } from "esbuild";

async function run() {
  console.log("📦 Bundling Codex Logger hooks with esbuild...");

  await build({
    entryPoints: {
      "session": "src/hooks/session.ts",
      "message": "src/hooks/message.ts",
      "tool": "src/hooks/tool.ts"
    },
    bundle: true,
    platform: "node",
    format: "esm",
    minify: true,
    outdir: "dist/hooks",
    sourcemap: false
  });

  console.log("✅ Hooks bundled successfully under dist/hooks/");
}

run().catch((err) => {
  console.error("❌ Bundling failed:", err);
  process.exit(1);
});
