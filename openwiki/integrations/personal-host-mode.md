---
type: integration
title: Personal Host Agent Mode
description: How a host coding agent reads and maintains the personal wiki through the separate openwiki-personal MCP server and skill — the personal tool set, session manager, scoped connector environment, secret redaction, gathering of agentic connectors, and install component.
tags:
  - personal-mode
  - mcp
  - host-agents
  - lifecycle
  - security
verified:
  - by: openwiki/0.7.1
    at: 2026-10-09T14:26:08.776Z
sources:
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-d984e7fe82b9cca5898d9123
    resource: repo://scripts/generate-personal-reference.mjs
  - id: openwiki-source-c2770ac037a7f4b0116a0dc5
    resource: repo://src/config/env.ts
  - id: openwiki-source-de8ae1002d3cb76f17b88053
    resource: repo://src/integrations/install/install-paths.ts
  - id: openwiki-source-c194ba7f94bf86a83012a7b4
    resource: repo://src/integrations/install/registry.ts
  - id: openwiki-source-6f06cc988142430d18f2233e
    resource: repo://src/integrations/mcp/stdio.ts
  - id: openwiki-source-cb5f0a49b9ebde1cea882e1a
    resource: repo://src/integrations/personal/connector-env.ts
  - id: openwiki-source-22d705fc427937586dec2dc5
    resource: repo://src/integrations/personal/lifecycle-tools.ts
  - id: openwiki-source-c1d83b493fbbcf35c781bed4
    resource: repo://src/integrations/personal/retrieval-tools.ts
  - id: openwiki-source-8ea009aa0fcc667f2a1fabaa
    resource: repo://src/integrations/personal/secret-redaction.ts
  - id: openwiki-source-96880e599985f4ab0b8c305c
    resource: repo://src/integrations/personal/session-manager.ts
  - id: openwiki-source-39fa3dcd0447332d30ba4bd9
    resource: repo://src/integrations/personal/status.ts
  - id: openwiki-source-bd0d30d47b383471080b7506
    resource: repo://src/retrieval/wiki.ts
generated: { by: "claude-code", at: "2026-10-09T14:26:08.776Z" }
---

# Personal Host Agent Mode

A coding agent (Codex, Claude Code, OpenCode, and the other registered hosts) can work with the user's personal wiki at `~/.openwiki/wiki` through a **separate** MCP server, `openwiki-personal`, and a matching `openwiki-personal` skill. It is independent of the repository server described in [Coding-agent integrations](coding-agents.md): different server name, different tools, user scope only. The server is model-free; the host's own authenticated model does the planning and page writing, while OpenWiki owns the durable run, the evidence frontier, the single-writer lock, validation, and finalization from the [Personal lifecycle core](../workflows/personal-lifecycle.md).

## Install and start

The personal component is installed with `openwiki integrations install <host> --personal`. It is user-scoped only (`HOST_INTEGRATION_COMPONENTS.personal`), installs the skill `openwiki-personal` and the MCP entry `openwiki-personal`, and the entry launches `openwiki mcp personal --host <host>`. Project scope is rejected with `invalid_input`. The skill bundle lives in `integrations/openwiki-personal/` (a `SKILL.md`, host agent manifests, and `references/personal.md`); the reference file is generated at build time from the shared personal guidance by `scripts/generate-personal-reference.mjs`, so the skill and OpenWiki's native personal prompts state one standard.

`runOpenWikiPersonalMcp` starts the stdio server. Before connecting it calls `scopeOpenWikiEnvLoading([])`, so **no** `~/.openwiki/.env` key loads until a fetching tool asks for the scoped connector environment. When stdin ends or closes, the session closes: it waits for the operation in progress, releases the lock of an unfinished run, and keeps `.run.json`, so another driver (native or another host) can resume it.

## Tool set

`PersonalSessionManager.tools()` returns the retrieval and evidence tools first, then the lifecycle tools, in a fixed order. Every handler is wrapped so results and `HostIntegrationError` messages are redacted (see below).

**Retrieval and read-only evidence** (`createPersonalRetrievalTools`; none loads the connector environment):

- `openwiki_personal_search` and `openwiki_personal_read` search and read the personal wiki without a model call, using a fixed `WikiRetrievalTarget` (id `personal`, directory `~/.openwiki/wiki`, page prefix `/`), so no Git root or workspace is resolved. Paths that begin with `openwiki/` are rejected: personal pages are relative to the personal wiki.
- `openwiki_personal_list_pages` lists concept pages under a directory.
- `openwiki_personal_status` reports the wiki directory, last update, wiki goal, source instances, connector readiness (config present and required env keys set, by key name only), the synthesis cursor, raw runs pending synthesis, and the active run with its lock. It reads saved env keys with `listSavedOpenWikiEnvKeys` and never loads them.
- `openwiki_personal_list_raw_items` and `openwiki_personal_read_raw_item` reuse the connector raw-store helpers, capped at 500,000 characters per read (default 100,000), refusing paths outside the connector raw directory and symbolic links.

**Lifecycle** (`createPersonalLifecycleTools`): `openwiki_personal_ingest`, `openwiki_personal_list_mcp_tools`, `openwiki_personal_call_mcp_tool`, `openwiki_personal_close_gathering`, `openwiki_personal_begin`, `openwiki_personal_submit_plan`, `openwiki_personal_next_page`, `openwiki_personal_write_page`, `openwiki_personal_edit_page`, `openwiki_personal_submit_page`, and `openwiki_personal_finish`. Inputs are strict Zod schemas: ids are UUIDs, a `baseVersion` is `sha256:<hex>` or `absent`, and a page write or edit string larger than 512 KB is rejected.

The advertised server instructions (`PERSONAL_INSTRUCTIONS`) tell the host to use these tools only when the user asks about their own knowledge or asks to refresh their brain, never at task start, and to ask before any pull, gathering call, or begin the user did not request.

## Run sequence as seen by the host

1. Optionally `openwiki_personal_ingest` runs one deterministic pull for every *connected* source instance of a connector, as a scheduled pull would, and starts no run. It refuses agentic connectors (Notion, custom MCP) because their evidence is gathered during a run, and refuses an unconnected connector. The pull window defaults to 24 hours (1 to 168).
2. `openwiki_personal_begin` starts or resumes the run with the session's lock holder `host-<hostId>:<hostname>:<pid>`. A no-op update returns `status: "noop"`. Otherwise the view adds `briefs` (per frontier connector: its synthesis guidance plus the user's ingestion goals for that source) and `openQuestions` (the Active section of `/open-questions.md`). A held lock surfaces as a `conflict`; `takeover: true` is passed only after the user confirms an expired holder is gone.
3. In the `gathering` phase the host queries each still-open agentic connector with `list_mcp_tools` and `call_mcp_tool`, then calls `close_gathering`, which freezes the frontier. These tools require the active run, the gathering phase, and a connector whose gathering is open; they renew the lock and load the scoped connector environment first. Tool names must come from a live discovery, and calls are read-only; refusals are mapped to `invalid_input`. Results come back in an `untrusted: true` envelope capped at 100,000 characters with a `raw://` ref that joins the frontier when gathering closes.
4. In `planning` the host reads the briefs, the frontier's raw files, and the pages they touch, then submits a plan. OpenWiki validates it and adds the required jobs.
5. For each job from `next_page` the host reads the seeds and page, writes exactly that page with `write_page` or `edit_page` carrying a `baseVersion`, and calls `submit_page`. A `conflict` on write means the page changed outside the job: the host re-reads it, re-applies its change, and writes with the new version, never retrying a stale `baseVersion`.
6. `openwiki_personal_finish` finalizes; success is reported only after it returns `complete`.

All operations run under the shared `OperationGuard` (a concurrent call fails with `invalid_state`), errors pass through `mapRepositoryRunError`, and run-bound calls need the exact active `runId` or fail with `invalid_state`.

## Scoped connector environment and secret redaction

The personal server must never expose provider credentials or connector secrets to the host. Two mechanisms enforce this:

- **Scoped loading.** `loadScopedConnectorEnv` computes the allowed key set (`resolveScopedConnectorEnvKeys`): personal connectors' required keys, the Tavily key, OAuth client and token keys used by token refresh, and variables referenced by the Notion and custom-MCP transport configs (`${NAME}` references and bare names in `transport.env`). It calls `scopeOpenWikiEnvLoading` with that set, which always removes `MODEL_PROVIDER_ENV_KEYS`, then loads the env. The first fetching call loads it once; failures reset so a retry can load again.
- **Redaction.** Every value the scoped load read, plus every process env value whose key looks secret, is collected (values of at least 8 characters, longest first) and replaced with `[redacted]` in tool results, object keys, and error messages (`collectSecretValues`, `redactSecretValues`).

Raw connector content and personal wiki content are treated as untrusted evidence, never instructions; the skill tells hosts not to copy personal content into repositories or other tools and to write the wiki only through the page tools, never with native file tools.

## Where to look

- Session and tools: `src/integrations/personal/session-manager.ts`, `lifecycle-tools.ts`, `retrieval-tools.ts`, `status.ts`, `connector-env.ts`, `secret-redaction.ts`, `instructions.ts`.
- Server wiring: `src/integrations/mcp/server.ts` (`createOpenWikiPersonalMcpServer`) and `stdio.ts`.
- Core operations the tools call: `src/generation/personal-run.ts`.
- Tests: `test/integrations/personal-lifecycle-tools.test.ts`, `personal-retrieval-tools.test.ts`, `personal-session-manager.test.ts`, `personal-connector-env.test.ts`, `personal-host-handoff.test.ts`, `personal-skill.test.ts`.
