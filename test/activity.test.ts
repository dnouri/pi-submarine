import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { cloneRunView, compactToolArgs, createActivityState, createInitialRunView, reduceActivityEvent } from "../src/activity.js";
import type { SavedConversationOccurrence, SubagentRunView } from "../src/types.js";
import { safeRunTitle } from "../src/render.js";
import { createSavedConversationCollection, safeReferenceText, savedConversationSnapshot } from "../src/saved-conversations.js";

function event(value: Record<string, unknown>): AgentSessionEvent {
  return value as unknown as AgentSessionEvent;
}

function initialRun(): SubagentRunView {
  return createInitialRunView({
    episodeId: "run-1",
    sessionId: "session-1",
    agent: "reviewer",
    title: "Review catalog conflicts",
    now: "2026-01-01T00:00:00.000Z",
  });
}

function savedOccurrence(id: string, parentId: string | null = null, sessionId = `session-${id}`): SavedConversationOccurrence {
  return { id, parentId, kind: "start", sessionId, label: "scout", save: { kind: "pi-v3", file: `${sessionId}.jsonl`, readiness: "checked" } };
}

function savedState(root = "/saved.subagents") {
  const run = initialRun();
  return createActivityState(run, createSavedConversationCollection(root, savedOccurrence(run.episodeId, null, run.sessionId)));
}

function savedTree(count: number, id = "a"): SavedConversationOccurrence[] {
  return Array.from({ length: count }, (_, index) => savedOccurrence(index === 0 ? id : `${id}-${index}`, index === 0 ? null : id));
}

function declaration(items: SavedConversationOccurrence[], coverage = "complete") {
  return { version: 2, root: "/saved.subagents", coverage, items };
}

function nestedSnapshot(state: ReturnType<typeof savedState>, toolCallId: string, savedConversations: unknown, terminal = false) {
  return reduceActivityEvent(state, event({
    type: terminal ? "tool_execution_end" : "tool_execution_update",
    toolCallId,
    toolName: "subagent",
    args: {},
    [terminal ? "result" : "partialResult"]: { details: { savedConversations } },
    isError: false,
  }), "2026-01-01T00:00:01.000Z");
}

describe("activity reducer", () => {
  it("keeps task titles in initial and cloned run views", () => {
    const run = initialRun();
    expect(run.title).toBe("Review catalog conflicts");
    expect(cloneRunView(run).title).toBe(run.title);
  });

  it.each([" \n\t ", "hidden\u200btext", "nul\u0000text", "bell\u0007text", "Safe title"])("round trips task title %j through grandparent aggregation without losing coverage", (task) => {
    const child = savedState();
    child.run.title = safeRunTitle(task);
    expect(child.run.title === "" || safeReferenceText(child.run.title)).toBe(true);
    nestedSnapshot(child, "descendant", declaration([savedOccurrence("descendant")]), true);
    const snapshot = savedConversationSnapshot(child.savedConversations!, true, child.run);
    const title = snapshot.items[0]!.title;
    expect(title === undefined || safeReferenceText(title)).toBe(true);
    const grandparent = savedState();
    grandparent.run.episodeId = "grandparent";
    grandparent.savedConversations = createSavedConversationCollection("/saved.subagents", savedOccurrence("grandparent"));
    nestedSnapshot(grandparent, "child", snapshot, true);
    const aggregated = savedConversationSnapshot(grandparent.savedConversations, true, grandparent.run);
    expect(aggregated.coverage).toBe("complete");
    expect(aggregated.items.map((item) => item.id)).toEqual(["grandparent", "run-1", "descendant"]);
  });

  it.each(["", "hidden\u200btext", "nul\u0000text"])("omits unsafe direct occurrence titles even without runner sanitization (%j)", (title) => {
    const state = savedState();
    state.run.title = title;
    expect(savedConversationSnapshot(state.savedConversations!, true, state.run).items[0]).not.toHaveProperty("title");
  });

  it("preserves nested occurrence titles and stats independently of run metadata", () => {
    const state = savedState();
    const child = { ...savedOccurrence("child"), title: "Inspect catalog conflicts", stats: { turns: 3, contextPercent: 42.5 } };
    nestedSnapshot(state, "call", declaration([child]), true);
    const snapshot = savedConversationSnapshot(state.savedConversations!, true);
    expect(snapshot.coverage).toBe("complete");
    expect(snapshot.items[1]).toEqual({ ...child, parentId: "run-1" });
    child.stats.turns = 99;
    snapshot.items[1]!.stats!.contextPercent = 0;
    expect(savedConversationSnapshot(state.savedConversations!, true).items[1]!.stats).toEqual({ turns: 3, contextPercent: 42.5 });
  });

  it.each([
    { turns: 0, contextPercent: null },
    { turns: 1_000_000, contextPercent: 100 },
    { turns: 3, contextPercent: 0 },
    { turns: 3, contextPercent: 42.5 },
  ])("accepts bounded nested occurrence stats %j", (stats) => {
    const state = savedState();
    nestedSnapshot(state, "call", declaration([{ ...savedOccurrence("child"), stats }]), true);
    expect(savedConversationSnapshot(state.savedConversations!, true)).toMatchObject({ coverage: "complete", items: [{}, { stats }] });
  });

  it.each(["", "line\nbreak", "hidden\u200btext", "nul\u0000text", 42, null])("withdraws nested occurrences with unsafe titles %j", (title) => {
    const state = savedState();
    nestedSnapshot(state, "call", { ...declaration([]), items: [{ ...savedOccurrence("child"), title }] }, true);
    const snapshot = savedConversationSnapshot(state.savedConversations!, true);
    expect(snapshot.coverage).toBe("partial");
    expect(snapshot.items.map((item) => item.id)).toEqual(["run-1"]);
  });

  it.each([
    null, {}, { turns: 1 }, { turns: -1, contextPercent: 0 }, { turns: 1_000_001, contextPercent: 0 },
    { turns: 1.5, contextPercent: 0 }, { turns: "1", contextPercent: 0 }, { turns: NaN, contextPercent: 0 },
    { turns: 1, contextPercent: -1 }, { turns: 1, contextPercent: 101 }, { turns: 1, contextPercent: NaN },
    { turns: 1, contextPercent: Infinity }, { turns: 1, contextPercent: "42" },
  ])("withdraws nested occurrences with invalid stats %j", (stats) => {
    const state = savedState();
    nestedSnapshot(state, "call", declaration([savedOccurrence("child")]));
    nestedSnapshot(state, "call", { ...declaration([]), items: [{ ...savedOccurrence("child"), stats }] }, true);
    expect(savedConversationSnapshot(state.savedConversations!, true)).toMatchObject({ coverage: "partial", items: [{ id: "run-1" }] });
    expect(savedConversationSnapshot(state.savedConversations!, true).items).toHaveLength(1);
  });

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
    const child = createInitialRunView({ episodeId: "child-1", sessionId: "session-child-1", agent: "scout", title: "Inspect catalog conflicts", now: "2026-01-01T00:00:01.000Z" });
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
    expect(update.nestedRun).toMatchObject({ episodeId: "child-1", contextUsage: { percent: 6 } });
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
    const child = createInitialRunView({ episodeId: "resume-1", sessionId: "session-child-1", agent: "scout", title: "Continue catalog review", now: "2026-01-01T00:00:01.000Z" });
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
    const firstResume = createInitialRunView({ episodeId: "resume-1", sessionId: "session-child-1", agent: "scout", title: "Continue catalog review", now: "2026-01-01T00:00:01.000Z" });
    firstResume.activity = "completed";
    firstResume.status = "completed";
    const secondResume = createInitialRunView({ episodeId: "resume-2", sessionId: "session-child-1", agent: "scout", title: "Continue catalog review again", now: "2026-01-01T00:00:02.000Z" });
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
      title: "Inspect catalog conflicts",
      status: "running",
      turnCount: 0,
      lastActivityAt: "2026-01-01T00:00:01.000Z",
      activity: "using read",
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

  it("retains failed nested activity but withdraws saves when terminal details are absent", () => {
    const state = savedState();
    const failedChild = createInitialRunView({ episodeId: "child-1", sessionId: "session-child-1", agent: "scout", title: "Inspect catalog conflicts", now: "2026-01-01T00:00:01.000Z" });
    failedChild.status = "failed";
    failedChild.activity = "failed";

    reduceActivityEvent(state, event({
      type: "tool_execution_update",
      toolCallId: "nested-tool",
      toolName: "subagent",
      args: { task: "inspect" },
      partialResult: { details: {
        run: failedChild,
        savedConversations: declaration([savedOccurrence(failedChild.episodeId, null, failedChild.sessionId)]),
      } },
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
    const saved = savedConversationSnapshot(state.savedConversations!, true);
    expect(saved.coverage).toBe("partial");
    expect(saved.items.map((item) => [item.id, item.parentId, item.sessionId])).toEqual([
      ["run-1", null, "session-1"],
    ]);
  });

  it("accepts aborted nested partials and summarizes them as interrupted subagents", () => {
    const state = createActivityState(initialRun());
    const abortedChild = createInitialRunView({ episodeId: "child-1", sessionId: "session-child-1", agent: "scout", title: "Inspect catalog conflicts", now: "2026-01-01T00:00:01.000Z" });
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

  it("replaces concurrent declarations by exact tool-call id and preserves first-observation order", () => {
    const state = savedState();
    const a = savedOccurrence("a");
    const b = savedOccurrence("b");
    const c = savedOccurrence("c", "a");
    nestedSnapshot(state, "call", declaration([a], "observed"));
    nestedSnapshot(state, "call-extra", declaration([b], "observed"));
    const cumulative = declaration([a, c], "observed");
    nestedSnapshot(state, "call", cumulative);
    nestedSnapshot(state, "call", cumulative);
    const snapshot = savedConversationSnapshot(state.savedConversations!, false);
    expect(snapshot.coverage).toBe("observed");
    expect(snapshot.items.map((item) => [item.id, item.parentId])).toEqual([
      ["run-1", null], ["a", "run-1"], ["b", "run-1"], ["c", "a"],
    ]);
    a.sessionId = "mutated-input";
    snapshot.items[1]!.sessionId = "mutated-output";
    expect(savedConversationSnapshot(state.savedConversations!, false).items[1]!.sessionId).toBe("session-a");

    nestedSnapshot(state, "call", declaration([savedOccurrence("a")]), true);
    nestedSnapshot(state, "call-extra", declaration([b]), true);
    expect(savedConversationSnapshot(state.savedConversations!, true)).toMatchObject({ coverage: "complete", items: [{ id: "run-1" }, { id: "a" }, { id: "b" }] });
    expect(savedConversationSnapshot(state.savedConversations!, true).items).toHaveLength(3);
    expect(state.run.children).toEqual([]);
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["empty v1 items", { version: 1, root: "/saved.subagents", items: [] }],
    ["empty v2 ledger", declaration([])],
    ["multiple v2 roots", declaration([savedOccurrence("a"), savedOccurrence("c")])],
    ["sparse rows", { ...declaration([]), items: Array(1) }],
    ["malformed legacy", { version: 1, root: "/saved.subagents", items: [{ sessionId: "a", file: "../a.jsonl" }] }],
    ["unsupported", { version: 3, root: "/saved.subagents", items: [] }],
    ["wrong root", { ...declaration([savedOccurrence("a")]), root: "/elsewhere.subagents" }],
    ["unsafe path", declaration([{ ...savedOccurrence("a"), save: { kind: "pi-v3", file: "../a.jsonl", readiness: "checked" } }])],
    ["dangling parent", declaration([savedOccurrence("a", "missing")])],
    ["cycle", declaration([savedOccurrence("a", "c"), savedOccurrence("c", "a")])],
    ["duplicate occurrence", declaration([savedOccurrence("a"), savedOccurrence("a")])],
    ["invalid readiness", { ...declaration([savedOccurrence("a")]), items: [{ ...savedOccurrence("a"), save: { kind: "pi-v3", file: "a.jsonl", readiness: "ready" } }] }],
  ])("withdraws only the terminal source's references for %s declarations", (_name, value) => {
    const state = savedState();
    nestedSnapshot(state, "call", declaration([savedOccurrence("a"), savedOccurrence("c", "a")]));
    nestedSnapshot(state, "call-extra", declaration([savedOccurrence("b")]), true);
    nestedSnapshot(state, "call", value, true);
    const snapshot = savedConversationSnapshot(state.savedConversations!, true);
    expect(snapshot.coverage).toBe("partial");
    expect(snapshot.items.map((item) => item.id)).toEqual(["run-1", "b"]);
  });

  it("retains multi-item legacy direct saves as unknown leaves without using run metadata for identity", () => {
    const state = savedState();
    nestedSnapshot(state, "legacy-call", declaration([savedOccurrence("old"), savedOccurrence("descendant", "old")]));
    reduceActivityEvent(state, event({
      type: "tool_execution_end", toolCallId: "legacy-call", toolName: "subagent", isError: false,
      result: { details: {
        run: { ...initialRun(), episodeId: "not-a-legacy-id" },
        savedConversations: { version: 1, root: "/saved.subagents", items: [
          { sessionId: "legacy-chat", file: "exact/legacy.jsonl", label: "scout" },
          { sessionId: "other-chat", file: "other.jsonl", label: "scout" },
        ] },
      } },
    }), "2026-01-01T00:00:01.000Z");
    const snapshot = savedConversationSnapshot(state.savedConversations!, true);
    expect(snapshot.coverage).toBe("partial");
    expect(snapshot.items).toHaveLength(3);
    expect(snapshot.items.slice(1)).toEqual([
      { id: expect.stringMatching(/^legacy:/), parentId: "run-1", kind: "unknown", sessionId: "legacy-chat", label: "scout", save: { kind: "pi-v3", file: "exact/legacy.jsonl", readiness: "planned" } },
      { id: expect.stringMatching(/^legacy:/), parentId: "run-1", kind: "unknown", sessionId: "other-chat", label: "scout", save: { kind: "pi-v3", file: "other.jsonl", readiness: "planned" } },
    ]);
    expect(new Set(snapshot.items.map((item) => item.id)).size).toBe(3);
    expect(snapshot.items.map((item) => item.id)).not.toContain("not-a-legacy-id");
  });

  it.each([
    ["absent", {}],
    ["empty", { details: {} }],
    ["null", { details: null }],
    ["malformed", { details: "not details" }],
    ["malformed declaration", { details: { savedConversations: { version: 99 } } }],
  ])("withdraws only the failed source for %s terminal details", (_name, result) => {
    const state = savedState();
    nestedSnapshot(state, "failed", declaration([savedOccurrence("a"), savedOccurrence("c", "a")]));
    nestedSnapshot(state, "sibling", declaration([savedOccurrence("b")]), true);
    reduceActivityEvent(state, event({ type: "tool_execution_end", toolCallId: "failed", toolName: "subagent", result, isError: true }), "now");
    const snapshot = savedConversationSnapshot(state.savedConversations!, true);
    expect(snapshot.coverage).toBe("partial");
    expect(snapshot.items.map((item) => item.id)).toEqual(["run-1", "b"]);
  });

  it("replaces malformed running snapshots without disturbing another source and can recover on a later declaration", () => {
    const state = savedState();
    nestedSnapshot(state, "a", declaration([savedOccurrence("a")]));
    nestedSnapshot(state, "b", declaration([savedOccurrence("b")]), true);
    nestedSnapshot(state, "a", { ...declaration([savedOccurrence("a")]), version: 99 });
    expect(savedConversationSnapshot(state.savedConversations!, false).coverage).toBe("partial");
    expect(savedConversationSnapshot(state.savedConversations!, false).items.map((item) => item.id)).toEqual(["run-1", "b"]);
    nestedSnapshot(state, "a", declaration([savedOccurrence("a")]), true);
    expect(savedConversationSnapshot(state.savedConversations!, true).coverage).toBe("complete");
    expect(savedConversationSnapshot(state.savedConversations!, true).items.map((item) => item.id)).toEqual(["run-1", "b", "a"]);
  });

  it.each(["one session with two files", "two sessions with one file"])("preserves %s across duplicate occurrence IDs and ancestor aggregation", (conflict) => {
    const state = savedState();
    const first = { ...savedOccurrence("duplicate", null, "shared"), save: { kind: "pi-v3" as const, file: "a.jsonl", readiness: "checked" as const } };
    const second = { ...first, sessionId: conflict === "one session with two files" ? "shared" : "other", save: { ...first.save, file: conflict === "one session with two files" ? "b.jsonl" : "a.jsonl" } };
    const child = savedOccurrence("second-child", "duplicate");
    const resume = { ...first, id: "resume", kind: "resume" as const };
    nestedSnapshot(state, "first", declaration([first, savedOccurrence("first-child", "duplicate")]), true);
    nestedSnapshot(state, "second", declaration([second, child]), true);
    nestedSnapshot(state, "resume", declaration([resume]), true);
    nestedSnapshot(state, "sibling", declaration([savedOccurrence("safe")]), true);
    const snapshot = savedConversationSnapshot(state.savedConversations!, true);
    expect(snapshot.coverage).toBe("partial");
    expect(snapshot.items).toHaveLength(7);
    expect(new Set(snapshot.items.map((item) => item.id)).size).toBe(7);
    const remapped = snapshot.items[3]!;
    expect(snapshot.items[1]).toEqual({ ...first, parentId: "run-1" });
    expect(remapped).toEqual({ ...second, id: expect.stringMatching(/^conflict:/), parentId: "run-1" });
    expect(snapshot.items[4]).toEqual({ ...child, id: expect.stringMatching(/^conflict:/), parentId: remapped.id });
    expect(snapshot.items[5]).toEqual({ ...resume, parentId: "run-1" });
    expect(snapshot.items[6]?.id).toBe("safe");

    const ancestor = createActivityState(initialRun(), createSavedConversationCollection("/saved.subagents", savedOccurrence("ancestor")));
    nestedSnapshot(ancestor, "nested", snapshot, true);
    const aggregated = savedConversationSnapshot(ancestor.savedConversations!, true);
    expect(aggregated.coverage).toBe("partial");
    expect(aggregated.items).toEqual([savedOccurrence("ancestor"), { ...snapshot.items[0]!, parentId: "ancestor" }, ...snapshot.items.slice(1)]);
    const associations = aggregated.items.filter((item) => item.save.kind === "pi-v3"
      && (conflict === "one session with two files" ? item.sessionId === "shared" : item.save.file === "a.jsonl"));
    expect(new Set(associations.map((item) => item.save.kind === "pi-v3"
      ? conflict === "one session with two files" ? item.save.file : item.sessionId : "")))
      .toEqual(new Set(conflict === "one session with two files" ? ["a.jsonl", "b.jsonl"] : ["shared", "other"]));
  });

  it("preserves unavailable descendant occurrences and their ancestry without treating file availability as coverage", () => {
    const state = savedState();
    const unavailable: SavedConversationOccurrence = { ...savedOccurrence("child", "a"), save: { kind: "unavailable", reason: "No readable save." } };
    nestedSnapshot(state, "call", declaration([savedOccurrence("a"), unavailable]), true);
    const snapshot = savedConversationSnapshot(state.savedConversations!, true);
    expect(snapshot.coverage).toBe("complete");
    expect(snapshot.items[2]).toEqual(unavailable);
  });

  it("reports incomplete nested execution as partial at terminal settlement", () => {
    const state = savedState();
    reduceActivityEvent(state, event({ type: "tool_execution_start", toolCallId: "pending", toolName: "subagent", args: {} }), "now");
    expect(savedConversationSnapshot(state.savedConversations!, false).coverage).toBe("observed");
    expect(savedConversationSnapshot(state.savedConversations!, true).coverage).toBe("partial");
    nestedSnapshot(state, "pending", declaration([savedOccurrence("a")], "observed"));
    reduceActivityEvent(state, event({ type: "tool_execution_end", toolCallId: "pending", toolName: "subagent", result: {}, isError: true }), "now");
    expect(savedConversationSnapshot(state.savedConversations!, true).coverage).toBe("partial");
    expect(savedConversationSnapshot(state.savedConversations!, true).items.map((item) => item.id)).toEqual(["run-1"]);
  });

  it("uses a nested declaration's own completeness rather than waiting for a second terminal event", () => {
    const state = savedState();
    nestedSnapshot(state, "finished-partial", declaration([savedOccurrence("a")]));
    expect(savedConversationSnapshot(state.savedConversations!, false).coverage).toBe("observed");
    expect(savedConversationSnapshot(state.savedConversations!, true).coverage).toBe("complete");
  });

  it("normalizes nested rows without retaining undeclared fields or mutable input objects", () => {
    const state = savedState();
    const row = { ...savedOccurrence("a"), unrelated: () => undefined };
    nestedSnapshot(state, "call", declaration([row]), true);
    row.save = { kind: "unavailable", reason: "Changed later." };
    const snapshot = savedConversationSnapshot(state.savedConversations!, true);
    expect(snapshot.items[1]).toEqual({ ...savedOccurrence("a"), parentId: "run-1" });
  });

  it("keeps equal labels and repeated resume episodes independent of chat identity", () => {
    const state = savedState();
    const rows = [savedOccurrence("first", null, "shared-chat"), savedOccurrence("other-chat")];
    const resumes = ["resume-1", "resume-2"].map((id) => ({ ...savedOccurrence(id, null, "shared-chat"), kind: "resume" as const }));
    for (const row of [...rows, ...resumes]) nestedSnapshot(state, `call-${row.id}`, declaration([row]), true);
    const snapshot = savedConversationSnapshot(state.savedConversations!, true);
    expect(snapshot.coverage).toBe("complete");
    expect(snapshot.items.slice(1).map((item) => [item.id, item.sessionId, item.label, item.kind, item.parentId])).toEqual([
      ["first", "shared-chat", "scout", "start", "run-1"],
      ["other-chat", "session-other-chat", "scout", "start", "run-1"],
      ["resume-1", "shared-chat", "scout", "resume", "run-1"],
      ["resume-2", "shared-chat", "scout", "resume", "run-1"],
    ]);
  });

  it("keeps completed descendants when a later invocation reuses a settled tool-call ID", () => {
    const state = savedState();
    const start = () => reduceActivityEvent(state, event({ type: "tool_execution_start", toolCallId: "call", toolName: "subagent", args: {} }), "now");
    start();
    nestedSnapshot(state, "call", declaration([savedOccurrence("a"), savedOccurrence("g", "a")], "observed"));
    start();
    nestedSnapshot(state, "call", declaration([savedOccurrence("a"), savedOccurrence("g", "a")]), true);
    start();
    nestedSnapshot(state, "call", declaration([savedOccurrence("b")]), true);
    const snapshot = savedConversationSnapshot(state.savedConversations!, true);
    expect(snapshot.coverage).toBe("complete");
    expect(snapshot.items.map((item) => [item.id, item.parentId])).toEqual([
      ["run-1", null], ["a", "run-1"], ["g", "a"], ["b", "run-1"],
    ]);
  });

  it("assigns distinct legacy occurrence IDs to invocations that reuse a settled tool-call ID", () => {
    const state = savedState();
    const legacy = (ids: string[]) => ({ version: 1, root: "/saved.subagents", items: ids.map((sessionId) => ({ sessionId, file: `${sessionId}.jsonl` })) });
    nestedSnapshot(state, "call", legacy(["a", "g"]));
    nestedSnapshot(state, "call", legacy(["a", "g"]), true);
    const first = savedConversationSnapshot(state.savedConversations!, true).items;
    nestedSnapshot(state, "call", legacy(["b"]), true);
    const snapshot = savedConversationSnapshot(state.savedConversations!, true);
    expect(snapshot.coverage).toBe("partial");
    expect(snapshot.items.slice(0, 3)).toEqual(first);
    expect(new Set(snapshot.items.map((item) => item.id)).size).toBe(4);
    expect(snapshot.items.slice(1).map((item) => [item.parentId, item.kind, item.sessionId])).toEqual([
      ["run-1", "unknown", "a"], ["run-1", "unknown", "g"], ["run-1", "unknown", "b"],
    ]);
  });

  it("keeps observation order and stable conflict IDs when an existing source later collides", () => {
    const state = savedState();
    nestedSnapshot(state, "first", declaration([savedOccurrence("a")]));
    nestedSnapshot(state, "second", declaration([savedOccurrence("b")]), true);
    const rows = [savedOccurrence("a"), savedOccurrence("b", "a"), savedOccurrence("c", "a")];
    nestedSnapshot(state, "first", declaration(rows));
    const snapshot = savedConversationSnapshot(state.savedConversations!, false);
    expect(snapshot.coverage).toBe("partial");
    expect(snapshot.items.map((item) => item.sessionId)).toEqual(["session-1", "session-a", "session-b", "session-b", "session-c"]);
    expect(snapshot.items[2]?.id).toBe("b");
    expect(snapshot.items.filter((item) => item.id.startsWith("conflict:"))).toHaveLength(3);
    nestedSnapshot(state, "first", declaration([...rows].reverse()), true);
    expect(savedConversationSnapshot(state.savedConversations!, true).items).toEqual(snapshot.items);
  });

  it("remaps a complete nested subtree that collides with the direct occurrence", () => {
    const state = savedState();
    nestedSnapshot(state, "call", declaration([savedOccurrence("run-1"), savedOccurrence("child", "run-1")]), true);
    const snapshot = savedConversationSnapshot(state.savedConversations!, true);
    expect(snapshot.coverage).toBe("partial");
    expect(snapshot.items).toHaveLength(3);
    expect(snapshot.items[0]?.id).toBe("run-1");
    expect(snapshot.items[1]).toMatchObject({ id: expect.stringMatching(/^conflict:/), parentId: "run-1", sessionId: "session-run-1" });
    expect(snapshot.items[2]).toMatchObject({ id: expect.stringMatching(/^conflict:/), parentId: snapshot.items[1]!.id });
  });

  it.each([1, 2])("accepts 1,024 nested v%s rows but rejects 1,025 and withdraws the previous source", (version) => {
    const state = savedState();
    nestedSnapshot(state, "call", declaration([savedOccurrence("old")]));
    nestedSnapshot(state, "sibling", declaration([savedOccurrence("safe")]), true);
    for (const count of [1_024, 1_025]) {
      const rows = savedTree(count);
      const value = version === 2 ? declaration(rows) : {
        version: 1, root: "/saved.subagents", items: rows.map((item) => ({ sessionId: item.sessionId, file: `${item.sessionId}.jsonl` })),
      };
      nestedSnapshot(state, "call", value, count === 1_025);
      const snapshot = savedConversationSnapshot(state.savedConversations!, true);
      expect(snapshot.coverage).toBe("partial");
      expect(snapshot.items).toHaveLength(count === 1_024 ? 1_024 : 2);
      expect(snapshot.items.slice(0, 2).map((item) => item.id)).toEqual(["run-1", "safe"]);
      expect(snapshot.items.map((item) => item.id)).not.toContain("old");
    }
  });

  it.each([1_024, 1_025])("limits an aggregate of %s occurrences in first-observation order", (count) => {
    const state = savedState();
    const rows = savedTree(count - 1);
    nestedSnapshot(state, "call", declaration(rows), true);
    const snapshot = savedConversationSnapshot(state.savedConversations!, true);
    expect(snapshot.coverage).toBe(count === 1_024 ? "complete" : "partial");
    expect(snapshot.items).toHaveLength(1_024);
    expect(snapshot.items.slice(1)).toEqual(rows.slice(0, 1_023).map((item) => ({ ...item, parentId: item.parentId ?? "run-1" })));
    const ids = new Set(snapshot.items.map((item) => item.id));
    expect(snapshot.items.every((item) => item.parentId === null || ids.has(item.parentId))).toBe(true);
  });

  it("does not select descendants whose later-observed parent cannot fit in the aggregate", () => {
    const state = savedState();
    nestedSnapshot(state, "early", declaration(savedTree(1_022)), true);
    nestedSnapshot(state, "late", declaration([savedOccurrence("late-child")]));
    nestedSnapshot(state, "sibling", declaration([savedOccurrence("safe")]), true);
    nestedSnapshot(state, "late", declaration([savedOccurrence("late-child", "late-parent"), savedOccurrence("late-parent")]), true);
    const snapshot = savedConversationSnapshot(state.savedConversations!, true);
    expect(snapshot.coverage).toBe("partial");
    expect(snapshot.items).toHaveLength(1_024);
    expect(snapshot.items.at(-1)?.id).toBe("safe");
    expect(snapshot.items.map((item) => item.id)).not.toContain("late-parent");
    expect(snapshot.items.map((item) => item.id)).not.toContain("late-child");
  });

  it.each(["id", "sessionId", "label", "title", "file", "reason"] as const)("bounds v2 %s strings at 4 KiB of UTF-8 without retaining stale saves", (field) => {
    const state = savedState();
    nestedSnapshot(state, "call", declaration([savedOccurrence("old")]));
    nestedSnapshot(state, "sibling", declaration([savedOccurrence("safe")]), true);
    for (const extra of ["", "x"]) {
      const text = `${"é".repeat(2_048)}${extra}`;
      const row = savedOccurrence("a");
      if (field === "file") row.save = { kind: "pi-v3", file: text, readiness: "checked" };
      else if (field === "reason") row.save = { kind: "unavailable", reason: text };
      else row[field] = text;
      const rows = field === "id" ? [row, savedOccurrence("child", text)] : [row];
      nestedSnapshot(state, "call", declaration(rows), extra !== "");
      const snapshot = savedConversationSnapshot(state.savedConversations!, true);
      expect(snapshot.coverage).toBe(extra === "" ? "complete" : "partial");
      expect(snapshot.items.slice(2)).toEqual(extra === "" ? rows.map((item) => ({ ...item, parentId: item.parentId ?? "run-1" })) : []);
      expect(snapshot.items.slice(0, 2).map((item) => item.id)).toEqual(["run-1", "safe"]);
    }
  });

  it.each(["sessionId", "label", "file"] as const)("bounds v1 %s strings at 4 KiB of UTF-8", (field) => {
    const state = savedState();
    for (const extra of ["", "x"]) {
      const row = { sessionId: "legacy", label: "scout", file: "legacy.jsonl", [field]: `${"é".repeat(2_048)}${extra}` };
      nestedSnapshot(state, "call", { version: 1, root: "/saved.subagents", items: [row] }, extra !== "");
      const snapshot = savedConversationSnapshot(state.savedConversations!, true);
      expect(snapshot.coverage).toBe("partial");
      expect(snapshot.items).toHaveLength(extra === "" ? 2 : 1);
      if (extra === "") expect(snapshot.items[1]).toMatchObject({ sessionId: row.sessionId, label: row.label, save: { file: row.file } });
    }
  });

  it.each([1, 2])("bounds the v%s root at 4 KiB of UTF-8", (version) => {
    for (const extra of ["", "x"]) {
      const root = `/${"é".repeat(2_047)}x${extra}`;
      const state = savedState(root);
      nestedSnapshot(state, "call", version === 2 ? { ...declaration([savedOccurrence("a")]), root } : {
        version: 1, root, items: [{ sessionId: "a", file: "a.jsonl" }],
      }, true);
      const snapshot = savedConversationSnapshot(state.savedConversations!, true);
      expect(snapshot.coverage).toBe(extra === "" && version === 2 ? "complete" : "partial");
      expect(snapshot.items).toHaveLength(extra === "" ? 2 : 1);
    }
  });

  it("bounds active source slots and still withdraws a rejected replacement at the slot limit", () => {
    const state = savedState();
    for (let index = 0; index < 1_024; index++) {
      reduceActivityEvent(state, event({ type: "tool_execution_start", toolCallId: `call-${index}`, toolName: "subagent", args: {} }), "now");
    }
    const collection = state.savedConversations!;
    expect(collection.sources.size).toBe(1_024);
    expect(collection.activeSources.size).toBe(1_024);
    expect(savedConversationSnapshot(collection, false).coverage).toBe("observed");
    reduceActivityEvent(state, event({ type: "tool_execution_start", toolCallId: "call-0", toolName: "subagent", args: {} }), "now");
    nestedSnapshot(state, "overflow", declaration([savedOccurrence("overflow")]), true);
    expect(collection.sources.size).toBe(1_024);
    expect(collection.activeSources.size).toBe(1_024);
    expect(savedConversationSnapshot(collection, false)).toMatchObject({ coverage: "partial", items: [{ id: "run-1" }] });
    nestedSnapshot(state, "call-0", declaration([savedOccurrence("old")]));
    nestedSnapshot(state, "call-0", declaration(savedTree(1_025)), true);
    nestedSnapshot(state, "call-0", declaration([savedOccurrence("new-invocation")]), true);
    expect(savedConversationSnapshot(collection, true).items.map((item) => item.id)).toEqual(["run-1"]);
    expect(collection.order.size).toBe(1);
    expect(collection.activeSources.size).toBe(1_023);
  });

  it("does not replace a settled source when a reused tool-call ID overflows the slot limit", () => {
    const state = savedState();
    for (let index = 0; index < 1_023; index++) nestedSnapshot(state, "call", undefined, true);
    nestedSnapshot(state, "call", declaration([savedOccurrence("last")]), true);
    expect(savedConversationSnapshot(state.savedConversations!, true).items.map((item) => item.id)).toEqual(["run-1", "last"]);
    nestedSnapshot(state, "call", declaration([savedOccurrence("overflow")]), true);
    const snapshot = savedConversationSnapshot(state.savedConversations!, true);
    expect(snapshot.coverage).toBe("partial");
    expect(snapshot.items.map((item) => item.id)).toEqual(["run-1", "last"]);
    expect(state.savedConversations!.sources.size).toBe(1_024);
    expect(state.savedConversations!.activeSources.size).toBe(0);
  });

  it("prunes stale ordering metadata across many fresh replacements without reusing order keys", () => {
    const state = savedState();
    nestedSnapshot(state, "sibling", declaration([savedOccurrence("safe")]), true);
    for (let index = 0; index < 2_048; index++) {
      nestedSnapshot(state, "call", declaration(savedTree(2, `fresh-${index}`)));
      expect(state.savedConversations!.order.size).toBe(index < 1_024 ? 4 : 5);
      if (index === 1_023) nestedSnapshot(state, "middle", declaration([savedOccurrence("middle")]), true);
    }
    const snapshot = savedConversationSnapshot(state.savedConversations!, false);
    expect(snapshot.coverage).toBe("observed");
    expect(snapshot.items.map((item) => item.id)).toEqual(["run-1", "safe", "middle", "fresh-2047", "fresh-2047-1"]);
    expect(state.savedConversations!.sources.size).toBe(3);
  });

  it("reports saved-only changes even when run activity and timestamp are unchanged", () => {
    const state = savedState();
    nestedSnapshot(state, "call", declaration([savedOccurrence("a")], "observed"));
    const run = cloneRunView(state.run);
    const reduction = nestedSnapshot(state, "call", declaration([savedOccurrence("a"), savedOccurrence("child", "a")], "observed"));
    expect(state.run).toEqual(run);
    expect(reduction).toEqual({ changed: true });
    expect(savedConversationSnapshot(state.savedConversations!, false).items.map((item) => item.id)).toEqual(["run-1", "a", "child"]);
  });

  it("compacts unsafe tool args to one truncated line", () => {
    const circular: Record<string, unknown> = { alpha: "beta" };
    circular.self = circular;

    expect(compactToolArgs({ multi: "line\nvalue" })).toBe('{"multi":"line value"}');
    expect(compactToolArgs(circular)).toContain("[unserializable args]");
    expect(compactToolArgs({ text: "x".repeat(500) }).length).toBeLessThanOrEqual(161);
  });
});
