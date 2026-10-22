import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, getDocsPath, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import register from "../src/index.js";
import type { SubagentToolDetails } from "../src/types.js";

const artifactOutput = process.env.SUBMARINE_ARTIFACT_OUTPUT;
const originalEnv = process.env;
const temporaryRoots: string[] = [];

afterEach(async () => {
  process.env = originalEnv;
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(name: string) {
  if (artifactOutput) await mkdir(artifactOutput, { recursive: true });
  const root = await mkdtemp(path.join(artifactOutput ?? tmpdir(), `${name}-`));
  if (!artifactOutput) temporaryRoots.push(root);
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const home = path.join(root, "home");
  await Promise.all([cwd, agentDir, home].map((dir) => mkdir(dir, { recursive: true })));
  process.env = { PATH: originalEnv.PATH ?? "", HOME: home, PI_CODING_AGENT_DIR: agentDir };
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Network forbidden in offline SDK tests"); });
  const connect = vi.spyOn(net.Socket.prototype, "connect").mockImplementation(() => { throw new Error("Socket connection forbidden in offline SDK tests"); });
  const settings = { retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" as const };
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify(settings));
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true, extensionFactories: [register] });
  return { root, cwd, agentDir, settingsManager, resourceLoader, fetch, connect };
}

function savedResults(session: AgentSession) {
  return SessionManager.open(session.sessionFile!).getBranch().flatMap((entry) => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []);
}

async function verifySave(details: SubagentToolDetails, cwd: string) {
  expect(details).not.toHaveProperty("pilish");
  const saved = details.savedConversations!;
  expect(saved).toBeDefined();
  expect(saved.version).toBe(1);
  expect(saved.items).toHaveLength(1);
  const item = saved.items[0];
  expect(item.sessionId).toBe(details.run.sessionId);
  const file = path.join(saved.root, item.file);
  const header = JSON.parse((await readFile(file, "utf8")).split("\n")[0]!);
  expect(header).toMatchObject({ type: "session", version: 3, id: item.sessionId, cwd });
  expect(SessionManager.open(file).getSessionId()).toBe(item.sessionId);
  return file;
}

async function exportResults(root: string, parent: AgentSession, events: AgentSessionEvent[], childFile: string) {
  if (!artifactOutput) return;
  const sdkVersion = JSON.parse(await readFile(new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url), "utf8")).version;
  expect(sdkVersion).toBe("1.3.0");
  await writeFile(path.join(root, "bundle.json"), JSON.stringify({
    sdkVersion, generation: "Native SDK request authentication into an offline provider; no network requests.",
    parentSessionFile: parent.sessionFile, results: savedResults(parent), events, childSessionFiles: [childFile],
  }, null, 2));
}

const startupProvider = `
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { createAssistantMessageEventStream, getCurrentTools } from "@earendil-works/pi-ai";

export default function(pi) {
  pi.registerProvider("submarine-offline", {
    api: "openai-completions",
    streamSimple(model, context, options) {
      assert.equal(model.provider, "submarine-offline");
      assert.equal(model.id, "selected");
      assert.equal(options.apiKey, "stored-dummy-key");
      assert.equal(options.headers["X-Model-Proof"], "stored-model-header");
      assert.equal(options.reasoning, "high");
      const user = context.messages.filter(message => message.role === "user").at(-1);
      const child = JSON.stringify(user.content).includes("<subagent-context>");
      const tools = getCurrentTools(context.messages).map(tool => tool.name);
      if (child) for (const name of ["read", "bash", "edit", "write", "subagent", "subagent_resume"]) assert(tools.includes(name), name);
      const result = context.messages.find(message => message.role === "toolResult");
      appendFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "requests.jsonl"), JSON.stringify({ child, model: model.id, reasoning: options.reasoning, credentialMatched: true, headerMatched: true, tools }) + "\\n");
      const message = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        content: child ? [{ type: "text", text: "Offline child answer." }]
          : result ? [{ type: "text", text: "Parent continued after the child." }]
          : [{ type: "toolCall", id: "normal-auth-call", name: "subagent", arguments: { task: "Verify normal offline configuration." } }],
        stopReason: child || result ? "stop" : "toolUse",
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: message.stopReason, message });
      return stream;
    },
  });
}
`;

describe("normal child SDK model runtime", () => {
  it("loads stored auth and model headers through a child startup provider with inherited context effort", async () => {
    const f = await fixture("normal-auth");
    await mkdir(path.join(f.agentDir, "extensions"));
    await writeFile(path.join(f.agentDir, "extensions", "offline.js"), startupProvider);
    await writeFile(path.join(f.agentDir, "auth.json"), JSON.stringify({ "submarine-offline": { type: "api_key", key: "stored-dummy-key" } }));
    await writeFile(path.join(f.agentDir, "models.json"), JSON.stringify({ providers: {
      "submarine-offline": { api: "openai-completions", baseUrl: "https://never-called.invalid/v1", models: [
        { id: "selected", reasoning: true, thinkingLevelMap: { low: "low", high: "high" }, headers: { "X-Model-Proof": "stored-model-header" } },
      ] },
    } }));
    await f.resourceLoader.reload();
    expect(f.resourceLoader.getExtensions().errors).toEqual([]);
    const runtime = await ModelRuntime.create({ authPath: path.join(f.agentDir, "auth.json"), modelsPath: path.join(f.agentDir, "models.json") });
    const model = runtime.getModel("submarine-offline", "selected");
    expect(model).toBeDefined();
    const { session: parent } = await createAgentSession({ cwd: f.cwd, agentDir: f.agentDir, model: model!, thinkingLevel: "high", settingsManager: f.settingsManager,
      resourceLoader: f.resourceLoader, sessionManager: SessionManager.create(f.cwd, path.join(f.root, "sessions")) });
    const events: Extract<AgentSessionEvent, { type: "tool_execution_end" }>[] = [];
    parent.subscribe((event) => { if (event.type === "tool_execution_end") events.push(structuredClone(event)); });
    try {
      await parent.bindExtensions({ onError: (error) => { throw error; } });
      await parent.prompt("Delegate to a normally configured child.");
      const result = savedResults(parent)[0]!;
      expect(result).toMatchObject({ isError: false, details: { run: { status: "completed" } } });
      const details = result.details as unknown as SubagentToolDetails;
      expect(result.content).toEqual([{ type: "text", text: `## Subagent result\nSubagent session ID: ${details.run.sessionId}\nModel: submarine-offline/selected\n\nOffline child answer.` }]);
      const childFile = await verifySave(details, f.cwd);
      expect(SessionManager.open(childFile).buildSessionContext()).toMatchObject({ model: { provider: "submarine-offline", modelId: "selected" }, thinkingLevel: "high" });
      const requests = (await readFile(path.join(f.agentDir, "requests.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(requests.map((request) => request.child)).toEqual([false, true, false]);
      expect(requests.every((request) => request.credentialMatched && request.headerMatched && request.model === "selected" && request.reasoning === "high")).toBe(true);
      expect(events.at(-1)?.isError).toBe(false);
      expect(events.at(-1)?.result.content).toEqual(result.content);
      expect(events.at(-1)?.result.details).toEqual(result.details);
      expect(parent.getLastAssistantText()).toBe("Parent continued after the child.");
      expect(f.fetch).not.toHaveBeenCalled();
      expect(f.connect).not.toHaveBeenCalled();
      await exportResults(f.root, parent, events, childFile);
    } finally {
      parent.dispose();
    }
  });

  it("does not copy parent-only runtime credentials, providers, or model headers into a normal child", async () => {
    const f = await fixture("parent-only-negative");
    await f.resourceLoader.reload();
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
    let requests = 0;
    runtime.registerProvider("submarine-parent-only", {
      api: "openai-completions", baseUrl: "https://never-called.invalid/v1",
      models: [{ id: "only-in-parent", name: "Parent-only offline model", reasoning: true, thinkingLevelMap: { high: "high" },
        input: ["text"], contextWindow: 64000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        headers: { "X-Parent-Only": "not-copied" } }],
      streamSimple: (model, context, options) => {
        requests += 1;
        expect(model.id).toBe("only-in-parent");
        expect(options?.apiKey).toBe("parent-only-dummy-key");
        expect(options?.headers?.["X-Parent-Only"]).toBe("not-copied");
        expect(options?.reasoning).toBe("high");
        const failed = context.messages.find((message) => message.role === "toolResult");
        const message: AssistantMessage = {
          role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          content: failed ? [{ type: "text", text: "Parent continued after missing child configuration." }]
            : [{ type: "toolCall", id: "parent-only-call", name: "subagent", arguments: { task: "Use parent-only configuration." } }],
          stopReason: failed ? "stop" : "toolUse",
        };
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: failed ? "stop" : "toolUse", message });
        return stream;
      },
    });
    await runtime.setRuntimeApiKey("submarine-parent-only", "parent-only-dummy-key");
    const model = runtime.getModel("submarine-parent-only", "only-in-parent")!;
    const { session: parent } = await createAgentSession({ cwd: f.cwd, agentDir: f.agentDir, modelRuntime: runtime, model, thinkingLevel: "high", settingsManager: f.settingsManager,
      resourceLoader: f.resourceLoader, sessionManager: SessionManager.create(f.cwd, path.join(f.root, "sessions")) });
    const events: Extract<AgentSessionEvent, { type: "tool_execution_end" }>[] = [];
    parent.subscribe((event) => { if (event.type === "tool_execution_end") events.push(structuredClone(event)); });
    try {
      await parent.bindExtensions({ onError: (error) => { throw error; } });
      await parent.prompt("Delegate without copying runtime configuration.");
      const result = savedResults(parent)[0]!;
      expect(result).toMatchObject({ isError: true, details: { run: { status: "failed" } } });
      const details = result.details as unknown as SubagentToolDetails;
      expect(result.content).toEqual([{ type: "text", text: ["## Subagent error", "", "No API key found for submarine-parent-only.", "",
        "Use /login to log into a provider via OAuth or API key. See:",
        `  ${path.join(getDocsPath(), "providers.md")}`, `  ${path.join(getDocsPath(), "models.md")}`, "",
        `Subagent session ID: ${details.run.sessionId}`, "",
        "This child session may be recoverable. If the same task should continue after a transient failure, call `subagent_resume` with this session ID and a message. Otherwise start a new `subagent`."].join("\n") }]);
      const childFile = await verifySave(details, f.cwd);
      const child = SessionManager.open(childFile).buildSessionContext();
      expect(child.model).toEqual({ provider: "submarine-parent-only", modelId: "only-in-parent" });
      expect(child.thinkingLevel).toBe("high");
      expect(child.messages.filter((message) => message.role === "assistant")).toEqual([]);
      expect(requests).toBe(2);
      expect(events.at(-1)?.isError).toBe(true);
      expect(events.at(-1)?.result.content).toEqual(result.content);
      expect(events.at(-1)?.result.details).toEqual(result.details);
      expect(parent.getLastAssistantText()).toBe("Parent continued after missing child configuration.");
      expect(f.fetch).not.toHaveBeenCalled();
      expect(f.connect).not.toHaveBeenCalled();
      await exportResults(f.root, parent, events, childFile);
    } finally {
      parent.dispose();
    }
  });
});
