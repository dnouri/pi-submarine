import { describe, expect, it } from "vitest";
import { namedAgentSelection, omittedAgentSelection, renderSubagentInterrupted, renderSubagentProgress, renderSubagentRecoverableError, renderSubagentResult, resultHeading, subagentTitle } from "../src/render.js";
import type { SubagentRunView } from "../src/types.js";

function runView(overrides: Partial<SubagentRunView> = {}): SubagentRunView {
  return {
    episodeId: "run",
    sessionId: "session-1",
    agent: "subagent",
    status: "running",
    turnCount: 0,
    lastActivityAt: "now",
    activity: "starting",
    activityLog: "/tmp/subagents.live.md",
    children: [],
    ...overrides,
  };
}

describe("subagent display helpers", () => {
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

    expect(renderSubagentResult(reviewer, "session-123", "child answer")).toBe([
      "## Subagent reviewer result",
      "Subagent session ID: session-123",
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
      "To continue this exact child session, call `subagent_resume` with this session ID and a message.",
      "",
      "Examples for `message`:",
      "- You were interrupted. Continue work exactly where you left off.",
      "- Good. Now also check the edge cases you mentioned and update your recommendation.",
      "- Please summarize what you did so far for a handoff so we can continue later.",
    ].join("\n"));
    expect(text).not.toMatch(/\.jsonl|\.subagents|subagents\.live\.md|Activity log|stack|runId|episodeId/i);
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
      "This child session may be resumable. To continue this exact child session, call `subagent_resume` with this session ID and a message.",
    ].join("\n"));
    expect(text).not.toContain("interrupted");
    expect(text).not.toMatch(/\.jsonl|\.subagents|subagents\.live\.md|Activity log|stack|runId|episodeId/i);
  });

  it("renders a single running root as an active progress bullet", () => {
    expect(renderSubagentProgress(runView({
      agent: "experiment",
      turnCount: 5,
      activity: "using bash",
      activityLog: "/tmp/subagents.live.md",
    }))).toBe([
      "Active log: /tmp/subagents.live.md",
      "Subagents:",
      "- experiment (5 turns): using bash",
    ].join("\n"));
  });

  it("renders the deepest running nested path as one progress bullet", () => {
    expect(renderSubagentProgress(runView({
      agent: "experiment",
      turnCount: 5,
      activity: "using subagent",
      activityLog: "/tmp/subagents.live.md",
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
      "Active log: /tmp/subagents.live.md",
      "Subagents:",
      "- experiment (5 turns) -> execution (16 turns) -> implementation (3 turns): preparing tool call",
    ].join("\n"));
  });

  it("renders multiple running leaves as multiple progress bullets", () => {
    expect(renderSubagentProgress(runView({
      agent: "experiment",
      turnCount: 5,
      activity: "using subagent",
      activityLog: "/tmp/subagents.live.md",
      children: [
        runView({ episodeId: "execution", agent: "execution", turnCount: 16, activity: "using bash" }),
        runView({ episodeId: "research", agent: "research", turnCount: 2, activity: "responding" }),
      ],
    }))).toBe([
      "Active log: /tmp/subagents.live.md",
      "Subagents:",
      "- experiment (5 turns) -> execution (16 turns): using bash",
      "- experiment (5 turns) -> research (2 turns): responding",
    ].join("\n"));
  });

  it("renders known context usage before turn counts", () => {
    expect(renderSubagentProgress(runView({
      agent: "experiment",
      turnCount: 5,
      contextUsage: { tokens: 12_400, contextWindow: 200_000, percent: 6.2 },
      activity: "using bash",
      activityLog: "/tmp/subagents.live.md",
      children: [runView({
        episodeId: "execution",
        agent: "execution",
        turnCount: 16,
        contextUsage: { tokens: 24_800, contextWindow: 200_000, percent: 12.4 },
        activity: "responding",
      })],
    }))).toBe([
      "Active log: /tmp/subagents.live.md",
      "Subagents:",
      "- experiment (6% ctx, 5 turns) -> execution (12% ctx, 16 turns): responding",
    ].join("\n"));
  });

  it("renders unknown context usage honestly", () => {
    expect(renderSubagentProgress(runView({
      agent: "implementation",
      turnCount: 3,
      contextUsage: { tokens: null, contextWindow: 200_000, percent: null },
      activity: "preparing tool call",
      activityLog: "/tmp/subagents.live.md",
    }))).toBe([
      "Active log: /tmp/subagents.live.md",
      "Subagents:",
      "- implementation (? ctx, 3 turns): preparing tool call",
    ].join("\n"));
  });

  it("renders the root terminal status when no running leaf remains", () => {
    expect(renderSubagentProgress(runView({
      agent: "experiment",
      status: "failed",
      turnCount: 1,
      activity: "failed",
      activityLog: "/tmp/subagents.live.md",
      children: [runView({
        episodeId: "execution",
        agent: "execution",
        status: "completed",
        turnCount: 2,
        activity: "completed",
      })],
    }))).toBe([
      "Active log: /tmp/subagents.live.md",
      "Subagents:",
      "- experiment (1 turn): failed",
    ].join("\n"));
  });

  it("renders parent activity when nested children are no longer running", () => {
    expect(renderSubagentProgress(runView({
      agent: "experiment",
      activity: "failed subagent",
      activityLog: "/tmp/subagents.live.md",
      children: [runView({
        episodeId: "execution",
        agent: "execution",
        status: "failed",
        activity: "failed",
      })],
    }))).toBe([
      "Active log: /tmp/subagents.live.md",
      "Subagents:",
      "- experiment (0 turns): failed subagent",
    ].join("\n"));
  });
});
