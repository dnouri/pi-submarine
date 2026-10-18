# pi-submarine

Delegate one focused task to a child Pi session. Each `subagent` call waits for the child's answer and returns its session ID without copying the child transcript into the parent.

<p align="center">
  <img src="https://raw.githubusercontent.com/dnouri/pi-submarine/0.4/media/pi-submarine.gif" alt="pi-submarine animation" width="480">
</p>

## Start a child

Install the extension in Pi `0.79.1` or newer:

```bash
pi install npm:pi-submarine
```

Give a fresh child a self-contained task:

```ts
subagent({
	task: "Read src/runner.ts and its tests. Report concrete failure cases. Do not edit files.",
})
```

Fresh children do not see the parent conversation or its attached images. Include background, paths, constraints, and expected output in `task`. For images, provide child-readable file paths.

Use a named agent, a model chain, or copied history when the task needs one:

```ts
subagent({
	agent: "reviewer",
	model: "acme/fast@low,acme/steady@high",
	agentsMd: "none",
	task: "Review src/runner.ts for regressions. Report paths and failure cases.",
})
subagent({ context: "fork", task: "Check the last plan against the current code. Do not edit." })
```

Model names in these examples are placeholders. Use `subagent_list({})` to find visible agents and authenticated models with supported effort levels.

## Arguments

The extension registers three strict tools. Unknown arguments are rejected.

```ts
subagent({ task, agent?, model?, agentsMd?, context?, cwd? })
subagent_resume({ sessionId, message })
subagent_list({ cwd? })
```

| `subagent` argument | Meaning |
| --- | --- |
| `task` | Required child task and expected output. Role text does not select a named agent. |
| `agent` | Markdown filename stem. Omit it for an unnamed child. Project agents override same-named user agents. |
| `model` | One to three comma-separated model IDs or `provider/model` references, each optionally suffixed with `@effort`. Replaces the profile's whole model chain. |
| `agentsMd` | Fresh-only context-file override. `none` skips automatic context-file loading. `auto` enables normal discovery. An explicit choice persists on resume. |
| `context` | `fresh` by default. `fork` copies the selected parent branch and forbids both `cwd` and `agentsMd`. |
| `cwd` | Fresh-only workspace, relative to the caller cwd. Defaults to the caller cwd. Tools, project-agent discovery, and Pi resources use this directory. |

Usually omit `cwd`. To work on files outside the project, put their paths in `task` unless that other directory must define the child's project resources. If an explicit cwd hides a named agent visible from the caller cwd, the error explains how to find it.

A literal `agent: "subagent"` loads `subagent.md`. The name `default` selects the unnamed mode only when no `default.md` is visible.

### Models and fallback

Effort uses only model suffixes, in calls and agent files. The suffix vocabulary is `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Support depends on the model and installed Pi version.

Each selected candidate must be registered, authenticated, and support its requested suffix before any child session, manifest, or activity log is created. Candidates are never skipped and requested levels are never clamped. Unsuffixed candidates leave effort selection to Pi.

A bare model ID prefers a match from the parent's provider, then the only authenticated match. Ambiguous IDs require a canonical `provider/model` reference. An `@` before the final slash remains part of the ID, as in `@cf/openai/gpt-oss-120b`. Empty, unknown, or duplicate suffixes fail validation.

Without a selected model chain, a fresh child inherits the parent model. A fork restores the model and effort from the copied branch.

One chain runs one child, not parallel children. Fallback occurs only after an initial provider-error response, before assistant success or tool progress. Prompt rejection, abort, later errors, and an exhausted chain do not trigger fallback. Retries keep the same child session ID. Failed attempts remain inspectable in its JSONL file but stay outside the active conversation.

Separate calls can run in parallel through Pi's native multi-tool calling. The extension does not add background jobs or a workflow engine.

## Named agents

Create `.pi/agents/reviewer.md` in your project:

```md
---
description: Reviews code for concrete regressions
model: acme/fast@low,acme/steady@high
agentsMd: auto
skills: audit
---

Inspect the requested changes. Separate verified failures from concerns.
```

The four allowed frontmatter keys are:

- `description` is required and nonempty.
- `model` supplies the default chain, using the call argument's grammar.
- `agentsMd` is `none` or `auto`. It defaults to `none`.
- `skills` is `auto`, `none`, or a comma-separated list of skill names. It defaults to `auto`. Missing or model-hidden named skills fail fresh preflight.

The parser accepts this small format, not YAML. It rejects unknown or duplicate keys, blank frontmatter lines, comments, quotes, arrays, block scalars, missing delimiters, and empty bodies.

User agents live in `<agent-dir>/agents/*.md`. `PI_CODING_AGENT_DIR` can select the agent directory. Project agents come from the nearest ancestor `.pi/agents/` directory. Discovery is non-recursive and ignores hidden files, uppercase `.MD`, and `*.chain.md`.

Named bodies appear in an XML-style block in the initial user prompt, not the system prompt. Model and context-file overrides preserve the named body and skills.

### Fresh and fork resources

Unnamed fresh children skip context files unless you pass `agentsMd: "auto"`. They retain normal skills. Named fresh children follow their profile unless the call supplies `agentsMd`.

`agentsMd` controls automatic Pi context-file discovery, including `AGENTS.md` and `CLAUDE.md`. It does not disable skills, extensions, settings, `SYSTEM.md`, `APPEND_SYSTEM.md`, or the child's ability to read files.

Fork children use normal fork resources and ignore agent-file `agentsMd` and `skills` controls. Named bodies and model chains still apply. Copied history is not scrubbed, so fork cannot promise instruction isolation. Forked children may see the current parent turn. Avoid parent-only answer markers that conflict with the child's task.

## Recover a child

A result includes the final answer and a `Subagent session ID`. A model-chain result also names the serving model and summarizes earlier failed attempts.

For an interrupted or failed task, recover that child with its returned ID:

```ts
subagent_resume({
	sessionId: "<returned-child-id>",
	message: "Continue the interrupted task from where you left off.",
})
```

Use a new `subagent` for ordinary follow-up work. Resume is for recovery or an explicit user request to continue that exact child.

Resume lookup is scoped to the current parent/root manifest. It does not search globally or copy the session. Both execution tools require a persisted parent Pi session.

Fresh resume reloads current resources from the recorded cwd. An explicit original `agentsMd` choice remains in effect, even if the named profile changes. Without an original override, current profile controls remain live. Skills and file contents are reloaded, not snapshotted. Named fresh sessions still require a valid current agent file.

Fork resume uses fork resources. Both modes restore the active child's recorded model and effort rather than reapplying current model defaults. Resume sends `message` as plain user text without a second named-body envelope.

`subagent_list({ cwd? })` inspects another directory when needed. Its result includes agent paths and sources, callable models, supported thinking levels, and the current model. Structured details include discovery directories and source counts.

## Trust and limitations

**Review unfamiliar project resources before running a child.** pi-submarine treats project-local Pi inputs for the child cwd as trusted, including `.pi/` resources and project `.agents/` skills. Children run with the Pi process's permissions. Neither fresh context nor `agentsMd: "none"` is a sandbox.

- Parent aborts propagate to the child. After a child exists, interruption and failure errors include its session ID for possible recovery. Preflight errors do not invent one.
- Resume requires the recorded model to be available and authenticated. An SDK model substitution fails before prompting instead of silently changing models.
- Manifest and activity-log write failures are logged without failing an otherwise successful child. Recovery is not guaranteed if the original manifest write failed.
- Concurrent writes to the same child are rejected within one Pi process. There is no cross-process lock.
- Nested children share the Node.js event loop and extension runtime. The maximum nesting depth is four.
- The extension adds no wall-clock timeout around Pi's prompt operation.
- Compact result text omits transcript and artifact paths. Provider or extension error messages can still contain their own details.

## Artifacts and progress

Children share a directory beside the root parent session:

```text
<parent-session>.jsonl
<parent-session>.jsonl.subagents.md
<parent-session>.jsonl.subagents/
  manifest.jsonl
  <child-session>.jsonl
```

The manifest records lifecycle episodes for recovery and nesting. The append-only Markdown activity log reports status and fallback attempts, not full transcripts. Use `tail -f` to watch it. Child JSONL files retain the full messages.

Partial updates report activity, turns, context usage, and nested children. Structured `details.run` includes `sessionId`, `episodeId`, status, activity-log path, context usage, and child run metadata. Multiple episodes can share one child session ID. Unknown context usage appears as `? ctx`.

## Development

Load the local extension:

```bash
pi -e ./src/index.ts
```

Run the checks:

```bash
npm install --ignore-scripts --no-package-lock
npm run typecheck
npm test
npm run build
npm run smoke:registration
```

Development tests pin Pi SDK `0.79.1`. Pi loads the published TypeScript source through `./src/index.ts`. Keep `src/tool-prompts.ts`, `src/index.ts`, and this README in sync when arguments change.
