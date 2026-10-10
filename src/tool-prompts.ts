export const TOOL_PROMPTS = {
  subagent: {
    label: "Subagent",
    description: "Delegate one focused task; return the child's answer and session metadata.",
    promptSnippet: "Delegate one foreground task",
    parameterDescriptions: {
      agent: "Markdown filename stem; omit for default mode. Project `.pi/agents/*.md` overrides same-named user agents.",
      task: "Task and expected output. For `fresh`, include required context, paths, and constraints.",
      model: "1–3 comma-separated model IDs or `provider/model` references with optional `@thinkingLevel` suffixes. `@` before the last `/` stays literal. Replaces the whole profile chain.",
      thinkingLevel: "Override thinking for every candidate.",
      context: "`fresh` (default): no parent history. `fork` copies it and forbids `cwd`.",
      cwd: "Child workspace; defaults to caller cwd. Relative paths resolve there. Project agents, instructions, skills, and tools follow it.",
    },
    promptGuidelines: [
      "Each call waits for one foreground child. A chain is fallback, not parallel children.",
      "Role text in `task` does not select an agent. Overrides keep the named prompt and resource controls.",
      "Example: subagent({ agent: \"reviewer\", model: \"acme/fast@low,acme/steady@high\", task: \"Review changes\" }).",
      "Thinking precedence: call `thinkingLevel` > candidate suffix > profile default. Only the effective level must be supported.",
      "Every candidate must be registered, authenticated, and support its effective level before child session files, manifests, or logs. No skipping or clamping.",
      "Fallback only on an initial provider error, before assistant success or tool progress; never on abort or prompt rejection.",
    ],
  },
  subagentResume: {
    label: "Resume subagent",
    description: "Resume a failed/interrupted child, or the exact child the user asks to continue; otherwise use `subagent`.",
    promptSnippet: "Recover or explicitly resume a child",
    parameterDescriptions: {
      sessionId: "Session ID from a `subagent` or `subagent_resume` result or recovery hint.",
      message: "Message to append before waiting for the next answer.",
    },
    promptGuidelines: [
      "Appends to the existing child in this root session; no new context.",
    ],
  },
  subagentList: {
    label: "List subagents",
    description: "List visible agents, default mode, and authenticated models with supported thinking levels.",
    promptSnippet: "Inspect agents and model/level choices",
    parameterDescriptions: {
      cwd: "Directory to inspect; defaults to caller cwd. Relative paths resolve there.",
    },
    promptGuidelines: [
      "Use for unknown agents or model/level choices; skip for known choices.",
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
