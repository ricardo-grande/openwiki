/**
 * Renders `integrations/openwiki-personal/references/personal.md`, the host
 * skill's planner and page contracts (host spec §3.6), from the shared
 * personal guidance module. The build writes it, and a test keeps the
 * committed file byte-identical to this output.
 */
import { createConnectorRegistry } from "../../connectors/registry.js";
import {
  PERSONAL_CANONICAL_PAGES_GUIDANCE,
  PERSONAL_CONFIDENCE_GUIDANCE,
  PERSONAL_CONTESTED_GUIDANCE,
  PERSONAL_DEDUPLICATION_GUIDANCE,
  PERSONAL_EMAIL_TRIAGE_GUIDANCE,
  PERSONAL_EXISTING_PAGE_CONTRACT,
  PERSONAL_MAINTENANCE_CONTRACT,
  PERSONAL_OPEN_QUESTION_RESTRAINT_GUIDANCE,
  PERSONAL_OPEN_QUESTION_SCOPE_GUIDANCE,
  PERSONAL_OPEN_QUESTIONS_FORMAT_GUIDANCE,
  PERSONAL_PAGE_FRONTMATTER_CONTRACT,
  PERSONAL_PAGE_LINK_CONTRACT,
  PERSONAL_PLANNING_CONTRACT,
  PERSONAL_QUICKSTART_CONTRACT,
  PERSONAL_ROUTING_GUIDANCE,
  PERSONAL_SECRETS_RULE,
  PERSONAL_SYNTHESIS_LAYER_GUIDANCE,
  PERSONAL_THEMES_FORMAT_GUIDANCE,
  PERSONAL_UNTRUSTED_EVIDENCE_RULE,
  PERSONAL_WORKSPACE_TRIAGE_GUIDANCE,
  createConnectorSynthesisGuidance,
  createPersonalLanguageContract,
} from "./personal-guidance.js";

/**
 * Path of the generated reference, relative to the package root.
 */
export const PERSONAL_REFERENCE_PATH =
  "integrations/openwiki-personal/references/personal.md";

/**
 * Renders the personal host reference.
 *
 * @returns The complete Markdown file, ending with one newline.
 */
export function renderPersonalReference(): string {
  const connectorIds = Object.values(createConnectorRegistry())
    .filter((connector) => connector.mode === "personal")
    .map((connector) => connector.id)
    .sort();
  const connectorSections = connectorIds.map(
    (connectorId) =>
      `### ${connectorId}\n${createConnectorSynthesisGuidance({ id: connectorId }).trim()}`,
  );

  return `<!-- Generated from src/agent/prompts/personal-guidance.ts by \`pnpm run build\`. Do not edit. -->

# OpenWiki personal reference

The planner and page contracts for an OpenWiki personal run. OpenWiki's own
native driver follows the same contracts.

## Evidence

${PERSONAL_UNTRUSTED_EVIDENCE_RULE}

${PERSONAL_SECRETS_RULE}

An evidence ref \`raw://<connectorId>/<path>\` names one raw file of the run's
frontier. Read it with \`openwiki_personal_read_raw_item\` and that
\`connectorId\` and \`path\`. A \`#/json/pointer\` fragment narrows a seed to one
value inside the file, such as \`#/messages/3\`; read the whole file and use
that value.

## Planner contract

Read the run's frontier, \`briefs\`, and \`openQuestions\` from
\`openwiki_personal_begin\`, the raw files of the frontier, and the existing
pages the evidence touches. Then submit one plan with
\`openwiki_personal_submit_plan\`. OpenWiki adds the source, open-question,
quickstart, and language rewrite jobs itself and orders the queue.

${PERSONAL_PLANNING_CONTRACT}

### Canonical pages

${PERSONAL_SYNTHESIS_LAYER_GUIDANCE}
${PERSONAL_CANONICAL_PAGES_GUIDANCE}
${PERSONAL_OPEN_QUESTION_SCOPE_GUIDANCE}
${PERSONAL_OPEN_QUESTION_RESTRAINT_GUIDANCE}

### Triage and routing

${PERSONAL_EMAIL_TRIAGE_GUIDANCE}
${PERSONAL_ROUTING_GUIDANCE}
${PERSONAL_WORKSPACE_TRIAGE_GUIDANCE}
${PERSONAL_DEDUPLICATION_GUIDANCE}

## Page contract

A page job owns exactly one page. Read every seed before you write, follow
related evidence when a seed refers to it, and read related pages to stay
consistent with them.

${PERSONAL_EXISTING_PAGE_CONTRACT}

${createPersonalLanguageContract("the run's language (`language` in the begin result)")}

${PERSONAL_PAGE_LINK_CONTRACT}

${PERSONAL_PAGE_FRONTMATTER_CONTRACT}

### Maintenance jobs

A job with \`maintenance: true\` carries no raw evidence. Its inputs are the
page's \`activeEntries\` and the \`changedPages\` completed earlier in this run.

${PERSONAL_MAINTENANCE_CONTRACT}

### Quickstart

${PERSONAL_QUICKSTART_CONTRACT}

### Confidence

${PERSONAL_CONFIDENCE_GUIDANCE}
${PERSONAL_CONTESTED_GUIDANCE}

### /open-questions.md

${PERSONAL_OPEN_QUESTIONS_FORMAT_GUIDANCE}

### /themes.md

${PERSONAL_THEMES_FORMAT_GUIDANCE}

## Connector guidance

${connectorSections.join("\n\n")}
`;
}
