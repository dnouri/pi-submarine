export const TOOL_PROMPTS = {
  subagent: {
    label: "Subagent",
    description: "Delegate one focused task to a new subagent, and return compact session metadata plus that child's final answer.",
    promptSnippet: "Run one synchronous subagent to delegate a focused task",
    parameterDescriptions: {
      agent: "Markdown agent name, i.e. its filename stem. Omit for default mode; project agents from the effective `cwd` override same-named user-defined agents.",
      task: "Prompt for the child. For `fresh` independent work, make sure to include needed context, paths, constraints, and desired output because the child does not see the parent conversation.",
      model: "Optional model ID or provider/model ID, or a comma-separated chain of one to three such references. Each may have one `@thinkingLevel` suffix in the final slash-delimited path segment; earlier `@` characters belong to the model ID. Empty, unknown, or duplicate suffixes are invalid. Replaces the whole frontmatter model chain for this call, in default or named-agent mode.",
      thinkingLevel: "Optional thinking level for this call: one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. See the thinking precedence and validation rules below.",
      context: "Defaults to `fresh`. Use `fork` only when the child must inherit a copy of the current conversation; `cwd` is invalid with fork.",
      cwd: "Omit to inherit the caller cwd. Set only to run the child from a different workspace/project, with its tools, agents, context files, and skills.",
    },
    promptGuidelines: [
      "Common calls: subagent({ task: \"...\" }) for independent work, subagent({ model: \"acme/acme-5v-turbo\", task: \"Read screenshots/login.png and return its contents\" }) to pick a default-mode child's model, or subagent({ context: \"fork\", task: \"...\" }) when the child should inherit a copy of the current conversation.",
      "Fresh/default children do not see the parent conversation, so make sure you pass sufficient context in the task!",
      "One call runs one foreground child and waits for the final answer; it is not a background job or workflow engine. A model chain is fallback within that child, not parallel children.",
      "Omit `agent` for default mode; pass an agent name instead to use a specific agent. Role text inside `task` does not select an agent.",
      "Usually omit `cwd`. Use it only when another directory should be the child's workspace/project.",
      "Named `agent`s resolve from the effective cwd; project .pi/agents/*.md overrides same-named user agents.",
      "Call-level `model`/`thinkingLevel` override named-agent defaults without changing the named prompt or resource controls.",
      "Named-agent chain example: subagent({ agent: \"reviewer\", model: \"acme/fast@low,acme/steady@high\", task: \"Review src/runner.ts\" }). Choose model references and levels from subagent_list.",
      "Surrounding whitespace in model references and suffixes is ignored; slashes and colons in IDs are preserved.",
      "Thinking precedence: call-level `thinkingLevel`, then each candidate's suffix, then frontmatter `thinkingLevel`. A supported call override can shadow a valid but unsupported suffix.",
      "Every selected candidate must be registered, authenticated, and support its effective thinking level before a child session file, manifest, or activity log is created; unavailable candidates are not skipped. Unsupported effective levels fail listing the supported levels rather than silently clamping.",
      "A next candidate is tried only after an initial provider error, before successful assistant output or tool progress. Prompt rejections and aborts are not retried.",
      "Prefer a new `subagent` for follow-up or related work, even when an earlier child already knows the topic.",
    ],
  },
  subagentResume: {
    label: "Resume subagent",
    description: "Continue an existing child Pi session by its subagent session ID and return compact session metadata plus that child's next final answer. Use `subagent_resume` to recover an interrupted or failed child when its result includes a session ID, or when the user explicitly asks to resume that exact child session; otherwise use a new `subagent`.",
    promptSnippet: "Recover an interrupted or failed child, or honor an explicit request to resume one by session ID",
    parameterDescriptions: {
      sessionId: "The child subagent session ID from an earlier `subagent` or `subagent_resume` result, including recovery text after an interrupted or failed run.",
      message: "Message to append to the existing child conversation before waiting for its next answer.",
    },
    promptGuidelines: [
      "Common call form: subagent_resume({ sessionId: \"...\", message: \"...\" }).",
      "Use `subagent_resume` to recover an interrupted or failed child when its result includes a session ID, or when the user explicitly asks to resume that exact child session.",
      "`subagent_resume` continues an existing child subagent session in the current parent/root session; it appends `message` to that conversation and does not create a new child context.",
    ],
  },
  subagentList: {
    label: "List subagents",
    description: "List specialized markdown `agent`s visible from the caller `cwd`, or from an explicit cwd override, plus the special omitted-agent `default` mode, and the callable models with their supported thinking levels.",
    promptSnippet: "Inspect visible subagents and callable models for a working directory",
    parameterDescriptions: {
      cwd: "Optional directory override. Usually omit to list agents visible from the caller project context. Set only when intentionally inspecting another directory; relative paths resolve from caller `cwd`.",
    },
    promptGuidelines: [
      "Common call forms: subagent_list({}) for the caller cwd; subagent_list({ cwd: \"/path\" }) only when inspecting another project context.",
      "subagent_list lists markdown `agent`s visible from the effective cwd, plus the special `default` mode used when agent is omitted.",
      "subagent_list also lists callable models (authenticated only) with their supported `thinkingLevel` values, marking the current model; use it to pick valid model and thinkingLevel values for subagent calls.",
      "Use subagent_list when you need to discover available markdown `agent`s or valid model/thinkingLevel values; do not call it first if you already know the agent name.",
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
