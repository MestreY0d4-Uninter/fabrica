import fs from "node:fs";
import { pathToFileURL } from "node:url";

export const blockedPatterns = [
  'from "openclaw/plugin-sdk"',
  "from 'openclaw/plugin-sdk'",
  'import("openclaw/plugin-sdk")',
  "import('openclaw/plugin-sdk')",
  'import "openclaw/plugin-sdk";',
  "import 'openclaw/plugin-sdk';",
];

export function findRuntimeBoundaryViolations(bundleText) {
  return blockedPatterns.filter(pattern => bundleText.includes(pattern));
}

export function verifyRuntimeBoundary(distFile = "dist/index.js") {
  const bundle = fs.readFileSync(distFile, "utf8");
  const found = findRuntimeBoundaryViolations(bundle);

  if (found.length > 0) {
    console.error(`Runtime boundary check failed: ${distFile} still imports openclaw/plugin-sdk.`);
    for (const pattern of found) {
      console.error(`- Found blocked pattern: ${pattern}`);
    }
    return false;
  }

  console.log(
    `Runtime boundary check passed: ${distFile} has no runtime imports to openclaw/plugin-sdk.`
  );
  return true;
}

function isMainModule() {
  return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule() && !verifyRuntimeBoundary()) {
  process.exit(1);
}
