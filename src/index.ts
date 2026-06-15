import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { listSubagents } from "./listing.js";
import { runSubagent, runSubagentResume } from "./runner.js";
import { TOOL_PROMPTS } from "./tool-prompts.js";
import { SUBAGENT_LIST_TOOL_NAME, SUBAGENT_RESUME_TOOL_NAME, SUBAGENT_TOOL_NAME } from "./types.js";

export const subagentParameters = Type.Object(
  {
    agent: Type.Optional(Type.String({ description: TOOL_PROMPTS.subagent.parameterDescriptions.agent })),
    task: Type.String({ minLength: 1, description: TOOL_PROMPTS.subagent.parameterDescriptions.task }),
    context: Type.Optional(
      StringEnum(["fresh", "fork"] as const, {
        default: "fresh",
        description: TOOL_PROMPTS.subagent.parameterDescriptions.context,
      }),
    ),
    cwd: Type.Optional(Type.String({ description: TOOL_PROMPTS.subagent.parameterDescriptions.cwd })),
  },
  { additionalProperties: false },
);

export const subagentResumeParameters = Type.Object(
  {
    sessionId: Type.String({ minLength: 1, description: TOOL_PROMPTS.subagentResume.parameterDescriptions.sessionId }),
    message: Type.String({ minLength: 1, description: TOOL_PROMPTS.subagentResume.parameterDescriptions.message }),
  },
  { additionalProperties: false },
);

export const subagentListParameters = Type.Object(
  {
    cwd: Type.Optional(Type.String({ description: TOOL_PROMPTS.subagentList.parameterDescriptions.cwd })),
  },
  { additionalProperties: false },
);

export const subagentTool = defineTool({
  name: SUBAGENT_TOOL_NAME,
  label: TOOL_PROMPTS.subagent.label,
  description: TOOL_PROMPTS.subagent.description,
  promptSnippet: TOOL_PROMPTS.subagent.promptSnippet,
  promptGuidelines: [...TOOL_PROMPTS.subagent.promptGuidelines],
  parameters: subagentParameters,
  async execute(_toolCallId, params, signal, onUpdate, ctx) {
    return runSubagent(params, signal, onUpdate, ctx, { extensionFactories: [register] });
  },
});

export const subagentResumeTool = defineTool({
  name: SUBAGENT_RESUME_TOOL_NAME,
  label: TOOL_PROMPTS.subagentResume.label,
  description: TOOL_PROMPTS.subagentResume.description,
  promptSnippet: TOOL_PROMPTS.subagentResume.promptSnippet,
  promptGuidelines: [...TOOL_PROMPTS.subagentResume.promptGuidelines],
  parameters: subagentResumeParameters,
  async execute(_toolCallId, params, signal, onUpdate, ctx) {
    return runSubagentResume(params, signal, onUpdate, ctx, { extensionFactories: [register] });
  },
});

export const subagentListTool = defineTool({
  name: SUBAGENT_LIST_TOOL_NAME,
  label: TOOL_PROMPTS.subagentList.label,
  description: TOOL_PROMPTS.subagentList.description,
  promptSnippet: TOOL_PROMPTS.subagentList.promptSnippet,
  promptGuidelines: [...TOOL_PROMPTS.subagentList.promptGuidelines],
  parameters: subagentListParameters,
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    return listSubagents(params, ctx);
  },
});

export default function register(pi: ExtensionAPI) {
  pi.registerTool(subagentTool);
  pi.registerTool(subagentResumeTool);
  pi.registerTool(subagentListTool);
}
