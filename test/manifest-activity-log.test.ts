import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueuedActivityLogWriter, appendActivityLogFinished, appendActivityLogStarted, ensureActivityLogHeader } from "../src/activity-log.js";
import { appendManifestRecord, readManifestRecords, requireUniqueStartedRecordBySessionId, serializeManifestRecord } from "../src/manifest.js";
import type { ManifestRecord, SubagentRunView } from "../src/types.js";

const tempRoots: string[] = [];

async function tempRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "pi-submarine-artifacts-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const started: ManifestRecord = {
  type: "started",
  episodeId: "run-1",
  sessionId: "session-1",
  parentEpisodeId: null,
  agent: "subagent",
  cwd: "/repo",
  context: "fresh",
  sessionFile: "/sessions/root.jsonl.subagents/child.jsonl",
  activityLog: "/sessions/root.jsonl.subagents.md",
  startedAt: "2026-01-01T00:00:00.000Z",
};

function runView(overrides: Partial<SubagentRunView> = {}): SubagentRunView {
  return {
    episodeId: "run-1",
    sessionId: "session-1",
    agent: "implementation",
    status: "completed",
    turnCount: 3,
    lastActivityAt: "2026-01-01T00:01:00.000Z",
    activity: "completed",
    activityLog: "/sessions/root.jsonl.subagents.md",
    children: [],
    ...overrides,
  };
}

describe("manifest helpers", () => {
  it("serializes manifest records as JSON lines", () => {
    expect(serializeManifestRecord(started)).toBe(`${JSON.stringify(started)}\n`);
  });

  it("finds exactly one started record by child session ID", () => {
    const finished: ManifestRecord = { type: "finished", episodeId: "run-1", status: "completed", finishedAt: "later" };

    expect(requireUniqueStartedRecordBySessionId([started, finished], "session-1")).toBe(started);
  });

  it("fails clearly when a child session ID is not in the current manifest", () => {
    expect(() => requireUniqueStartedRecordBySessionId([started], "missing-session")).toThrow("No subagent session found for session ID 'missing-session' in the current parent/root session.");
  });

  it("fails clearly when a child session ID has duplicate started records", () => {
    const duplicate = { ...started, episodeId: "run-2", sessionFile: "/sessions/root.jsonl.subagents/child-2.jsonl" };

    expect(() => requireUniqueStartedRecordBySessionId([started, duplicate], "session-1")).toThrow("Multiple subagent sessions found for session ID 'session-1' in the current parent/root session.");
  });

  it("appends and reads start, resume, and terminal lifecycle records", async () => {
    const root = await tempRoot();
    const manifest = path.join(root, ".subagents", "manifest.jsonl");
    const aborted: ManifestRecord = { type: "finished", episodeId: "run-1", status: "aborted", finishedAt: "2026-01-01T00:01:00.000Z", error: "Interrupted by parent abort." };
    const resumeStarted: ManifestRecord = {
      type: "resume_started",
      episodeId: "resume-1",
      sessionId: "session-1",
      parentEpisodeId: null,
      agent: "subagent",
      cwd: "/repo",
      context: "fresh",
      sessionFile: "/sessions/root.jsonl.subagents/child.jsonl",
      activityLog: "/sessions/root.jsonl.subagents.md",
      startedAt: "2026-01-01T00:02:00.000Z",
    };
    const resumeAborted: ManifestRecord = { type: "resume_finished", episodeId: "resume-1", sessionId: "session-1", status: "aborted", finishedAt: "2026-01-01T00:03:00.000Z", error: "Interrupted by parent abort." };

    await appendManifestRecord(manifest, started);
    await appendManifestRecord(manifest, aborted);
    await appendManifestRecord(manifest, resumeStarted);
    await appendManifestRecord(manifest, resumeAborted);

    await expect(readManifestRecords(manifest)).resolves.toEqual([
      started,
      aborted,
      resumeStarted,
      resumeAborted,
    ]);
  });

  it("logs degraded append failures without throwing", async () => {
    const logger = vi.fn();
    const appendFile = vi.fn(async () => {
      throw new Error("disk full");
    });

    await expect(appendManifestRecord("/nope/manifest.jsonl", started, { appendFile, logger })).resolves.toBe(false);

    expect(logger).toHaveBeenCalledWith(expect.stringContaining("Could not append subagent manifest"), expect.any(Error));
  });
});

describe("activity log helpers", () => {
  it("creates one idempotent aggregate header for the root parent session", async () => {
    const root = await tempRoot();
    const rootSession = path.join(root, "parent.jsonl");
    const activityLog = `${rootSession}.subagents.md`;

    await ensureActivityLogHeader(activityLog, rootSession, "2026-01-01T00:00:00.000Z");
    await ensureActivityLogHeader(activityLog, rootSession, "2026-01-01T00:00:01.000Z");

    const text = await readFile(activityLog, "utf8");
    expect(text.match(/# Subagents/g)).toHaveLength(1);
    expect(text).toContain(`Root session: ${rootSession}`);
    expect(text).toContain(`Activity log: ${activityLog}`);
    expect(text).toContain("compact status stream, not a transcript");
    expect(text).toContain("Child session JSONL files are canonical.");
    expect(text).toContain("## Activity");
  });

  it("appends start, status, and completion events with JSONL session references", async () => {
    const root = await tempRoot();
    const rootSession = path.join(root, "parent.jsonl");
    const activityLog = `${rootSession}.subagents.md`;
    const childSession = path.join(`${rootSession}.subagents`, "child.jsonl");
    await ensureActivityLogHeader(activityLog, rootSession, "2026-01-01T00:00:00.000Z");

    await appendActivityLogStarted(activityLog, {
      timestamp: "2026-01-01T00:00:01.000Z",
      path: ["experiment"],
      episodeId: "run-1",
      sessionFile: childSession,
    });
    const writer = new QueuedActivityLogWriter(activityLog, ["experiment", "implementation"], childSession);
    writer.appendStatus("2026-01-01T00:00:02.000Z", 'using bash {"command":"npm test"}');
    writer.appendStatus("2026-01-01T00:00:03.000Z", 'using bash {"command":"npm test"}');
    writer.appendStatus("2026-01-01T00:00:04.000Z", "responding");
    writer.appendFinished("2026-01-01T00:00:05.000Z", runView({
      contextUsage: { tokens: 12_400, contextWindow: 200_000, percent: 6.2 },
    }));
    await writer.drain();

    const text = await readFile(activityLog, "utf8");
    expect(text).toContain(`- 2026-01-01T00:00:01.000Z started experiment — episode run-1 — session: ${childSession}`);
    expect(text).toContain('- 2026-01-01T00:00:02.000Z experiment -> implementation: using bash {"command":"npm test"}');
    expect(text).not.toContain("2026-01-01T00:00:03.000Z");
    expect(text).toContain("- 2026-01-01T00:00:04.000Z experiment -> implementation: responding");
    expect(text).toContain(`- 2026-01-01T00:00:05.000Z completed experiment -> implementation — 6% ctx, 3 turns — session: ${childSession}`);
    expect(text).not.toContain("## Assistant");
    expect(text).not.toContain("Partial answer");
  });

  it("renders unknown final context usage honestly", async () => {
    const root = await tempRoot();
    const activityLog = path.join(root, "subagents.md");
    const childSession = path.join(root, "child.jsonl");

    await appendActivityLogFinished(activityLog, "2026-01-01T00:00:05.000Z", ["implementation"], childSession, runView({
      contextUsage: { tokens: null, contextWindow: 200_000, percent: null },
    }));

    const text = await readFile(activityLog, "utf8");
    expect(text).toContain(`- 2026-01-01T00:00:05.000Z completed implementation — ? ctx, 3 turns — session: ${childSession}`);
  });

  it("appends failed and aborted completion events with one-line errors", async () => {
    const root = await tempRoot();
    const activityLog = path.join(root, "subagents.md");
    const childSession = path.join(root, "child.jsonl");

    await appendActivityLogFinished(activityLog, "2026-01-01T00:00:05.000Z", ["implementation"], childSession, runView({
      status: "failed",
      activity: "failed",
      turnCount: 2,
    }), "provider\nfailed");
    await appendActivityLogFinished(activityLog, "2026-01-01T00:00:06.000Z", ["implementation"], childSession, runView({
      status: "aborted",
      activity: "interrupted",
      turnCount: 2,
    }), "Interrupted by parent abort.");

    const text = await readFile(activityLog, "utf8");
    expect(text).toContain(`- 2026-01-01T00:00:05.000Z failed implementation — 2 turns — error: provider failed — session: ${childSession}`);
    expect(text).toContain(`- 2026-01-01T00:00:06.000Z aborted implementation — 2 turns — error: Interrupted by parent abort. — session: ${childSession}`);
  });

  it("queues activity-log appends and degrades write failures without throwing", async () => {
    const logger = vi.fn();
    const appendFile = vi.fn(async () => {
      throw new Error("permission denied");
    });

    await expect(appendActivityLogFinished("/nope/root.jsonl.subagents.md", "now", ["subagent"], "/nope/child.jsonl", runView({ status: "failed" }), "boom", { appendFile, logger })).resolves.toBe(false);

    const writer = new QueuedActivityLogWriter("/nope/root.jsonl.subagents.md", ["subagent"], "/nope/child.jsonl", { appendFile, logger });
    writer.appendStatus("now", "using read");
    await expect(writer.drain()).resolves.toBeUndefined();

    expect(logger).toHaveBeenCalledWith(expect.stringContaining("Could not append subagent activity log"), expect.any(Error));
  });
});
