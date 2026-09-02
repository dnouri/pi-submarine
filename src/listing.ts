import { stat } from "node:fs/promises";
import path from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";
import { discoverMarkdownAgents, findNearestProjectAgentsDir, type AgentDiscoveryOptions } from "./agents.js";
import type { SubagentModelRegistry } from "./models.js";
import type { MarkdownAgent, SubagentListParams, TextToolResult } from "./types.js";

export interface CallableModelInfo {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  thinkingLevels: string[];
}

export interface ListingInput {
  cwd: string;
  agents: MarkdownAgent[];
  warnings?: string[];
  models?: CallableModelInfo[];
  currentModel?: string | null;
}

export interface ListingContext {
  cwd?: string;
  modelRegistry: SubagentModelRegistry;
  model?: Model<Api> | null | undefined;
}

export interface ListSubagentsOptions {
  userAgentsDir?: string;
}

export function formatSubagentList({ cwd, agents, warnings = [], models = [], currentModel = null }: ListingInput): string {
  const lines = [
    `Available subagents for ${cwd}:`,
    "",
    "Special mode:",
    "- omit agent: run the default `subagent`",
    "",
    "Markdown agents:",
  ];

  if (agents.length === 0) {
    lines.push("- none found");
  } else {
    for (const agent of agents) {
      lines.push(`- ${agent.name} (${agent.source}) — ${agent.description}`);
      lines.push(`  path: ${agent.filePath}`);
    }
  }

  lines.push("", "Callable models:");
  if (models.length === 0) {
    lines.push("- none authenticated");
  } else {
    for (const model of models) {
      const currentSuffix =
        currentModel !== null && currentModel === `${model.provider}/${model.id}` ? " — current" : "";
      lines.push(`- ${model.provider}/${model.id} — thinking: ${model.thinkingLevels.join(", ")}${currentSuffix}`);
    }
  }

  if (warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of warnings) lines.push(`- ${warning}`);
  }

  return lines.join("\n");
}

export async function resolveListingCwd(params: SubagentListParams, ctx: ListingContext): Promise<string> {
  const baseCwd = ctx.cwd;
  if (!params.cwd && !baseCwd) {
    throw new Error("subagent_list requires a cwd from the calling session or an explicit cwd parameter.");
  }

  const cwd = path.resolve(baseCwd ?? process.cwd(), params.cwd ?? ".");
  if (!await isDirectory(cwd)) {
    throw new Error(`subagent_list cwd does not exist or is not a directory: ${cwd}`);
  }
  return cwd;
}

export async function listSubagents(params: SubagentListParams, ctx: ListingContext, options: ListSubagentsOptions = {}): Promise<TextToolResult> {
  const cwd = await resolveListingCwd(params, ctx);
  const result = await discoverMarkdownAgents(discoveryOptions(cwd, options));
  const warnings = [
    ...result.warnings,
    ...await explicitCwdProjectAgentWarnings(params, ctx, cwd, result.agentDirectories.project),
  ];
  const models = listCallableModels(ctx);
  const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null;

  return {
    content: [{ type: "text", text: formatSubagentList({ cwd, agents: result.agents, warnings, models, currentModel }) }],
    details: {
      status: "listed",
      count: result.agents.length,
      cwd,
      sourceCounts: result.sourceCounts,
      agentDirectories: result.agentDirectories,
      models,
      currentModel,
    },
  };
}

function listCallableModels(ctx: ListingContext): CallableModelInfo[] {
  return ctx.modelRegistry
    .getAll()
    .filter((model) => ctx.modelRegistry.hasConfiguredAuth(model))
    .sort((left, right) => `${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`))
    .map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      thinkingLevels: getSupportedThinkingLevels(model),
    }));
}

function discoveryOptions(cwd: string, options: ListSubagentsOptions): AgentDiscoveryOptions {
  return options.userAgentsDir === undefined ? { cwd } : { cwd, userAgentsDir: options.userAgentsDir };
}

async function explicitCwdProjectAgentWarnings(
  params: SubagentListParams,
  ctx: ListingContext,
  cwd: string,
  projectAgentsDir: string | null,
): Promise<string[]> {
  if (params.cwd === undefined || !ctx.cwd) return [];

  const callerCwd = path.resolve(ctx.cwd);
  if (callerCwd === cwd) return [];

  const callerProjectAgentsDir = await findNearestProjectAgentsDir(callerCwd);
  if (!callerProjectAgentsDir || callerProjectAgentsDir === projectAgentsDir) return [];

  return [
    `explicit cwd hides the caller project's agent directory: ${callerProjectAgentsDir}. If you meant to use or inspect those project agents, omit cwd and pass external paths inside task. Caller cwd: ${callerCwd}.`,
  ];
}

async function isDirectory(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}
