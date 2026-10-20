# pi-submarine

And now for something completely delegated.

`pi-submarine` sends tasks to [Pi](https://pi.dev/) child sessions and
brings back their answers.  It also tries to stay out of the way.

<p align="center">
  <img src="https://raw.githubusercontent.com/dnouri/pi-submarine/0.5/media/pi-submarine.gif" alt="pi-submarine animation" width="480">
</p>

## Features

- Fresh child sessions without parent conversation history, or forked
  child sessions that inherit the current conversation branch.
- Named agents defined by markdown files with four frontmatter keys:
  `description`, `model`, `agentsMd`, and `skills`.
- Per-agent model chains with explicit effort levels and first-turn
  fallback. Call-level `model` overrides work for both unnamed and
  named agents.
- Call-level `agentsMd` overrides for loading personal and project
  instructions in fresh children, without changing the named prompt
  or skills.
- Agent discovery for user-level and project-level markdown agents,
  including `subagent_list` for showing what is visible from a cwd.
- Runtime status updates that report activity, turn counts, nested
  children, and context usage.
- Nested subagents, with a depth limit to prevent accidental circular
  delegation.
- Parallel subagents through `multi_tool_use.parallel`.
- Resumable child sessions through `subagent_resume` for recovery
  after an interruption or failure, or when the user explicitly asks
  to resume that exact child session.

Each `subagent` call waits for one foreground child. The extension does
not provide built-in agent roles, background jobs, or a workflow engine.

## Usage

The extension registers three tools:

```ts
subagent({ task, agent?, model?, agentsMd?, context?, cwd? })
subagent_resume({ sessionId, message })
subagent_list({ cwd? })
```

All three tools reject unknown arguments.

> [!IMPORTANT]
> `pi-submarine` treats project-local Pi inputs for the child cwd as trusted.
> Review unfamiliar `.pi/` resources and project `.agents/` skills before running subagents.
> Children run with the Pi process's permissions. Neither fresh context nor `agentsMd: "none"` is a sandbox.

For example:

```ts
subagent({ task: "Inspect src/runner.ts and summarize the control flow. Do not edit files." })
subagent({ agentsMd: "auto", task: "Review src/runner.ts using the project instructions. Do not edit files." })
subagent({ model: "acme/acme-5v-turbo@low", task: "Read screenshots/login.png and return its contents." })
subagent({ agent: "reviewer", model: "acme/fast@low,acme/steady@high", task: "Review src/runner.ts for regressions. Do not edit files." })
subagent({ context: "fork", task: "Use the parent conversation to check my last plan. Do not edit files." })
```

Model names in these examples are placeholders. Use `subagent_list({})`
when agent names, models, or supported effort levels are unknown. Use
known choices. One comma-separated model chain is one child with
fallback, not parallel children.

Fresh children can use files and tools in their cwd. They do not see
the parent conversation or its attached images. Include the needed
background, paths, constraints, checks, and expected output in `task`.
Unnamed fresh children skip automatic context files unless you pass
`agentsMd: "auto"`. Use `context: "fork"` when the child needs the
parent conversation.

Use `multi_tool_use.parallel` to run independent `subagent` calls
together. Each call waits for its child. Start dependent calls after
their prerequisites finish.

### `subagent({ task, agent?, model?, agentsMd?, context?, cwd? })`

A `subagent` call runs one focused task in a child Pi session and returns the child's answer and session ID.

Arguments:

- `task` is required. It is the task and expected output for the child.
- `agent` is optional. Omit it for an unnamed child. Pass an existing
  filename stem such as `"reviewer"` to use `reviewer.md`, not a role
  name. A literal `agent: "subagent"` loads `subagent.md`.
- `model` is optional. Pass comma-separated `model@effort` or
  `provider/model@effort` candidates in fallback order. This replaces
  the profile's model chain for the call.
- `agentsMd` is optional and valid only with fresh runs. `none` skips
  automatic context-file loading, including `AGENTS.md` and `CLAUDE.md`.
  `auto` enables normal discovery. Omission uses the named profile's
  choice, or `none` for an unnamed child. An explicit choice persists
  on resume.
- `context` is optional and defaults to `"fresh"`. Use `"fresh"` for a
  new child session. Use `"fork"` only when the child must inherit the
  current conversation branch. Fork rejects both `cwd` and `agentsMd`.
- `cwd` is optional and valid only with fresh runs. Omit it to use the
  caller cwd. Set it when another directory should define the child's
  workspace. Relative tool paths and bash commands use that directory.
  Pi discovers project agents, context files, skills, and other
  resources from that cwd. Relative `cwd` values resolve from the
  caller cwd.

Effort levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and
`max`. Support depends on the model and installed Pi version.
Non-reasoning models support `@off`.

For a model ID without a provider, `pi-submarine` first prefers a
matching model from the parent's provider, then the only authenticated
match. Ambiguous IDs require `provider/model@effort`.

When neither the call nor the profile selects a model chain, fresh and
forked children inherit the parent's current model and effort.

Fallback advances only on an initial provider error before assistant
success or tool progress. Prompt rejection, abort, later failures, and
weak answers do not trigger fallback. If all candidates fail, the call
returns an error. Retries keep the same child session ID. The extension
keeps failed attempts in the child's JSONL file but excludes them from
the active conversation.

Fresh runs create a new child session below the current root session's
`.subagents/` directory; nested subagents share that directory. Fork
runs branch from the current conversation leaf into the same
`.subagents/` directory.

If a named agent cannot be found from an explicit `cwd` but would have
been found from the caller cwd, `subagent` fails with a hint to omit
`cwd` and put external paths in `task` instead.

A successful initial result looks like this:

```md
## Subagent reviewer result
Subagent session ID: 019...
Model: acme/fast

<child assistant answer>
```

The `Subagent session ID` identifies the child for recovery or an
explicit request to resume that exact child session. Initial results
name the serving model when known and summarize any earlier failed
attempts with truncated provider errors.

### `subagent_resume({ sessionId, message })`

This tool continues a child Pi session within the current root session.
It opens the recorded child JSONL session and appends `message`.
It waits for the child's answer, then returns the answer and the same
session ID. Resume results omit the initial `Model` line.

Arguments:

- `sessionId` is required. Use the child Pi session ID from an earlier
  `subagent` or `subagent_resume` result, including recovery text after
  an interrupted or failed child run.
- `message` is required. It is appended to that same child
  conversation.

For example, recover an interrupted task with:

```ts
subagent_resume({
	sessionId: "<returned-child-id>",
	message: "Continue the interrupted task from where you left off.",
})
```

Resume requires a persisted parent Pi session. It looks up the child
in the current root session's manifest. It does not search other roots
or copy the child session. Use a new `subagent` for ordinary follow-up
work. Resume is for recovery or an explicit user request to continue
that exact child.

For a child that started fresh, resume reloads current resources from
the recorded cwd. If the original call set `agentsMd`, resume keeps
that choice even if the named profile changes. Otherwise, it uses the
current profile's settings. Resume reloads skills and files rather than
using snapshots. Resuming a named fresh child requires a valid current
agent file.

For a child that started as a fork, resume loads normal Pi resources
from the recorded cwd. It ignores the agent file's `agentsMd` and
`skills` controls. Both modes restore the child's recorded model and
effort rather than reapplying current defaults. Resume sends `message`
as plain user text. It does not repeat the initial prompt envelope or
add new parent history.

### `subagent_list({ cwd? })`

Lists the markdown agents visible from a working directory, plus the
unnamed mode and models with configured authentication.

Arguments:

- `cwd` is optional. Usually omit it to inspect the caller project
  context. An explicit `cwd` inspects another directory's visible
  agents; relative paths resolve from the caller cwd.

The text result shows each agent's name, description, path, and source.
The source is `user` or `project`. The `Callable models` section lists
supported effort levels and marks the current session model.
Structured details include the resolved cwd, source counts, user and
project agent directories, the callable model catalog, and the current
model. If an explicit `cwd` hides project agents visible from the
caller cwd, the result includes a warning.

## Markdown agents

Review unfamiliar project `.pi/agents/*.md` files before running them.
Their prompts can instruct the child to use tools and change files.

User agents live under the Pi agent directory in `agents/*.md`
(`$PI_CODING_AGENT_DIR/agents` when that environment variable is set,
otherwise Pi's normal agent directory). Project agents live in the
nearest ancestor `.pi/agents/*.md` from the effective cwd. Project
agents override user agents with the same filename stem.

For project agents, normally pass the agent name and omit `cwd`. For
example, create `.pi/agents/reviewer.md`:

```md
---
description: Reviews code for concrete regressions
agentsMd: auto
skills: auto
---

Inspect the requested changes. Separate verified failures from concerns.
```

This profile inherits the parent's model and effort unless the profile
or call selects a model chain. Select it by filename stem:

```ts
subagent({ agent: "reviewer", task: "Review src/runner.ts for regressions. Do not edit files." })
```

A call-level `model` replaces the profile's whole model chain for one
invocation. A call-level `agentsMd` overrides the profile's context-file
choice for fresh runs. Both preserve the named prompt and skills.

If the task needs files outside the project, put those paths in `task`
unless you intentionally want the external directory to define the
child's project context.

Agent files use the small frontmatter block shown above, not YAML.
`description` is required and nonempty. The optional `model` supplies
the default chain when the call omits it. It uses the call argument's
format, with an `@effort` suffix on every candidate. For example:

```md
---
description: Completes bounded development tasks
model: acme/fast@low,acme/steady@high,acme/backup@low
---

Complete the task and report the result.
```

The four allowed frontmatter keys are `description`, `model`,
`agentsMd`, and `skills`. `agentsMd` may be `none` or `auto` and defaults
to `none`. `skills` may be `auto`, `none`, or a comma-separated list of
skill names and defaults to `auto`. A fresh run fails before execution
if a named skill is missing or hidden from automatic model invocation.

The parser rejects unknown or duplicate keys, blank frontmatter lines,
comments, quoted values, arrays, and block scalars. Files must have
both frontmatter delimiters and a nonempty body.

Discovery is non-recursive and ignores hidden files, nested
directories, uppercase `.MD`, and `*.chain.md` files.

Every initial `subagent` call sends the child a user prompt envelope
with subagent context and the task. Named agents add their markdown
body in an XML-style block, not in the system prompt.

Unnamed fresh children skip context files unless the call supplies
`agentsMd: "auto"`. They retain normal skills. Named fresh children
follow their profile's `agentsMd` and `skills` controls unless the call
overrides `agentsMd`. The `agentsMd` setting controls automatic loading
of context files such as `AGENTS.md` and `CLAUDE.md`. It does not
disable extensions, settings, `SYSTEM.md`, `APPEND_SYSTEM.md`, or the
child's ability to read files.

Fork runs ignore agent-file `agentsMd` and `skills` controls and load
normal Pi resources. Named bodies and model chains still apply. A fork
copies the existing conversation, including its instructions. It does
not isolate the child from those instructions.

## Artifacts and progress

`subagent` and `subagent_resume` require a persisted parent Pi
session. Once a child episode starts, `pi-submarine` writes artifacts
beside the root parent session when possible, even if the episode
later fails or is aborted:

```text
<parent-session>.jsonl
<parent-session>.jsonl.subagents.md
<parent-session>.jsonl.subagents/
  manifest.jsonl
  <child-session>.jsonl
```

`manifest.jsonl` records lifecycle data used for resume and
nesting. `<parent-session>.jsonl.subagents.md` is an append-only
status stream suitable for `tail -f`, not a transcript. It reports
status and fallback attempts. Full child messages remain in the child
session JSONL.

While a child runs, Pi frontends receive portable text partial updates
like this:

```text
Log: ~/.pi/agent/sessions/.../parent.jsonl.subagents.md
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
- The extension forwards parent abort signals to the child session.
  If a child session already exists, interruption and failure errors
  include its session ID for possible recovery. Validation and lookup
  failures do not return a session ID.
- Resume requires the recorded model to be available and authenticated.
  If Pi reports an SDK model substitution on any run, the run fails
  before prompting instead of silently using a substitute.
- `pi-submarine`'s wrapper text does not add session-file paths,
  activity-log paths, stack traces, child transcripts, or the Markdown
  activity log to model-visible success, interruption, or recovery
  text. The original provider or extension error message is preserved
  and may contain its own details.
- Manifest and activity-log append failures are logged and do not fail
  an otherwise successful child episode. Recovery is not guaranteed if
  the original manifest write failed.
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

**Upgrading to 0.5.** Remove `thinkingLevel` from calls and agent files,
and append `@effort` to every explicit model candidate.

## Development

For local development, load the extension directly:

```bash
pi -e ./src/index.ts
```

Run the checks with:

```bash
npm install --ignore-scripts --no-package-lock
npm run typecheck
npm test
npm run build
npm run smoke:registration
```

Development tests pin Pi SDK `0.79.1`. The model-facing tool labels,
descriptions, schema descriptions, guidelines, and prompt envelope
helpers live in `src/tool-prompts.ts`. Keep that file, `src/index.ts`,
and this README in sync when the tool contract changes.
