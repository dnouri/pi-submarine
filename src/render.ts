import { safeReferenceText } from "./saved-conversations.js";
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

export function requiredRunTitle(title: string): string {
  const trimmed = title.trim().replace(/\s+/g, " ");
  if (!safeReferenceText(trimmed)) {
    throw new Error("Title must be one short line of printable text. Give the call a three-to-five-word title and retry.");
  }
  return trimmed;
}

export function safeRunTitle(title: string): string {
  return safeReferenceText(title) ? title : "";
}

export function renderSubagentResult(selection: AgentSelection, run: Pick<SubagentRunView, "sessionId" | "title" | "turnCount" | "contextUsage">, answer: string, modelNote?: string): string {
  const note = modelNote === undefined ? "" : `\n${modelNote}`;
  const percent = run.contextUsage?.percent;
  const context = percent == null ? "? context" : `${percent}% context`;
  const task = run.title ? `\nTask: ${run.title}` : "";
  return `${resultHeading(selection)}\nSubagent session ID: ${run.sessionId}${task}\nRan ${formatTurnCount(run.turnCount)} at ${context}${note}\n\n${answer}`;
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
    "If the interrupted task should continue, call `subagent_resume` with this session ID and a message. Otherwise start a new `subagent`.",
    "",
    "Example for `message`:",
    "- You were interrupted. Continue the original task from where you left off.",
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
    "This child session may be recoverable. If the same task should continue after a transient failure, call `subagent_resume` with this session ID and a message. Otherwise start a new `subagent`.",
  ].join("\n");
}

export function renderSubagentProgress(run: SubagentRunView, now = Date.now()): string {
  return activeRunPaths(run).map((path) => formatRunProgressBullet(path, now)).join("\n");
}

function activeRunPaths(run: SubagentRunView): SubagentRunView[][] {
  const runningPaths = runningLeafPaths(run, []);
  return runningPaths.length > 0 ? runningPaths : [[run]];
}

function formatRunPath(path: readonly SubagentRunView[], now: number): string {
  return path.map((run) => formatRunSegment(run, now)).join(" -> ");
}

function formatRunSegment(run: SubagentRunView, now: number): string {
  const details = formatRunSegmentDetails(run, now).join(", ");
  const title = safeRunTitle(run.title);
  return title ? `${title} (${run.agent}, ${details})` : `${run.agent} (${details})`;
}

function formatRunProgressBullet(path: readonly SubagentRunView[], now: number): string {
  const leaf = path.at(-1);
  if (!leaf) throw new Error("Cannot render an empty subagent path.");
  return `- ${formatRunPath(path, now)}: ${leaf.activity}`;
}

function runningLeafPaths(run: SubagentRunView, ancestors: readonly SubagentRunView[]): SubagentRunView[][] {
  if (run.status !== "running") return [];

  const path = [...ancestors, run];
  const childPaths = run.children.flatMap((child) => runningLeafPaths(child, path));
  return childPaths.length > 0 ? childPaths : [path];
}

function formatRunSegmentDetails(run: SubagentRunView, now: number): string[] {
  const details: string[] = [];
  const contextUsage = formatContextUsage(run);
  if (contextUsage) details.push(contextUsage);
  details.push(formatTurnCount(run.turnCount));
  const age = formatActivityAge(run.lastActivityAt, now);
  if (age !== undefined) details.push(age);
  return details;
}

export function formatActivityAge(lastActivityAt: string, now: number): string | undefined {
  const timestamp = Date.parse(lastActivityAt);
  if (Number.isNaN(timestamp)) return undefined;
  return `${Math.max(0, Math.floor((now - timestamp) / 1000))}s`;
}

function formatContextUsage(run: Pick<SubagentRunView, "contextUsage">): string | undefined {
  if (run.contextUsage === undefined) return undefined;
  if (run.contextUsage.percent === null) return "? ctx";
  return `${Math.round(run.contextUsage.percent)}% ctx`;
}

function formatTurnCount(turnCount: number): string {
  return `${turnCount} ${turnCount === 1 ? "turn" : "turns"}`;
}
