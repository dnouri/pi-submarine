export const TOOL_PROMPTS = {
  subagent: {
    label: "Subagent",
    description: "Delegate one focused task to a subagent, and return compact session metadata plus that child's final answer.",
    promptSnippet: "Run one synchronous subagent to delegate a focused task",
    parameterDescriptions: {
      agent: "Markdown agent name, i.e. its filename stem. Omit for default mode; project agents from the effective `cwd` override same-named user-defined agents.",
      task: "Prompt for the child. For `fresh` independent work, make sure to include needed context, paths, constraints, and desired output because the child does not see the parent conversation.",
      context: "Defaults to `fresh`. Use `fork` only when the child must inherit a copy of the current conversation; `cwd` is invalid with fork.",
      cwd: "Usually omit. Set when another directory should be the child's workspace/project; relative tool paths, bash, agent discovery, context files, skills, and Pi resources follow that `cwd`.",
    },
    promptGuidelines: [
      "Common calls: subagent({ task: \"...\" }) for independent work, subagent({ agent: \"reviewer\", task: \"...\" }) to use a specialized named agent, or subagent({ context: \"fork\", task: \"...\" }) when the child should inherit a copy of the current conversation.",
      "Fresh/default children do not see the parent conversation, so make sure you pass sufficient context in the task!",
      "One call runs one foreground child and waits for the final answer; it is not a background job or workflow engine.",
      "Omit `agent` for default mode; pass an agent name instead to use a specific agent. Role text inside `task` does not select an agent.",
      "Usually omit `cwd`. Use it only when another directory should be the child's workspace/project.",
      "Named `agent`s resolve from the effective cwd; project .pi/agents/*.md overrides same-named user agents.",
    ],
  },
  subagentResume: {
    label: "Resume subagent",
    description: "Continue an existing child Pi session by its subagent session ID and return compact session metadata plus that child's next final answer.",
    promptSnippet: "Continue an existing subagent child session by session ID",
    parameterDescriptions: {
      sessionId: "The child subagent session ID from an earlier subagent or subagent_resume result, or from recovery text in the current parent/root session.",
      message: "Message to append to the existing child conversation before waiting for its next answer.",
    },
    promptGuidelines: [
      "Common call form: subagent_resume({ sessionId: \"...\", message: \"...\" }).",
      "Use `subagent_resume` when continuing the same child context is better than starting a new `subagent`, including after interruption, failure, or a completed result that needs a follow-up.",
      "If the follow-up depends on information only in the parent conversation, include that information in message.",
      "`subagent_resume` continues an existing child subagent session in the current parent/root session; it appends message to that same child conversation instead of starting over.",
      "Use `subagent` instead for new work, independent investigations, or a fresh child context.",
    ],
  },
  subagentList: {
    label: "List subagents",
    description: "List specialized markdown `agent`s visible from the caller `cwd`, or from an explicit cwd override, plus the special omitted-agent `default` mode.",
    promptSnippet: "Inspect visible subagents for a working directory",
    parameterDescriptions: {
      cwd: "Optional directory override. Usually omit to list agents visible from the caller project context. Set only when intentionally inspecting another directory; relative paths resolve from caller `cwd`.",
    },
    promptGuidelines: [
      "Common call forms: subagent_list({}) for the caller cwd; subagent_list({ cwd: \"/path\" }) only when inspecting another project context.",
      "subagent_list lists markdown `agent`s visible from the effective cwd, plus the special `default` mode used when agent is omitted.",
      "Use subagent_list when you need to discover available markdown `agent`s; do not call it first if you already know the agent name.",
    ],
  },
} as const;

export function namedForkPrompt(agentName: string, agentBody: string | undefined, task: string): string {
  return `Subagent instructions from \`${agentName}\`:\n${agentBody ?? ""}\n\nTask:\n${task}`;
}
