import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findParentEpisodeId, readManifestRecords } from "../src/manifest.js";
import { activityLogPathForSubagentsRoot, resolveSubagentsRoot } from "../src/sessions.js";

const tempRoots: string[] = [];

async function tempRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "pi-submarine-sessions-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("subagent artifact root detection", () => {
  it("creates a top-level .subagents directory beside the parent session file", async () => {
    const root = await tempRoot();
    const parentSession = path.join(root, "parent.jsonl");

    const resolved = resolveSubagentsRoot(parentSession, null);

    expect(resolved).toEqual({
      rootSessionFile: parentSession,
      subagentsDir: `${parentSession}.subagents`,
      activityLogPath: `${parentSession}.subagents.md`,
      parentEpisodeId: null,
    });
  });

  it("reuses the existing root .subagents directory for nested child sessions", async () => {
    const root = await tempRoot();
    const rootSession = path.join(root, "parent.jsonl");
    const subagentsDir = `${rootSession}.subagents`;
    const childSession = path.join(subagentsDir, "child.jsonl");

    const resolved = resolveSubagentsRoot(childSession, "run-parent");

    expect(resolved).toEqual({
      rootSessionFile: rootSession,
      subagentsDir,
      activityLogPath: `${rootSession}.subagents.md`,
      parentEpisodeId: "run-parent",
    });
  });

  it("returns the shared aggregate activity log path beside a subagents directory", async () => {
    const root = await tempRoot();
    const parentSession = path.join(root, "parent.jsonl");
    const subagentsDir = `${parentSession}.subagents`;

    expect(activityLogPathForSubagentsRoot(subagentsDir)).toBe(`${parentSession}.subagents.md`);
  });

  it("reconstructs a nested parent episode id from manifest started records", async () => {
    const root = await tempRoot();
    const manifest = path.join(root, "manifest.jsonl");
    const childSession = path.join(root, "child.jsonl");
    await mkdir(root, { recursive: true });
    await writeFile(
      manifest,
      `${JSON.stringify({ type: "started", episodeId: "run-1", sessionId: "session-1", parentEpisodeId: null, agent: "subagent", cwd: root, context: "fresh", sessionFile: childSession, activityLog: path.join(root, "parent.jsonl.subagents.md"), startedAt: "2026-01-01T00:00:00.000Z" })}\n`,
      "utf8",
    );

    const records = await readManifestRecords(manifest);

    expect(findParentEpisodeId(records, childSession)).toBe("run-1");
  });

  it("uses the latest lifecycle episode for a child session when reconstructing a nested parent", async () => {
    const root = await tempRoot();
    const manifest = path.join(root, "manifest.jsonl");
    const childSession = path.join(root, "child.jsonl");
    await mkdir(root, { recursive: true });
    await writeFile(
      manifest,
      [
        { type: "started", episodeId: "initial-run", sessionId: "session-1", parentEpisodeId: null, agent: "subagent", cwd: root, context: "fresh", sessionFile: childSession, activityLog: path.join(root, "parent.jsonl.subagents.md"), startedAt: "2026-01-01T00:00:00.000Z" },
        { type: "finished", episodeId: "initial-run", status: "completed", finishedAt: "2026-01-01T00:01:00.000Z" },
        { type: "resume_started", episodeId: "resume-run", sessionId: "session-1", parentEpisodeId: null, agent: "subagent", cwd: root, context: "fresh", sessionFile: childSession, activityLog: path.join(root, "parent.jsonl.subagents.md"), startedAt: "2026-01-01T00:02:00.000Z" },
      ].map((record) => JSON.stringify(record)).join("\n") + "\n",
      "utf8",
    );

    const records = await readManifestRecords(manifest);

    expect(findParentEpisodeId(records, childSession)).toBe("resume-run");
  });
});
