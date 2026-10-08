/**
 * Writes the personal host skill's reference file from the compiled shared
 * personal guidance module (host spec §3.6). Runs after `tsc`, so it reads
 * `dist/`; a test keeps the committed file byte-identical to this output.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PERSONAL_REFERENCE_PATH,
  renderPersonalReference,
} from "../dist/agent/prompts/personal-reference.js";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

writeFileSync(
  path.join(packageRoot, PERSONAL_REFERENCE_PATH),
  renderPersonalReference(),
);
