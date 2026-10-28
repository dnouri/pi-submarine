# pi-submarine

And now for something completely delegated.

`pi-submarine` sends tasks to [Pi](https://pi.dev/) child sessions and
brings back their answers. The child's transcript stays out of the parent's
context.

<p align="center">
  <img src="https://raw.githubusercontent.com/dnouri/pi-submarine/0.6/media/pi-submarine.gif" alt="pi-submarine animation" width="480">
</p>

## Install

```bash
pi install npm:pi-submarine
```

Requires Pi `1.3.0` or newer in the 1.x series. Both Pi peer dependency ranges
are `^1.3.0`, and the tests run against SDK `1.3.0` only, so a later 1.x
release is not covered.

**Upgrading to 0.6.** Upgrade Pi to `1.3.0` or newer in the 1.x series.
Children no longer inherit parent-only provider configuration. See
[Child configuration](#child-configuration) to configure provider access.
The Markdown activity log and the `activityLog` run detail are gone. Read the
child session transcript instead.

## Features

- Fresh children that start without the parent conversation, and forked
  children that copy the current branch.
- Named agents from markdown files with four frontmatter keys:
  `description`, `model`, `agentsMd`, and `skills`.
- Model chains on a named agent, with explicit effort levels and fallback
  on the first turn.
- Call-level overrides for the model and context files that keep the named
  prompt and skills.
- `subagent_list` for the agents and models visible from a directory.
- Progress updates with activity, turn count, nested children, and context
  usage.
- A depth limit for nested subagents, and parallel calls through
  `multi_tool_use.parallel`.
- Saved-conversation references that let a viewer open a child transcript.
- Child sessions that resume after a failure, an interruption, or an
  explicit user request to continue that exact child.

Each `subagent` call waits for one foreground child. The extension provides
no built-in agent roles, background jobs, or workflow engine.

## Usage

> [!IMPORTANT]
> `pi-submarine` trusts project-local Pi inputs for the child cwd.
> Review unfamiliar `.pi/` resources and project `.agents/` skills before you run subagents.
> Children run with the Pi process's permissions. Neither fresh context nor `agentsMd: "none"` is a sandbox.

The extension registers three tools:

```ts
subagent({ task, agent?, model?, agentsMd?, context?, cwd? })
subagent_resume({ sessionId, message })
subagent_list({ cwd? })
```

All three tools reject unknown arguments. For example:

```ts
subagent({ task: "Inspect src/runner.ts and summarize the control flow. Do not edit files." })
subagent({ agentsMd: "auto", task: "Review src/runner.ts using the project instructions. Do not edit files." })
subagent({ model: "acme/acme-5v-turbo@low", task: "Read screenshots/login.png and return its contents." })
subagent({ agent: "reviewer", model: "acme/fast@low,acme/steady@high", task: "Review src/runner.ts for regressions. Do not edit files." })
subagent({ context: "fork", task: "Use the parent conversation to check my last plan. Do not edit files." })
```

Model names in the examples are placeholders. Call `subagent_list({})` only
when agent names, models, or supported effort levels are unknown. Use known
choices directly. One comma-separated model chain is one child with
fallback, not parallel children.

Fresh children can use files and tools in their cwd. They do not see the
parent conversation or its attached images. Include the needed background,
paths, constraints, checks, and expected output in `task`. Use
`context: "fork"` when the child needs the parent conversation.

Use `multi_tool_use.parallel` to run independent `subagent` calls together.
Start dependent calls after their prerequisites finish.

### `subagent({ task, agent?, model?, agentsMd?, context?, cwd? })`

Runs one focused task in a child Pi session and returns the child's answer
and session ID. The arguments are:

- `task` is required. It is the task and expected output for the child.
- `agent` is optional. Omit it for an unnamed child. Pass an existing
  filename stem such as `"reviewer"` to use `reviewer.md`, not a role
  name. A literal `agent: "subagent"` loads `subagent.md`.
- `model` is optional. Pass comma-separated `model@effort` or
  `provider/model@effort` candidates in fallback order. This replaces
  the named agent's model chain for the call.
- `agentsMd` is optional and valid only with fresh runs. `none` skips
  automatic context-file loading, including `AGENTS.md` and `CLAUDE.md`.
  `auto` enables normal discovery. Omission uses the named agent's
  choice, or `none` for an unnamed child. An explicit choice persists
  on resume.
- `context` is optional and defaults to `"fresh"`. Use `"fresh"` for a
  new child session. Use `"fork"` only when the child must inherit the
  current conversation branch. A fork rejects both `cwd` and `agentsMd`.
- `cwd` is optional and valid only with fresh runs. Omit it to use the
  caller cwd. Relative values resolve from the caller cwd. Pi discovers
  project agents, context files, skills, and other resources there.
  Relative tool paths and bash commands use that directory.

Effort levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and
`max`. Support depends on the model and the installed Pi version.
Non-reasoning models support `@off`.

For a model ID without a provider, `pi-submarine` prefers a single
authenticated match from the parent's provider. Otherwise, the ID must have
exactly one authenticated match from any provider. Ambiguous IDs require
`provider/model@effort`.

When neither the call nor the agent file selects a model chain, fresh and
forked children inherit the parent's current model and effort.

Fallback advances only on an initial provider error before assistant
success or tool progress. Prompt rejection, abort, later failures, and
weak answers do not trigger fallback. If all candidates fail, the call
returns an error. Each fallback attempt uses the same child session ID. The
extension keeps failed attempts in the child's JSONL file but excludes them
from the active conversation.

Fresh runs create a new child session in the current root session's
`.subagents/` directory. Nested subagents share that directory. Fork runs
branch from the current conversation leaf into the same directory. A fork
can see the current parent turn and the parent's instructions. Phrase the
task so a parent-only final-answer marker stays out of the child's output.

An explicit `cwd` can hide a named agent that the caller cwd would find.
In that case, `subagent` fails with a hint to omit `cwd` and put external
paths in `task`.

A successful initial result looks like this:

```md
## Subagent reviewer result
Subagent session ID: 019...
Model: acme/fast

<child assistant answer>
```

The `Subagent session ID` identifies the child for recovery or an explicit
request to resume that exact child session. Initial results name the serving
model when known and summarize earlier failed attempts with truncated
provider errors.

### `subagent_resume({ sessionId, message })`

Continues a child Pi session within the current root session. It opens the
recorded child JSONL session, appends `message`, and waits for the child's
answer. It returns the answer and the same session ID, without the initial
`Model` line. The arguments are:

- `sessionId` is required. Use the child Pi session ID from an earlier
  `subagent` or `subagent_resume` result, including recovery text after
  an interrupted or failed child run.
- `message` is required. The extension appends it to that same child
  conversation.

For example, recover an interrupted task with:

```ts
subagent_resume({
	sessionId: "<returned-child-id>",
	message: "Continue the interrupted task from where you left off.",
})
```

Resume requires a persisted parent Pi session. It looks up the child in
the current root session's manifest. It does not search other roots or
copy the child session. Use a new `subagent` for ordinary follow-up work.
Resume is for recovery or an explicit user request to continue that exact
child.

For a child that started fresh, resume reloads current resources from the
recorded cwd. If the original call set `agentsMd`, resume keeps that choice
even if the agent file changes. Otherwise, resume uses the current agent
file's settings. An unnamed child uses `agentsMd: none` and `skills: auto`.
Resume reloads skills and files rather than using snapshots. Resuming a
named fresh child requires a valid current agent file.

For a child that started as a fork, resume loads normal Pi resources from
the recorded cwd. It ignores the agent file's `agentsMd` and `skills`
controls. Both modes restore the child's recorded model and effort rather
than reapplying current defaults. Resume sends `message` as plain user text.
It does not repeat the initial prompt envelope or add new parent history.

### `subagent_list({ cwd? })`

Lists the markdown agents visible from a working directory, plus the unnamed
child mode and models with configured authentication. The argument is:

- `cwd` is optional. Usually omit it to list the caller project's agents.
  An explicit `cwd` lists another directory's agents. Relative values
  resolve from the caller cwd.

The text result shows each agent's name, description, path, and source.
The source is `user` or `project`. The `Callable models` section lists
supported effort levels and marks the current session model.
Structured details include the resolved cwd, source counts, user and
project agent directories, the callable model catalog, and the current
model. If an explicit `cwd` hides project agents visible from the
caller cwd, the result includes a warning.

## Child configuration

Children load their own Pi settings and resources for the child cwd and
agent directory. The agent directory is `$PI_CODING_AGENT_DIR` when set,
otherwise `~/.pi/agent`. To give a child provider access, configure
`auth.json`, `models.json`, the environment, or a startup extension that
loads in the child.

The extension does not copy temporary API keys, provider registrations, or
model-header overrides from the parent. Give a child equivalent files or
startup extensions when it needs them.

These choices control each initial call:

| Choice | Default | Override |
| --- | --- | --- |
| Model and effort | The named agent's chain, otherwise the parent's current model and effort. | Call-level `model` replaces the whole chain for named or unnamed children. |
| Context files | The agent file's `agentsMd`, otherwise `none`. | Fresh-only `agentsMd: "auto"` loads normal personal and project instructions. `"none"` skips them. |
| Skills | `auto` for unnamed children and agent files that omit `skills`. | An agent file can set `skills: none` or a comma-separated list. |
| Workspace | The caller cwd for fresh children. | Fresh-only `cwd` changes project discovery and tool paths. |

Forks copy the current conversation branch and load normal Pi resources.
They reject call-level `agentsMd` and `cwd`. See [Markdown agents](#markdown-agents)
for the agent file format.

## Markdown agents

Review unfamiliar project `.pi/agents/*.md` files before running them.
Their prompts can instruct the child to use tools and change files.

User agents live in `agents/*.md` under the Pi agent directory. Project
agents live in the nearest ancestor `.pi/agents/*.md` from the effective
cwd. Project agents override user agents with the same filename stem.
Discovery reads only the top level of each directory. It ignores hidden
files, uppercase `.MD`, and `*.chain.md` files.

For a project agent, normally pass the agent name and omit `cwd`. For
example, create `.pi/agents/reviewer.md`:

```md
---
description: Reviews code for concrete regressions
agentsMd: auto
skills: auto
---

Inspect the requested changes. Separate verified failures from concerns.
```

This agent inherits the parent's model and effort unless the call selects
a model chain. Select it by filename stem:

```ts
subagent({ agent: "reviewer", task: "Review src/runner.ts for regressions. Do not edit files." })
```

Call-level `model` and `agentsMd` overrides preserve the named prompt and
skills. If the task needs files outside the project, put their paths in
`task` unless that directory should define the child's project context.

Agent files use the frontmatter block shown above, not YAML. `description`
is required and nonempty. The optional `model` supplies the default chain
when the call omits it. The value uses the same format as the call argument,
with an `@effort` suffix on every candidate. For example:

```md
---
description: Completes bounded development tasks
model: acme/fast@low,acme/steady@high,acme/backup@low
---

Complete the task and report the result.
```

The parser accepts only `description`, `model`, `agentsMd`, and `skills`.
It rejects duplicate keys, blank frontmatter lines, comments, quoted values,
arrays, and block scalars. Files must have both frontmatter delimiters and a
nonempty body.

`agentsMd` may be `none` or `auto` and defaults to `none`. `skills` may be
`auto`, `none`, or a comma-separated list of skill names and defaults to
`auto`. A fresh run fails before execution if a named skill is missing or
hidden from automatic model invocation.

Every initial `subagent` call sends the child a user prompt envelope with
subagent context and the task. Named agents add their markdown body in an
XML-style block, not in the system prompt.

Unnamed fresh children retain normal skills. Named fresh children follow
their agent file's `agentsMd` and `skills` controls unless the call overrides
`agentsMd`. The `agentsMd` choice controls automatic context-file loading.
It does not disable extensions, settings, `SYSTEM.md`, `APPEND_SYSTEM.md`,
or the child's ability to read files.

A fork ignores the agent file's `agentsMd` and `skills` controls but still
applies its prompt body and model chain. It also copies the parent
conversation, instructions included, so the child is not isolated from them.

## Artifacts and progress

`subagent` and `subagent_resume` require a persisted parent Pi session.
Once a child episode starts, `pi-submarine` writes artifacts beside the
root parent session when possible, even if the episode later fails or is
aborted:

```text
<parent-session>.jsonl
<parent-session>.jsonl.subagents/
	manifest.jsonl
	<child-session>.jsonl
```

`manifest.jsonl` records lifecycle data used for resume and nesting.
Full child messages remain in the child session JSONL.

While a child runs, Pi frontends receive partial text updates like this:

```text
- subagent (6% ctx, 1 turn) -> reviewer (? ctx, 2 turns): using read
```

Each update also carries structured `details.run` data:

```ts
type SubagentRunView = {
	episodeId: string
	sessionId: string
	agent: string
	status: "running" | "completed" | "failed" | "aborted"
	turnCount: number
	lastActivityAt: string
	activity: string
	contextUsage?: {
		tokens: number | null
		contextWindow: number
		percent: number | null
	}
	children: SubagentRunView[]
}
```

`sessionId` is the ID to use for continuation. `episodeId` identifies one
call to `subagent` or `subagent_resume`. An initial call and its later
resume calls are separate episodes that share one child `sessionId`. Nested
child run metadata stays in structured run details. The extension leaves
nested transcripts and final answers in child sessions instead of pasting
them into the parent model context.

Context usage comes from Pi's `AgentSession.getContextUsage()`. If Pi
reports unknown usage, the progress text shows `? ctx`. If usage is
unavailable, the segment omits it. The extension uses Pi's standard
tool update callback, so it needs no custom TUI renderer.

### Saved-conversation references

A saved-conversation reference is a pointer to a child transcript. A viewer
that renders tool details can use it to open the transcript. The reference
appears in `details.savedConversations`, beside `details.run`. The field
does not depend on the tool name. It is a viewer convention, not an upstream
Pi API. It has this shape:

```ts
// Shape of details.savedConversations
type SavedConversations = {
	version: 1
	root: string
	items: [{ sessionId: string; file: string; label?: string }]
}
```

`root` is an absolute directory, not a filesystem root. `items` contains
exactly one entry, for the immediate child. That entry has the exact session
ID from the child's Pi v3 header, a safe path relative to `root`, and an
optional display `label`. The child's session manager supplies the file and
the ID. Fresh and fork runs label the child with its agent name. Fallback
attempts and resume runs keep the same child session ID and file.

A running update can include the reference before Pi writes the session
file. A viewer that opens it too early should retry after the child finishes.
Terminal details include the reference only when three checks pass. The file
must be readable, sit inside `root`, and have a header that matches the
recorded session ID and cwd. If the file fails these checks, terminal
details omit the reference without changing the tool's outcome. The file
can still disappear after it is published.

For nested work, open the immediate child's reference, then follow that
child's tool results to the next child, including failed results. The parent
result lists only its immediate child. It does not aggregate descendant
references or forward native nested tool events from independent children.
A result without this field remains readable text. See [Pilish's extension
author guide](https://github.com/dnouri/pilish#extension-support) for the
full contract.

## Errors and limits

- Once a child episode starts, failures and interruptions return native
  `isError: true` results with error text and terminal details. The extension
  throws preflight validation and lookup errors instead. Pi turns both kinds
  into failed tool results, and a parent that was not aborted can continue.
- The extension forwards parent abort signals to the child session.
  If a child session already exists, interruption and failure errors
  include its session ID for possible recovery. Validation and lookup
  failures do not return a session ID.
- Resume requires the recorded model to be available and authenticated.
  If Pi reports an SDK model substitution on any run, the run fails
  before prompting instead of using a substitute.
- Pi persists final details for registered tools and standalone SDK
  `customTools`. If the Pi process dies before it finalizes the parent result,
  those details are not saved. A later extension can replace result details.
- `pi-submarine` does not add session-file paths, stack traces, or child
  transcripts to the text a model sees in a success, interruption, or
  recovery result. It preserves the original provider or extension error
  message, which may contain its own details.
- The extension logs manifest append failures but does not fail an otherwise
  successful child episode. Recovery is not guaranteed if the
  original manifest write failed.
- In one Pi process, `pi-submarine` rejects concurrent attempts to
  append to the same child session, including `subagent_resume` while
  the original `subagent` is still active. This is not a cross-process lock.
- Nested subagents share the Node.js event loop. Each child has its own
  Pi extension runtime. The extension rejects nesting deeper than 4 to stop
  accidental circular delegation.
- `pi-submarine` does not add a wall-clock timeout around Pi's
  `session.prompt()`.

## Development

For local development, load the extension directly:

```bash
pi -e ./src/index.ts
```

Run the checks with:

```bash
npm install --ignore-scripts --no-package-lock
npm run typecheck
npm test -- --no-cache
npm run build
npm run smoke:registration -- --no-cache
```

The offline SDK `1.3.0` checks in `test/sdk-seam.test.ts` and
`test/sdk-auth.test.ts` cover registered and standalone tools, persistence,
failures, recovery, and child authentication without real provider requests.
To keep the saved conversations and raw results from a consumer check, run:

```sh
SUBMARINE_ARTIFACT_OUTPUT="$PWD/tmp/saved-conversation-artifacts" \
	npx vitest run test/sdk-seam.test.ts test/sdk-auth.test.ts --no-cache
```

Pi loads `./src/index.ts` through its TypeScript extension loader. The npm
package contains `src/`, `README.md`, and `package.json`. Model-facing labels,
descriptions, guidelines, and prompt envelopes live in `src/tool-prompts.ts`.
Keep that file, `src/index.ts`, and this README in sync when the tool
contract changes.
