import { validateEvidenceTree } from "./gate.js";

try {
  const manifests = await validateEvidenceTree();
  console.log(`evidence validation: ok (${manifests.length} manifests)`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
