import { execSync } from "child_process";

function check() {
  console.log("🔍 Running pre-publish safety checks...");

  // 1. Ensure we are on main branch
  const branch = execSync("git rev-parse --abbrev-ref HEAD").toString().trim();
  if (branch !== "main" && branch !== "master") {
    console.warn(`⚠️  Warning: You are on branch '${branch}'. Releases are typically done from 'main'.`);
  }

  // 2. Ensure working directory is clean
  const status = execSync("git status --porcelain").toString().trim();
  if (status !== "") {
    console.error("❌ Error: Working directory is not clean. Commit or stash changes before publishing.");
    process.exit(1);
  }

  // 3. Ensure all tests pass
  try {
    console.log("🧪 Running final quality gate...");
    execSync("bun run quality", { stdio: "inherit" });
  } catch (e) {
    console.error("❌ Error: Quality gate failed.");
    process.exit(1);
  }

  console.log("✅ Pre-publish checks passed.");
}

check();
