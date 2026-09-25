import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import register from "../src/index.js";

const tempRoots: string[] = [];

async function tempRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "pi-submarine-sdk-seam-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Pi SDK integration seam", () => {
  it("creates a persisted child AgentSession and binds pi-submarine tools from the inline extension factory", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent-dir");
    const subagentsDir = path.join(root, "parent.jsonl.subagents");
    const sessionManager = SessionManager.create(cwd, subagentsDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      noContextFiles: true,
      extensionFactories: [register],
    });

    await resourceLoader.reload();
    const { session } = await createAgentSession({ cwd, agentDir, resourceLoader, sessionManager });

    try {
      await session.bindExtensions({ onError: (error) => { throw error; } });

      expect(sessionManager.getSessionFile()).toMatch(new RegExp(`${escapeRegExp(subagentsDir)}[/\\\\].+\\.jsonl$`));
      expect(session.getAllTools().map((tool) => tool.name)).toEqual(expect.arrayContaining(["subagent", "subagent_resume", "subagent_list"]));
      expect(resourceLoader.getExtensions().errors).toEqual([]);
    } finally {
      session.dispose();
    }
  });

  it("loads project-local extension tools when child resources are explicitly project-trusted", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent-dir");
    const subagentsDir = path.join(root, "parent.jsonl.subagents");
    const extensionPath = path.join(cwd, ".pi", "extensions", "project-tool.js");
    await mkdir(path.dirname(extensionPath), { recursive: true });
    await writeFile(extensionPath, `
export default function(pi) {
  pi.registerTool({
    name: "project_tool",
    label: "Project Tool",
    description: "A project-local test tool",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; }
  });
}
`, "utf8");

    const sessionManager = SessionManager.create(cwd, subagentsDir);
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noContextFiles: true });

    await resourceLoader.reload();
    const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, sessionManager });

    try {
      await session.bindExtensions({ onError: (error) => { throw error; } });

      expect(settingsManager.isProjectTrusted()).toBe(true);
      expect(session.getAllTools().map((tool) => tool.name)).toEqual(expect.arrayContaining(["project_tool"]));
      expect(resourceLoader.getExtensions().errors).toEqual([]);
    } finally {
      session.dispose();
    }
  });

  it.each([
    { name: "rebinds an inline extension after reloading the resource loader", reloadBeforeSecond: true },
    { name: "reports a stale inline extension when the resource loader is not reloaded", reloadBeforeSecond: false },
  ])("$name", async ({ reloadBeforeSecond }) => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent-dir");
    const sessionsDir = path.join(root, "sessions");
    const errors: Array<{ event: string; error: string }> = [];
    let factoryLoads = 0;
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      noContextFiles: true,
      extensionFactories: [(pi) => {
        const load = ++factoryLoads;
        pi.on("session_start", (event, ctx) => {
          pi.appendEntry("sdk-seam-start", {
            load,
            reason: event.reason,
            sessionId: ctx.sessionManager.getSessionId(),
          });
        });
      }],
    });

    await resourceLoader.reload();
    const firstManager = SessionManager.create(cwd, sessionsDir);
    const { session: first } = await createAgentSession({
      cwd, agentDir, resourceLoader, sessionManager: firstManager, noTools: "all",
    });
    try {
      await first.bindExtensions({ onError: (error) => { errors.push(error); } });
      expect(errors).toEqual([]);
      expect(firstManager.getEntries().filter((entry) => entry.type === "custom")).toEqual([
        expect.objectContaining({
          customType: "sdk-seam-start",
          data: { load: 1, reason: "startup", sessionId: firstManager.getSessionId() },
        }),
      ]);
    } finally {
      first.dispose();
    }

    const originalRuntime = resourceLoader.getExtensions().runtime;
    if (reloadBeforeSecond) await resourceLoader.reload();
    expect(resourceLoader.getExtensions().runtime === originalRuntime).toBe(!reloadBeforeSecond);
    expect(resourceLoader.getExtensions().errors).toEqual([]);
    expect(factoryLoads).toBe(reloadBeforeSecond ? 2 : 1);

    const secondManager = SessionManager.create(cwd, sessionsDir);
    const { session: second } = await createAgentSession({
      cwd, agentDir, resourceLoader, sessionManager: secondManager, noTools: "all",
    });
    try {
      await second.bindExtensions({ onError: (error) => { errors.push(error); } });
      expect(secondManager.getSessionId()).not.toBe(firstManager.getSessionId());
      expect(secondManager.getSessionFile()).not.toBe(firstManager.getSessionFile());
      const secondStarts = secondManager.getEntries().filter((entry) => entry.type === "custom");
      if (reloadBeforeSecond) {
        expect(errors).toEqual([]);
        expect(secondStarts).toEqual([
          expect.objectContaining({
            customType: "sdk-seam-start",
            data: { load: 2, reason: "startup", sessionId: secondManager.getSessionId() },
          }),
        ]);
      } else {
        // dispose() invalidates the loader's current extension runtime. A new
        // AgentSession cannot reuse its captured pi API without loader.reload().
        expect(secondStarts).toEqual([]);
        expect(errors).toEqual([
          expect.objectContaining({
            event: "session_start",
            error: expect.stringContaining("stale after session replacement or reload"),
          }),
        ]);
      }
      expect(firstManager.getEntries().filter((entry) => entry.type === "custom")).toHaveLength(1);
    } finally {
      second.dispose();
    }
  });

  it("branches a reopened parent session into the parent-local .subagents directory", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project with spaces");
    const sessionsDir = path.join(root, "sessions");
    const subagentsDir = path.join(root, "parent.jsonl.subagents");
    await mkdir(cwd, { recursive: true });

    const parent = SessionManager.create(cwd, sessionsDir);
    const userId = parent.appendMessage({ role: "user", content: "Remember blue." } as Parameters<SessionManager["appendMessage"]>[0]);
    const assistantId = parent.appendMessage({ role: "assistant", content: "I will remember blue.", stopReason: "stop" } as unknown as Parameters<SessionManager["appendMessage"]>[0]);
    const parentSessionFile = parent.getSessionFile();
    if (!parentSessionFile) throw new Error("expected parent session file");

    const source = SessionManager.open(parentSessionFile, subagentsDir);
    const originalSourceSessionFile = source.getSessionFile();
    const originalParentSessionFile = parent.getSessionFile();
    const childSessionFile = source.createBranchedSession(parent.getLeafId() ?? "");
    if (!childSessionFile) throw new Error("expected child session file");

    const childLines = (await readFile(childSessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; id?: string; cwd?: string; parentSession?: string });
    const header = childLines[0];
    const entries = childLines.slice(1);

    expect(path.dirname(childSessionFile)).toBe(subagentsDir);
    expect(path.basename(childSessionFile)).toMatch(/\.jsonl$/);
    expect(header).toMatchObject({ type: "session", cwd: path.resolve(cwd), parentSession: parentSessionFile });
    expect(entries.map((entry) => entry.id)).toEqual([userId, assistantId]);
    expect(source.getSessionFile()).toBe(childSessionFile);
    expect(source.getSessionFile()).not.toBe(originalSourceSessionFile);
    expect(parent.getSessionFile()).toBe(originalParentSessionFile);
  });
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
