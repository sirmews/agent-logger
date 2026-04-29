import pkg from "../package.json";
import { readFileSync } from "fs";
import { join } from "path";

const semverRegex = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

if (!semverRegex.test(pkg.version)) {
  console.error(`Invalid SemVer version in package.json: ${pkg.version}`);
  process.exit(1);
}

console.log(`Version ${pkg.version} is valid SemVer.`);

// Optional: Check if SCHEMA_VERSION changed but version didn't bump (requires git)
// For now, just ensure SCHEMA_VERSION exists in src/index.ts
const indexContent = readFileSync(join(__dirname, "../src/index.ts"), "utf-8");
const schemaVersionMatch = indexContent.match(/const SCHEMA_VERSION = (\d+);/);

if (!schemaVersionMatch) {
  console.error("Could not find SCHEMA_VERSION in src/index.ts");
  process.exit(1);
}

const schemaVersion = parseInt(schemaVersionMatch[1], 10);
console.log(`Detected SCHEMA_VERSION: ${schemaVersion}`);

// In a real CI, we would compare with the main branch's version.
