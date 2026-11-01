import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatActivityAge, requiredRunTitle, safeRunTitle, namedAgentSelection, omittedAgentSelection, renderSubagentInterrupted, renderSubagentProgress, renderSubagentRecoverableError, renderSubagentResult, resultHeading, subagentTitle } from "../src/render.js";
import { safeReferenceText } from "../src/saved-conversations.js";
import type { SubagentRunView } from "../src/types.js";

function runView(overrides: Partial<SubagentRunView> = {}): SubagentRunView {
  return {
    episodeId: "run",
    sessionId: "session-1",
    agent: "subagent",
    title: "Check catalog conflicts",
    status: "running",
    turnCount: 0,
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    activity: "starting",
    children: [],
    ...overrides,
  };
}

describe("subagent display helpers", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime("2026-01-01T00:00:00.000Z"); });
  afterEach(() => { vi.useRealTimers(); });

  it("requires a caller-given title and collapses its whitespace", () => {
    expect(requiredRunTitle("  Check\n catalog\tconflicts  ")).toBe("Check catalog conflicts");
    expect(requiredRunTitle("Check catalog conflicts")).toBe("Check catalog conflicts");
  });

  it.each(["", " \n\t ", "hidden\u200btext", "nul\u0000text", "bell\u0007text"])("rejects unusable titles like %j at the tool boundary", (title) => {
    expect(() => requiredRunTitle(title)).toThrow("Title must be one short line of printable text");
  });

  it.each([" ", "hidden\u200btext", "nul\u0000text", "Safe title"])("keeps only safe titles for foreign run views %j", (task) => {
    expect(safeRunTitle(task)).toBe(safeReferenceText(task) ? task : "");
  });

  it("omits empty titles from progress bullets and result metadata", () => {
    const run = runView({ title: "", turnCount: 1 });
    expect(renderSubagentProgress(run)).toBe("- subagent (1 turn, 0s): starting");
    expect(renderSubagentResult(omittedAgentSelection(), run, "answer")).toBe([
      "## Subagent result", "Subagent session ID: session-1", "Ran 1 turn at ? context", "", "answer",
    ].join("\n"));
  });

  it("omits invalid activity ages and floors future activity at zero", () => {
    expect(formatActivityAge("not a date", Date.now())).toBeUndefined();
    expect(formatActivityAge("2026-01-01T00:00:01.000Z", Date.now())).toBe("0s");
    expect(renderSubagentProgress(runView({ lastActivityAt: "invalid" }))).toBe(
      "- Check catalog conflicts (subagent, 0 turns): starting",
    );
  });

  it("renders each nested segment with its own whole-second activity age", () => {
    const run = runView({
      agent: "parent",
      children: [runView({ agent: "reviewer", lastActivityAt: "2026-01-01T00:00:05.100Z", turnCount: 3,
        contextUsage: { tokens: 42, contextWindow: 100, percent: 42 }, activity: "using read" })],
    });
    expect(renderSubagentProgress(run, Date.parse("2026-01-01T00:00:13.999Z"))).toBe(
      "- Check catalog conflicts (parent, 0 turns, 13s) -> Check catalog conflicts (reviewer, 42% ctx, 3 turns, 8s): using read",
    );
    expect(renderSubagentProgress(runView(), Date.parse("2025-12-31T23:59:59.000Z"))).toContain("0s");
    expect(renderSubagentProgress(runView(), Date.parse("2026-01-02T00:00:00.000Z"))).toContain("86400s");
  });

  it("renders unknown result context before the model note and final answer", () => {
    expect(renderSubagentResult(omittedAgentSelection(), runView({ contextUsage: { tokens: null, contextWindow: 100, percent: null } }), "answer", "Model: provider/model")).toBe([
      "## Subagent result", "Subagent session ID: session-1", "Task: Check catalog conflicts", "Ran 0 turns at ? context", "Model: provider/model", "", "answer",
    ].join("\n"));
  });

  it("renders omitted agent as the special Subagent mode", () => {
    const selection = omittedAgentSelection();

    expect(subagentTitle(selection)).toBe("Subagent");
    expect(resultHeading(selection)).toBe("## Subagent result");
  });

  it("renders named agents without collapsing literal subagent.md into omitted mode", () => {
    const reviewer = namedAgentSelection("reviewer", "/repo/.pi/agents/reviewer.md");
    const literalSubagent = namedAgentSelection("subagent", "/repo/.pi/agents/subagent.md");

    expect(subagentTitle(reviewer)).toBe("Subagent reviewer");
    expect(subagentTitle(literalSubagent)).toBe("Subagent subagent");
  });

  it("renders successful results with compact session metadata", () => {
    const reviewer = namedAgentSelection("reviewer", "/repo/.pi/agents/reviewer.md");

    expect(renderSubagentResult(reviewer, runView({ sessionId: "session-123", turnCount: 3, contextUsage: { tokens: 42, contextWindow: 100, percent: 42.4 } }), "child answer")).toBe([
      "## Subagent reviewer result",
      "Subagent session ID: session-123",
      "Task: Check catalog conflicts",
      "Ran 3 turns at 42.4% context",
      "",
      "child answer",
    ].join("\n"));
  });

  it("renders interrupted recovery capsules with the resumable session id only", () => {
    const reviewer = namedAgentSelection("reviewer", "/repo/.pi/agents/reviewer.md");
    const text = renderSubagentInterrupted(reviewer, "session-123");

    expect(text).toBe([
      "## Subagent reviewer interrupted",
      "",
      "No final answer was produced.",
      "",
      "Subagent session ID: session-123",
      "",
      "If the interrupted task should continue, call `subagent_resume` with this session ID and a message. Otherwise start a new `subagent`.",
      "",
      "Example for `message`:",
      "- You were interrupted. Continue the original task from where you left off.",
    ].join("\n"));
    expect(text).not.toMatch(/\.jsonl|\.subagents|stack|runId|episodeId/i);
  });

  it("renders recoverable child failure text without calling it interrupted", () => {
    const reviewer = namedAgentSelection("reviewer", "/repo/.pi/agents/reviewer.md");
    const text = renderSubagentRecoverableError(reviewer, "session-123", "provider exhausted retries");

    expect(text).toBe([
      "## Subagent reviewer error",
      "",
      "provider exhausted retries",
      "",
      "Subagent session ID: session-123",
      "",
      "This child session may be recoverable. If the same task should continue after a transient failure, call `subagent_resume` with this session ID and a message. Otherwise start a new `subagent`.",
    ].join("\n"));
    expect(text).not.toContain("interrupted");
    expect(text).not.toMatch(/\.jsonl|\.subagents|stack|runId|episodeId/i);
  });

  it("renders a single running root as an active progress bullet", () => {
    expect(renderSubagentProgress(runView({
      agent: "experiment",
      turnCount: 5,
      activity: "using bash",
    }))).toBe([
      "- Check catalog conflicts (experiment, 5 turns, 0s): using bash",
    ].join("\n"));
  });

  it("renders the deepest running nested path as one progress bullet", () => {
    expect(renderSubagentProgress(runView({
      agent: "experiment",
      turnCount: 5,
      activity: "using subagent",
      children: [runView({
        episodeId: "execution",
        agent: "execution",
        turnCount: 16,
        activity: "using subagent",
        children: [runView({
          episodeId: "implementation",
          agent: "implementation",
          turnCount: 3,
          activity: "preparing tool call",
        })],
      })],
    }))).toBe([
      "- Check catalog conflicts (experiment, 5 turns, 0s) -> Check catalog conflicts (execution, 16 turns, 0s) -> Check catalog conflicts (implementation, 3 turns, 0s): preparing tool call",
    ].join("\n"));
  });

  it("renders multiple running leaves as multiple progress bullets", () => {
    expect(renderSubagentProgress(runView({
      agent: "experiment",
      turnCount: 5,
      activity: "using subagent",
      children: [
        runView({ episodeId: "execution", agent: "execution", turnCount: 16, activity: "using bash" }),
        runView({ episodeId: "research", agent: "research", turnCount: 2, activity: "responding" }),
      ],
    }))).toBe([
      "- Check catalog conflicts (experiment, 5 turns, 0s) -> Check catalog conflicts (execution, 16 turns, 0s): using bash",
      "- Check catalog conflicts (experiment, 5 turns, 0s) -> Check catalog conflicts (research, 2 turns, 0s): responding",
    ].join("\n"));
  });

  it("renders known context usage before turn counts", () => {
    expect(renderSubagentProgress(runView({
      agent: "experiment",
      turnCount: 5,
      contextUsage: { tokens: 12_400, contextWindow: 200_000, percent: 6.2 },
      activity: "using bash",
      children: [runView({
        episodeId: "execution",
        agent: "execution",
        turnCount: 16,
        contextUsage: { tokens: 24_800, contextWindow: 200_000, percent: 12.4 },
        activity: "responding",
      })],
    }))).toBe([
      "- Check catalog conflicts (experiment, 6% ctx, 5 turns, 0s) -> Check catalog conflicts (execution, 12% ctx, 16 turns, 0s): responding",
    ].join("\n"));
  });

  it("renders unknown context usage honestly", () => {
    expect(renderSubagentProgress(runView({
      agent: "implementation",
      turnCount: 3,
      contextUsage: { tokens: null, contextWindow: 200_000, percent: null },
      activity: "preparing tool call",
    }))).toBe([
      "- Check catalog conflicts (implementation, ? ctx, 3 turns, 0s): preparing tool call",
    ].join("\n"));
  });

  it("renders the root terminal status when no running leaf remains", () => {
    expect(renderSubagentProgress(runView({
      agent: "experiment",
      status: "failed",
      turnCount: 1,
      activity: "failed",
      children: [runView({
        episodeId: "execution",
        agent: "execution",
        status: "completed",
        turnCount: 2,
        activity: "completed",
      })],
    }))).toBe([
      "- Check catalog conflicts (experiment, 1 turn, 0s): failed",
    ].join("\n"));
  });

  it("renders parent activity when nested children are no longer running", () => {
    expect(renderSubagentProgress(runView({
      agent: "experiment",
      activity: "failed subagent",
      children: [runView({
        episodeId: "execution",
        agent: "execution",
        status: "failed",
        activity: "failed",
      })],
    }))).toBe([
      "- Check catalog conflicts (experiment, 0 turns, 0s): failed subagent",
    ].join("\n"));
  });
});
