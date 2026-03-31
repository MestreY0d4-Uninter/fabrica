import fs from "node:fs";

const distFile = "dist/index.js";
const blockedPatterns = [
  'from "openclaw/plugin-sdk"',
  "from 'openclaw/plugin-sdk'",
  'import("openclaw/plugin-sdk")',
  "import('openclaw/plugin-sdk')",
];

const bundle = fs.readFileSync(distFile, "utf8");
const found = blockedPatterns.filter(pattern => bundle.includes(pattern));

if (found.length > 0) {
  console.error(`Runtime boundary check failed: ${distFile} still imports openclaw/plugin-sdk.`);
  for (const pattern of found) {
    console.error(`- Found blocked pattern: ${pattern}`);
  }
  process.exit(1);
}

console.log(`Runtime boundary check passed: ${distFile} has no runtime imports to openclaw/plugin-sdk.`);
