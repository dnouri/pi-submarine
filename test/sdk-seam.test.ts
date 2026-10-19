import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getModel, type AssistantMessage } from "@earendil-works/pi-ai";
import { AuthStorage, createAgentSession, DefaultResourceLoader, ModelRegistry, SessionManager, SettingsManager, type AgentSession, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import register from "../src/index.js";
import { buildFreshResourceLoaderOptions, namedSubagentProfile, omittedSubagentProfile, runSubagent, runSubagentResume, type RunnerDependencies } from "../src/runner.js";

const tempRoots: string[] = [];

async function tempRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "pi-submarine-sdk-seam-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function syntheticAssistant(model: NonNullable<AgentSession["model"]>): AssistantMessage {
  return {
    role: "assistant", content: [{ type: "text", text: "Synthetic persisted answer." }], api: model.api, provider: model.provider, model: model.id,
    stopReason: "stop", timestamp: 2,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

function appendSyntheticTurn(session: AgentSession, text: string): void {
  if (!session.model) throw new Error("Expected a selected SDK model");
  const user = { role: "user" as const, content: text, timestamp: 1 };
  const assistant = syntheticAssistant(session.model);
  session.sessionManager.appendMessage(user);
  session.sessionManager.appendMessage(assistant);
  session.agent.state.messages = [...session.messages, user, assistant];
}

async function runnerSdkFixture(prompt = appendSyntheticTurn) {
  const root = await tempRoot();
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "agent-dir");
  await mkdir(path.join(cwd, ".pi", "agents"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultThinkingLevel: "medium" }), "utf8");
  await writeFile(path.join(cwd, ".pi", "agents", "reviewer.md"), "---\ndescription: Reviews\n---\n\nReview the task.\n", "utf8");
  const model = getModel("anthropic", "claude-opus-4-5");
  const historicalModel = getModel("anthropic", "claude-sonnet-4-5");
  const modelRegistry = ModelRegistry.inMemory(AuthStorage.inMemory({ anthropic: { type: "api_key", key: "sdk-seam-never-sent" } }));
  const parent = SessionManager.create(cwd, path.join(root, "sessions"));
  parent.appendModelChange(historicalModel.provider, historicalModel.id);
  parent.appendThinkingLevelChange("low");
  parent.appendMessage({ role: "user", content: "Synthetic parent request.", timestamp: 1 });
  parent.appendMessage(syntheticAssistant(historicalModel));
  // The live parent has switched since these messages were recorded.
  const ctx = { cwd, sessionManager: parent, model, modelRegistry } as unknown as ExtensionContext;
  const observed: Array<{ session: AgentSession; model: AgentSession["model"]; thinkingLevel: AgentSession["thinkingLevel"]; messageCount: number }> = [];
  const deps: Partial<RunnerDependencies> = {
    getAgentDir: () => agentDir,
    createResourceLoader: (options) => new DefaultResourceLoader({
      ...options, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    }),
    createAgentSession: async (options) => {
      const created = await createAgentSession({ ...options, noTools: "all" });
      // Keep the real SDK's model selection, history, persistence, and lifecycle;
      // replace only prompt() so no provider can be contacted.
      vi.spyOn(created.session, "prompt").mockImplementation(async (text) => {
        const session = created.session;
        observed.push({ session, model: session.model, thinkingLevel: session.thinkingLevel, messageCount: session.messages.length });
        prompt(session, text);
      });
      return created;
    },
  };
  return { agentDir, ctx, deps, model, historicalModel, observed };
}

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

  it.each([
    ["omitted", "none"], ["omitted", "auto"],
    ["named skills none", "none"], ["named skills none", "auto"],
    ["named selected skills", "none"], ["named selected skills", "auto"],
  ] as const)("loads actual context markers independently of skills (%s, %s)", async (selection, agentsMd) => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent-dir");
    await mkdir(cwd, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(path.join(agentDir, "AGENTS.md"), "SDK_USER_CONTEXT_MARKER", "utf8");
    await writeFile(path.join(cwd, "AGENTS.md"), "SDK_PROJECT_CONTEXT_BEFORE", "utf8");
    for (const name of ["audit", "other"]) {
      const skillDir = path.join(cwd, ".pi", "skills", name);
      await mkdir(skillDir, { recursive: true });
      await writeFile(path.join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: SDK ${name} skill marker\n---\n\nRead the requested code.\n`, "utf8");
    }
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    const profile = selection === "omitted" ? omittedSubagentProfile() : namedSubagentProfile({
      name: "reviewer", description: "Reviews", source: "project", filePath: path.join(cwd, ".pi", "agents", "reviewer.md"), body: "Named body marker.",
      agentsMd: agentsMd === "none" ? "auto" : "none",
      skills: selection === "named skills none" ? "none" : { names: ["audit"] },
    });
    const loader = new DefaultResourceLoader(buildFreshResourceLoaderOptions(profile, { cwd, agentDir, settingsManager }, agentsMd));
    await loader.reload();
    const contents = loader.getAgentsFiles().agentsFiles.map((file) => file.content).join("\n");
    if (agentsMd === "auto") {
      expect(contents).toContain("SDK_USER_CONTEXT_MARKER");
      expect(contents).toContain("SDK_PROJECT_CONTEXT_BEFORE");
    } else {
      expect(contents).not.toContain("SDK_USER_CONTEXT_MARKER");
      expect(contents).not.toContain("SDK_PROJECT_CONTEXT_BEFORE");
    }
    const skillNames = loader.getSkills().skills.map((skill) => skill.name);
    if (selection === "named skills none") expect(skillNames).toEqual([]);
    else if (selection === "named selected skills") expect(skillNames).toEqual(["audit"]);
    else expect(skillNames).toEqual(expect.arrayContaining(["audit", "other"]));

    await writeFile(path.join(cwd, "AGENTS.md"), "SDK_PROJECT_CONTEXT_AFTER", "utf8");
    await loader.reload();
    const reloaded = loader.getAgentsFiles().agentsFiles.map((file) => file.content).join("\n");
    expect(reloaded).not.toContain("SDK_PROJECT_CONTEXT_BEFORE");
    expect(reloaded.includes("SDK_PROJECT_CONTEXT_AFTER")).toBe(agentsMd === "auto");
    const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), model: getModel("anthropic", "claude-opus-4-5"), tools: ["read"] });
    try {
      expect(session.systemPrompt.includes("SDK_PROJECT_CONTEXT_AFTER")).toBe(agentsMd === "auto");
      expect(session.systemPrompt.includes("SDK_USER_CONTEXT_MARKER")).toBe(agentsMd === "auto");
      expect(session.systemPrompt.includes("SDK audit skill marker")).toBe(selection !== "named skills none");
      expect(session.systemPrompt).not.toContain("Named body marker.");
    } finally {
      session.dispose();
    }
  });

  it("lets the real SDK select effort from settings when no explicit level is supplied", async () => {
    const root = await tempRoot();
    const settingsManager = SettingsManager.inMemory({ defaultThinkingLevel: "high" });
    const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: path.join(root, "agent"), settingsManager, noContextFiles: true });
    await resourceLoader.reload();
    const manager = SessionManager.inMemory(root);
    const { session } = await createAgentSession({ cwd: root, agentDir: path.join(root, "agent"), model: getModel("anthropic", "claude-opus-4-5"), settingsManager, resourceLoader, sessionManager: manager, noTools: "all" });
    try {
      expect(session.thinkingLevel).toBe("high");
      expect(manager.buildSessionContext().thinkingLevel).toBe("high");
    } finally {
      session.dispose();
    }
  });

  it("persists explicit SDK effort and restores it without an effort override or network request", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent-dir");
    await mkdir(cwd, { recursive: true });
    const settingsManager = SettingsManager.inMemory({ defaultThinkingLevel: "high" });
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noContextFiles: true });
    await resourceLoader.reload();
    const manager = SessionManager.create(cwd, path.join(root, "sessions"));
    const model = getModel("anthropic", "claude-opus-4-5");
    const { session: first } = await createAgentSession({ cwd, agentDir, model, thinkingLevel: "low", settingsManager, resourceLoader, sessionManager: manager, noTools: "all" });
    try {
      expect(first.thinkingLevel).toBe("low");
      expect(manager.getEntries()).toContainEqual(expect.objectContaining({ type: "thinking_level_change", thinkingLevel: "low" }));
      manager.appendMessage({ role: "user", content: "Synthetic persisted request.", timestamp: 1 });
      manager.appendMessage({
        role: "assistant", content: [{ type: "text", text: "Synthetic persisted answer." }], api: model.api, provider: model.provider, model: model.id,
        stopReason: "stop", timestamp: 2,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      });
    } finally {
      first.dispose();
    }
    const sessionFile = manager.getSessionFile();
    if (!sessionFile) throw new Error("Expected persisted SDK session");
    expect(await readFile(sessionFile, "utf8")).toContain('"thinkingLevel":"low"');
    const reopened = SessionManager.open(sessionFile);
    await resourceLoader.reload();
    const { session: restored } = await createAgentSession({ cwd, agentDir, model, settingsManager, resourceLoader, sessionManager: reopened, noTools: "all" });
    try {
      expect(settingsManager.getDefaultThinkingLevel()).toBe("high");
      expect(restored.thinkingLevel).toBe("low");
      expect(restored.messages).toHaveLength(2);
      expect(reopened.buildSessionContext()).toMatchObject({ model: { provider: model.provider, modelId: model.id }, thinkingLevel: "low" });
      expect(reopened.getEntries().filter((entry) => entry.type === "thinking_level_change")).toHaveLength(1);
    } finally {
      restored.dispose();
    }
  });

  it.each([
    { context: "fresh", agent: undefined }, { context: "fork", agent: undefined },
    { context: "fresh", agent: "reviewer" }, { context: "fork", agent: "reviewer" },
  ] as const)("executes and records current parent model/effort for $context (agent: $agent), then resumes those child choices", async ({ context, agent }) => {
    const { agentDir, ctx, deps, model, historicalModel, observed } = await runnerSdkFixture();
    const result = await runSubagent({ task: "Synthetic child task.", context, ...(agent === undefined ? {} : { agent }) }, undefined, undefined, ctx, { deps, parentThinkingLevel: "high" });
    expect(observed[0]).toMatchObject({ model, thinkingLevel: "high", messageCount: context === "fork" ? 2 : 0 });
    const child = observed[0]?.session;
    if (!child?.sessionFile) throw new Error("Expected persisted SDK child");
    // SDK 0.79.1 can execute an explicit effort on an existing-message fork
    // without recording it. Check disk, not just the effective session option.
    expect(SessionManager.open(child.sessionFile).buildSessionContext()).toMatchObject({
      model: { provider: model.provider, modelId: model.id }, thinkingLevel: "high",
    });

    await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultThinkingLevel: "low" }), "utf8");
    await runSubagentResume({ sessionId: result.details.run.sessionId, message: "Synthetic follow-up." }, undefined, undefined,
      { ...ctx, model: historicalModel }, { deps, parentThinkingLevel: "off" });
    expect(observed[1]).toMatchObject({ model, thinkingLevel: "high", messageCount: context === "fork" ? 4 : 2 });
    expect(observed[1]?.session.sessionFile).toBe(child.sessionFile);
    expect(SessionManager.open(child.sessionFile).buildSessionContext()).toMatchObject({
      model: { provider: model.provider, modelId: model.id }, thinkingLevel: "high",
    });
  });

  it.each(["call", "profile"] as const)("persists an explicit %s chain's effective model/effort on an existing-message fork", async (source) => {
    const { ctx, deps, model, observed } = await runnerSdkFixture();
    const chain = `${model.provider}/${model.id}@high`;
    if (source === "profile") {
      await writeFile(path.join(ctx.cwd, ".pi", "agents", "reviewer.md"), `---\ndescription: Reviews\nmodel: ${chain}\n---\n\nReview the task.\n`, "utf8");
    }
    await runSubagent({ task: "Use the explicit fork model and effort.", context: "fork", ...(source === "call" ? { model: chain } : { agent: "reviewer" }) },
      undefined, undefined, ctx, { deps, parentThinkingLevel: "low" });
    expect(observed[0]).toMatchObject({ model, thinkingLevel: "high", messageCount: 2 });
    const child = observed[0]?.session;
    if (!child?.sessionFile) throw new Error("Expected persisted forked SDK child");
    expect(SessionManager.open(child.sessionFile).buildSessionContext()).toMatchObject({
      model: { provider: model.provider, modelId: model.id }, thinkingLevel: "high",
    });
  });

  it.each(["inherited", "explicit"] as const)("restores %s effort from a message-empty interrupted SDK child instead of later parent/settings defaults", async (selection) => {
    const controller = new AbortController();
    let interrupt = true;
    const { agentDir, ctx, deps, model, historicalModel, observed } = await runnerSdkFixture((session, text) => {
      if (interrupt) controller.abort();
      else appendSyntheticTurn(session, text);
    });
    await expect(runSubagent({ task: "Interrupt before recording a message.", ...(selection === "explicit" ? { model: `${model.provider}/${model.id}@high` } : {}) },
      controller.signal, undefined, ctx, { deps, parentThinkingLevel: selection === "explicit" ? "low" : "high" })).rejects.toThrow("Subagent interrupted");
    expect(observed[0]).toMatchObject({ model, thinkingLevel: "high", messageCount: 0 });
    const child = observed[0]?.session;
    if (!child?.sessionFile) throw new Error("Expected persisted interrupted SDK child");
    const reopened = SessionManager.open(child.sessionFile);
    expect(reopened.buildSessionContext()).toMatchObject({
      messages: [], model: { provider: model.provider, modelId: model.id }, thinkingLevel: "high",
    });

    interrupt = false;
    await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultThinkingLevel: "low" }), "utf8");
    // SDK 0.79.1 does not restore recorded effort when messages are empty;
    // resume must supply the child's recorded level explicitly.
    await runSubagentResume({ sessionId: child.sessionId, message: "Recover the interrupted task." }, undefined, undefined,
      { ...ctx, model: historicalModel }, { deps, parentThinkingLevel: "off" });
    expect(observed[1]).toMatchObject({ model, thinkingLevel: "high", messageCount: 0 });
    expect(observed[1]?.session.sessionFile).toBe(child.sessionFile);
    expect(SessionManager.open(child.sessionFile).buildSessionContext()).toMatchObject({
      model: { provider: model.provider, modelId: model.id }, thinkingLevel: "high",
    });
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
