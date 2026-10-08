import path from "node:path";
import { ClaimSessionError } from "../../core/errors.js";

/**
 * OpenWiki-owned claims directory relative to the wiki root.
 */
export const CLAIMS_DIRECTORY = ".claims";

/**
 * Virtual page prefix of the code-mode wiki, which lives in `openwiki/` below
 * the repository root.
 */
export const CODE_WIKI_PAGE_PREFIX = "/openwiki/";

/**
 * Markdown basenames excluded from factual claim persistence.
 */
export const RESERVED_WIKI_FILES: ReadonlySet<string> = new Set([
  "index.md",
  "log.md",
  "instructions.md",
]);

/**
 * Canonicalizes a virtual generated-page path.
 *
 * @param page - Agent-supplied page path.
 * @param pagePrefix - Virtual prefix of the wiki's pages, such as
 *   `/openwiki/` for code mode or `/` for a wiki rooted at its directory.
 * @returns Canonical `<pagePrefix>...md` path.
 */
export function normalizeWikiPagePath(
  page: string,
  pagePrefix: string = CODE_WIKI_PAGE_PREFIX,
): string {
  const slashed = page.trim().replace(/\\/gu, "/");
  if (hasTraversalSegment(slashed)) {
    throw new ClaimSessionError(
      `Claim page cannot contain traversal segments: ${page}`,
    );
  }
  const absolute = path.posix.normalize(`/${slashed.replace(/^\/+/, "")}`);
  if (!absolute.startsWith(pagePrefix) || !absolute.endsWith(".md")) {
    throw new ClaimSessionError(
      `Claim page must be a Markdown file below ${describeWikiRoot(pagePrefix)}: ${page}`,
    );
  }
  if (!isGroundedWikiPage(absolute, pagePrefix)) {
    throw new ClaimSessionError(
      `Claim page is reserved or structural: ${page}`,
    );
  }
  return absolute;
}

/**
 * Canonicalizes a model-supplied page with an optional wiki-root prefix.
 *
 * @param page - Agent-supplied canonical, repository-relative, or wiki-relative path.
 * @param pagePrefix - Virtual prefix of the wiki's pages.
 * @returns Canonical `<pagePrefix>...md` path for internal Claims APIs.
 */
export function normalizeClaimsToolPagePath(
  page: string,
  pagePrefix: string = CODE_WIKI_PAGE_PREFIX,
): string {
  return normalizeWikiPagePath(
    normalizeWikiToolPagePath(page, pagePrefix),
    pagePrefix,
  );
}

/**
 * Canonicalizes a model-supplied generated Markdown path.
 *
 * Unlike {@link normalizeClaimsToolPagePath}, this permits structural generated
 * pages that do not own Claims. Claims implementation files remain unavailable.
 *
 * @param page - Agent-supplied canonical, repository-relative, or wiki-relative path.
 * @param pagePrefix - Virtual prefix of the wiki's pages.
 * @returns Canonical `<pagePrefix>...md` path for a generated Markdown file.
 */
export function normalizeWikiToolPagePath(
  page: string,
  pagePrefix: string = CODE_WIKI_PAGE_PREFIX,
): string {
  const slashed = page.trim().replace(/\\/gu, "/");
  if (hasTraversalSegment(slashed)) {
    throw new ClaimSessionError(
      `Wiki page cannot contain traversal segments: ${page}`,
    );
  }
  const unrooted = slashed.replace(/^\/+/, "");
  const wikiDirectory = pagePrefix.slice(1);
  const rooted =
    unrooted === wikiDirectory.slice(0, -1) ||
    unrooted.startsWith(wikiDirectory)
      ? unrooted
      : `${wikiDirectory}${unrooted}`;
  const normalized = path.posix.normalize(`/${rooted}`);
  const segments = normalized.toLowerCase().split("/");
  if (
    !normalized.startsWith(pagePrefix) ||
    !normalized.endsWith(".md") ||
    segments.includes(CLAIMS_DIRECTORY)
  ) {
    throw new ClaimSessionError(
      `Wiki page must be a Markdown file below ${describeWikiRoot(pagePrefix)}: ${page}`,
    );
  }
  return normalized;
}

/**
 * Determines whether a virtual Markdown path owns code-brain claim state.
 *
 * @param page - Canonical or candidate virtual page path.
 * @param pagePrefix - Virtual prefix of the wiki's pages.
 * @returns Whether the page receives a `.claims` sidecar.
 */
export function isGroundedWikiPage(
  page: string,
  pagePrefix: string = CODE_WIKI_PAGE_PREFIX,
): boolean {
  const slashed = page.replace(/\\/gu, "/");
  if (hasTraversalSegment(slashed)) {
    return false;
  }
  const normalized = path.posix.normalize(`/${slashed.replace(/^\/+/, "")}`);
  const normalizedLower = normalized.toLowerCase();
  const basename = path.posix.basename(normalizedLower);
  const segments = normalizedLower.split("/");
  return (
    normalized.startsWith(pagePrefix) &&
    normalized.endsWith(".md") &&
    !segments.includes(CLAIMS_DIRECTORY) &&
    !RESERVED_WIKI_FILES.has(basename)
  );
}

/**
 * Determines whether a path uses dot-segment aliases.
 *
 * @param filePath - Slash-normalized candidate path.
 * @returns Whether the path contains `.` or `..` segments.
 */
function hasTraversalSegment(filePath: string): boolean {
  return filePath
    .split("/")
    .some((segment) => segment === "." || segment === "..");
}

/**
 * Converts a virtual generated-page path into its path below the store root.
 *
 * @param page - Canonical virtual page path.
 * @param pagePrefix - Virtual prefix of the wiki's pages.
 * @returns Root-relative POSIX path, beginning with `openwiki/` in code mode.
 */
export function toRepositoryPagePath(
  page: string,
  pagePrefix: string = CODE_WIKI_PAGE_PREFIX,
): string {
  return normalizeWikiPagePath(page, pagePrefix).replace(/^\//u, "");
}

/**
 * Converts a virtual generated-page path into its sidecar-relative path.
 *
 * @param page - Canonical virtual page path.
 * @param pagePrefix - Virtual prefix of the wiki's pages.
 * @returns Path relative to the wiki's `.claims` with a `.json` extension.
 */
export function toClaimsSidecarRelativePath(
  page: string,
  pagePrefix: string = CODE_WIKI_PAGE_PREFIX,
): string {
  const relativePage = normalizeWikiPagePath(page, pagePrefix).slice(
    pagePrefix.length,
  );
  return relativePage.replace(/\.md$/u, ".json");
}

/**
 * Names a wiki's virtual root in validation messages.
 *
 * @param pagePrefix - Virtual prefix of the wiki's pages.
 * @returns `/openwiki` for code mode, or `/` for a wiki rooted at its directory.
 */
function describeWikiRoot(pagePrefix: string): string {
  return pagePrefix === "/" ? "/" : pagePrefix.slice(0, -1);
}
