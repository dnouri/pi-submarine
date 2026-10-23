import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendManifestRecord, readManifestRecords, requireUniqueStartedRecordBySessionId, serializeManifestRecord } from "../src/manifest.js";
import type { ManifestRecord } from "../src/types.js";

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
  startedAt: "2026-01-01T00:00:00.000Z",
};

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
