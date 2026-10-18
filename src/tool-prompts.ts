export const TOOL_PROMPTS = {
  subagent: {
    label: "Subagent",
    description: "Delegate one focused task and wait for its answer and session ID.",
    promptSnippet: "Delegate one foreground task",
    parameterDescriptions: {
      agent: "Existing agent filename stem, not a role name. Omit for an unnamed child. Project `.pi/agents/*.md` overrides same-named user agents.",
      task: "Task and expected output. For `fresh`, include the needed context, paths, constraints, and checks.",
      model: "Comma-separated fallback models, in order, for one child. Use model IDs or `provider/model`, each optionally `@effort`. Replaces the profile's whole chain.",
      agentsMd: "Fresh only. `none` skips AGENTS.md context files. `auto` loads them normally. Defaults to the profile's choice or `none` for an unnamed child. Explicit overrides persist on resume.",
      context: "`fresh` starts without parent history. `fork` copies the selected parent branch and rejects `cwd` and `agentsMd`. Defaults to `fresh`.",
      cwd: "Fresh-only workspace override, relative to caller cwd. Usually omit to keep caller cwd. Project agents, instructions, skills, and tools follow it. Read external files by path in `task`.",
    },
    promptGuidelines: [
      "Every call waits for its foreground child. Use `multi_tool_use.parallel`, when available, for independent calls. Start dependent work after its inputs arrive. There are no detached background jobs.",
      "Every candidate must be registered, have configured authentication, and support its requested effort. Invalid candidates fail the whole call. Candidates are not skipped and effort is not clamped.",
      "Fallback advances only on an initial provider error before assistant success or tool progress. Abort, prompt rejection, later failure, and weak answers do not trigger fallback.",
      "Changing `model` or `agentsMd` keeps the named prompt and skills. Context-file selection does not restrict the child's permissions.",
    ],
  },
  subagentResume: {
    label: "Resume subagent",
    description: "Recover a failed or interrupted child, or continue the exact child at the user's explicit request.",
    promptSnippet: "Recover or explicitly continue a child",
    parameterDescriptions: {
      sessionId: "Child session ID from a tool result or recovery hint.",
      message: "User message to append before waiting for the child's next answer.",
    },
    promptGuidelines: [
      "Use `subagent` for new work and ordinary follow-ups. Resume stays within this root session and adds no new parent history.",
    ],
  },
  subagentList: {
    label: "List subagents",
    description: "List visible agents and models with configured authentication and supported effort levels.",
    promptSnippet: "Inspect agent and model choices",
    parameterDescriptions: {
      cwd: "Directory to inspect, relative to caller cwd. Usually omit to inspect the caller's workspace.",
    },
    promptGuidelines: [
      "List only when agent names, models, or effort support are unknown. Use known choices directly.",
    ],
  },
} as const;

export interface SubagentPromptEnvelopeOptions {
  context: "fresh" | "fork";
  task: string;
  parentDepth: number;
  agentName?: string;
  agentBody?: string;
}

export function buildSubagentPromptEnvelope(options: SubagentPromptEnvelopeOptions): string {
  const contextLine = options.context === "fresh"
    ? "You are a child subagent. You start without the parent conversation."
    : "You are a child subagent. You start from a copy of the parent conversation.";
  const depthLine = subagentDepthLine(options.parentDepth);
  const parts = [
    `<subagent-context>\n${contextLine}\n${depthLine}\n</subagent-context>`,
  ];

  if (options.agentName !== undefined) {
    const tag = subagentAgentTagName(options.agentName);
    parts.push(`<${tag}>\n${options.agentBody ?? ""}\n</${tag}>`);
  }

  parts.push(`<task>\n${options.task}\n</task>`);
  return parts.join("\n\n");
}

export function subagentAgentTagName(agentName: string): string {
  let sanitized = agentName.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!sanitized) sanitized = "agent";
  if (!/^[a-z]/.test(sanitized)) sanitized = `agent-${sanitized}`;
  return `${sanitized}-agent`;
}

function subagentDepthLine(parentDepth: number): string {
  if (parentDepth <= 0) return "You are the first subagent in this tree.";
  if (parentDepth === 1) return "You have one parent subagent above you in this tree.";
  return `You have ${parentDepth} parent subagents above you in this tree.`;
}
