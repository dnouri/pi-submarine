export const TOOL_PROMPTS = {
  subagent: {
    label: "Subagent",
    description: "Run one focused task in a foreground child Pi session and return compact session metadata plus that child's final answer.",
    promptSnippet: "Run one foreground pi-submarine child session for one focused task",
    parameterDescriptions: {
      agent: "Filename stem of a markdown-defined subagent. Project agents resolve from the nearest .pi/agents/<name>.md at or above the effective cwd and override same-named user agents. Omit only for the generic default mode.",
      task: "Prompt for the single child Pi session.",
      context: "Child context mode; defaults to fresh. Use fork only when the child must inherit the current conversation branch. cwd is invalid with fork.",
      cwd: "Advanced working-directory override for fresh runs. Usually omit cwd; the child then uses the caller cwd and keeps the current project agents and prompt resources visible. Relative paths resolve from the caller cwd. Explicit cwd controls project-agent discovery, AGENTS.md / CLAUDE.md, skills, and prompt resources. Invalid with context: fork.",
    },
    promptGuidelines: [
      "subagent is pi-submarine's foreground-only delegation tool: one call runs one child Pi session and waits for its final answer. It does not provide async/background jobs, chains, dashboards, or a workflow engine.",
      "subagent named agents are markdown files resolved from the effective cwd; the nearest project .pi/agents/*.md overrides user agents with the same name.",
      "subagent child sessions intentionally approve project-local Pi inputs for their effective cwd, including .pi/settings.json, project packages configured there, .pi resources, project .agents skills, and pi-submarine .pi/agents/*.md files; review project-local Pi files before using subagents in unfamiliar checkouts.",
      "subagent uses the generic default mode only when agent is omitted. When a prompt names a specific agent, pass agent explicitly; role text inside task does not select an agent.",
      "subagent context defaults to fresh. Use context=fork only when the child must inherit the current conversation branch; cwd is invalid with fork.",
      "Usually omit cwd for fresh runs; the child uses the caller cwd, which keeps current project agents and prompt resources visible.",
      "subagent cwd controls project-agent discovery, AGENTS.md / CLAUDE.md, skills, and prompt resources for fresh runs. Use explicit cwd only when you intentionally want that other directory's project context.",
    ],
  },
  subagentResume: {
    label: "Resume subagent",
    description: "Continue an existing child Pi session by its subagent session ID and return compact session metadata plus that child's next final answer.",
    promptSnippet: "Continue an existing pi-submarine child session by session ID",
    parameterDescriptions: {
      sessionId: "The child Pi session ID from an earlier subagent or subagent_resume result, or from recovery text in the current parent/root session.",
      message: "Message to append to the existing child Pi session before waiting for its next final answer.",
    },
    promptGuidelines: [
      "subagent_resume continues an existing child Pi session in the current parent/root session; it appends message to that same child conversation instead of starting over.",
      "subagent_resume lookup is scoped to the current parent/root session; it does not search globally, fork, or copy the child session.",
      "subagent_resume reloads child resources with pi-submarine's approved project-local resource policy for the recorded cwd.",
      "Use subagent for unrelated work, independent investigations, or a fresh child context.",
      "Use subagent_resume when continuing the same child context is better than starting a new subagent, including after interruption, failure, or a completed result that needs a follow-up.",
      "Example subagent_resume message: You were interrupted. Continue work exactly where you left off.",
      "Example subagent_resume message: Good. Now also check the edge cases you mentioned and update your recommendation.",
      "Example subagent_resume message: Please summarize what you did so far for a handoff so we can continue later.",
    ],
  },
  subagentList: {
    label: "List subagents",
    description: "List pi-submarine markdown agents visible from the caller cwd, or from an explicit advanced cwd override, plus the special omitted-agent default mode.",
    promptSnippet: "Inspect visible pi-submarine subagents for a working directory",
    parameterDescriptions: {
      cwd: "Advanced directory override for listing visible subagents. Usually omit cwd to list agents from the caller project context. Relative paths resolve from the caller cwd.",
    },
    promptGuidelines: [
      "subagent_list lists markdown agents visible from the caller cwd, plus the special default mode used when agent is omitted.",
      "Usually omit cwd for subagent_list. Use explicit cwd only when you intentionally want to inspect another directory's project agents.",
    ],
  },
} as const;

export function namedForkPrompt(agentName: string, agentBody: string | undefined, task: string): string {
  return `Subagent instructions from \`${agentName}\`:\n${agentBody ?? ""}\n\nTask:\n${task}`;
}
