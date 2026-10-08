import {
  DynamicStructuredTool,
  type StructuredToolInterface,
} from "@langchain/core/tools";
import { z } from "zod";
import { createOpenWikiConnectorTools } from "../connectors/tools.js";
import { RepositoryRunError } from "../generation/errors.js";
import { isCanonicalPersonalPagePath } from "../generation/personal-run-plan.js";
import { PERSONAL_EDIT_PAGE_TOOL } from "./personal-prompts.js";

/**
 * Connector tools the read-only chat keeps. Each one reads; none fetches,
 * pulls, or writes a raw run.
 */
export const PERSONAL_CHAT_CONNECTOR_TOOLS: ReadonlySet<string> = new Set([
  "openwiki_list_connectors",
  "openwiki_list_raw_items",
  "openwiki_read_raw_item",
]);

/**
 * Wiki filesystem tools of the read-only chat.
 */
export const PERSONAL_CHAT_WIKI_TOOLS = [
  "ls",
  "read_file",
  "glob",
  "grep",
] as const;

/**
 * One edit request from the chat: the page to change and what to change.
 */
export interface PersonalChatEditRequest {
  /**
   * Canonical page path, such as `/commitments.md`.
   */
  page: string;

  /**
   * Self-contained description of the change, recorded as the run's
   * instruction.
   */
  request: string;
}

/**
 * Outcome of a one-page run, as the chat reports it.
 */
export interface PersonalChatEditResult {
  /**
   * `complete` when the page job finished, `interrupted` when it was skipped,
   * or `noop` when nothing changed.
   */
  status: "complete" | "interrupted" | "noop";
}

/**
 * Runs one one-page update: `begin(update, scope.pages = [page], instruction)`
 * and the native driver.
 */
export type PersonalChatEditRunner = (
  request: PersonalChatEditRequest,
) => Promise<PersonalChatEditResult>;

const EditPageSchema = z
  .object({
    path: z
      .string()
      .trim()
      .min(1)
      .describe("Canonical wiki page path, such as /commitments.md."),
    request: z
      .string()
      .trim()
      .min(1)
      .describe(
        "Self-contained description of the change the user asked for on this page.",
      ),
  })
  .strict();

/**
 * Builds the tools of the read-only personal chat: the reading connector
 * tools and the one-page edit tool.
 *
 * @param editPage - Runs a one-page update for an edit request.
 * @returns Chat tools, none of which writes the wiki or pulls a connector.
 */
export function createPersonalChatTools(
  editPage: PersonalChatEditRunner,
): StructuredToolInterface[] {
  const readTools = createOpenWikiConnectorTools("local-wiki").filter(
    ({ name }) => PERSONAL_CHAT_CONNECTOR_TOOLS.has(name),
  );
  const editPageTool = new DynamicStructuredTool({
    name: PERSONAL_EDIT_PAGE_TOOL,
    description:
      "Apply a change the user explicitly asked for to one wiki page. Runs a one-page OpenWiki update that writes the page and finalizes the wiki. Never call it for a question.",
    schema: EditPageSchema,
    func: async ({ path, request }) => {
      if (!isCanonicalPersonalPagePath(path)) {
        return JSON.stringify({
          status: "rejected",
          message: `${path} is not a canonical wiki page path. Use a /-rooted Markdown path such as /commitments.md.`,
        });
      }
      try {
        return JSON.stringify(await editPage({ page: path, request }));
      } catch (error) {
        if (error instanceof RepositoryRunError) {
          return JSON.stringify({ status: error.code, message: error.message });
        }
        throw error;
      }
    },
  });
  return [...readTools, editPageTool];
}
