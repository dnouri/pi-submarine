import { homedir } from "node:os";
import path from "node:path";
import { OMITTED_AGENT_LABEL, type AgentSelection, type SubagentRunView } from "./types.js";

export function omittedAgentSelection(): AgentSelection {
  return { kind: "omitted", label: OMITTED_AGENT_LABEL };
}

export function namedAgentSelection(name: string, agentFile?: string): AgentSelection {
  return agentFile === undefined ? { kind: "named", name } : { kind: "named", name, agentFile };
}

export function subagentTitle(selection: AgentSelection): string {
  if (selection.kind === "omitted") return "Subagent";
  return `Subagent ${selection.name}`;
}

export function resultHeading(selection: AgentSelection): string {
  return `## ${subagentTitle(selection)} result`;
}

export function renderSubagentResult(selection: AgentSelection, sessionId: string, answer: string): string {
  return `${resultHeading(selection)}\nSubagent session ID: ${sessionId}\n\n${answer}`;
}

export function interruptedHeading(selection: AgentSelection): string {
  return `## ${subagentTitle(selection)} interrupted`;
}

export function renderSubagentInterrupted(selection: AgentSelection, sessionId: string): string {
  return [
    interruptedHeading(selection),
    "",
    "No final answer was produced.",
    "",
    `Subagent session ID: ${sessionId}`,
    "",
    "To continue this exact child session, call `subagent_resume` with this session ID and a message.",
    "",
    "Examples for `message`:",
    "- You were interrupted. Continue work exactly where you left off.",
    "- Good. Now also check the edge cases you mentioned and update your recommendation.",
    "- Please summarize what you did so far for a handoff so we can continue later.",
  ].join("\n");
}

export function errorHeading(selection: AgentSelection): string {
  return `## ${subagentTitle(selection)} error`;
}

export function renderSubagentRecoverableError(selection: AgentSelection, sessionId: string, message: string): string {
  return [
    errorHeading(selection),
    "",
    message,
    "",
    `Subagent session ID: ${sessionId}`,
    "",
    "This child session may be resumable. To continue this exact child session, call `subagent_resume` with this session ID and a message.",
  ].join("\n");
}

export function renderSubagentProgress(run: SubagentRunView): string {
  return [
    `Log: ${formatActiveLogPath(run.activityLog)}  Subagents:`,
    ...activeRunPaths(run).map(formatRunProgressBullet),
  ].join("\n");
}

function formatActiveLogPath(activityLog: string): string {
  if (!path.isAbsolute(activityLog)) return toDisplayPath(activityLog);

  const home = homedir();
  if (!home) return toDisplayPath(activityLog);

  const absoluteLog = path.resolve(activityLog);
  const absoluteHome = path.resolve(home);
  const relativeToHome = path.relative(absoluteHome, absoluteLog);
  if (relativeToHome === "") return "~";
  if (relativeToHome !== ".." && !relativeToHome.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeToHome)) {
    return `~/${toDisplayPath(relativeToHome)}`;
  }

  return toDisplayPath(activityLog);
}

function toDisplayPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function activeRunPaths(run: SubagentRunView): SubagentRunView[][] {
  const runningPaths = runningLeafPaths(run, []);
  return runningPaths.length > 0 ? runningPaths : [[run]];
}

function formatRunPath(path: readonly SubagentRunView[]): string {
  return path.map(formatRunSegment).join(" -> ");
}

function formatRunSegment(run: SubagentRunView): string {
  return `${run.agent} (${formatRunDetails(run)})`;
}

export function formatRunDetails(run: Pick<SubagentRunView, "contextUsage" | "turnCount">): string {
  return formatRunSegmentDetails(run).join(", ");
}

function formatRunProgressBullet(path: readonly SubagentRunView[]): string {
  const leaf = path.at(-1);
  if (!leaf) throw new Error("Cannot render an empty subagent path.");
  return `- ${formatRunPath(path)}: ${leaf.activity}`;
}

function runningLeafPaths(run: SubagentRunView, ancestors: readonly SubagentRunView[]): SubagentRunView[][] {
  if (run.status !== "running") return [];

  const path = [...ancestors, run];
  const childPaths = run.children.flatMap((child) => runningLeafPaths(child, path));
  return childPaths.length > 0 ? childPaths : [path];
}

function formatRunSegmentDetails(run: Pick<SubagentRunView, "contextUsage" | "turnCount">): string[] {
  const details: string[] = [];
  const contextUsage = formatContextUsage(run);
  if (contextUsage) details.push(contextUsage);
  details.push(formatTurnCount(run.turnCount));
  return details;
}

function formatContextUsage(run: Pick<SubagentRunView, "contextUsage">): string | undefined {
  if (run.contextUsage === undefined) return undefined;
  if (run.contextUsage.percent === null) return "? ctx";
  return `${Math.round(run.contextUsage.percent)}% ctx`;
}

function formatTurnCount(turnCount: number): string {
  return `${turnCount} ${turnCount === 1 ? "turn" : "turns"}`;
}
