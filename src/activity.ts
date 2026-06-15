import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_RESUME_TOOL_NAME, SUBAGENT_TOOL_NAME, type SubagentContextUsage, type SubagentRunView } from "./types.js";

const MAX_TOOL_ARGS_LENGTH = 160;

interface ActiveTool {
  id: string;
  name: string;
  argsSummary: string;
}

export interface SubagentActivityState {
  run: SubagentRunView;
  activeTools: Map<string, ActiveTool>;
}

export interface ActivityReduction {
  changed: boolean;
  nestedRun?: SubagentRunView;
}

export function createInitialRunView(input: {
  episodeId: string;
  sessionId: string;
  agent: string;
  activityLog: string;
  now: string;
}): SubagentRunView {
  return {
    episodeId: input.episodeId,
    sessionId: input.sessionId,
    agent: input.agent,
    status: "running",
    turnCount: 0,
    lastActivityAt: input.now,
    activity: "starting",
    activityLog: input.activityLog,
    children: [],
  };
}

export function createActivityState(run: SubagentRunView): SubagentActivityState {
  return { run, activeTools: new Map() };
}

export function reduceActivityEvent(state: SubagentActivityState, event: AgentSessionEvent, now: string): ActivityReduction {
  state.run.lastActivityAt = now;

  switch (event.type) {
    case "agent_start":
      return setActivity(state, "running");
    case "turn_start":
      return setActivity(state, "starting turn");
    case "turn_end":
      state.run.turnCount += 1;
      return setActivity(state, state.activeTools.size > 0 ? summarizeActiveTools(state.activeTools) : "turn completed", { forceChanged: true });
    case "message_update":
      return reduceAssistantUpdate(state, event.assistantMessageEvent);
    case "message_end":
      return setActivity(state, state.activeTools.size > 0 ? summarizeActiveTools(state.activeTools) : messageEndActivity(event.message));
    case "tool_execution_start":
      state.activeTools.set(event.toolCallId, { id: event.toolCallId, name: event.toolName, argsSummary: compactToolArgs(event.args) });
      return setActivity(state, summarizeActiveTools(state.activeTools), { forceChanged: true });
    case "tool_execution_update": {
      const tool = state.activeTools.get(event.toolCallId);
      if (tool) {
        tool.argsSummary = compactToolArgs(event.args);
      } else {
        state.activeTools.set(event.toolCallId, { id: event.toolCallId, name: event.toolName, argsSummary: compactToolArgs(event.args) });
      }

      const nestedRun = isSubagentActivityTool(event.toolName) ? extractRunView(event.partialResult) : undefined;
      if (nestedRun) return reduceNestedRunUpdate(state, nestedRun);

      return setActivity(state, summarizeActiveTools(state.activeTools));
    }
    case "tool_execution_end": {
      state.activeTools.delete(event.toolCallId);
      const nestedRun = isSubagentActivityTool(event.toolName) ? extractRunView(event.result) : undefined;
      if (nestedRun) return reduceNestedRunUpdate(state, nestedRun);
      if (isSubagentActivityTool(event.toolName) && event.isError) return summarizeThrownNestedToolEnd(state);

      return setActivity(state, state.activeTools.size > 0
        ? summarizeActiveTools(state.activeTools)
        : `${event.isError ? "failed" : "finished"} ${event.toolName}`, { forceChanged: true });
    }
    case "auto_retry_start":
      return setActivity(state, `retrying attempt ${event.attempt}/${event.maxAttempts} after ${oneLine(event.errorMessage)}`);
    case "auto_retry_end":
      return setActivity(state, event.success ? `retry attempt ${event.attempt} succeeded` : `retry attempt ${event.attempt} failed${event.finalError ? `: ${oneLine(event.finalError)}` : ""}`);
    case "compaction_start":
      return setActivity(state, `compacting context (${event.reason})`);
    case "compaction_end":
      if (event.aborted) return setActivity(state, "context compaction aborted");
      if (event.errorMessage) return setActivity(state, `context compaction failed: ${oneLine(event.errorMessage)}`);
      return setActivity(state, "context compacted");
    case "agent_end":
      return setActivity(state, event.willRetry ? "retry pending" : "agent finished");
    case "message_start":
      return setActivity(state, messageStartActivity(event.message));
    default:
      return { changed: false };
  }
}

function isSubagentActivityTool(toolName: string): boolean {
  return toolName === SUBAGENT_TOOL_NAME || toolName === SUBAGENT_RESUME_TOOL_NAME;
}

function reduceAssistantUpdate(state: SubagentActivityState, assistantMessageEvent: unknown): ActivityReduction {
  if (!isObject(assistantMessageEvent) || typeof assistantMessageEvent.type !== "string") return setActivity(state, "responding");
  if (assistantMessageEvent.type === "thinking_delta") return setActivity(state, "thinking");
  if (assistantMessageEvent.type === "text_delta") return setActivity(state, "responding");
  if (assistantMessageEvent.type === "toolcall_delta" || assistantMessageEvent.type === "toolcall_start") return setActivity(state, "preparing tool call");
  return setActivity(state, "responding");
}

function reduceNestedRunUpdate(state: SubagentActivityState, run: SubagentRunView): ActivityReduction {
  const snapshot = cloneRunView(run);
  mergeChildRun(state.run, snapshot);
  state.run.activity = summarizeNestedRun(snapshot);
  return { changed: true, nestedRun: snapshot };
}

function setActivity(state: SubagentActivityState, activity: string, options: { forceChanged?: boolean } = {}): ActivityReduction {
  const changed = options.forceChanged === true || state.run.activity !== activity;
  state.run.activity = activity;
  return { changed };
}

export function compactToolArgs(args: unknown, maxLength = MAX_TOOL_ARGS_LENGTH): string {
  let text: string;
  try {
    text = JSON.stringify(args ?? {});
  } catch {
    text = "[unserializable args]";
  }

  text = oneLine(text);
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

export function cloneRunView(run: SubagentRunView): SubagentRunView {
  const { children, contextUsage, ...rest } = run;
  return {
    ...rest,
    ...(contextUsage === undefined ? {} : { contextUsage: cloneContextUsage(contextUsage) }),
    children: children.map(cloneRunView),
  };
}

function summarizeActiveTools(activeTools: Map<string, ActiveTool>): string {
  const tools = [...activeTools.values()];
  const first = tools[0];
  if (!first) return "running";
  const firstSummary = `using ${first.name} ${first.argsSummary}`;
  return tools.length === 1 ? firstSummary : `${firstSummary} + ${tools.length - 1} tool${tools.length === 2 ? "" : "s"}`;
}

function summarizeThrownNestedToolEnd(state: SubagentActivityState): ActivityReduction {
  const latestTerminalChild = [...state.run.children].reverse().find((child) => child.status !== "running");
  return setActivity(state, latestTerminalChild ? summarizeNestedRun(latestTerminalChild) : "failed subagent", { forceChanged: true });
}

function mergeChildRun(parent: SubagentRunView, child: SubagentRunView): void {
  const index = parent.children.findIndex((existing) => existing.episodeId === child.episodeId);
  if (index === -1) parent.children.push(child);
  else parent.children[index] = child;
}

function extractRunView(toolResult: unknown): SubagentRunView | undefined {
  if (!isObject(toolResult) || !isObject(toolResult.details)) return undefined;
  const run = toolResult.details.run;
  return isRunView(run) ? run : undefined;
}

function isRunView(value: unknown): value is SubagentRunView {
  if (!isObject(value)) return false;
  return typeof value.episodeId === "string"
    && typeof value.sessionId === "string"
    && typeof value.agent === "string"
    && (value.status === "running" || value.status === "completed" || value.status === "failed" || value.status === "aborted")
    && typeof value.turnCount === "number"
    && typeof value.lastActivityAt === "string"
    && typeof value.activity === "string"
    && typeof value.activityLog === "string"
    && (!("contextUsage" in value) || isContextUsage(value.contextUsage))
    && Array.isArray(value.children)
    && value.children.every(isRunView);
}

function cloneContextUsage(contextUsage: SubagentContextUsage): SubagentContextUsage {
  return { ...contextUsage };
}

function isContextUsage(value: unknown): value is SubagentContextUsage {
  if (!isObject(value)) return false;
  return isNumberOrNull(value.tokens)
    && typeof value.contextWindow === "number"
    && isNumberOrNull(value.percent);
}

function isNumberOrNull(value: unknown): value is number | null {
  return typeof value === "number" || value === null;
}

function summarizeNestedRun(run: SubagentRunView): string {
  if (run.status === "completed") return "finished subagent";
  if (run.status === "failed") return "failed subagent";
  if (run.status === "aborted") return "interrupted subagent";
  return "using subagent";
}

function messageStartActivity(message: unknown): string {
  const role = messageRole(message);
  if (role === "assistant") return "responding";
  if (role === "toolResult") return "receiving tool result";
  return "message started";
}

function messageEndActivity(message: unknown): string {
  const role = messageRole(message);
  if (role === "assistant") return "assistant message finished";
  if (role === "toolResult") return "tool result received";
  return "message finished";
}

function messageRole(message: unknown): string | undefined {
  return isObject(message) && typeof message.role === "string" ? message.role : undefined;
}

function oneLine(text: string): string {
  return text.replace(/\\[nrt]/g, " ").replace(/\s+/g, " ").trim();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
