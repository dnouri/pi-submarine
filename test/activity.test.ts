import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { cloneRunView, compactToolArgs, createActivityState, createInitialRunView, reduceActivityEvent } from "../src/activity.js";
import type { SubagentRunView } from "../src/types.js";

function event(value: Record<string, unknown>): AgentSessionEvent {
  return value as unknown as AgentSessionEvent;
}

function initialRun(): SubagentRunView {
  return createInitialRunView({
    episodeId: "run-1",
    sessionId: "session-1",
    agent: "reviewer",
    activityLog: "/tmp/subagents.live.md",
    now: "2026-01-01T00:00:00.000Z",
  });
}

describe("activity reducer", () => {
  it("tracks assistant status and turn boundaries without treating token deltas as transcript output", () => {
    const state = createActivityState(initialRun());

    const thinking = reduceActivityEvent(state, event({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "hmm" } }), "2026-01-01T00:00:01.000Z");
    expect(thinking.changed).toBe(true);
    expect(state.run).toMatchObject({ activity: "thinking", lastActivityAt: "2026-01-01T00:00:01.000Z", turnCount: 0 });

    const repeatedThinking = reduceActivityEvent(state, event({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "still hmm" } }), "2026-01-01T00:00:02.000Z");
    expect(repeatedThinking.changed).toBe(false);
    expect(state.run.activity).toBe("thinking");

    const text = reduceActivityEvent(state, event({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello" } }), "2026-01-01T00:00:03.000Z");
    expect(text.changed).toBe(true);
    expect(state.run.activity).toBe("responding");

    const repeatedText = reduceActivityEvent(state, event({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " world" } }), "2026-01-01T00:00:04.000Z");
    expect(repeatedText.changed).toBe(false);

    reduceActivityEvent(state, event({ type: "turn_end", message: {}, toolResults: [] }), "2026-01-01T00:00:05.000Z");
    expect(state.run).toMatchObject({ activity: "turn completed", turnCount: 1 });
  });

  it("summarizes tool activity compactly and tracks parallel active tools by id", () => {
    const state = createActivityState(initialRun());
    const longArgs = { command: `npm test ${"x".repeat(300)}`, nested: { value: true } };

    const start = reduceActivityEvent(state, event({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: longArgs }), "2026-01-01T00:00:01.000Z");
    expect(start.changed).toBe(true);
    expect(state.run.activity).toMatch(/^using bash /);
    expect(state.run.activity.length).toBeLessThan(220);
    expect(state.run.activity).not.toContain("\n");

    reduceActivityEvent(state, event({ type: "tool_execution_start", toolCallId: "tool-2", toolName: "read", args: { path: "src/runner.ts" } }), "2026-01-01T00:00:02.000Z");
    expect(state.run.activity).toContain("+ 1 tool");

    reduceActivityEvent(state, event({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "bash", result: {}, isError: false }), "2026-01-01T00:00:03.000Z");
    expect(state.run.activity).toBe('using read {"path":"src/runner.ts"}');

    reduceActivityEvent(state, event({ type: "tool_execution_end", toolCallId: "tool-2", toolName: "read", result: {}, isError: false }), "2026-01-01T00:00:04.000Z");
    expect(state.run.activity).toBe("finished read");
  });

  it("reports retry and compaction events without finalizing intermediate agent_end", () => {
    const state = createActivityState(initialRun());

    reduceActivityEvent(state, event({ type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 2000, errorMessage: "rate limited" }), "2026-01-01T00:00:01.000Z");
    expect(state.run.activity).toBe("retrying attempt 2/3 after rate limited");

    reduceActivityEvent(state, event({ type: "agent_end", messages: [], willRetry: true }), "2026-01-01T00:00:02.000Z");
    expect(state.run.status).toBe("running");
    expect(state.run.activity).toBe("retry pending");

    reduceActivityEvent(state, event({ type: "compaction_start", reason: "threshold" }), "2026-01-01T00:00:03.000Z");
    expect(state.run.activity).toBe("compacting context (threshold)");

    reduceActivityEvent(state, event({ type: "compaction_end", reason: "threshold", result: {}, aborted: false, willRetry: false }), "2026-01-01T00:00:04.000Z");
    expect(state.run.activity).toBe("context compacted");
  });

  it("merges nested subagent run updates by episode id without duplicating child detail into parent activity", () => {
    const state = createActivityState(initialRun());
    const child = createInitialRunView({ episodeId: "child-1", sessionId: "session-child-1", agent: "scout", activityLog: "/tmp/subagents.live.md", now: "2026-01-01T00:00:01.000Z" });
    child.activity = "using read";
    child.contextUsage = { tokens: 12_000, contextWindow: 200_000, percent: 6 };

    const update = reduceActivityEvent(state, event({
      type: "tool_execution_update",
      toolCallId: "nested-tool",
      toolName: "subagent",
      args: { task: "inspect" },
      partialResult: { details: { run: child }, content: [{ type: "text", text: "nested output that must not be copied" }] },
    }), "2026-01-01T00:00:02.000Z");

    expect(update.changed).toBe(true);
    expect(update.nestedRun).toMatchObject({ episodeId: "child-1", activityLog: "/tmp/subagents.live.md", contextUsage: { percent: 6 } });
    expect(state.run.children).toHaveLength(1);
    expect(state.run.children[0]).toMatchObject({ episodeId: "child-1", activity: "using read", contextUsage: { tokens: 12_000 } });
    expect(state.run.activity).toBe("using subagent");

    const completedChild = { ...child, status: "completed" as const, activity: "completed" };
    reduceActivityEvent(state, event({
      type: "tool_execution_end",
      toolCallId: "nested-tool",
      toolName: "subagent",
      result: { details: { run: completedChild }, content: [{ type: "text", text: "final nested answer" }] },
      isError: false,
    }), "2026-01-01T00:00:03.000Z");

    expect(state.run.children).toHaveLength(1);
    expect(state.run.children[0]).toMatchObject({ episodeId: "child-1", status: "completed", activity: "completed" });
    expect(state.run.activity).toBe("finished subagent");
  });

  it("merges nested subagent_resume run updates like subagent updates", () => {
    const state = createActivityState(initialRun());
    const child = createInitialRunView({ episodeId: "resume-1", sessionId: "session-child-1", agent: "scout", activityLog: "/tmp/subagents.live.md", now: "2026-01-01T00:00:01.000Z" });
    child.activity = "responding";

    reduceActivityEvent(state, event({
      type: "tool_execution_update",
      toolCallId: "resume-tool",
      toolName: "subagent_resume",
      args: { sessionId: "session-child-1", message: "continue" },
      partialResult: { details: { run: child } },
    }), "2026-01-01T00:00:02.000Z");

    expect(state.run.children).toHaveLength(1);
    expect(state.run.children[0]).toMatchObject({ episodeId: "resume-1", sessionId: "session-child-1", activity: "responding" });
    expect(state.run.activity).toBe("using subagent");
  });

  it("keeps repeated resume episodes for the same child session as separate activity children", () => {
    const state = createActivityState(initialRun());
    const firstResume = createInitialRunView({ episodeId: "resume-1", sessionId: "session-child-1", agent: "scout", activityLog: "/tmp/subagents.live.md", now: "2026-01-01T00:00:01.000Z" });
    firstResume.activity = "completed";
    firstResume.status = "completed";
    const secondResume = createInitialRunView({ episodeId: "resume-2", sessionId: "session-child-1", agent: "scout", activityLog: "/tmp/subagents.live.md", now: "2026-01-01T00:00:02.000Z" });
    secondResume.activity = "responding";

    reduceActivityEvent(state, event({
      type: "tool_execution_end",
      toolCallId: "resume-tool-1",
      toolName: "subagent_resume",
      result: { details: { run: firstResume } },
      isError: false,
    }), "2026-01-01T00:00:03.000Z");
    reduceActivityEvent(state, event({
      type: "tool_execution_update",
      toolCallId: "resume-tool-2",
      toolName: "subagent_resume",
      partialResult: { details: { run: secondResume } },
    }), "2026-01-01T00:00:04.000Z");

    expect(state.run.children).toHaveLength(2);
    expect(state.run.children.map((child) => child.episodeId)).toEqual(["resume-1", "resume-2"]);
    expect(state.run.children.map((child) => child.sessionId)).toEqual(["session-child-1", "session-child-1"]);
  });

  it("ignores nested run details with invalid context usage", () => {
    const state = createActivityState(initialRun());
    const invalidChild = {
      episodeId: "child-1",
      sessionId: "session-child-1",
      agent: "scout",
      status: "running",
      turnCount: 0,
      lastActivityAt: "2026-01-01T00:00:01.000Z",
      activity: "using read",
      activityLog: "/tmp/subagents.live.md",
      contextUsage: { tokens: "many", contextWindow: 200_000, percent: 6 },
      children: [],
    };

    reduceActivityEvent(state, event({
      type: "tool_execution_update",
      toolCallId: "nested-tool",
      toolName: "subagent",
      args: { task: "inspect" },
      partialResult: { details: { run: invalidChild } },
    }), "2026-01-01T00:00:02.000Z");

    expect(state.run.children).toHaveLength(0);
    expect(state.run.activity).toBe('using subagent {"task":"inspect"}');
  });

  it("preserves a failed nested partial when Pi's final thrown tool result has no details", () => {
    const state = createActivityState(initialRun());
    const failedChild = createInitialRunView({ episodeId: "child-1", sessionId: "session-child-1", agent: "scout", activityLog: "/tmp/subagents.live.md", now: "2026-01-01T00:00:01.000Z" });
    failedChild.status = "failed";
    failedChild.activity = "failed";

    reduceActivityEvent(state, event({
      type: "tool_execution_update",
      toolCallId: "nested-tool",
      toolName: "subagent",
      args: { task: "inspect" },
      partialResult: { details: { run: failedChild } },
    }), "2026-01-01T00:00:02.000Z");
    reduceActivityEvent(state, event({
      type: "tool_execution_end",
      toolCallId: "nested-tool",
      toolName: "subagent",
      result: { content: [{ type: "text", text: "thrown tool error" }] },
      isError: true,
    }), "2026-01-01T00:00:03.000Z");

    expect(state.run.children).toHaveLength(1);
    expect(state.run.children[0]).toMatchObject({ episodeId: "child-1", status: "failed", activity: "failed" });
    expect(state.run.activity).toBe("failed subagent");
  });

  it("accepts aborted nested partials and summarizes them as interrupted subagents", () => {
    const state = createActivityState(initialRun());
    const abortedChild = createInitialRunView({ episodeId: "child-1", sessionId: "session-child-1", agent: "scout", activityLog: "/tmp/subagents.live.md", now: "2026-01-01T00:00:01.000Z" });
    abortedChild.status = "aborted";
    abortedChild.activity = "interrupted";

    reduceActivityEvent(state, event({
      type: "tool_execution_update",
      toolCallId: "nested-tool",
      toolName: "subagent",
      args: { task: "inspect" },
      partialResult: { details: { run: abortedChild } },
    }), "2026-01-01T00:00:02.000Z");
    reduceActivityEvent(state, event({
      type: "tool_execution_end",
      toolCallId: "nested-tool",
      toolName: "subagent",
      result: { content: [{ type: "text", text: "interrupted tool error" }] },
      isError: true,
    }), "2026-01-01T00:00:03.000Z");

    expect(state.run.children).toHaveLength(1);
    expect(state.run.children[0]).toMatchObject({ episodeId: "child-1", status: "aborted", activity: "interrupted" });
    expect(state.run.activity).toBe("interrupted subagent");
  });

  it("clones run views so emitted snapshots cannot be mutated by later reducer changes", () => {
    const state = createActivityState(initialRun());
    state.run.contextUsage = { tokens: 12_000, contextWindow: 200_000, percent: 6 };
    const snapshot = cloneRunView(state.run);

    reduceActivityEvent(state, event({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Later" } }), "2026-01-01T00:00:01.000Z");
    state.run.contextUsage.percent = 12;

    expect(snapshot.activity).toBe("starting");
    expect(snapshot.contextUsage).toEqual({ tokens: 12_000, contextWindow: 200_000, percent: 6 });
    expect(state.run.activity).toBe("responding");
  });

  it("compacts unsafe tool args to one truncated line", () => {
    const circular: Record<string, unknown> = { alpha: "beta" };
    circular.self = circular;

    expect(compactToolArgs({ multi: "line\nvalue" })).toBe('{"multi":"line value"}');
    expect(compactToolArgs(circular)).toContain("[unserializable args]");
    expect(compactToolArgs({ text: "x".repeat(500) }).length).toBeLessThanOrEqual(161);
  });
});
