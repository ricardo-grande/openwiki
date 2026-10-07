# Personal Host Mode — research notes

Status: **research draft, v4** · Scope: expose OpenWiki's *personal mode* (the
local "personal brain") to host coding agents over MCP, the same way *code mode*
is exposed today.

All file references are to the current `main` (`9d51767`). Source code is the
authority; this document records what the code does today and what would have
to change.

---

## 1. TL;DR

- **Code mode was refactored into a "lifecycle core + drivers" shape; personal
  mode was not.** Code mode has a durable, model-free lifecycle core
  (`src/generation/repository-run.ts`) driven either by OpenWiki's own model
  (`src/agent/repository-runner.ts`) or by a host coding agent over MCP
  (`src/integrations/core/session-manager.ts` → `src/integrations/mcp/server.ts`).
  Personal mode is still a single monolithic DeepAgents run
  (`runOpenWikiAgentCore`, `src/agent/index.ts:575`) whose behavior lives in a
  ~70 KB prompt (`src/agent/prompts/personal.ts`) and whose deterministic
  finalization is hidden inside agent middleware
  (`createOpenWikiIndexMiddleware`, `src/agent/okf-middleware.ts:50`).
- **Nothing about personal mode is reachable over MCP today.** All ten MCP tools
  require `root` to be an absolute Git repository root, and
  `resolveRepositoryRoot` explicitly *refuses the home directory*
  (`src/integrations/core/repository-root.ts:115-132`). The personal wiki lives at
  `~/.openwiki/wiki` (not a Git repo, pages at the root rather than under
  `openwiki/`). The README states it directly: "Host-driven runs currently
  support repository code wikis, not personal brains" (`README.md:106`).
- **The deterministic parts of personal mode already exist as reusable,
  model-free functions.** These are `prepareWikiForAuthoring` /
  `finalizeWikiArtifacts` (`src/agent/wiki-finalizer.ts`), the connector
  ingest/list/read functions (`src/connectors/tools.ts`), and connector
  configuration and state (`src/connectors/io.ts`, `src/setup/onboarding.ts`). A
  host driver can be built mostly by *re-hosting* these behind MCP tools and
  moving the prompt's "personal brain" contract into a host skill.
- **Three non-obvious blockers sit beyond the MCP layer:**
  - **The wiki is outside the host's workspace.** Hosts cannot rely on their
    native editors there (sandboxing, approvals), so page writes must go through
    confined MCP tools (§7 option C).
  - **The MCP process deliberately never loads `~/.openwiki/.env`.** Ingestion
    needs a *scoped* connector-only env loader, so the user's LLM keys never
    enter a process serving a third-party model (§6.5).
  - **Personal mode assumes an OpenWiki LLM everywhere.** Onboarding is gated on
    a provider, and every `openwiki ingest` (including the launchd job) ends in
    an agent synthesis run. A host-only user cannot even get started without
    model-free setup and pull-only ingestion (§6.6).
- **Recommended path (phased):**
  1. Model-free personal retrieval: search and read over `~/.openwiki/wiki`.
  2. Model-free connector evidence tools: status, list/read raw items, and a
     deterministic pull.
  3. A durable, session-bracketed authoring lifecycle (`begin` → confined page
     edits → `finish`) that reuses the existing finalizer.
  4. Optionally, a page-job core with a personal Claims brain for full parity
     with code mode.

  All personal tools sit behind an explicit `--personal` opt-in on the existing
  `openwiki mcp` server. Details in §7–§9.
- **Full redesign (§10).** Giving personal mode code mode's "model-free core +
  drivers" shape is feasible. The key enabler is that raw connector dumps are
  immutable, so a run freezes an *evidence frontier* at `begin` and never needs
  code mode's source-drift replanning.
  - It takes a sibling core to `repository-run.ts` that reuses its generic
    building blocks (finalizer, backend, state helpers, worker loop), a
    wiki-layout parameterization, a personal core
    (frontier, synthesis cursor, personal plan rules, `.run.json` lock), and a
    native planner/page-worker driver.
  - The 70 KB prompt gets split by lifecycle role. A personal Claims brain over
    `raw://` evidence with temporal staleness is an optional final step.
  - The host driver can ship before the native driver is re-platformed.

---

## 2. Architecture primer: two axes

OpenWiki varies along two independent axes (see also the generated
`openwiki/architecture/overview.md#the-two-axes`):

| | **Native driver** (OpenWiki's own model) | **Host driver** (coding agent's model over MCP) |
|---|---|---|
| **Code mode** (`outputMode: "repository"`, writes `<repo>/openwiki/`) | `openwiki --init/--update` → `runNativeRepositoryGeneration` (planner agent + per-page workers) | `openwiki mcp --host <id>` → `HostSessionManager` → the same lifecycle core |
| **Personal mode** (`outputMode: "local-wiki"`, writes `~/.openwiki/wiki`) | `openwiki personal [--init/--update]`, `openwiki ingest`, cron → `runOpenWikiAgentCore` (one DeepAgent) | **does not exist** ← this document |

Mode selection: `getRunModeCwd` / `getRunModeOutputMode`
(`src/cli/run-mode.ts:40-59`) map `personal` → `openWikiLocalWikiDir` +
`"local-wiki"`. The home directory is `OPENWIKI_CONFIG_DIR` or `~/.openwiki`
(`src/config/openwiki-home.ts:8-50`). Its layout:

```
~/.openwiki/
  .env                     provider + connector secrets (loadOpenWikiEnv)
  openwiki.sqlite          LangGraph checkpointer for chat threads
  wiki/                    ← the personal wiki (virtual root "/")
    quickstart.md, open-questions.md, themes.md, commitments.md,
    personal-logistics.md, sources/<connector>.md, …, .last-update.json
  connectors/<id>/
    config.json, state.json, raw/<runId>/<files>.json, logs/
  conversation_history/    DeepAgents history offload mount
  skills/                  bundled skills mounted at /skills/
```

---

## 3. How code mode is mapped to MCP

### 3.1 Layers

```
host agent (Codex, Claude Code, …)
  │  skill: integrations/openwiki/SKILL.md  (procedure + page/Claims contract)
  │  MCP config: `openwiki mcp --host <id>`  (written by `openwiki integrations install`)
  ▼
src/integrations/mcp/stdio.ts          StdioServerTransport, never writes stdout
src/integrations/mcp/server.ts         McpServer + INSTRUCTIONS; registers ProtocolTool[];
                                       JSON result → text + structuredContent;
                                       HostIntegrationError → "code: message", others → generic
src/integrations/core/protocol.ts      strict Zod schemas, ProtocolToolName union (10 names)
src/integrations/core/retrieval-tools.ts   4 read-only tools (no run state)
src/integrations/core/session-manager.ts   6 lifecycle tools; ≤1 active run per process;
                                           one operation at a time; runId must match;
                                           RepositoryRunError → HostIntegrationError
src/integrations/core/repository-root.ts   absolute path → realpath → git top-level;
                                           refuses "/" and $HOME
  ▼
src/generation/repository-run.ts       durable, model-free lifecycle core
  (run-state.ts .run.json, page-jobs.ts plan/Claims reconciliation,
   page-manifest.ts per-page source checkpoints)
  ▼
claims/, okf/, agent/wiki-finalizer.ts, agent/docs-only-backend.ts
```

The **native** code-mode driver (`src/agent/repository-runner.ts:346`) calls
*exactly the same core functions*. A planner DeepAgent gets a `submit_plan` tool
that wraps `submitRepositoryPlan`, and page workers get a submit tool that wraps
`submitRepositoryPage`. That symmetry is what made the host integration cheap:
the MCP layer is a thin adapter, and the *model-owned* work (research, planning,
prose, Claim decisions) moves from OpenWiki's prompts into the host skill.

### 3.2 Tool-by-tool mapping

| MCP tool | Session manager | Core function | Native-driver equivalent |
|---|---|---|---|
| `openwiki_list_workspaces` | — (`retrieval-tools.ts`) | `listWikiWorkspaces` (`linking/wiki-workspaces.ts`) | `openwiki workspace current` (CLI) |
| `openwiki_list_wikis` | — | `listWorkspaceWikis` | `openwiki link` TUI |
| `openwiki_search` | — | `searchWiki` (`retrieval/wiki.ts:428`, per-call in-memory FTS5) | none (native agent uses grep) |
| `openwiki_read` | — | `readWikiSections` (`retrieval/wiki.ts:627`) | none |
| `openwiki_begin` | `begin` | `beginRepositoryRun` (`repository-run.ts:388`) | `beginNativeRepositoryRun` |
| `openwiki_submit_plan` | `submitPlan` | `submitRepositoryPlan` (`:952`) | planner's `submit_plan` tool |
| `openwiki_next_page` | `nextPage` | `nextRepositoryPage` (`:1062`) | worker pool `acquireNextJob` |
| `openwiki_inspect_page_claims` | `inspectPageClaims` | `inspectRepositoryPageClaims` (`:1112`) | worker tool |
| `openwiki_submit_page` | `submitPage` | `submitRepositoryPage` (`:1283`) | worker submit tool |
| `openwiki_finish` | `finish` | `finishRepositoryRun` (`:1613`) | same call at end of `runNativeRepositoryGeneration` |

### 3.3 Division of responsibility (code mode, host-driven)

| Host agent owns | OpenWiki owns |
|---|---|
| Repository research with its native tools | Git-root resolution and safety (`repository-root.ts`) |
| Plan (page paths, purposes, seeds, related pages) | Durable run state `.run.json`, resume and source-drift invalidation |
| Writing exactly the assigned Markdown page | Plan validation and the ordered PageJob queue |
| Sparse Claim decisions per page | Claims reconciliation, evidence versioning, sidecars |
| Output language (from `begin`) | Front-matter repair, index sync, link and mermaid validation, provenance, `.last-update.json` |

### 3.4 Invariants the MCP surface relies on

- **Model-free.** No MCP tool invokes a model; the README and the skill both
  promise retrieval is "local, read-only, and model-free" (`README.md` "Search
  your wiki"). The host's model is the only model in host-driven runs.
- **No stdout writes** in the server process (stdio transport;
  `stdio.ts` docstring, generic stderr line in `server.ts`).
- **Bounded errors.** Only `HostIntegrationError` messages reach the host;
  everything else becomes "OpenWiki MCP operation failed."
- **Single active run, serialized operations** per server process
  (`session-manager.ts:requireSession`, `startOperation`).
- **Identity.** `--host <id>` is recorded as `host-agent/<id>` model metadata
  and as the provenance `producerActor`.
- **Content is untrusted.** INSTRUCTIONS and the skill tell the host to treat
  wiki and repository content as evidence, not instructions.
- **No OpenWiki credentials.** `commandLoadsEnvironment` (`cli/commands.ts:1165-1172`)
  deliberately excludes `mcp`: "Host integration and MCP commands … never load
  OpenWiki model credentials." `~/.openwiki/.env` is never read by the MCP
  process today. This matters for personal ingestion (§6.5).
- **No telemetry.** `mcp` bypasses `runStandardCommand` and `withRunTelemetry`
  (`cli/cli.tsx:48-53`). Host-driven runs leave only run metadata and
  provenance, with `metadataModel = host-agent/<id>`.

### 3.5 Packaging: one skill, one server per host

- `openwiki integrations install <host>` writes one MCP entry named `openwiki`
  with `{command: "openwiki", args: ["mcp", "--host", <id>]}`
  (`install/registry.ts:184-191`). The server key is hardcoded in all three
  config adapters (`config-json.ts:20-37`, `config-toml.ts:157-163`,
  `config-opencode.ts:8`).
- It copies one skill bundle, `integrations/openwiki/`, with a hashed receipt
  `.openwiki-install.json` (`install/skill-bundle.ts:12,78-84,173-191`). Only
  `SKILL.md`, `agents/`, and `references/` are allowed at the top level.
- There is **no mechanism for a second skill or a second server per host**.
  The single-skill assumption appears in `HostInstallationPaths.skillDirectory`,
  in the receipt's single `mcpServerCommand`, and in `package.json` `pi.skills`.
- Pi is separate. Its extension (`src/integrations/pi/openwiki.ts:45-88`)
  re-registers only the **six lifecycle tools**, so Pi users get no retrieval
  tools at all today, even though the spawned server exposes them.
- `CONTRIBUTING.md:60-93` sets the policy: one canonical skill, the 4 + 6 tools
  named explicitly, "add host-specific behavior to the registry and config
  boundary rather than … adding host-specific tools", and "keep the v1 boundary
  narrow".
- Consequence: **the cheapest delivery is more tools on the same server plus
  more text (or a `references/` file) in the same skill.** A separate
  `openwiki-personal` skill or server is an installer refactor.

---

## 4. Personal mode anatomy

### 4.1 Entry points

| Surface | What it does | Model? |
|---|---|---|
| `openwiki personal` (chat) | DeepAgent turn with the `chat` system prompt; persistent SQLite checkpointer (`resolveCheckpointTarget`, `agent/index.ts:937`); answers wiki-first; edits docs only when asked | yes |
| `openwiki personal --init [msg]` | DeepAgent with the `init` prompt: knowledge inventory → `/quickstart.md` → section pages | yes |
| `openwiki personal --update [msg]` | DeepAgent with the `update` prompt: map changed evidence to canonical pages, minimal edits, no-op allowed | yes |
| `openwiki ingest <source\|instance\|all>` | `runOpenWikiIngestion` (`ingestion/ingestion.ts:68`): per configured source instance, a deterministic `connector.ingest()` pull (24h window) **then** one source-scoped `update` agent run with a generated prompt that names the raw files | pull: no · synthesis: yes |
| `openwiki cron list\|pause\|resume\|delete` | scheduled `ingest` (see §4.6) | via ingest |
| `openwiki auth …` | provider/connector credentials, OAuth, MCP tool discovery (see §4.6) | no |
| first-run onboarding (TUI) | wiki goal, sources, schedule (see §4.6) | no, but **gated on a configured LLM provider** |

### 4.2 Runtime: one DeepAgent

`createOpenWikiAgentGraph` (`src/agent/index.ts:468`) for `outputMode:
"local-wiki"`:

- **Backend:** `OpenWikiLocalShellBackend` rooted at `~/.openwiki/wiki`, virtual
  mode, composed with `/conversation_history/` and `/skills/` mounts
  (`agent/agent-backend.ts`). `docsOnly` is relaxed for local-wiki
  (`docs-only-backend.ts:43-49`). Claims ownership checks apply only to the
  repository output mode.
- **Filesystem tools:** `ls, read_file, glob, grep, write_file, edit_file`. There
  is **no shell**: the filesystem middleware is replaced for local-wiki
  (`index.ts:505-520`).
- **Connector tools:** `createOpenWikiConnectorTools("local-wiki")`
  (`src/connectors/tools.ts:31`), see §4.3. They return `[]` for repository mode.
- **Middleware (init/update only, *not chat*):**
  - `createWikiTranslationMiddleware`: a `beforeAgent` pass that retranslates the
    wiki when `--language` changes. **This pass uses the model.**
  - `createOpenWikiIndexMiddleware`: `beforeAgent` → `prepareWikiForAuthoring`
    (OKF migration plus provenance snapshot), `wrapToolCall` → front-matter repair
    after every write, `afterAgent` → `finalizeWikiArtifacts` (mermaid validation,
    index sync, link validation, provenance). **All of this is deterministic.**
- **Run metadata:** `persistRunMetadataIfChanged` writes
  `~/.openwiki/wiki/.last-update.json` (`agent/utils.ts`). For local-wiki there is
  no `gitHead`. Failure leaves `status: "interrupted"`. There is no `.run.json`,
  no page queue, no resume, and no Claims (`prepareClaimsRuntime` returns early
  unless the mode is `repository`, `claims/brains/code/runtime.ts:72`).

Observation: **personal chat writes are never finalized.** The index middleware
is only installed when `command !== "chat"` (`index.ts:521`), so a chat turn
that edits the wiki skips front-matter repair and index sync until the next
init/update.

### 4.3 Personal agent tools (none exposed over MCP)

| Agent tool (`connectors/tools.ts`) | Function | External I/O | Writes | Model-free |
|---|---|---|---|---|
| `openwiki_list_connectors` | `listConnectors` | none | none | ✅ |
| `openwiki_ingest_connector` | `registry[id].ingest(opts)` | credentialed fetch (Gmail, Slack, X, Tavily, HN, git, MCP) | `connectors/<id>/raw/<runId>/…`, `state.json` | ✅ (pull itself) |
| `openwiki_ingest_all_connectors` | `Promise.allSettled(ingest())` | as above, all connectors | as above | ✅ |
| `openwiki_list_mcp_tools` | `discoverMcpConnectorTools` (`notion`, `custom-mcp`) | MCP client to the user's server | discovery dump in raw | ✅ |
| `openwiki_call_mcp_tool` | `callMcpConnectorTool` | MCP call, *read-only enforcement* (see §4.6) | result dump in raw | ✅ |
| `openwiki_list_raw_items` | `listRawItems` | none | none | ✅ |
| `openwiki_read_raw_item` | `readRawItem` (symlink-safe, ≤500 KB) | none | none | ✅ |
| `ls/read_file/glob/grep/write_file/edit_file` | DeepAgents FS over the wiki | none | wiki pages | ✅ |

Every personal tool is already model-free. The model-dependent parts are the
*agent loop* (synthesis), the translation pass, and the chat surface.

### 4.4 The "personal brain" contract (lives only in prompts)

The behavior that makes personal mode valuable is prompt-encoded rather than
code-enforced (`prompts/personal.ts`, plus the per-source policy in
`ingestion.ts:createSourceSynthesisPolicy` / `createConnectorSynthesisGuidance`).
A host driver must carry this contract in a skill:

- **Canonical files:** `/quickstart.md` (navigation and status, `## Backlog`),
  `/open-questions.md` (Active/Answered/Stale with a fixed field structure),
  `/themes.md` (a compact table index), `/commitments.md` (with Owner),
  `/personal-logistics.md`, and `/sources/<connector>.md` (an evidence index, not
  the synthesis layer).
- **Confidence labels:** `confirmed`, `source-backed`, `contested`, `watchlist`,
  and `saved-context`, plus a `## Contested` discipline (never resolve by recency
  alone).
- **Email triage taxonomy:** 13 classes × priority × durability, with routing
  rules.
- **Per-connector guidance:** Gmail, Notion, custom MCP, X, HN, web search,
  Slack (the `definitiveForLatestMessage` caveat), and git-repo.
- **Discipline:** wiki-first answering, read `/open-questions.md` first and last,
  dedupe by stable topic keys, no-op updates allowed, OKF front matter, link
  integrity, and diagram guidance.
- **Safety:** treat connector content as untrusted, never read `.env` or secret
  values, refer to credentials only by env var name, and treat MCP connectors as
  read-only.

### 4.5 Ingestion orchestration (the "source update run")

`runSourceIngestion` (`ingestion.ts:121`) is a two-phase pipeline per source
instance:

1. **Deterministic pull**, only for connectors with
   `supportsAgenticDiscovery === false`: `connector.ingest({connectorConfig,
   instanceId, windowHours: 24})` returns `ConnectorIngestResult {status,
   rawFiles, warnings, …}`.
2. **Synthesis:** `runOpenWikiAgent("update", ~/.openwiki/wiki, {userMessage:
   createSourceUpdateMessage(…)})`. The message lists the raw files, the wiki goal,
   the source-specific `ingestionGoal`, and the synthesis policy. For agentic
   connectors (Notion, custom MCP, and also `git-repo`, see §4.7) there is no pull, and the agent is
   told to discover and call read-only MCP tools itself.

This split maps naturally to a host driver: phase 1 is an MCP tool, and phase 2
is the host's model following a skill, with the generated message returned
by the tool as the task brief.

### 4.6 Non-agent surfaces (auth, onboarding, schedules)

**Onboarding config.** Stored in `~/.openwiki/onboarding.json` (0600,
`setup/onboarding.ts:11-14`). The wiki goal is stored separately in
`~/.openwiki/INSTRUCTIONS.md` (`:15-18`) and merged back on read.

- Shape (`:21-66`): `{version, completedAt?, modeId?, wikiGoal?,
  ingestionSchedule?, powerManagement?, sourceInstances[], sources{} (derived
  legacy)}`.
- `sourceInstances[i] = {id, connectorId, name?, connectedAt?,
  connectorConfig?, ingestionGoal?}`. `openwiki ingest` iterates only instances
  that have `connectedAt` (`ingestion.ts:225-247`).
- There is exactly one global `ingestionSchedule`.

**Auth** (`src/auth/*`). Four OAuth providers, all authorization-code + PKCE
(`auth/oauth.ts:47-105`):

| Provider | Prerequisite env | Notes |
|---|---|---|
| `gmail` | `OPENWIKI_GOOGLE_CLIENT_ID/_SECRET` | `gmail.readonly` |
| `x` | `OPENWIKI_X_CLIENT_ID` | |
| `slack` | `OPENWIKI_SLACK_CLIENT_ID/_SECRET` | the only provider using an HTTPS redirect, hence `openwiki ngrok` |
| `notion` | none | dynamic client registration with mcp.notion.com |

- `runOAuthAuth` opens a browser and blocks on a loopback callback server
  (`127.0.0.1:53682`) **with no timeout** (`oauth.ts:385-467`).
- It already supports `silent` + `onAuthorizationUrl` (`oauth.ts:37-45`),
  which is how the TUI surfaces the URL.
- Token refresh is model-free and non-interactive (`auth/tokens.ts:32-123`), but
  needs the client secret for Gmail and Slack.
- All secrets live in `~/.openwiki/.env` (0600, atomic writes,
  `config/env.ts:318-389`). That file holds **both** LLM-provider keys and
  connector tokens.
- `openwiki auth configure <p>` writes a default connector `config.json`
  (`auth/configure.ts:29-166`) with no network access.
- **`openwiki auth <p>` never creates a `sourceInstance`**, so a connector that
  was authorized only through the CLI is ignored by `openwiki ingest all`.

**Schedules** (`scheduling/schedules.ts`).

- macOS only: a launchd agent `~/Library/LaunchAgents/com.openwiki.ingestion.plist`
  runs `[node, cli, "ingest", "all", "--scheduled", "--print"]`
  (`schedules.ts:822-833`). On other platforms the schedule is saved with a
  warning and nothing runs.
- Optional `pmset` wake windows go through an `osascript … with administrator
  privileges` prompt (`:357-412`). `cron pause/resume/delete` can re-trigger
  that prompt.

**First-run onboarding (TUI).** Steps: provider/credential/model (**mandatory**,
`setup/credentials/steps.ts:74-98`) → wiki goal → global schedule (installs
launchd immediately) → power window → per-source loop (secret paste or OAuth
→ config → `ingestionGoal`) → "Run ingestion now".

- The step logic is partly pure (`steps.ts`, `constants.ts`, `persistence.ts`).
- The save actions (`configureLocalGitRepo`, `saveSelectedSourceDescription`,
  `saveModeSchedule`, …) are trapped inside the 2,779-line
  `use-init-setup.ts` hook. Each one is short and could be lifted out.

**Model dependence.**

- Model-free: every connector `ingest()`, auth, refresh, MCP discovery and calls,
  config, cron, and raw-item access.
- Model-bound:
  - `openwiki personal *`
  - `openwiki ingest`, which runs one full agent `update` per source instance
    after the pull (`ingestion.ts:177-200`). The scheduled job therefore needs an
    LLM as well.
  - TUI onboarding, which is gated on a configured provider.

### 4.7 Side findings (inconsistencies worth fixing independently)

All of these were verified in source.

1. **git-repo is never pulled by `openwiki ingest`.** `git-repo` declares
   `supportsAgenticDiscovery: true` (`connectors/sources/git-repo.ts:48`), and
   `runSourceIngestion` only pulls when that flag is false. Its cheap,
   deterministic manifest is produced only when the agent happens to call
   `openwiki_ingest_connector`.
2. **LangSmith instances are dropped.** `isKnownConnectorId`
   (`setup/onboarding.ts:459-470`) duplicates `CONNECTOR_IDS` but omits
   `langsmith`, so normalization silently drops LangSmith instances. LangSmith
   is code-mode only, so this may be intentional, but it is undocumented.
3. **Code-mode LangSmith guidance names tools workers do not have.** The guidance
   says to "Inspect it with `openwiki_list_raw_items` and `openwiki_read_raw_item`"
   (`ingestion.ts:407`), and `runCodeModeConnectors` appends it to the planning
   context (`ingestion/code-mode.ts:130-172`). But repository planners and page
   workers only have `read_file/ls/glob/grep(/write/edit)` plus their submit
   tools, rooted at the repository (`agent/repository-runner.ts:87-98`). The
   dump under `~/.openwiki/connectors/langsmith/raw/` is unreachable to them.
   This is the same gap that keeps "connector-sourced context" out of
   host-driven code runs (`README.md:106`). The phase-B evidence tools would
   close it for hosts too.
4. **Native chat edits are never finalized** (§4.2).
5. **The scheduled run's `--print` is parsed but ignored** by `runIngestCommand`
   (`cli/runners.ts:151-184`).
6. **`writableWikiPages` has no effect in local-wiki mode.**
   `getDocsOnlyWriteError` returns early when `outputMode === "local-wiki"`
   (`agent/docs-only-backend.ts:583`), before the per-page check at `:591-596`.
   This is harmless today because nothing passes the option for local-wiki. A
   page-confined personal worker needs it fixed (§10).
7. **Connector raw dumps are never pruned.** No retention code exists under
   `src/connectors`. Every pull adds a `raw/<runId>/` directory forever. This
   makes the evidence immutable, which §10 relies on, but it is also an
   unbounded store of private data.

---

## 5. Gap analysis: what is not exposed over MCP

| Personal capability | Where it lives today | MCP today | Notes for exposure |
|---|---|---|---|
| Search the personal wiki | none (agent greps) | ❌ `openwiki_search` requires a Git root and `openwiki/` layout | Needs a wiki-root abstraction in `retrieval/wiki.ts` (see §6.1) |
| Read sections of the personal wiki | none | ❌ | same |
| List connectors and readiness | agent tool `openwiki_list_connectors` | ❌ | trivially model-free; already secret-safe |
| List/read raw connector evidence | agent tools `openwiki_list_raw_items`, `openwiki_read_raw_item` | ❌ | model-free, already path-confined; exposes private data to the host model (§6.3) |
| Deterministic ingestion pull | agent tool `openwiki_ingest_connector`, `ingestion.ts` phase 1 | ❌ | credentialed network I/O inside the MCP process; long-running |
| Ingest all | agent tool `openwiki_ingest_all_connectors` | ❌ | the prompt itself discourages it during source runs |
| MCP connector discovery and calls | agent tools `openwiki_list_mcp_tools`, `openwiki_call_mcp_tool` | ❌ | an MCP proxy *through* OpenWiki; read-only enforcement must hold |
| Source-scoped update brief | `createSourceUpdateMessage` + synthesis policy | ❌ | should become the `begin` payload for a personal session |
| Personal init/update authoring | `runOpenWikiAgent("init"\|"update", local-wiki)` | ❌ | needs a model-free begin/finish bracket (§7, phase 3) |
| Wiki page I/O | DeepAgents FS tools rooted at the wiki, plus per-write front-matter repair | ❌ | the wiki is outside the host workspace, so it needs confined MCP page tools (§7 option C) |
| "What's new since the last synthesis" | none; implicit in the prompt's raw-file list | ❌ | needs a synthesis cursor (§6.6) |
| Wiki goal / source instances / `ingestionGoal` | `~/.openwiki/INSTRUCTIONS.md`, `onboarding.json` | ❌ | read in phase B (`status`); host editing of non-secret config later |
| Deterministic finalization | `createOpenWikiIndexMiddleware` → `prepareWikiForAuthoring` / `finalizeWikiArtifacts` | ❌ | reusable directly; this is what `finish` would call |
| Translation pass | `createWikiTranslationMiddleware` | ❌ | **model-bound**; the host would translate, or the feature is unsupported in host mode |
| `.last-update.json` bookkeeping | `persistRunMetadataIfChanged` | ❌ | model id → `host-agent/<id>` like code mode |
| Personal chat | `openwiki personal` | ❌ (not needed) | the host *is* the chat; retrieval tools replace it |
| OAuth, secrets, ngrok, pmset | CLI/TUI | ❌ | keep human-driven (§6.5) |
| Onboarding, schedules | TUI (gated on an LLM provider), `openwiki cron` | ❌ | needs model-free setup and pull-only scheduling first (§6.6); not MCP tools |
| Visualizer | `openwiki visualize ~/.openwiki/wiki` | n/a | already path-based |

---

## 6. Constraints and risks

### 6.1 Root and layout assumptions

There are three independent blockers. All of them are in the tool and storage
layer; the ranking logic itself is layout-neutral.

1. **Tool-layer root gate.** All four retrieval tools and `openwiki_begin` call
   `resolveRepositoryRoot` first (`retrieval-tools.ts:135,150,170,186`;
   `session-manager.ts:130`). `git rev-parse --show-toplevel` fails for
   `~/.openwiki/wiki`. If `$HOME` is itself a dotfiles repo, the top level
   resolves to `$HOME`, which is refused. The schema descriptions also hardcode
   "Absolute Git repository root containing openwiki/". **Do not relax this
   gate.** Add an explicit personal target that resolves to
   `openWikiLocalWikiDir` (`openwiki-home.ts:46`), so arbitrary non-Git paths
   never become readable.
2. **`/openwiki/` virtual prefix.** `ClaimsStore`'s constructor hardcodes
   `wikiDir = <root>/openwiki` (`claims/brains/code/store.ts:107-117`). Retrieval
   uses it only for `discoverPages()` and `readMarkdown()` (`retrieval/wiki.ts:481-485`,
   `:654`). Page validation goes through `normalizeWikiPagePath`, which requires
   `/openwiki/…md` (`claims/brains/code/paths.ts:24-43`). Refs are emitted as
   `page.slice(1)` → `openwiki/x.md#anchor` (`retrieval/wiki.ts:710,670`).
   Symlinking `~/.openwiki/openwiki → wiki` does not work, because
   `ClaimsStore` rejects a symlinked wiki directory (`store.ts:425-428`).
   - Smallest fix: a read-only *page reader* parameterized by `{wikiDir,
     pagePrefix: "/openwiki" | "/"}` that reuses `ClaimsStore`'s
     symlink and realpath containment logic.
   - The other option is an optional `wikiDir` on `ClaimsStore`. That is a
     larger change, because `paths.ts` bakes in the prefix.
   - Retrieval never touches `.claims` sidecars, so no Claims work is needed.
   - `isGroundedWikiPage` already drops `index.md`, `log.md`, and
     `instructions.md`. `isRetrievableWikiPage` drops dot-segments, which keeps
     `.last-update.json` out.
3. **Wiki identity and workspaces.**
   - An unregistered root becomes a standalone scope whose ID is the directory
     basename (`localWiki`, `linking/wiki-workspaces.ts:1601-1604`). That ID
     would be `wiki`: generic, and it collides with a repository named "wiki".
     Give the personal wiki a fixed ID such as `personal`.
   - It cannot be a workspace member today. `isWikiRepository` requires `.git`
     plus `openwiki/.last-update.json` (`wiki-workspaces.ts:1432-1462`), and
     discovery skips dot-directories (`:1513-1521`).
   - Cross-searching "my repos + my brain" in one workspace would need a
     `kind`/layout field on `RegisteredWiki`. That is out of scope for phase A.

Minor points:

- **Front-matter resources.** `sourceResources` keeps only `repo://` resources
  (`retrieval/wiki.ts:1111-1120`). Personal pages use a top-level `resource:`
  field with non-repo URIs, so they contribute no search signal. Harmless, but
  worth indexing.
- **Path hints.** `paths` hints are repository-relative and meaningless for the
  personal wiki. Reject them, or reinterpret them as connector IDs.
- **Prior art.** `openwiki visualize ~/.openwiki/wiki` already handles "a wiki
  in an arbitrary directory" (`visualize/graph.ts:253-271,332-346`): the root is
  the wiki itself, with no prefix and no Claims. It uses plain `fs` without
  realpath containment, so it is not directly reusable for an MCP read
  boundary.

### 6.2 Model-free contract vs. what personal mode needs a model for

Synthesis, translation, and chat are the only model-bound pieces. A host driver
moves synthesis to the host's model. Translation either becomes host-authored
(the host rewrites pages in the new language) or is rejected in host mode, as
code mode already does for languages: `begin` returns `language` and the host
writes in it. **No MCP tool should start a native OpenWiki agent run**, because
that would silently require a second configured model provider and break the
invariant.

### 6.3 Privacy: data leaves through the host's model provider

In native personal mode, raw Gmail/Slack/Notion content goes to the *user's
configured OpenWiki provider*. In host mode the same content goes to *the host
agent's provider* (Anthropic, OpenAI, Cursor, …), possibly under different
retention terms, and possibly into host transcripts and logs. Exposure should
be **opt-in** (for example a `--personal` flag on `openwiki mcp`, or a separate
installed skill/server) and documented, not silently added to every repository
integration.

### 6.4 Prompt injection surface

Connector raw data (emails, Slack messages, web results, MCP responses) is
adversarial input. Today it reaches an agent with **no shell** and writes
confined to the wiki. A host agent typically *does* have a shell, repository
write access, and other MCP servers. A malicious email that says "run `curl … |
sh`" is a much larger risk in host mode. Mitigations:

- Skill and INSTRUCTIONS: raw content is evidence only, and the agent must never
  act on instructions inside it (already the policy).
- Keep raw-reading tools explicit and narrow (bounded `maxBytes`; no bulk "dump
  everything" tool).
- Consider returning raw items wrapped in an explicit untrusted envelope.
- Recommend that hosts run personal sessions without unrelated write-capable
  tools. This cannot be enforced, so document it.

### 6.5 Credentials and the MCP process

The ingestion pull runs inside `openwiki mcp`, so connector tokens must be in
`process.env`. Today the MCP process deliberately never loads
`~/.openwiki/.env` (§3.4). Calling `loadOpenWikiEnv()` there would also import
the user's **LLM provider keys** into a process that serves a third-party
model.

- Use a scoped loader that copies only connector keys:
  - each registry connector's `requiredEnv`;
  - OAuth client IDs and secrets plus refresh tokens needed by
    `refreshOAuthAccessToken`;
  - `OPENWIKI_TAVILY_API_KEY`;
  - `${ENV}` references in MCP connector configs.
- Tool results must never include secret values. `listConnectors` already
  reports presence only, and `sanitizeMcpTransport` masks env references.

What a host may and may not do:

| Host may (model-free, non-interactive) | Must stay human-driven |
|---|---|
| Read connector readiness | Creating OAuth apps (Google Cloud, X, Slack) |
| `auth configure` (default config) | Browser consent |
| Token refresh | `ngrok` and registering the Slack redirect |
| MCP tool discovery | `pmset` admin prompts |
| Editing **non-secret** config such as source instances, `ingestionGoal`, and git-repo paths (a later phase) | Pasting client secrets or API keys. The host *could* relay them, but that routes secrets through the host model |

A hybrid OAuth tool is possible. It would return the authorization URL from
`runOAuthAuth({silent, onAuthorizationUrl})` and complete in the background.
That requires adding a timeout and cancellation first, because the callback
wait is unbounded. Keep this out of v1.

### 6.6 Host-only users need model-free personal setup and scheduling

Personal mode currently assumes an OpenWiki LLM provider at three points:
onboarding is gated on it, every `openwiki ingest` run ends with an agent
synthesis run, and so does the launchd job. A user who wants to use *only* their
coding agent's model cannot get started. Host personal mode therefore also needs:

1. **Model-free onboarding.** Allow personal source setup without a provider,
   for example `openwiki personal setup` or a "use my coding agent" provider
   choice that skips the credential steps. Then wiki goal, sources, and
   schedule work as today.
2. **Pull-only ingestion.** For example `openwiki ingest all --pull-only`, and
   a schedule mode that runs only the deterministic pulls. Synthesis is then
   deferred to the next host session.
3. **A synthesis cursor.** Today nothing records which raw runs have been folded
   into the wiki. Connector `state.json` lists pulls; `.last-update.json`
   records only the last wiki run. Raw `runId`s are ISO timestamps
   (`connectors/io.ts:createRunId`), so `openwiki_personal_begin({mode:
   "update"})` can list **unsynthesized pulls** (raw runs newer than the last
   successful wiki update, per connector). A durable per-connector
   `synthesizedThrough` marker written by `finish` would be more robust.

### 6.7 Concurrency with native runs

The scheduled `openwiki ingest` (launchd) and an interactive `openwiki personal`
can both write `~/.openwiki/wiki`. Neither holds a lock today, so a host session
adds a third writer.

**Correction:** an earlier draft said code mode avoids this. It does not. Code
mode guarantees one writer only *inside a process*, through the per-process run
and operation guards and `withRunMutation`. Across processes it relies on
sequential hand-off (`begin` resumes the existing run). **Decision:** personal
mode adds a cross-process single-writer lock (`.run.lock`) and a per-page change
check (`baseVersion`). See `specs/personal-lifecycle-core.md` §3.4.

### 6.8 Long-running tools

Ingestion pulls (Slack conversation scans, Gmail pages) can take a long time.
MCP clients impose tool timeouts that vary by host. Options: bounded
`limit`/`windowHours`, or a two-step `start_ingest` / `ingest_status`.

---

## 7. Design options

### Option A: retrieval only

Make `openwiki_search` / `openwiki_read` work against the personal wiki,
either by adding a `wiki: "personal"` selector (no `root` needed) or with
separate `openwiki_personal_search` / `openwiki_personal_read` tools.

- ✅ Small, read-only, and model-free. Immediately useful ("what did I commit to
  this week?").
- ❌ The host cannot maintain the brain.

### Option B: A plus connector evidence

Add `openwiki_personal_list_connectors`, `…_list_raw_items`, `…_read_raw_item`,
and `…_ingest` (deterministic pull for one connector or source instance).

- ✅ The host can answer from fresh evidence. Every function already exists.
- ❌ Raises the privacy and injection concerns (§6.3–6.4). Does not, by itself,
  produce finalized wiki edits.

### Option C: B plus a session-bracketed authoring lifecycle (recommended target)

Mirror code mode's begin/finish without the page queue, since personal mode has
no plan/page model today:

```
openwiki_personal_begin({ mode: "init"|"update", source?: <connectorId|instanceId>,
                          language?, ingest?: boolean })
  → creates or resumes .run.json; prepareWikiForAuthoring(local-wiki); snapshot content;
    optional deterministic pull; returns
    { runId, wikiRoot, language, lastUpdate, wikiGoal, ingestionGoal?,
      rawFiles?, brief /* createSourceUpdateMessage-equivalent */,
      canonicalFiles, openQuestionsPresent, … }
host: reads/writes wiki pages through confined MCP page tools (see below);
      reads raw evidence via MCP
openwiki_personal_finish({ runId })
  → finalizeWikiArtifacts(local-wiki); persistRunMetadataIfChanged(host-agent/<id>);
    returns { status, changedPages, frontmatterReport }
```

- ✅ Reuses the deterministic finalizer verbatim and keeps the model-free
  invariant. The prompt contract moves into a host skill.
- ✅ Durable like code mode. `prepareWikiForAuthoring`'s output is serializable
  (`serializePreparedWikiState`, `wiki-finalizer.ts:145-166`), which is exactly
  how `.run.json` lets code mode finish after a process restart. A personal
  `<wiki>/.run.json` is already excluded from the content snapshot
  (`isIgnoredSnapshotPath`, `agent/utils.ts:815-822`) and from retrieval
  (dot-segment).
- ❌ No per-page confinement inside the wiki. This matches native personal
  mode, which is also unconfined within the wiki, so it is parity rather than a
  regression.
- ⚠️ **Writes cannot rely on host-native tools.** In code mode the host writes
  `openwiki/` with its own editor, because the wiki is inside its workspace.
  `~/.openwiki/wiki` is outside every workspace:
  - Sandboxed hosts (for example Codex `workspace-write`) cannot write there.
  - Hosts with approval prompts would prompt on every page.
  - Native writes would skip the per-write front-matter repair that the
    middleware's `wrapToolCall` performs (`okf-middleware.ts:92-101`).

  So phase C should route wiki I/O through MCP tools backed by
  `OpenWikiLocalShellBackend({rootDir: openWikiLocalWikiDir, outputMode:
  "local-wiki", virtualMode: true})`. That gives path confinement, symlink
  safety, `repairPersistedFile` after each write, and a mutation log for the
  `finish` report.

### Option D: full lifecycle parity (page jobs for personal mode)

Introduce a personal lifecycle core analogous to `repository-run.ts`: a plan of
canonical pages, a PageJob queue, durable `.run.json` under the wiki, and
eventually a "personal brain" Claims implementation with connector-raw evidence
resources (the `claims/brains/code/` directory name suggests a sibling brain was
anticipated). The native personal driver would then be refactored onto the same
core, just as code mode was.

- ✅ Resumable, auditable, and consistent with code mode. Enables grounded,
  versioned personal facts.
- ❌ Large. It changes native personal behavior, and personal synthesis is
  cross-cutting (one email touches commitments, themes, and open questions),
  which fits a page queue less naturally than repository docs do.

§10 works this option out in full and argues the cross-cutting concern is
manageable.

### Option E (rejected): MCP tool that runs the native personal agent

`openwiki_personal_update` → `runOpenWikiAgent(...)`. This breaks the model-free
invariant, needs a second provider, is long-running, and gives the host no
control. Rejected.

### Recommendation

Ship **A → B → C** as increments, keeping D as a later refactor. Each phase is
independently useful and testable, and the riskiest data exposure (B) arrives
behind an explicit opt-in.

| Phase | Delivers | Depends on | Risk |
|---|---|---|---|
| **0: prerequisites** | Wiki-target abstraction in retrieval; scoped connector env loader; `--personal` flag plumbing (CLI → manager → installer args) | — | low |
| **A: retrieval** | `openwiki_personal_search` / `_read`; skill section | 0 | low (read-only, but personal data reaches the host model) |
| **B: evidence** | `_status`, `_list_raw_items`, `_read_raw_item`, `_ingest` (pull only); fixes side findings 1 and 3 for hosts | 0 | medium (credentialed I/O, injection surface) |
| **B′: host-only users** | Model-free onboarding, `ingest --pull-only`, pull-only schedule, synthesis cursor | independent of A/B | medium (touches the TUI and launchd) |
| **C: authoring** | `_begin` / page tools / `_finish`; `<wiki>/.run.json`; lock honored by native runs; `references/personal.md` single-sourced from the native prompt | A, B, cursor | medium-high |
| **D: parity** | Personal lifecycle core with page jobs and a personal Claims brain; native personal driver refactored onto it | C | high |

---

## 8. Draft MCP surface (Options A–C)

### 8.1 Naming and gating

Use **separate `openwiki_personal_*` tools** rather than overloading `root` on
the repository tools:

- The repository tools' contract ("absolute Git root", "do not search at task
  start", "verify against current source") is wrong for a personal brain.
  Personal retrieval is triggered by the user asking about *their* commitments,
  people, and themes, not by repository uncertainty.
- Separate names keep the existing ten-tool tests, the skill name-set test
  (`test/integrations/skill.test.ts:87-103`), and the repository guidance
  untouched.
- **Decision (superseding this draft's earlier proposal of a `--personal` flag
  on the shared server):** personal mode ships as a **separate MCP server and
  skill**: `openwiki mcp personal --host <id>`, config key `openwiki-personal`,
  and skill `openwiki-personal`. Each is installed as its own component with
  `openwiki integrations install <host> --personal`. Repository-only installs
  therefore carry no unused tools, no unused skill text, and no connector
  credentials. The cost is the installer refactor described in §3.5. See
  `specs/personal-host-mode.md` §3.1.

### 8.2 Phase A: retrieval (read-only, model-free)

| Tool | Input | Output | Backing |
|---|---|---|---|
| `openwiki_personal_search` | `{query, limit?}` | same shape as `openwiki_search` results, `wiki: "personal"`, refs like `commitments.md#active` | `searchWiki` over a `WikiTarget{dir: openWikiLocalWikiDir, prefix: "/"}` |
| `openwiki_personal_read` | `{page, sections}` | complete sections | `readWikiSections` over the same target |

### 8.3 Phase B: evidence (model-free; credentialed I/O)

| Tool | Input | Output | Backing |
|---|---|---|---|
| `openwiki_personal_status` | `{}` | wiki root, `lastUpdate`, `wikiGoal`, configured source instances (id, connector, name, connectedAt, ingestionGoal), connector readiness (presence-only env status), schedule, active-session lock | `listConnectors` + `readOpenWikiOnboardingConfig` + `readLastUpdate` |
| `openwiki_personal_list_raw_items` | `{connectorId}` | files, `latestRunId`, `latestFiles` | `listRawItems` |
| `openwiki_personal_read_raw_item` | `{connectorId, path, maxBytes?}` | bounded content, `truncated` | `readRawItem` (≤500 KB, symlink-safe) |
| `openwiki_personal_ingest` | `{source: connectorId \| sourceInstanceId, windowHours?, limit?, streams?}` | `ConnectorIngestResult` (status, rawFiles relative to the raw dir, warnings) | phase 1 of `runSourceIngestion` only. **Never** starts the synthesis agent. Agentic connectors return `status: "skipped"` with guidance |

Deferred: `openwiki_personal_list_mcp_tools` / `…_call_mcp_tool`. They proxy
the user's Notion or custom MCP through OpenWiki. Hosts usually have their own
connectors to those services, and the read-only enforcement must be re-reviewed
before exposing a generic MCP proxy to a third-party model.

### 8.4 Phase C: authoring session (model-free lifecycle)

| Tool | Input | Output / effect |
|---|---|---|
| `openwiki_personal_begin` | `{mode: "init"\|"update", source?, language?, instructions?}` | Acquires `<wiki>/.run.json` (or resumes it). Runs `prepareWikiForAuthoring` and persists the serialized prepared state and content snapshot. Returns `{runId, mode, language, languageChanged, lastUpdate, wikiGoal, canonicalFiles, unsynthesizedPulls: [{connectorId, sourceInstanceId?, runId, rawFiles}], brief}`. `brief` is the `createSourceUpdateMessage` equivalent per source |
| `openwiki_personal_list_pages` | `{runId?, dir?}` | page tree (paths, `type`, `title`, `description`) |
| `openwiki_personal_read_page` | `{page}` | full Markdown, including front matter |
| `openwiki_personal_write_page` | `{runId, page, content}` | confined write → `repairPersistedFile` → validation report |
| `openwiki_personal_edit_page` | `{runId, page, oldString, newString, replaceAll?}` | confined edit → repair → report |
| `openwiki_personal_delete_page` | `{runId, page}` | confined delete; refuses `index.md` / `log.md` / dot-files |
| `openwiki_personal_finish` | `{runId}` | `finalizeWikiArtifacts(local-wiki, producerActor = <host>)`, `.last-update.json` with model `host-agent/<id>`, removes `.run.json` → `{status, changedPages, frontmatterReport, brokenLinks, mermaidRepairs}` |

That is 13 tools in total. If tool count matters for some hosts, the authoring
I/O could collapse into one `openwiki_personal_page({op, …})` tool, at some
cost to schema clarity.

### 8.5 Skill and INSTRUCTIONS

- Port the prompt-only contract (§4.4) into
  `integrations/openwiki/references/personal.md`. The bundle allows
  `references/`, but `skill.test.ts:162-166` asserts that it is absent today.
- Add a short "Personal brain" section to `SKILL.md` that routes to the
  reference.
- **Single-source the text.** Code mode already shares
  `CLAIMS_RECONCILIATION_GUIDANCE` (`claims/guidance.ts`) between
  INSTRUCTIONS and native prompts. Do the same here: extract the canonical-files,
  confidence-label, and per-connector policy blocks from `prompts/personal.ts` and
  `ingestion.ts` into one module. Then either generate `references/personal.md`
  from it at build time, or add a test that the reference contains those blocks
  verbatim. Otherwise native and host personal behavior will drift.
- Add personal guidance to the MCP INSTRUCTIONS only when the server starts
  with `--personal`. `mcp-server.test.ts` pins the existing wording.

---

## 9. Implementation sketch

| Area | Change |
|---|---|
| `src/retrieval/wiki.ts` (+ a small page reader) | Introduce a `WikiTarget {id, name, dir, pagePrefix}`. Replace the direct `ClaimsStore` page access with a read-only reader that reuses its containment checks. Make page normalization, refs, and `INVALID_WIKI_PAGE_MESSAGE` depend on the prefix. Optionally index non-`repo://` resources |
| `src/generation/personal-run.ts` (new) | `beginPersonalRun` / `finishPersonalRun` plus a state schema (`schemaVersion`, `runId`, `mode`, `language`, `actor`, `preparedWiki`, `beforeContentSnapshot`, `source?`, `startedAt`, `pid/host` for stale-lock detection). Mirror `run-state.ts` atomic writes |
| `src/ingestion/briefs.ts` (extracted) | `createSourceUpdateMessage`, `createSourceSynthesisPolicy`, `createConnectorSynthesisGuidance`, shared by native `ingest` and `openwiki_personal_begin` |
| `src/ingestion/ingestion.ts` | Split phase 1 (pull) into an exported function usable without the agent |
| `src/integrations/core/personal-tools.ts` (new) | Zod schemas plus `ProtocolTool`s for phases A–C. Extend `ProtocolToolName`, or give personal tools their own name union |
| `src/integrations/core/session-manager.ts` | `HostSessionManagerOptions.personal?: boolean`. `tools()` appends the personal tools when it is set. Hold a separate single personal session; personal and repository runs are independent |
| `src/cli/commands.ts`, `mcp/stdio.ts`, `mcp/server.ts` | Parse `--personal`, thread it into the manager, and use conditional INSTRUCTIONS |
| Env loading | A scoped `loadConnectorEnv()` that copies only connector keys from `~/.openwiki/.env` into `process.env`, preserving the "never load model credentials" invariant (§6.5) |
| Native personal runs | `runOpenWikiAgent(local-wiki, init/update)` and `runOpenWikiIngestion` refuse to start (or wait) while a host personal session holds `.run.json`. Optionally they take the same lock themselves |
| Model-free setup (§6.6) | Lift the save actions out of `setup/credentials/use-init-setup.ts` into a service module. Allow personal onboarding without a provider. Add `openwiki ingest --pull-only` and a pull-only schedule. Make `openwiki auth <p>` able to create a `sourceInstance` |
| Synthesis cursor (§6.6) | Per-connector `synthesizedThrough` written by both native and host finish. Fallback: compare raw `runId` timestamps with `.last-update.json.updatedAt` |
| Installer | `install <host> --personal` → args `["mcp","--host",id,"--personal"]`. `status` reports it |
| Pi extension | Add the retrieval tools (a pre-existing gap) and the personal tools to `OPENWIKI_TOOLS`, gated by a Pi setting |
| Skill | `references/personal.md` plus a `SKILL.md` section (§8.5) |
| Tests | Update `session-manager.test.ts:215-232` (tool order, with and without `--personal`), `mcp-server.test.ts` (instructions), `skill.test.ts` (name set, `references/`), `pi-extension.test.ts:47-61`, `package-contents.test.ts`, and the installer registry tests. Add new tests for the personal retrieval target, the begin/finish durability and restart path, lock contention with native runs, confinement (path traversal, symlinks, `index.md` writes), the secret-free `status`, and the no-stdout guarantee for `--personal` |
| Docs | README "What the coding-agent integration supports" (`README.md:106`) and CONTRIBUTING's 4 + 6 tool statement (`CONTRIBUTING.md:62-66`) |

---

## 10. Redesign: personal lifecycle core + drivers (Option D in full)

Goal: give personal mode the same shape as code mode. A **durable, model-free
lifecycle core** owns state, the queue, validation, and finalization. **Drivers**
own only model work. There would be a native driver (OpenWiki's planner and page
workers) and a host driver (MCP plus skill), and both call the same core
functions. §7 options A–C then stop being a separate design and become the host
driver of this core.

### 10.1 What code mode actually consists of

Read from `repository-run.ts`, `run-state.ts`, `page-jobs.ts`,
`page-manifest.ts`, and `repository-runner.ts`:

| Concern | Code-mode mechanism | Code-specific? |
|---|---|---|
| Durable checkpoint | `<repo>/openwiki/.run.json` (`RepositoryRunState`, atomic writes) | no |
| Mutation serialization | `withRunMutation` (per-run promise chain) | no |
| Queue | `PageJob {id, path, title, purpose, seedPaths, relatedPages, instructions, status}`; `next` / `capture`→`restore`/`skip` / `submit` | mostly no (`seedPaths` is repository-flavored) |
| Plan validation | `createRepositoryPlan`: no duplicates; quickstart required on init and never deleted; quickstart ordered last; code-owned *required jobs* (Claim issues, language rewrites) | the rules are code-specific; the mechanism is not |
| Source identity and drift | `sourceFingerprint` (Git HEAD + working tree); drift on resume ⇒ discard the plan and replan | yes |
| Update baseline | `.last-update.json.gitHead` + per-page `page-manifest` checkpoints → `pageUpdateWindows` | yes |
| No-op proof | Git diff + Claims preflight + manifest coverage | yes |
| Grounding | Claims: generic core (`claims/core`: `Claim`, `Evidence`, `EvidenceResolver`, `applyClaimOperations`) + code brain (`claims/brains/code`) + `repo://` resolver (`claims/evidence/repository`) | the core is generic; the brain and resolver are not |
| Per-page write confinement | `OpenWikiLocalShellBackend({writableWikiPages: [job.path]})` | **broken for local-wiki**: the local-wiki early return at `docs-only-backend.ts:583` skips the `writableWikiPages` check |
| Front matter | `repairPersistedFile` on submit | no |
| Language change | code-owned `requiredRewritePages` ⇒ rewrite jobs, **no translation model pass** | no |
| Finalization | `finalizeWikiArtifacts(outputMode)` + deletions + Claims finalize + manifest + metadata, then delete `.run.json` last | the finalizer is already generic |
| Native driver | planner DeepAgent (read FS + `submit_plan`); page worker per job (FS confined to one page + `inspect_claims` + `submit_page`); two attempts then skip; worker pool with rate-limit backoff; quickstart held back until the rest finish | the driver is generic; the prompts are not |
| Host driver | `HostSessionManager` → MCP; skill carries the planner and worker contract | the adapter is generic; the skill is not |

**Correction (v4).** An earlier draft claimed that roughly half of
`repository-run.ts` is a reusable "queue kernel". On closer reading it is not:

- Claims, Git, and manifest calls are interleaved even in its most
  generic-looking functions. Snapshot, restore, and skip all touch Claims
  sidecars and `gitHead` metadata.
- The mode-free pieces are already shared modules (`finalizeWikiArtifacts`,
  `repairPersistedFile`, `OpenWikiLocalShellBackend`) or are tiny
  (`withRunMutation`, atomic state I/O).
- The larger reusable part is on the driver side: the worker pool and the
  retry-then-skip loop in `repository-runner.ts`.

The personal core is therefore a **sibling** of `repository-run.ts`, not a
second profile of a shared kernel. See `specs/personal-lifecycle-core.md`
§3.1.

### 10.2 Concept mapping: code → personal

| Code mode | Personal mode equivalent | Consequence |
|---|---|---|
| Repository working tree (mutable) | **Connector raw dumps** under `connectors/<id>/raw/<runId>/`. They are append-only and immutable (timestamped `runId`, never overwritten, never pruned; no retention code exists) | Evidence can be **frozen at `begin`**. A pull that lands mid-run belongs to the *next* run, so there is no drift invalidation or replanning. This is simpler than code mode |
| `sourceFingerprint` / `targetGitHead` | **Evidence frontier**: the set of raw runs per source instance selected for this run | Persisted in run state; resume uses the same frontier |
| `.last-update.json.gitHead` baseline | **Synthesis cursor**: `synthesizedThrough[sourceInstanceId] = runId`, advanced only by `finish` | This is the "what's new" signal (§6.6). Today nothing records it |
| `pageUpdateWindows` (per-page Git baselines) | Per-page `evidenceThrough` in a personal page manifest (optional; needed only when a run is partially skipped) | Mirrors `page-manifest.ts` without Git |
| `seedPaths` | `seedEvidence`: raw refs such as `google/2026-10-07T…/gmail-messages.json#/messages/3` | Workers start from the evidence the planner routed to them |
| Update no-op (Git clean + no Claim issues) | No unsynthesized pulls, no expired or contested Claims needing attention, and no language change, **with no explicit user instruction** | Today's update prompt has the model decide the no-op ("If the wiki is already current, do not edit files"). The core would decide it deterministically |
| Required jobs (Claim issues, rewrites) | Code-owned personal rules: `/sources/<connector>.md` for every source in the frontier; `/open-questions.md` when the plan touches anything; `/quickstart.md` on init or when the page set changes; rewrite jobs on language change | Moves prompt rules ("read open-questions first and last", "keep source pages as evidence indexes") into enforceable plan validation |
| Quickstart-last ordering | `domain pages → /commitments.md, /personal-logistics.md, /themes.md → /sources/* → /open-questions.md → /quickstart.md` | The canonical "synthesis" pages run after the pages that feed them; quickstart stays last |
| `repo://path#Lx-Ly` evidence | `raw://<connector>/<runId>/<file>#<json-pointer>` | The resolver is trivial: version = hash of the pointed value. Immutable, so never stale by change, only by *time* (see §10.5) |
| `.openwikiignore` read boundary | Connector raw-dir confinement (already in `readRawItem`) + wiki confinement | Already exists |
| Translation middleware (model in a `beforeAgent` pass) | `requiredRewritePages` exactly as in code mode | **Deletes the last model call hidden in personal infrastructure** |

### 10.3 The cross-cutting objection

In personal mode one email can produce a commitment, a theme, and an open
question, while code mode has one topic per page. This looks like a poor fit for
page jobs, but two things make it workable:

1. **Today's update prompt already asks for a plan.** It says: "Before editing,
   map changed evidence to the canonical topic, entity, source, theme, or
   open-question pages it affects. Do not edit unrelated pages"
   (`prompts/personal.ts`, update mode). The redesign turns that implicit step
   into an explicit, validated `submit_plan`.
2. **Evidence routing removes the duplication risk.** The plan assigns each
   evidence item a *canonical home* (`PersonalPageJob.seedEvidence`) plus any
   *reference* pages. Workers write facts only for evidence they own, and link
   for the rest. Topic keys go into plan-level `instructions`. The late canonical
   jobs (`/themes.md`, `/open-questions.md`, `/quickstart.md`) run after the
   domain pages and reconcile across them, which is the job the prompt gives to
   "return to /open-questions.md at the end" today.

What remains is parallel workers writing the same fact differently. This is
bounded by routing and by the canonical pages running last, and it can be forced
to zero by keeping personal concurrency at 1 (the code-mode default).

### 10.4 The personal lifecycle

```
             ┌───────────── frozen evidence frontier ─────────────┐
begin ──► [gathering]? ──► planning ──► generating ──► finish
  │           │                │             │            │
  │   agentic sources only     submit_plan   next/submit  finalizer + cursor advance
  │   (MCP discovery writes    (validated,   per page     + metadata, then delete
  │    raw dumps, then         required      (confined)   .run.json last
  │    "close" the frontier)   jobs added)
  └─ noop when nothing new and no instruction
```

- **`begin`** takes `{mode: init|update, scope?: {sourceInstanceIds?}, language?,
  instruction?}`.
  - It runs `prepareWikiForAuthoring(local-wiki)` and computes the frontier from
    raw runs after each source's `synthesizedThrough`.
  - It writes `<wiki>/.run.json`, which is already excluded from content
    snapshots and from retrieval.
  - It returns the view: `{runId, phase, language, wikiGoal, frontier,
    canonicalFiles, openQuestionsSummary, pageInventory, briefs}`. `briefs` is
    the per-source synthesis policy from `ingestion.ts`, without the "read these
    files" boilerplate.
- **`gathering`** is a new phase that code mode doesn't need. Notion and custom
  MCP (and git-repo today) are "agentic": raw evidence appears only when a model
  chooses which MCP tools to call.
  - In the native driver, a bounded gather worker gets only
    `list_mcp_tools` / `call_mcp_tool`.
  - In the host driver, the host calls the same proxied tools.
  - Either way, a `close_gathering` call freezes the frontier. Deterministic
    sources skip this phase.
  - Also fix git-repo to be deterministic (side finding 1). It has no reason to
    be agentic.
- **`submit_plan`** takes `{pages: PersonalPlanPage[], deletePages?}` where
  `PersonalPlanPage = {path, title, purpose, seedEvidence[], relatedPages[],
  instructions[]}`.
  - Validation mirrors code mode: no duplicates, no reserved pages
    (`index.md`, `log.md`), quickstart never deleted.
  - It adds the personal required jobs and orders the queue as in §10.2.
- **`next_page` / `submit_page`** are the same as code mode. On submit, the
  core:
  - checks that the page exists and is readable;
  - runs `repairPersistedFile`;
  - optionally reconciles Claims (§10.5);
  - records page completion (`evidenceThrough`) and marks the job complete
    durably.
- **`finish`** has the same structure as `finishRepositoryRun`: deletions →
  `finalizeWikiArtifacts(local-wiki, producerActor)` → restore skipped-page
  snapshots → (Claims finalize) → advance `synthesizedThrough` **only for
  sources whose routed jobs all completed** → `.last-update.json` → delete
  `.run.json` last. A skipped job leaves its sources' cursors behind, so the
  next update retries them automatically. This is the personal equivalent of
  code mode's "interrupted" metadata.
- **Concurrency (superseded; see `specs/personal-lifecycle-core.md` §3.4):**
  - `.run.json` alone cannot be the lock, because atomic replace has no
    compare-and-swap. The spec uses a separate `.run.lock`, created exclusively
    (`wx`).
  - The holder renews it on every operation. It expires after 30 minutes, or
    immediately when the holder's process on this machine is dead.
  - A driver that exits without finishing releases the lock and keeps the run
    resumable.
  - Takeover of an expired lock requires an explicit `takeover`, and scheduled
    ingestion never takes over.
  - A per-page `baseVersion` check stops a worker from overwriting a page that
    was edited by hand.

### 10.5 Grounding: a personal Claims brain (optional second step)

The Claims core is already brain-agnostic. `EvidenceResolver` is an interface
(`claims/core/types.ts`), and `applyClaimOperations` lives in
`claims/core/mutations.ts`. What is code-specific is the *brain*
(`claims/brains/code`: store paths under `/openwiki/.claims`, preflight,
session) and the `repo://` resolver. A personal brain needs:

- **A `raw://` resolver** in `claims/evidence/connector/`. It is trivial,
  because raw dumps are immutable: resolve = read file + JSON pointer, and
  version = hash. Claims would only become "unresolved" if raw data were
  deleted. That would require a retention policy, which doesn't exist yet and
  would be needed for privacy anyway.
- **A temporal staleness model.** Code facts go stale when the source changes,
  but personal facts mostly don't. A commitment "due Friday" expires, a
  `watchlist` theme decays, and a `contested` fact waits for settling evidence.
  So the personal brain adds Claim metadata the generic core can carry through:
  - `validUntil?` / `asOf`;
  - `confidence` (`confirmed | source-backed | contested | watchlist |
    saved-context`, today's prompt labels);
  - `supersedes?`.

  Preflight then flags *expired* and *contested-with-new-evidence* Claims as
  issues. Through the same `addRequiredClaimIssueJobs` path this makes the
  owning pages required work. That is how "mark stale themes or questions"
  becomes code-owned instead of prompt-owned.
- **A store at `<wiki>/.claims/`.** It is hidden from retrieval by the
  dot-segment rule. It needs a parameterized `ClaimsStore` layout (the same
  `wikiDir` / `pagePrefix` refactor that retrieval needs, §6.1).

Ship the core without Claims first, then add the brain directly to
`personal-run.ts`.

### 10.6 Drivers

| | Native personal driver | Host personal driver |
|---|---|---|
| Gather | bounded DeepAgent with only the MCP-proxy tools + `close_gathering` | host calls `openwiki_personal_list_mcp_tools` / `_call_mcp_tool` / `_close_gathering` |
| Plan | planner DeepAgent: wiki read FS + `list/read_raw_item` + `submit_plan`; prompt = the "inventory and routing" part of today's init/update prompts | host skill section + `openwiki_personal_submit_plan` |
| Pages | worker per job: wiki FS confined to `[job.path]` (**needs the `docs-only-backend.ts:583` fix**) + raw read tools + `submit_page`; prompt = the per-page contract (canonical-file formats, confidence and contested rules, email triage for that page's evidence) | host + confined MCP page I/O tools (`read/write/edit_page`, since the wiki is outside the host workspace, §7 option C) + `openwiki_personal_submit_page` |
| Retry / skip | reuse `runPageAgent` (two attempts, snapshot restore, skip) | host retries `submit_page`; skipped pages are restored at finish |
| Concurrency | reuse the worker pool; default 1 for personal (§10.3) | sequential, like code mode |
| Finish | `finishPersonalRun` | `openwiki_personal_finish` |

What happens to the existing personal surfaces:

- **`openwiki personal --init/--update`** → native driver.
- **`openwiki ingest <source>`** → deterministic pull, then
  `begin({mode: "update", scope: {sourceInstanceIds}})`, then the native driver.
  `ingest --pull-only` and pull-only cron (for host-only users) stop after the
  pull. The frontier mechanism picks the evidence up on the next host session.
- **`openwiki personal` chat** stays a free-form agent for *questions*. When
  the user asks for an edit, it should open a one-page run (`begin` + a
  single-page plan + `finish`) instead of writing directly. That fixes side
  finding 4 (chat edits never finalized) and makes chat edits respect the
  lock.
- **The translation middleware is deleted.** Its only live caller is personal
  init/update (`agent/index.ts:486-527`). Repository init/update never reach that
  graph, and chat skips it. Rewrite jobs replace it, as `requiredRewritePages`
  already does for code mode.

### 10.7 Prompt decomposition

`prompts/personal.ts` (~70 KB, three near-duplicate modes; init and update
differ only in their final "Mode-specific behavior" block) gets split by
*lifecycle role*, the way code mode split into `createRepositoryPlannerPrompt` /
`createRepositoryPagePrompt`:

| Block | Goes to |
|---|---|
| Inventory, evidence-to-page routing, taxonomy, canonical-file set, no-op judgement | planner prompt + skill "planning" section |
| Canonical-file formats (open-questions structure, themes table, commitments Owner), confidence and contested rules, email triage, per-connector guidance (`createConnectorSynthesisGuidance`) | page prompt + skill reference, **single-sourced** constants like `claims/guidance.ts` |
| Wiki-first answering, CLI reference | chat prompt only |
| OKF front matter, link integrity, diagrams | already shared with code mode |
| "Read /open-questions.md first and last", "update /.last-update.json", "don't edit index.md" | **deleted from prompts**, because they become code-owned (required jobs, ordering, finalizer) |

### 10.8 Work breakdown

| Step | Content | Behavior change | Size |
|---|---|---|---|
| 1. Shared building blocks | Move `withRunMutation`, the atomic state I/O, and the driver worker loop into shared modules, without behavior change (superseding the earlier "kernel extraction") | none; existing code-mode tests are the safety net | S–M |
| 2. Layout parameterization | `WikiLayout {dir, pagePrefix, outputMode}` used by `ClaimsStore`, `paths.ts`, retrieval, and the backend; fix `writableWikiPages` for local-wiki | none for code | M |
| 3. Personal core | `generation/personal-run.ts`: frontier + cursor, gathering phase, personal plan rules, `.run.json` lock, finish | new | M–L |
| 4. Native personal driver | gather / planner / page workers reusing the `repository-runner.ts` pool; prompt split (§10.7); `ingest` and chat rewired; translation middleware retired for personal; git-repo made deterministic | **user-visible**; old path kept behind a flag during evaluation | L |
| 5. Host driver | `HostSessionManager` personal session + phase A/B/C tools (§8) + skill reference; `--personal` opt-in; scoped env loader | new | M |
| 6. Model-free setup | §6.6 (onboarding without a provider, pull-only schedule) | user-visible | M |
| 7. Personal Claims brain | `raw://` resolver, temporal metadata, preflight issues → required jobs, retention policy | new | L |

Steps 1–2 are pure refactors and can merge independently. Step 5 can ship
after 3, before 4, if the native driver needs longer evaluation: the host
driver doesn't depend on the native one. That is the fastest route to "host
agents can maintain the personal brain" while keeping the architecture where
you want it.

### 10.9 Risks specific to the redesign

- **Synthesis quality regression in native personal mode.** Today one agent
  holds the whole picture. With planner-routed, page-scoped workers, the
  quality of the cross-source synthesis depends on the planner. There are no
  personal benchmarks in `evals/ledger` (only `benchmarks/taskflow`). Build
  a personal fixture set (frozen raw dumps plus an expected wiki rubric) before
  step 4, and A/B the old and new paths.
- **Cost.** A planner plus N workers re-read the wiki and evidence more than one
  agent does. For a typical daily ingest (one source, a few pages) this is
  modest. Budget it on the fixture set.
- **Init with no raw data.** Personal init today can run on an empty frontier,
  where the agent ingests on demand. The core must decide whether init requires
  a non-empty frontier or allows a skeleton wiki (quickstart + canonical files).
- **Kernel extraction touches the most heavily tested code in the repo.**
  Keep step 1 strictly behavior-preserving and land it alone.

---

## 11. Open questions

1. Should personal tools live on the same `openwiki mcp` server (gated by a flag
   or config) or on a separate server entry (`openwiki mcp --personal`), so
   repository-scoped installs never see personal data?
2. Should the host be allowed to run `ingest` at all, or only consume what
   cron already pulled? (This is a privacy, latency, and credential-refresh
   trade-off.)
3. Translation in host mode: support it (host-authored) or reject a language
   change in `begin`?
4. Should chat-mode edits (native and host) be finalized? Today native chat
   edits are not.
5. Lock semantics shared with native `openwiki personal` / `ingest` / cron.
6. Is a personal Claims brain (Option D) on the roadmap? It determines whether
   phase C's schema should leave room for sparse Claim decisions.
7. Should hosts be able to edit non-secret personal config, such as adding a
   source instance, a git-repo path, an `ingestionGoal`, or the wiki goal?
   This would be convenient, but it lets a model widen what OpenWiki fetches.
8. Should `openwiki_personal_*` also exist for Pi? Pi currently lacks even the
   repository retrieval tools (§3.5).
9. MCP proxying for Notion and custom MCP: expose it, or tell hosts to use
   their own connector and skip OpenWiki's raw-dump persistence for those
   sources?
10. Does the "use my coding agent" provider choice (§6.6) need a
    host-triggered synthesis hook? For example, the pull-only cron could leave
    a marker that the skill surfaces as "N unsynthesized pulls; run a personal
    update?".

---

## Appendix: verification notes

- Read directly: `src/integrations/**`, `src/generation/repository-run.ts`
  (begin/next/submit/finish), `src/agent/index.ts` (run core and graph),
  `src/agent/prompts/personal.ts` (all three modes and the diff between
  init and update), `src/agent/prompt.ts`, `src/connectors/{tools,types,registry,io}.ts`,
  `src/ingestion/ingestion.ts`, `src/config/openwiki-home.ts`,
  `src/agent/agent-backend.ts`, the docs-only backend write checks, and
  `src/agent/okf-middleware.ts`.
- Delegated sweeps with spot-checked claims: auth, onboarding, and scheduling
  (verified the onboarding paths, `isKnownConnectorId`, the launchd args, and
  the LangSmith wiring); retrieval, Claims, and workspace path assumptions
  (verified the `ClaimsStore` constructor, the local-wiki docs-only relax, and
  `localWiki` IDs); installer and tests (verified the pinned tool lists in
  `session-manager.test.ts` and `skill.test.ts`, and `commandLoadsEnvironment`).
- Not run: nothing here was executed. `~/.openwiki/wiki` is empty on the
  research machine, so retrieval behavior on real personal pages is
  unverified.
