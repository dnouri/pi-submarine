import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type JsonObject, type ToolResultMessage } from "@earendil-works/pi-ai";
import { getBuiltinModel as getModel } from "@earendil-works/pi-ai/providers/all";
import { createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type AgentSessionEvent, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import register, { subagentTool, subagentResumeTool } from "../src/index.js";
import * as runner from "../src/runner.js";
import type { SubagentToolDetails } from "../src/types.js";
import { buildFreshResourceLoaderOptions, namedSubagentProfile, omittedSubagentProfile, runSubagent, runSubagentResume, type RunnerDependencies } from "../src/runner.js";

const tempRoots: string[] = [];
const originalEnv = process.env;

beforeEach(async () => {
  process.env = { PATH: originalEnv.PATH ?? "", HOME: await tempRoot(),
    ...(originalEnv.SUBMARINE_ARTIFACT_OUTPUT ? { SUBMARINE_ARTIFACT_OUTPUT: originalEnv.SUBMARINE_ARTIFACT_OUTPUT } : {}) };
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Network forbidden in SDK seam tests"); });
  vi.spyOn(net.Socket.prototype, "connect").mockImplementation(() => { throw new Error("Socket connection forbidden in SDK seam tests"); });
});

async function tempRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "pi-submarine-sdk-seam-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(net.Socket.prototype.connect).not.toHaveBeenCalled();
  } finally {
    process.env = originalEnv;
    vi.restoreAllMocks();
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  }
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
  await writeFile(path.join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "sdk-seam-never-sent" } }));
  const modelRegistry = new ModelRegistry(await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json") }));
  const parent = SessionManager.create(cwd, path.join(root, "sessions"));
  parent.appendModelChange(historicalModel.provider, historicalModel.id);
  parent.appendThinkingLevelChange("low");
  parent.appendMessage({ role: "user", content: "Synthetic parent request.", timestamp: 1 });
  parent.appendMessage(syntheticAssistant(historicalModel));
  // The live parent has switched since these messages were recorded.
  const ctx = { cwd, sessionManager: parent, model, modelRegistry, thinkingLevel: "high" } as unknown as ExtensionContext;
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

type SavedToolMessage = Omit<ToolResultMessage, "details"> & { details?: SubagentToolDetails };
type ScriptStep = (messages: AgentSession["messages"]) => AssistantMessage;

function scriptSession(session: AgentSession, steps: ScriptStep[], beforeResponse?: () => void): void {
  if (!session.model) throw new Error("Expected a selected SDK model");
  session.modelRuntime.registerProvider(session.model.provider, { api: session.model.api, streamSimple: () => {
    const stream = createAssistantMessageEventStream();
    const next = steps.shift();
    if (!next) throw new Error("Unexpected scripted model request");
    const message = next(session.messages);
    stream.push({ type: "start", partial: message });
    beforeResponse?.();
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      stream.push({ type: "error", reason: message.stopReason, error: message });
    } else {
      stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
    }
    return stream;
  } });
}

function toolRequest(name: string, args: JsonObject, id = "scripted-call"): AssistantMessage {
  return { ...syntheticAssistant(getModel("anthropic", "claude-opus-4-5")),
    content: [{ type: "toolCall", id, name, arguments: args }], stopReason: "toolUse" };
}

function toolMessages(manager: SessionManager): SavedToolMessage[] {
  return manager.getBranch().flatMap((entry) => entry.type === "message" && entry.message.role === "toolResult"
    ? [entry.message as unknown as SavedToolMessage] : []);
}

async function expectExactSave(details: SubagentToolDetails) {
  expect(details).not.toHaveProperty("pilish");
  const declaration = details.savedConversations;
  expect(declaration).toBeDefined();
  if (!declaration) throw new Error("Missing saved conversation");
  expect(declaration.version).toBe(1);
  expect(declaration.items).toHaveLength(1);
  const item = declaration.items[0];
  const file = path.join(declaration.root, item.file);
  const header = JSON.parse((await readFile(file, "utf8")).split("\n")[0]!);
  expect(header).toMatchObject({ type: "session", version: 3, id: item.sessionId });
  expect(item.sessionId).toBe(details.run.sessionId);
  const manager = SessionManager.open(file);
  expect(manager.getSessionId()).toBe(item.sessionId);
  return { file, manager };
}

async function scriptedRegisteredFixture(name: string, childSteps: (options: Parameters<RunnerDependencies["createAgentSession"]>[0]) => ScriptStep[], rename = false, standalone = false) {
  const output = process.env.SUBMARINE_ARTIFACT_OUTPUT;
  if (output) await mkdir(output, { recursive: true });
  const root = output ? await mkdtemp(path.join(output, `${name}-`)) : await tempRoot();
  const sdkVersion = JSON.parse(await readFile(new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url), "utf8")).version;
  expect(sdkVersion).toBe("1.3.0");
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const model = getModel("anthropic", "claude-opus-4-5");
  await writeFile(path.join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "scripted-never-sent" } }));
  const parentManager = SessionManager.create(cwd, path.join(root, "sessions"));
  const observedChildren: AgentSession[] = [];
  let beforeChildResponse: (() => void) | undefined;
  const extension = (pi: ExtensionAPI) => {
    if (!rename) return register(pi);
    register(new Proxy(pi, { get(target, property) {
      if (property === "registerTool") return (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => target.registerTool({ ...tool, name: tool.name === "subagent" ? "delegate_work" : tool.name });
      return Reflect.get(target, property);
    } }));
  };
  const deps: Partial<RunnerDependencies> = {
    getAgentDir: () => agentDir,
    createResourceLoader: (options) => new DefaultResourceLoader({
      ...options, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
    }),
    createAgentSession: async (options) => {
      const steps = childSteps(options);
      const created = await createAgentSession({ ...options, settingsManager, tools: ["subagent", "subagent_resume", "subagent_list"] });
      scriptSession(created.session, steps, () => beforeChildResponse?.());
      observedChildren.push(created.session);
      return created;
    },
  };
  const originalRun = runner.runSubagent;
  const originalResume = runner.runSubagentResume;
  vi.spyOn(runner, "runSubagent").mockImplementation((params, signal, update, ctx, options) => originalRun(params, signal, update, ctx, { ...options, deps }));
  vi.spyOn(runner, "runSubagentResume").mockImplementation((params, signal, update, ctx, options) => originalResume(params, signal, update, ctx, { ...options, deps }));
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true, extensionFactories: standalone ? [] : [extension] });
  await resourceLoader.reload();
  const { session: parent } = await createAgentSession({ cwd, agentDir, settingsManager, model, thinkingLevel: "high", resourceLoader, sessionManager: parentManager,
    ...(standalone ? { customTools: [subagentTool, subagentResumeTool] } : {}),
    tools: [rename ? "delegate_work" : "subagent", "subagent_resume", ...(standalone ? [] : ["subagent_list"])] });
  await parent.bindExtensions({ onError: (error) => { throw error; } });
  const events: Extract<AgentSessionEvent, { type: "tool_execution_end" }>[] = [];
  parent.subscribe((event) => { if (event.type === "tool_execution_end") events.push(structuredClone(event)); });
  return {
    root, parent, parentManager, observedChildren, events,
    abortOnChildResponse: () => { beforeChildResponse = () => { void parent.abort(); }; },
    async exportResults() {
      if (!output) return;
      await writeFile(path.join(root, "bundle.json"), JSON.stringify({
        sdkVersion, generation: "Real SDK with offline scripted providers; no network requests.",
        parentSessionFile: parentManager.getSessionFile(), results: toolMessages(parentManager), events,
        childSessionFiles: observedChildren.map((child) => child.sessionFile),
      }, null, 2));
    },
  };
}

describe("Pi SDK integration seam", () => {
  it.each([
    ["fresh", "failed"], ["fresh", "aborted"], ["resume", "failed"], ["resume", "aborted"],
  ] as const)("persists registered %s %s terminal details through real parent tool execution", async (mode, outcome) => {
    const answer = syntheticAssistant(getModel("anthropic", "claude-opus-4-5"));
    let failChild = mode === "fresh";
    const fixture = await scriptedRegisteredFixture(`${mode}-${outcome}`, () => [() => failChild
      ? { ...answer, content: [], stopReason: outcome === "aborted" ? "aborted" : "error", errorMessage: "scripted child failure" }
      : answer]);
    try {
      if (mode === "resume") {
        scriptSession(fixture.parent, [() => toolRequest("subagent", { task: "Save the first turn." }), () => answer]);
        await fixture.parent.prompt("Create the child.");
        failChild = true;
      }
      const first = toolMessages(fixture.parentManager)[0];
      if (outcome === "aborted") fixture.abortOnChildResponse();
      const name = mode === "resume" ? "subagent_resume" : "subagent";
      const args = mode === "resume" ? { sessionId: first!.details!.run.sessionId, message: "Continue the child." } : { task: "Fail the child." };
      scriptSession(fixture.parent, [() => toolRequest(name, args, "terminal-call"), () => answer]);
      await fixture.parent.prompt("Run the failing tool.");
      const message = toolMessages(SessionManager.open(fixture.parentManager.getSessionFile()!)).at(-1)!;
      expect(message.details, JSON.stringify(message)).toHaveProperty("run");
      expect(message.isError).toBe(true);
      expect(message.toolCallId).toBe("terminal-call");
      expect(message.details?.run.status).toBe(outcome);
      expect(message.content).toEqual([{ type: "text", text: outcome === "aborted"
        ? ["## Subagent interrupted", "", "No final answer was produced.", "", `Subagent session ID: ${message.details!.run.sessionId}`, "",
          "If the interrupted task should continue, call `subagent_resume` with this session ID and a message. Otherwise start a new `subagent`.",
          "", "Example for `message`:", "- You were interrupted. Continue the original task from where you left off."].join("\n")
        : ["## Subagent error", "", "scripted child failure", "", `Subagent session ID: ${message.details!.run.sessionId}`, "",
          "This child session may be recoverable. If the same task should continue after a transient failure, call `subagent_resume` with this session ID and a message. Otherwise start a new `subagent`."].join("\n") }]);
      if (outcome === "failed") {
        expect(fixture.parent.getLastAssistantText()).toBe("Synthetic persisted answer.");
        expect(fixture.parent.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
      }
      const saved = await expectExactSave(message.details!);
      expect(fixture.observedChildren.at(-1)?.sessionFile).toBe(saved.file);
      expect(fixture.events.at(-1)?.isError).toBe(true);
      expect(fixture.events.at(-1)?.result.details).toEqual(message.details);
      expect(fixture.events.at(-1)?.result.content).toEqual(message.content);
      if (first) expect(message.details?.savedConversations).toEqual(first.details?.savedConversations);
      await fixture.exportResults();
    } finally {
      fixture.parent.dispose();
    }
  });

  it.each(["fresh", "resume"] as const)("persists standalone customTools %s failures without register()", async (mode) => {
    const answer = syntheticAssistant(getModel("anthropic", "claude-opus-4-5"));
    let failChild = mode === "fresh";
    const fixture = await scriptedRegisteredFixture(`standalone-${mode}`, () => [() => failChild
      ? { ...answer, content: [], stopReason: "error", errorMessage: "standalone child failure" }
      : answer], false, true);
    try {
      let sessionId: string | undefined;
      if (mode === "resume") {
        scriptSession(fixture.parent, [() => toolRequest("subagent", { task: "Save the child." }), () => answer]);
        await fixture.parent.prompt("Create a standalone child.");
        const first = toolMessages(fixture.parentManager)[0]!;
        expect(first.isError).toBe(false);
        sessionId = first.details!.run.sessionId;
        failChild = true;
      }
      scriptSession(fixture.parent, [() => sessionId
        ? toolRequest("subagent_resume", { sessionId, message: "Fail the follow-up." })
        : toolRequest("subagent", { task: "Fail the child." }), () => answer]);
      await fixture.parent.prompt("Run the standalone failure.");
      const message = toolMessages(SessionManager.open(fixture.parent.sessionFile!)).at(-1)!;
      expect(message).toMatchObject({ isError: true, details: { run: { status: "failed" } } });
      expect(message.content).toEqual([{ type: "text", text: ["## Subagent error", "", "standalone child failure", "",
        `Subagent session ID: ${message.details!.run.sessionId}`, "",
        "This child session may be recoverable. If the same task should continue after a transient failure, call `subagent_resume` with this session ID and a message. Otherwise start a new `subagent`."].join("\n") }]);
      const saved = await expectExactSave(message.details!);
      expect(saved.file).toBe(fixture.observedChildren.at(-1)?.sessionFile);
      if (sessionId) expect(message.details!.run.sessionId).toBe(sessionId);
      expect(fixture.events.at(-1)?.isError).toBe(true);
      expect(fixture.events.at(-1)?.result.details).toEqual(message.details);
      expect(fixture.events.at(-1)?.result.content).toEqual(message.content);
      expect(fixture.parent.getLastAssistantText()).toBe("Synthetic persisted answer.");
      await fixture.exportResults();
    } finally {
      fixture.parent.dispose();
    }
  });

  it("persists registered failure metadata for an early materialized child before SDK session creation succeeds", async () => {
    const fixture = await scriptedRegisteredFixture("early-failed", () => { throw new Error("early SDK allocation failure"); });
    try {
      const answer = syntheticAssistant(getModel("anthropic", "claude-opus-4-5"));
      scriptSession(fixture.parent, [() => toolRequest("subagent", { task: "Fail before creating the SDK session." }), () => answer]);
      await fixture.parent.prompt("Run the early failing tool.");
      const message = toolMessages(SessionManager.open(fixture.parentManager.getSessionFile()!))[0]!;
      expect(message.isError).toBe(true);
      expect(message.content).toEqual([{ type: "text", text: expect.stringContaining("early SDK allocation failure") }]);
      expect(message.details?.run.status).toBe("failed");
      const saved = await expectExactSave(message.details!);
      expect(saved.manager.buildSessionContext()).toMatchObject({ messages: [], model: { provider: "anthropic", modelId: "claude-opus-4-5" }, thinkingLevel: "high" });
      expect(fixture.events.at(-1)?.isError).toBe(true);
      expect(fixture.events.at(-1)?.result.details).toEqual(message.details);
      expect(fixture.events.at(-1)?.result.content).toEqual(message.content);
      await fixture.exportResults();
    } finally {
      fixture.parent.dispose();
    }
  });

  it("follows immediate-child links through real nested failed and resumed tool results, including a renamed parent tool", async () => {
    const answer = syntheticAssistant(getModel("anthropic", "claude-opus-4-5"));
    let created = 0;
    const fixture = await scriptedRegisteredFixture("nested", () => {
      created += 1;
      if (created === 1) return [() => toolRequest("subagent", { task: "Create B." }), () => answer];
      if (created === 2) return [
        () => toolRequest("subagent", { task: "Create C and fail." }),
        (messages) => {
          const result = [...messages].reverse().find((message) => message.role === "toolResult") as unknown as SavedToolMessage;
          return toolRequest("subagent_resume", { sessionId: result.details!.run.sessionId, message: "Recover C." }, "resume-C");
        },
        () => answer,
      ];
      if (created === 3) return [() => ({ ...answer, content: [], stopReason: "error", errorMessage: "nested scripted failure" })];
      return [() => answer];
    }, true);
    try {
      scriptSession(fixture.parent, [() => toolRequest("delegate_work", { task: "Create A." }), () => answer]);
      await fixture.parent.prompt("Run a nested delegation.");
      const parentResult = toolMessages(SessionManager.open(fixture.parentManager.getSessionFile()!))[0]!;
      expect(parentResult.details, JSON.stringify(parentResult)).toHaveProperty("run");
      expect(parentResult.isError).toBe(false);
      expect(parentResult.toolName).toBe("delegate_work");
      expect(fixture.events.at(-1)?.isError).toBe(false);
      expect(fixture.events.at(-1)?.result.details).toEqual(parentResult.details);
      expect(fixture.events.at(-1)?.result.content).toEqual(parentResult.content);
      const a = await expectExactSave(parentResult.details!);
      const aResult = toolMessages(a.manager)[0]!;
      expect(aResult.isError).toBe(false);
      const b = await expectExactSave(aResult.details!);
      const bResults = toolMessages(b.manager);
      expect(bResults).toHaveLength(2);
      expect(bResults.map((message) => message.isError)).toEqual([true, false]);
      expect(bResults[0]?.details?.run.status).toBe("failed");
      expect(bResults[1]?.details?.run.status).toBe("completed");
      expect(bResults[0]?.details?.savedConversations).toEqual(bResults[1]?.details?.savedConversations);
      const c = await expectExactSave(bResults[0]!.details!);
      expect([a.file, b.file, c.file]).toEqual(fixture.observedChildren.slice(0, 3).map((session) => session.sessionFile));
      expect(fixture.observedChildren[3]?.sessionFile).toBe(c.file);
      await writeFile(path.join(parentResult.details!.savedConversations!.root, "manifest.jsonl"), "poisoned after emission\n");
      for (const result of [parentResult, aResult, ...bResults]) await expectExactSave(result.details!);
      await fixture.exportResults();
    } finally {
      fixture.parent.dispose();
    }
  });
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
    const result = await runSubagent({ task: "Synthetic child task.", context, ...(agent === undefined ? {} : { agent }) }, undefined, undefined, ctx, { deps });
    expect(observed[0]).toMatchObject({ model, thinkingLevel: "high", messageCount: context === "fork" ? 2 : 0 });
    const child = observed[0]?.session;
    if (!child?.sessionFile) throw new Error("Expected persisted SDK child");
    expect((await expectExactSave(result.details)).file).toBe(child.sessionFile);
    expect(SessionManager.open(child.sessionFile).buildSessionContext()).toMatchObject({
      model: { provider: model.provider, modelId: model.id }, thinkingLevel: "high",
    });

    await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultThinkingLevel: "low" }), "utf8");
    const resumed = await runSubagentResume({ sessionId: result.details.run.sessionId, message: "Synthetic follow-up." }, undefined, undefined,
      { ...ctx, model: historicalModel, thinkingLevel: "off" }, { deps });
    expect(resumed.details.savedConversations).toEqual(result.details.savedConversations);
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
      undefined, undefined, { ...ctx, thinkingLevel: "low" }, { deps });
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
    const interrupted = await runSubagent({ task: "Interrupt before recording a message.", ...(selection === "explicit" ? { model: `${model.provider}/${model.id}@high` } : {}) },
      controller.signal, undefined, { ...ctx, thinkingLevel: selection === "explicit" ? "low" : "high" }, { deps });
    expect(interrupted).toMatchObject({ isError: true, details: { run: { status: "aborted" } } });
    expect(interrupted.content[0]?.text).toContain("Subagent interrupted");
    await expectExactSave(interrupted.details);
    expect(observed[0]).toMatchObject({ model, thinkingLevel: "high", messageCount: 0 });
    const child = observed[0]?.session;
    if (!child?.sessionFile) throw new Error("Expected persisted interrupted SDK child");
    const reopened = SessionManager.open(child.sessionFile);
    expect(reopened.buildSessionContext()).toMatchObject({
      messages: [], model: { provider: model.provider, modelId: model.id }, thinkingLevel: "high",
    });

    interrupt = false;
    await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultThinkingLevel: "low" }), "utf8");
    await runSubagentResume({ sessionId: child.sessionId, message: "Recover the interrupted task." }, undefined, undefined,
      { ...ctx, model: historicalModel, thinkingLevel: "off" }, { deps });
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
