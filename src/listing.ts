import { stat } from "node:fs/promises";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverMarkdownAgents, findNearestProjectAgentsDir, type AgentDiscoveryOptions } from "./agents.js";
import type { MarkdownAgent, SubagentListParams, TextToolResult } from "./types.js";

export interface ListingInput {
  cwd: string;
  agents: MarkdownAgent[];
  warnings?: string[];
}

export type ListingContext = Pick<ExtensionContext, "cwd"> | { cwd?: string };

export interface ListSubagentsOptions {
  userAgentsDir?: string;
}

export function formatSubagentList({ cwd, agents, warnings = [] }: ListingInput): string {
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

  return {
    content: [{ type: "text", text: formatSubagentList({ cwd, agents: result.agents, warnings }) }],
    details: {
      status: "listed",
      count: result.agents.length,
      cwd,
      sourceCounts: result.sourceCounts,
      agentDirectories: result.agentDirectories,
    },
  };
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
