# pi-submarine 🥽

`pi-submarine` is a minimal Pi extension for delegating tasks to child
Pi sessions, also known as *subagents*. The parent receives compact
run metadata, the child session ID, and the child's final answer.

## Features

- Fresh child sessions for isolated work, or forked child sessions
  when the child should inherit the current conversation branch.
- Named agents defined by simple markdown files with only three
  frontmatter knobs: `description`, `agentsMd`, and `skills`.
- Agent discovery for user-level and project-level markdown agents,
  including `subagent_list` for showing what is visible from a cwd.
- Runtime status updates that report activity, turn counts, nested
  children, and context usage.
- An append-only `subagents.live.md` activity log that can be tailed
  while children run.
- Nested subagents, with a depth limit to prevent accidental circular
  delegation.
- Support for parallel subagents through Pi's native multi tool
  calling.
- Resumable child sessions through `subagent_resume` when continuing
  the same child context is useful after an abort, failure, or
  deliberate follow-up.

The package is deliberately narrow: one `subagent` call runs one
foreground child Pi session and waits for it.  It does not provide
built-in agent roles, background jobs, chains, dashboards, or a
workflow engine.

## Usage

The extension registers three tools:

```ts
subagent({ agent?, task, context?, cwd? })
subagent_resume({ sessionId, message })
subagent_list({ cwd? })
```

All three tools use strict parameter schemas: unknown properties are
rejected.

> [!IMPORTANT]
> `pi-submarine` treats project-local Pi inputs for the child cwd as trusted. Review unfamiliar `.pi/` and `.agents/` files before running subagents.

The common calls are intentionally small:

```ts
subagent({ task: "Inspect src/runner.ts and summarize the control flow." })
subagent({ agent: "reviewer", task: "Review the changes in src/runner.ts." })
subagent({ context: "fork", task: "Use the current conversation branch to check my last plan." })
```

Fresh runs are independent child sessions. They can use files and
tools in their cwd, but they do not see the current parent
conversation, so put the needed background, paths, constraints, and
desired output in `task`. Use `context: "fork"` only when the child
should inherit a copy of the current conversation.

### `subagent({ agent?, task, context?, cwd? })`

Runs one focused task in a child Pi session and returns compact session metadata plus the child's final answer.

Arguments:

- `task` is required. It is the prompt for the child session.
- `agent` is optional. Omit it for the generic default mode. Pass a
  filename stem such as `"reviewer"` to use a markdown agent named
  `reviewer.md`. A literal `agent: "subagent"` means the markdown file
  `subagent.md`; omission is the only way to request the default mode.
- `context` is optional and defaults to `"fresh"`. Use `"fresh"` for a
  new child session. Use `"fork"` only when the child must inherit the
  current conversation branch.
- `cwd` is optional and valid only with fresh runs. Usually omit it;
  the child then uses the caller cwd. Set it only when another
  directory should be the child's workspace/project: relative tool
  paths and bash run there, and project-agent discovery, context
  files such as `AGENTS.md` / `CLAUDE.md`, skills, and Pi resources
  follow that cwd. Relative `cwd` values resolve from the caller cwd.

Fresh runs create a new child session below the current root session's
`.subagents/` directory; nested subagents share that directory. Fork
runs branch from the current conversation leaf into the same
`.subagents/` directory; `cwd` is invalid for fork because the child
keeps the branch cwd and prompt shape.

If a named agent cannot be found from an explicit `cwd` but would have
been found from the caller cwd, `subagent` fails with a hint to omit
`cwd` and put external paths in `task` instead.

A successful result looks like this:

```md
## Subagent reviewer result
Subagent session ID: 019...

<child assistant answer>
```

Use the `Subagent session ID` for later continuation.

### `subagent_resume({ sessionId, message })`

Continues an existing child Pi session in the current parent/root
session. It requires a persisted parent Pi session so it can find the
current parent/root manifest. It reopens the recorded child JSONL
session, appends `message`, waits for the next child answer, and
returns the same compact result shape.

Arguments:

- `sessionId` is required. Use the child Pi session ID from an earlier
  `subagent` or `subagent_resume` result, or from recovery text after
  an interrupted or failed child run.
- `message` is required. It is appended to that same child
  conversation.

Resume lookup is scoped to the current parent/root manifest. It does
not search globally, fork, or copy the child session. Use `subagent`
for unrelated work; use `subagent_resume` when continuing the same
child context is clearer than starting over.

For original fresh runs, resume reloads current prompt resources from
the recorded cwd, including named-agent `agentsMd` and `skills`
controls. For original fork runs, resume uses fork-style resources and
sends `message` as plain user text, because any named-agent body is
already in the child transcript.

### `subagent_list({ cwd? })`

Lists the markdown agents visible from a working directory, plus the
special default mode where `agent` is omitted.

Arguments:

- `cwd` is optional. Usually omit it to inspect the caller project
  context. An explicit `cwd` is an advanced override for listing
  another directory's visible agents; relative paths resolve from the
  caller cwd.

The text result shows each markdown agent's name, source label (`user`
or `project`), description, and path. The structured details include
the resolved cwd, source counts, and user/project agent
directories. If an explicit `cwd` hides project agents visible from
the caller cwd, the result includes a warning.

## Markdown agents

Markdown agents are prompt resources. Treat them like trusted code:
review project `.pi/agents/*.md` files before running subagents in an
unfamiliar checkout.

User agents live under the Pi agent directory in `agents/*.md`
(`$PI_CODING_AGENT_DIR/agents` when that environment variable is set,
otherwise Pi's normal agent directory). Project agents live in the
nearest ancestor `.pi/agents/*.md` from the effective cwd. Project
agents override user agents with the same filename stem.

For project agents, normally pass the agent name and omit `cwd`:

```ts
subagent({ agent: "reviewer", task: "Review the changes in src/runner.ts." })
```

If the task needs files outside the project, put those paths in `task`
unless you intentionally want the external directory to define the
child's project context.

Agent files use a small frontmatter block, not YAML:

```md
---
description: Reviews branch for correctness, tests, and unnecessary complexity.
agentsMd: auto
skills: none
---

Perform an adversarial review of the changes in this branch. Look for
opportunities to reduce layers, remove complexity, and increase
reliability. Ensure repo-wide policies are maintained, changes are
verified, and maintain the original intent.
```

`description` is required. `agentsMd` is optional and may be `none` or
`auto`; it defaults to `none`. `skills` is optional and may be `auto`,
`none`, or a comma-separated list of skill names; it defaults to
`auto`. Unknown keys, blank frontmatter lines, comments, quoted
values, arrays, block scalars, duplicate keys, missing delimiters, and
empty bodies are rejected.

Discovery is non-recursive and ignores hidden files, nested
directories, uppercase `.MD`, and `*.chain.md` files.

Fresh default-mode runs do not load markdown agents, suppress
`AGENTS.md` / `CLAUDE.md` context files, and keep normal skills. Named
fresh runs append the agent body to the child system prompt;
`agentsMd` controls context-file loading, and `skills` controls skill
loading. Fork runs ignore those frontmatter resource controls and
place any named-agent body in the user prompt instead of the system
prompt.

## Artifacts and progress

`subagent` and `subagent_resume` require a persisted parent Pi
session. Once a child episode starts, `pi-submarine` writes artifacts
beside the root parent session when possible, even if the episode
later fails or is aborted:

```text
<parent-session>.jsonl
<parent-session>.jsonl.subagents/
  manifest.jsonl
  subagents.live.md
  <child-session>.jsonl
```

`manifest.jsonl` records lifecycle data used for resume and
nesting. `subagents.live.md` is an append-only status stream suitable
for `tail -f`, not a transcript. Full child messages remain in the
child session JSONL.

While a child runs, Pi frontends receive portable text partial updates
like this:

```text
Active log: /path/to/parent.jsonl.subagents/subagents.live.md
Subagents:
- subagent (6% ctx, 1 turn) -> reviewer (? ctx, 2 turns): using read
```

The same update includes structured `details.run` data:

```ts
type SubagentRunView = {
  episodeId: string
  sessionId: string
  agent: string
  status: "running" | "completed" | "failed" | "aborted"
  turnCount: number
  lastActivityAt: string
  activity: string
  activityLog: string
  contextUsage?: {
    tokens: number | null
    contextWindow: number
    percent: number | null
  }
  children: SubagentRunView[]
}
```

`sessionId` is the public continuation handle. `episodeId` identifies
one `subagent` or `subagent_resume` lifecycle episode; multiple
episodes can share one child `sessionId`. Nested child run metadata
stays in structured run details; nested transcripts and final answers
remain in their child sessions instead of being pasted into the parent
model context.

Context usage comes from Pi's `AgentSession.getContextUsage()`. If Pi
reports unknown usage, the progress text shows `? ctx`; if usage is
unavailable, the segment omits context usage. No custom TUI renderer
is required for correctness.

## Errors and limits

- Tool errors are thrown from `execute()`, which Pi records as failed
  tool results.
- Parent abort signals are forwarded to the child session. If a child
  session already exists, the durable status is `aborted` and the
  model-visible error text includes the `Subagent session ID` and
  examples for `subagent_resume`.
- Non-abort child failures after a trusted child session exists stay
  durable `failed`; the error text includes the public session ID only
  as a cautious “may be resumable” handle. Preflight and lookup
  failures before a trusted child session exists do not invent a
  continuation handle.
- `pi-submarine`'s wrapper text does not add session-file paths,
  activity-log paths, stack traces, child transcripts, or the Markdown
  activity log to model-visible success, interruption, or recovery
  text. The original provider or extension error message is preserved
  and may contain its own details.
- Manifest and activity-log append failures are logged and do not fail
  an otherwise successful child episode. Continuation needs the
  current-root manifest start record, so resume is not guaranteed
  after a degraded manifest write.
- In one Pi process, `pi-submarine` rejects concurrent attempts to
  append to the same child session, including `subagent_resume` while
  the original `subagent` is still active. This is not a cross-process
  lock.
- Nested subagents share the Node.js event loop and Pi extension
  runtime. Nesting deeper than 4 is rejected to stop accidental
  circular delegation.
- `pi-submarine` does not add a wall-clock timeout around Pi's
  `session.prompt()`.
- Forked children start from the current branch and may see the
  current parent turn. Phrase fork tasks so parent-only final-answer
  markers do not conflict with what the child should produce.

## Install

```bash
pi install npm:pi-submarine
```

Requires Pi `0.79.1` or newer. The package manifest registers
`./src/index.ts`, which Pi loads through its TypeScript extension
loader. The npm package contains `src/`, `README.md`, and npm's
automatic `package.json`.

## Development

For local development, load the extension directly:

```bash
pi -e ./src/index.ts
```

Run the checks with:

```bash
npm install
npm run typecheck
npm test
npm run build
npm run smoke:registration
```

The model-facing tool labels, descriptions, schema descriptions,
guidelines, and fork prompt template live in
`src/tool-prompts.ts`. Keep that file, `src/index.ts`, and this README
in sync when the tool contract changes.
