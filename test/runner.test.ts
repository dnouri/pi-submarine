import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager, SettingsManager, type AgentSession, type AgentSessionEvent, type ExtensionContext, type ResourceLoader } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readManifestRecords } from "../src/manifest.js";
import { runSubagent, runSubagentResume } from "../src/runner.js";
import type { SubagentContextUsage } from "../src/types.js";

const tempRoots: string[] = [];

async function tempRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "pi-submarine-runner-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class FakeSessionManager {
  constructor(private readonly sessionFile: string | undefined, private readonly cwd: string, private readonly leafId: string | null = "leaf-1") {}
  getSessionFile() { return this.sessionFile; }
  getCwd() { return this.cwd; }
  getLeafId() { return this.leafId; }
}

function fakeContext(cwd: string, sessionFile?: string, options: { leafId?: string | null; model?: unknown } = {}): ExtensionContext {
  return {
    cwd,
    sessionManager: new FakeSessionManager(sessionFile, cwd, options.leafId),
    modelRegistry: {},
    model: options.model,
  } as unknown as ExtensionContext;
}

function expectSubagentResult(
  result: { content: Array<{ text: string }>; details: { run: { sessionId: string } } },
  heading = "## Subagent result",
  answer = "child answer",
): void {
  const sessionId = result.details.run.sessionId;
  expect(sessionId).toEqual(expect.any(String));
  expect(sessionId).not.toBe("");
  expect(result.content[0]?.text).toBe(`${heading}\nSubagent session ID: ${sessionId}\n\n${answer}`);
}

async function rejectedMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(Error);
    return (error as Error).message;
  }
  throw new Error("Expected promise to reject.");
}

function expectNoModelVisiblePaths(text: string): void {
  expect(text).not.toMatch(/\.jsonl|\.subagents|subagents\.live\.md|Activity log|stack|runId|episodeId/i);
}

function expectInterruptedCapsule(text: string, sessionId: string, heading = "## Subagent interrupted"): void {
  expect(text).toContain(heading);
  expect(text).toContain("No final answer was produced.");
  expect(text).toContain(`Subagent session ID: ${sessionId}`);
  expect(text).toContain("call `subagent_resume` with this session ID");
  expect(text).toContain("You were interrupted. Continue work exactly where you left off.");
  expect(text).toContain("Good. Now also check the edge cases you mentioned and update your recommendation.");
  expect(text).toContain("Please summarize what you did so far for a handoff so we can continue later.");
  expectNoModelVisiblePaths(text);
}

function expectRecoverableFailure(text: string, sessionId: string, originalMessage: string, heading = "## Subagent error"): void {
  expect(text).toContain(heading);
  expect(text).toContain(originalMessage);
  expect(text).toContain(`Subagent session ID: ${sessionId}`);
  expect(text).toContain("This child session may be resumable.");
  expect(text).toContain("call `subagent_resume` with this session ID and a message.");
  expect(text).not.toContain("No final answer was produced.");
  expect(text).not.toContain("Examples for `message`:");
  expectNoModelVisiblePaths(text);
}

function expectNoRecoveryHandle(text: string): void {
  expect(text).not.toContain("Subagent session ID:");
  expect(text).not.toContain("may be resumable");
  expect(text).not.toContain("call `subagent_resume`");
}

function expectProjectTrustedSettingsManager(value: unknown): void {
  expect(value).toMatchObject({ isProjectTrusted: expect.any(Function) });
  expect((value as { isProjectTrusted: () => boolean }).isProjectTrusted()).toBe(true);
}

async function writeChildSessionHeader(sessionFile: string, sessionId: string, cwd: string): Promise<void> {
  await mkdir(path.dirname(sessionFile), { recursive: true });
  await writeFile(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd })}\n`, "utf8");
}

async function writeManifestRecord(parentSession: string, record: Record<string, unknown>): Promise<void> {
  await writeManifestRecords(parentSession, [record]);
}

async function writeManifestRecords(parentSession: string, records: Array<Record<string, unknown>>): Promise<void> {
  const manifest = path.join(`${parentSession}.subagents`, "manifest.jsonl");
  await mkdir(path.dirname(manifest), { recursive: true });
  await writeFile(manifest, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
}

function startedManifestRecord(input: {
  episodeId?: string;
  sessionId: string;
  parentEpisodeId?: string | null;
  agent?: string;
  cwd: string;
  context?: "fresh" | "fork";
  sessionFile: string;
  activityLog?: string;
  agentFile?: string | null;
}): Record<string, unknown> {
  return {
    type: "started",
    episodeId: input.episodeId ?? "run-1",
    sessionId: input.sessionId,
    parentEpisodeId: input.parentEpisodeId ?? null,
    agent: input.agent ?? "subagent",
    cwd: input.cwd,
    context: input.context ?? "fresh",
    sessionFile: input.sessionFile,
    activityLog: input.activityLog ?? path.join(path.dirname(input.sessionFile), "subagents.live.md"),
    agentFile: input.agentFile ?? null,
    startedAt: "2026-01-01T00:00:00.000Z",
  };
}

function event(value: Record<string, unknown>): AgentSessionEvent {
  return value as unknown as AgentSessionEvent;
}

class FakeForkSessionManager {
  public branchedFrom: string | undefined;

  constructor(
    private readonly cwd: string,
    private sessionFile: string,
    private readonly childSessionFile: string = path.join(`${sessionFile}.subagents`, "fork-child.jsonl"),
    private readonly branchError?: Error,
  ) {}

  getSessionFile() { return this.sessionFile; }
  getCwd() { return this.cwd; }
  getSessionId() { return `session:${path.basename(this.sessionFile)}`; }
  getLeafId() { return this.branchedFrom ?? "fork-leaf"; }
  getBranch() { return []; }

  createBranchedSession(leafId: string) {
    this.branchedFrom = leafId;
    if (this.branchError) throw this.branchError;
    this.sessionFile = this.childSessionFile;
    return this.childSessionFile;
  }
}

interface FakeChildSessionOptions {
  lastAssistantText?: string;
  initialMessages?: unknown[];
  messages?: unknown[];
  promptImpl?: (text: string) => Promise<void>;
  bindImpl?: () => Promise<void>;
  abortImpl?: () => Promise<void>;
  unsubscribeImpl?: () => void;
  disposeImpl?: () => void;
  events?: AgentSessionEvent[];
  contextUsage?: SubagentContextUsage;
  getContextUsageImpl?: () => SubagentContextUsage | undefined;
}

function fakeDeps(root: string, session?: FakeChildSessionOptions) {
  const fakeSession = new FakeChildSession(session);
  return {
    fakeSession,
    deps: {
      now: vi.fn()
        .mockReturnValueOnce("2026-01-01T00:00:00.000Z")
        .mockReturnValue("2026-01-01T00:01:00.000Z"),
      createEpisodeId: vi.fn(() => "run-1"),
      getAgentDir: vi.fn(() => path.join(root, "agent")),
      createFreshSessionManager: vi.fn((cwd: string, subagentsDir: string) => SessionManager.create(cwd, subagentsDir)),
      openSessionManager: vi.fn((sessionFile: string, subagentsDir: string) => SessionManager.open(sessionFile, subagentsDir)),
      createResourceLoader: vi.fn(() => ({
        reload: vi.fn(async () => undefined),
        getExtensions: vi.fn(),
        getSkills: vi.fn(),
        getPrompts: vi.fn(),
        getThemes: vi.fn(),
        getAgentsFiles: vi.fn(),
        getSystemPrompt: vi.fn(),
        getAppendSystemPrompt: vi.fn(),
        extendResources: vi.fn(),
      } as unknown as ResourceLoader)),
      createAgentSession: vi.fn(async () => ({ session: fakeSession as unknown as AgentSession })),
    },
  };
}

class FakeChildSession {
  public promptedWith: string | undefined;
  public aborted = false;
  public disposed = false;
  public unsubscribed = false;
  public promptCount = 0;
  public abortCount = 0;
  public disposeCount = 0;
  public unsubscribeCount = 0;
  public contextUsageCallCount = 0;
  public messages: unknown[] = [];
  private readonly lastAssistantText: string | undefined;
  private readonly promptImpl: (text: string) => Promise<void>;
  private readonly bindImpl: () => Promise<void>;
  private readonly abortImpl: () => Promise<void>;
  private readonly unsubscribeImpl: () => void;
  private readonly disposeImpl: () => void;
  private readonly getContextUsageImpl: () => SubagentContextUsage | undefined;
  private readonly events: AgentSessionEvent[];
  private readonly messagesAfterPrompt: unknown[];
  private listeners: Array<(event: AgentSessionEvent) => void> = [];

  constructor(options: FakeChildSessionOptions = {}) {
    this.lastAssistantText = options.lastAssistantText ?? "child answer";
    this.messages = [...(options.initialMessages ?? [])];
    this.messagesAfterPrompt = options.messages ?? [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: this.lastAssistantText }] }];
    this.promptImpl = options.promptImpl ?? (async () => undefined);
    this.bindImpl = options.bindImpl ?? (async () => undefined);
    this.abortImpl = options.abortImpl ?? (async () => undefined);
    this.unsubscribeImpl = options.unsubscribeImpl ?? (() => undefined);
    this.disposeImpl = options.disposeImpl ?? (() => undefined);
    this.getContextUsageImpl = options.getContextUsageImpl ?? (() => options.contextUsage);
    this.events = options.events ?? [];
  }

  async prompt(text: string) {
    this.promptCount += 1;
    this.promptedWith = text;
    for (const event of this.events) this.emit(event);
    await this.promptImpl(text);
    this.messages.push(...this.messagesAfterPrompt);
  }

  emit(event: AgentSessionEvent) {
    for (const listener of this.listeners) listener(event);
  }

  getLastAssistantText() {
    return this.lastAssistantText;
  }

  getContextUsage() {
    this.contextUsageCallCount += 1;
    return this.getContextUsageImpl();
  }

  subscribe(listener: (event: AgentSessionEvent) => void) {
    this.listeners.push(listener);
    return () => {
      this.unsubscribeCount += 1;
      this.unsubscribed = true;
      this.unsubscribeImpl();
      this.listeners = this.listeners.filter((candidate) => candidate !== listener);
    };
  }

  async bindExtensions() {
    await this.bindImpl();
  }

  async abort() {
    this.abortCount += 1;
    this.aborted = true;
    await this.abortImpl();
  }

  dispose() {
    this.disposeCount += 1;
    this.disposed = true;
    this.disposeImpl();
  }
}

describe("subagent runner", () => {
  it("requires a persisted parent session before executing", async () => {
    const root = await tempRoot();
    const { deps } = fakeDeps(root);

    await expect(runSubagent({ task: "hello" }, undefined, undefined, fakeContext(root), { deps })).rejects.toThrow("requires a persisted parent Pi session");
  });

  it("resumes a completed child session by opening the recorded session file and prompting with the follow-up message", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const childSession = path.join(`${parentSession}.subagents`, "child.jsonl");
    await writeChildSessionHeader(childSession, "child-session-1", cwd);
    await writeManifestRecord(parentSession, startedManifestRecord({ sessionId: "child-session-1", cwd, sessionFile: childSession }));
    const { deps, fakeSession } = fakeDeps(root);
    deps.createEpisodeId = vi.fn(() => "resume-1");

    const result = await runSubagentResume({ sessionId: "child-session-1", message: "continue from there" }, undefined, undefined, fakeContext(cwd, parentSession), { deps });

    expect(deps.openSessionManager).toHaveBeenCalledWith(childSession, `${parentSession}.subagents`);
    expect(deps.createFreshSessionManager).not.toHaveBeenCalled();
    expect(fakeSession.promptedWith).toBe("continue from there");
    expectSubagentResult(result);
    expect(result.details.run).toMatchObject({ episodeId: "resume-1", sessionId: "child-session-1", agent: "subagent", status: "completed" });
    const activityText = await readFile(path.join(`${parentSession}.subagents`, "subagents.live.md"), "utf8");
    expect(activityText).toContain("started subagent — episode resume-1 — session:");
    expect(activityText).toContain("completed subagent — 0 turns — session:");
    const manifest = await readManifestRecords(`${parentSession}.subagents/manifest.jsonl`);
    expect(manifest).toEqual([
      expect.objectContaining({ type: "started", episodeId: "run-1", sessionId: "child-session-1" }),
      expect.objectContaining({ type: "resume_started", episodeId: "resume-1", sessionId: "child-session-1", parentEpisodeId: null, sessionFile: childSession }),
      expect.objectContaining({ type: "resume_finished", episodeId: "resume-1", sessionId: "child-session-1", status: "completed" }),
    ]);
    expectNoModelVisiblePaths(result.content[0]?.text ?? "");
  });

  it("records repeated resumes of one child session as distinct lifecycle episodes", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const childSession = path.join(`${parentSession}.subagents`, "child.jsonl");
    await writeChildSessionHeader(childSession, "repeat-session", cwd);
    await writeManifestRecord(parentSession, startedManifestRecord({ sessionId: "repeat-session", cwd, sessionFile: childSession }));

    const first = fakeDeps(root, { lastAssistantText: "first follow-up" });
    first.deps.createEpisodeId = vi.fn(() => "resume-1");
    const firstResult = await runSubagentResume({ sessionId: "repeat-session", message: "continue once" }, undefined, undefined, fakeContext(cwd, parentSession), { deps: first.deps });

    const second = fakeDeps(root, { lastAssistantText: "second follow-up" });
    second.deps.createEpisodeId = vi.fn(() => "resume-2");
    const secondResult = await runSubagentResume({ sessionId: "repeat-session", message: "continue twice" }, undefined, undefined, fakeContext(cwd, parentSession), { deps: second.deps });

    expect(firstResult.details.run).toMatchObject({ episodeId: "resume-1", sessionId: "repeat-session", status: "completed" });
    expect(secondResult.details.run).toMatchObject({ episodeId: "resume-2", sessionId: "repeat-session", status: "completed" });
    const manifest = await readManifestRecords(`${parentSession}.subagents/manifest.jsonl`);
    expect(manifest).toEqual([
      expect.objectContaining({ type: "started", episodeId: "run-1", sessionId: "repeat-session" }),
      expect.objectContaining({ type: "resume_started", episodeId: "resume-1", sessionId: "repeat-session" }),
      expect.objectContaining({ type: "resume_finished", episodeId: "resume-1", sessionId: "repeat-session", status: "completed" }),
      expect.objectContaining({ type: "resume_started", episodeId: "resume-2", sessionId: "repeat-session" }),
      expect.objectContaining({ type: "resume_finished", episodeId: "resume-2", sessionId: "repeat-session", status: "completed" }),
    ]);
  });

  it("resumes child sessions after failed or aborted terminal records when the session file is valid", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const cases = ["failed", "aborted"] as const;

    for (const status of cases) {
      const parentSession = path.join(root, "sessions", `${status}-parent.jsonl`);
      const childSession = path.join(`${parentSession}.subagents`, "child.jsonl");
      const sessionId = `${status}-session`;
      await writeChildSessionHeader(childSession, sessionId, cwd);
      await writeManifestRecords(parentSession, [
        startedManifestRecord({ episodeId: `${status}-run`, sessionId, cwd, sessionFile: childSession }),
        { type: "finished", episodeId: `${status}-run`, status, finishedAt: "2026-01-01T00:01:00.000Z", error: `${status} before resume` },
      ]);
      const { deps } = fakeDeps(root);
      deps.createEpisodeId = vi.fn(() => `${status}-resume`);

      const result = await runSubagentResume({ sessionId, message: `continue ${status}` }, undefined, undefined, fakeContext(cwd, parentSession), { deps });

      expectSubagentResult(result);
      expect(result.details.run).toMatchObject({ episodeId: `${status}-resume`, sessionId, status: "completed" });
      const manifest = await readManifestRecords(`${parentSession}.subagents/manifest.jsonl`);
      expect(manifest).toEqual([
        expect.objectContaining({ type: "started", episodeId: `${status}-run`, sessionId }),
        expect.objectContaining({ type: "finished", episodeId: `${status}-run`, status }),
        expect.objectContaining({ type: "resume_started", episodeId: `${status}-resume`, sessionId }),
        expect.objectContaining({ type: "resume_finished", episodeId: `${status}-resume`, sessionId, status: "completed" }),
      ]);
    }
  });

  it("does not resolve a resume session ID from another parent root", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const currentParentSession = path.join(root, "sessions", "current.jsonl");
    const otherParentSession = path.join(root, "sessions", "other.jsonl");
    const otherChildSession = path.join(`${otherParentSession}.subagents`, "child.jsonl");
    await writeChildSessionHeader(otherChildSession, "child-session-1", cwd);
    await writeManifestRecord(otherParentSession, startedManifestRecord({ sessionId: "child-session-1", cwd, sessionFile: otherChildSession }));
    const { deps } = fakeDeps(root);

    const message = await rejectedMessage(runSubagentResume({ sessionId: "child-session-1", message: "continue" }, undefined, undefined, fakeContext(cwd, currentParentSession), { deps }));

    expect(message).toContain("No subagent session found for session ID 'child-session-1' in the current parent/root session.");
    expectNoRecoveryHandle(message);
    expect(deps.openSessionManager).not.toHaveBeenCalled();
  });

  it("fails clearly before opening when the recorded child session file is missing", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const childSession = path.join(`${parentSession}.subagents`, "missing-child.jsonl");
    await writeManifestRecord(parentSession, startedManifestRecord({ sessionId: "missing-session", cwd, sessionFile: childSession }));
    const { deps } = fakeDeps(root);

    const message = await rejectedMessage(runSubagentResume({ sessionId: "missing-session", message: "continue" }, undefined, undefined, fakeContext(cwd, parentSession), { deps }));

    expect(message).toContain("Subagent session 'missing-session' is recorded, but its child session file is missing.");
    expectNoRecoveryHandle(message);
    expect(deps.openSessionManager).not.toHaveBeenCalled();
  });

  it("fails clearly before opening when the child session header does not match the requested session ID", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const childSession = path.join(`${parentSession}.subagents`, "child.jsonl");
    await writeChildSessionHeader(childSession, "different-session", cwd);
    await writeManifestRecord(parentSession, startedManifestRecord({ sessionId: "expected-session", cwd, sessionFile: childSession }));
    const { deps } = fakeDeps(root);

    await expect(runSubagentResume({ sessionId: "expected-session", message: "continue" }, undefined, undefined, fakeContext(cwd, parentSession), { deps })).rejects.toThrow("Recorded subagent session ID 'expected-session' does not match the child session header ID 'different-session'.");

    expect(deps.openSessionManager).not.toHaveBeenCalled();
  });

  it("rejects manifest records that point outside the current subagents root", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const outsideChildSession = path.join(root, "other-root", "child.jsonl");
    await writeChildSessionHeader(outsideChildSession, "outside-session", cwd);
    await writeManifestRecord(parentSession, startedManifestRecord({ sessionId: "outside-session", cwd, sessionFile: outsideChildSession }));
    const { deps } = fakeDeps(root);

    await expect(runSubagentResume({ sessionId: "outside-session", message: "continue" }, undefined, undefined, fakeContext(cwd, parentSession), { deps })).rejects.toThrow("Subagent session 'outside-session' points outside the current parent/root subagents directory.");

    expect(deps.openSessionManager).not.toHaveBeenCalled();
  });

  it("rejects child session files whose header cwd disagrees with the manifest", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    const otherCwd = path.join(root, "other-project");
    await mkdir(cwd, { recursive: true });
    await mkdir(otherCwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const childSession = path.join(`${parentSession}.subagents`, "child.jsonl");
    await writeChildSessionHeader(childSession, "cwd-mismatch-session", otherCwd);
    await writeManifestRecord(parentSession, startedManifestRecord({ sessionId: "cwd-mismatch-session", cwd, sessionFile: childSession }));
    const { deps } = fakeDeps(root);

    await expect(runSubagentResume({ sessionId: "cwd-mismatch-session", message: "continue" }, undefined, undefined, fakeContext(cwd, parentSession), { deps })).rejects.toThrow("Subagent session 'cwd-mismatch-session' has a child session cwd that does not match its manifest record.");

    expect(deps.openSessionManager).not.toHaveBeenCalled();
  });

  it("rejects manifest records with activity logs outside the current subagents root", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const childSession = path.join(`${parentSession}.subagents`, "child.jsonl");
    await writeChildSessionHeader(childSession, "bad-log-session", cwd);
    await writeManifestRecord(parentSession, startedManifestRecord({
      sessionId: "bad-log-session",
      cwd,
      sessionFile: childSession,
      activityLog: path.join(root, "elsewhere", "subagents.live.md"),
    }));
    const { deps } = fakeDeps(root);

    await expect(runSubagentResume({ sessionId: "bad-log-session", message: "continue" }, undefined, undefined, fakeContext(cwd, parentSession), { deps })).rejects.toThrow("Subagent session 'bad-log-session' has an invalid activity-log manifest path.");

    expect(deps.openSessionManager).not.toHaveBeenCalled();
  });

  it("does not return a stale previous assistant answer when resume produces no new assistant", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const childSession = path.join(`${parentSession}.subagents`, "child.jsonl");
    await writeChildSessionHeader(childSession, "stale-answer-session", cwd);
    await writeManifestRecord(parentSession, startedManifestRecord({ sessionId: "stale-answer-session", cwd, sessionFile: childSession }));
    const { deps } = fakeDeps(root, {
      initialMessages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "old answer" }] }],
      messages: [],
      lastAssistantText: "old answer",
    });

    const message = await rejectedMessage(runSubagentResume({ sessionId: "stale-answer-session", message: "extension command with no assistant" }, undefined, undefined, fakeContext(cwd, parentSession), { deps }));

    expectRecoverableFailure(message, "stale-answer-session", "Child subagent finished without a new assistant response.");
  });

  it("rejects resume while the original child session is still active", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const abortController = new AbortController();
    const { deps, fakeSession } = fakeDeps(root, {
      promptImpl: async () => new Promise<void>(() => undefined),
    });
    const running = runSubagent({ task: "stay active" }, abortController.signal, undefined, fakeContext(cwd, parentSession), { deps });
    await vi.waitFor(() => expect(fakeSession.promptCount).toBe(1));
    const manifest = await readManifestRecords(`${parentSession}.subagents/manifest.jsonl`);
    const sessionId = manifest[0]?.type === "started" ? manifest[0].sessionId : "";

    await expect(runSubagentResume({ sessionId, message: "continue concurrently" }, undefined, undefined, fakeContext(cwd, parentSession), { deps })).rejects.toThrow(`Subagent session '${sessionId}' is already active`);

    abortController.abort();
    expectInterruptedCapsule(await rejectedMessage(running), sessionId);
  });

  it("rejects a second resume while the first resume is still active", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const childSession = path.join(`${parentSession}.subagents`, "child.jsonl");
    await writeChildSessionHeader(childSession, "active-resume-session", cwd);
    await writeManifestRecord(parentSession, startedManifestRecord({ sessionId: "active-resume-session", cwd, sessionFile: childSession }));
    const abortController = new AbortController();
    const { deps, fakeSession } = fakeDeps(root, {
      promptImpl: async () => new Promise<void>(() => undefined),
    });

    const running = runSubagentResume({ sessionId: "active-resume-session", message: "first" }, abortController.signal, undefined, fakeContext(cwd, parentSession), { deps });
    await vi.waitFor(() => expect(fakeSession.promptCount).toBe(1));

    await expect(runSubagentResume({ sessionId: "active-resume-session", message: "second" }, undefined, undefined, fakeContext(cwd, parentSession), { deps })).rejects.toThrow("Subagent session 'active-resume-session' is already active");

    abortController.abort();
    expectInterruptedCapsule(await rejectedMessage(running), "active-resume-session");
  });

  it("records a failed resume activity entry when child session creation fails", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const childSession = path.join(`${parentSession}.subagents`, "child.jsonl");
    await writeChildSessionHeader(childSession, "resume-create-failure-session", cwd);
    await writeManifestRecord(parentSession, startedManifestRecord({ sessionId: "resume-create-failure-session", cwd, sessionFile: childSession }));
    const { deps } = fakeDeps(root);
    deps.createEpisodeId = vi.fn(() => "resume-1");
    deps.createAgentSession = vi.fn(async () => { throw new Error("sdk resume session failed"); });

    const message = await rejectedMessage(runSubagentResume({ sessionId: "resume-create-failure-session", message: "continue" }, undefined, undefined, fakeContext(cwd, parentSession), { deps }));

    expectRecoverableFailure(message, "resume-create-failure-session", "sdk resume session failed");
    const activityText = await readFile(path.join(`${parentSession}.subagents`, "subagents.live.md"), "utf8");
    expect(activityText).toContain("started subagent — episode resume-1 — session:");
    expect(activityText).toContain("failed subagent — 0 turns — error: sdk resume session failed — session:");
    const manifest = await readManifestRecords(`${parentSession}.subagents/manifest.jsonl`);
    expect(manifest.at(-1)).toMatchObject({ type: "resume_finished", episodeId: "resume-1", sessionId: "resume-create-failure-session", status: "failed" });
  });

  it("materializes a resume follow-up when a header-only child fails before producing an assistant message", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const childSession = path.join(`${parentSession}.subagents`, "child.jsonl");
    await writeChildSessionHeader(childSession, "header-only-resume-session", cwd);
    await writeManifestRecord(parentSession, startedManifestRecord({ sessionId: "header-only-resume-session", cwd, sessionFile: childSession }));
    const { deps } = fakeDeps(root);
    deps.createEpisodeId = vi.fn(() => "resume-1");
    deps.createAgentSession = vi.fn(async (options: { sessionManager: SessionManager }) => ({
      session: new FakeChildSession({
        promptImpl: async (text) => {
          options.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() } as Parameters<SessionManager["appendMessage"]>[0]);
          throw new Error("resume model failed before assistant");
        },
      }) as unknown as AgentSession,
    }));

    const message = await rejectedMessage(runSubagentResume({ sessionId: "header-only-resume-session", message: "preserve this follow-up" }, undefined, undefined, fakeContext(cwd, parentSession), { deps }));

    expectRecoverableFailure(message, "header-only-resume-session", "resume model failed before assistant");
    const childText = await readFile(childSession, "utf8");
    expect(childText).toContain('"role":"user"');
    expect(childText).toContain("preserve this follow-up");
  });

  it("recreates the aggregate activity-log header before appending resume activity", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const childSession = path.join(`${parentSession}.subagents`, "child.jsonl");
    await writeChildSessionHeader(childSession, "missing-log-header-session", cwd);
    await writeManifestRecord(parentSession, startedManifestRecord({ sessionId: "missing-log-header-session", cwd, sessionFile: childSession }));
    const { deps } = fakeDeps(root);
    deps.createEpisodeId = vi.fn(() => "resume-1");

    await runSubagentResume({ sessionId: "missing-log-header-session", message: "continue" }, undefined, undefined, fakeContext(cwd, parentSession), { deps });

    const activityText = await readFile(path.join(`${parentSession}.subagents`, "subagents.live.md"), "utf8");
    expect(activityText).toMatch(/^# Subagents\n/);
    expect(activityText).toContain("started subagent — episode resume-1 — session:");
  });

  it("keeps the nesting-depth guard when a deeply nested session tries to resume another child", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const subagentsDir = `${parentSession}.subagents`;
    const nestedSession = path.join(subagentsDir, "level-4.jsonl");
    const targetSession = path.join(subagentsDir, "target.jsonl");
    await mkdir(subagentsDir, { recursive: true });
    await writeFile(path.join(subagentsDir, "manifest.jsonl"), [
      JSON.stringify(startedManifestRecord({ episodeId: "run-a", sessionId: "session-a", parentEpisodeId: null, agent: "subagent", cwd, sessionFile: path.join(subagentsDir, "level-1.jsonl") })),
      JSON.stringify(startedManifestRecord({ episodeId: "run-b", sessionId: "session-b", parentEpisodeId: "run-a", agent: "subagent", cwd, sessionFile: path.join(subagentsDir, "level-2.jsonl") })),
      JSON.stringify(startedManifestRecord({ episodeId: "run-c", sessionId: "session-c", parentEpisodeId: "run-b", agent: "subagent", cwd, sessionFile: path.join(subagentsDir, "level-3.jsonl") })),
      JSON.stringify(startedManifestRecord({ episodeId: "run-d", sessionId: "session-d", parentEpisodeId: "run-c", agent: "subagent", cwd, sessionFile: nestedSession })),
      JSON.stringify(startedManifestRecord({ episodeId: "target-run", sessionId: "target-session", parentEpisodeId: null, agent: "subagent", cwd, sessionFile: targetSession })),
      "",
    ].join("\n"), "utf8");
    const { deps } = fakeDeps(root);

    await expect(runSubagentResume({ sessionId: "target-session", message: "continue" }, undefined, undefined, fakeContext(cwd, nestedSession), { deps })).rejects.toThrow("Subagent nesting limit exceeded");

    expect(deps.openSessionManager).not.toHaveBeenCalled();
  });

  it("counts resumed sessions under the current caller depth for nested delegation", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const subagentsDir = `${parentSession}.subagents`;
    const currentNestedSession = path.join(subagentsDir, "level-3.jsonl");
    const targetSession = path.join(subagentsDir, "target.jsonl");
    await writeChildSessionHeader(targetSession, "target-session", cwd);
    await mkdir(subagentsDir, { recursive: true });
    await writeFile(path.join(subagentsDir, "manifest.jsonl"), [
      JSON.stringify(startedManifestRecord({ episodeId: "run-a", sessionId: "session-a", parentEpisodeId: null, cwd, sessionFile: path.join(subagentsDir, "level-1.jsonl") })),
      JSON.stringify(startedManifestRecord({ episodeId: "run-b", sessionId: "session-b", parentEpisodeId: "run-a", cwd, sessionFile: path.join(subagentsDir, "level-2.jsonl") })),
      JSON.stringify(startedManifestRecord({ episodeId: "run-c", sessionId: "session-c", parentEpisodeId: "run-b", cwd, sessionFile: currentNestedSession })),
      JSON.stringify(startedManifestRecord({ episodeId: "target-run", sessionId: "target-session", parentEpisodeId: null, cwd, sessionFile: targetSession })),
      "",
    ].join("\n"), "utf8");
    const nested = fakeDeps(root, { lastAssistantText: "inner" });
    nested.deps.createEpisodeId = vi.fn(() => "inner-run");
    const resume = fakeDeps(root, {
      promptImpl: async () => {
        await runSubagent({ task: "inner" }, undefined, undefined, fakeContext(cwd, targetSession), { deps: nested.deps });
      },
    });
    resume.deps.createEpisodeId = vi.fn(() => "resume-1");

    await expect(runSubagentResume({ sessionId: "target-session", message: "continue and delegate" }, undefined, undefined, fakeContext(cwd, currentNestedSession), { deps: resume.deps })).rejects.toThrow("Subagent nesting limit exceeded");

    const manifest = await readManifestRecords(path.join(subagentsDir, "manifest.jsonl"));
    expect(manifest).toContainEqual(expect.objectContaining({ type: "resume_started", episodeId: "resume-1", parentEpisodeId: "run-c", sessionId: "target-session" }));
    expect(nested.deps.createFreshSessionManager).not.toHaveBeenCalled();
  });

  it("uses the active resume episode as the parent for nested delegation from a resumed child", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const childSession = path.join(`${parentSession}.subagents`, "child.jsonl");
    await writeChildSessionHeader(childSession, "resumed-child-session", cwd);
    await writeManifestRecord(parentSession, startedManifestRecord({ episodeId: "initial-run", sessionId: "resumed-child-session", cwd, sessionFile: childSession }));
    const nested = fakeDeps(root, { lastAssistantText: "inner answer" });
    nested.deps.createEpisodeId = vi.fn(() => "inner-run");
    const resume = fakeDeps(root, {
      promptImpl: async () => {
        await runSubagent({ task: "inner" }, undefined, undefined, fakeContext(cwd, childSession), { deps: nested.deps });
      },
    });
    resume.deps.createEpisodeId = vi.fn(() => "resume-1");

    const result = await runSubagentResume({ sessionId: "resumed-child-session", message: "continue and delegate" }, undefined, undefined, fakeContext(cwd, parentSession), { deps: resume.deps });

    expectSubagentResult(result);
    const manifest = await readManifestRecords(`${parentSession}.subagents/manifest.jsonl`);
    expect(manifest).toContainEqual(expect.objectContaining({ type: "resume_started", episodeId: "resume-1", sessionId: "resumed-child-session" }));
    expect(manifest).toContainEqual(expect.objectContaining({ type: "started", episodeId: "inner-run", parentEpisodeId: "resume-1", sessionId: expect.any(String) }));
  });

  it("uses runtime resume episode fallback for nested delegation when resume manifest writes degrade", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const childSession = path.join(`${parentSession}.subagents`, "child.jsonl");
    const logger = vi.fn();
    await writeChildSessionHeader(childSession, "degraded-resume-session", cwd);
    await writeManifestRecord(parentSession, startedManifestRecord({ episodeId: "initial-run", sessionId: "degraded-resume-session", cwd, sessionFile: childSession }));
    const nested = fakeDeps(root, { lastAssistantText: "inner answer" });
    nested.deps.createEpisodeId = vi.fn(() => "inner-run");
    const resume = fakeDeps(root, {
      promptImpl: async () => {
        await runSubagent({ task: "inner" }, undefined, undefined, fakeContext(cwd, childSession), { deps: nested.deps });
      },
    });
    resume.deps.createEpisodeId = vi.fn(() => "resume-1");
    Object.assign(resume.deps, { artifactOptions: { manifest: { appendFile: async () => { throw new Error("manifest unavailable"); }, logger } } });

    const result = await runSubagentResume({ sessionId: "degraded-resume-session", message: "continue and delegate" }, undefined, undefined, fakeContext(cwd, parentSession), { deps: resume.deps });

    expectSubagentResult(result);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("Could not append subagent manifest"), expect.any(Error));
    const manifest = await readManifestRecords(`${parentSession}.subagents/manifest.jsonl`);
    expect(manifest).not.toContainEqual(expect.objectContaining({ type: "resume_started", episodeId: "resume-1" }));
    expect(manifest).toContainEqual(expect.objectContaining({ type: "started", episodeId: "inner-run", parentEpisodeId: "resume-1", sessionId: expect.any(String) }));
  });

  it("resumes omitted-agent fresh sessions with fresh resource policy and restored child model state", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const childSession = path.join(`${parentSession}.subagents`, "child.jsonl");
    await writeChildSessionHeader(childSession, "fresh-session", cwd);
    await writeManifestRecord(parentSession, startedManifestRecord({ sessionId: "fresh-session", cwd, context: "fresh", sessionFile: childSession, agentFile: null }));
    const { deps } = fakeDeps(root);
    const createSettingsManager = vi.spyOn(SettingsManager, "create");

    await runSubagentResume({ sessionId: "fresh-session", message: "continue" }, undefined, undefined, fakeContext(cwd, parentSession, { model: { id: "parent-model" } }), { deps });

    const loaderCalls = (deps.createResourceLoader as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls;
    const loaderOptions = loaderCalls[0]?.[0];
    expect(loaderOptions).toMatchObject({ cwd, agentDir: path.join(root, "agent"), noContextFiles: true });
    expect(loaderOptions?.noSkills).toBeUndefined();
    expect(loaderOptions?.skillsOverride).toBeUndefined();
    expect(loaderOptions?.appendSystemPromptOverride).toBeUndefined();

    const sessionCalls = (deps.createAgentSession as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls;
    expect(sessionCalls[0]?.[0]).not.toHaveProperty("model");
    expect(createSettingsManager).toHaveBeenCalledWith(cwd, path.join(root, "agent"), { projectTrusted: true });
    expectProjectTrustedSettingsManager(loaderOptions?.settingsManager);
    expect(sessionCalls[0]?.[0]?.settingsManager).toBe(loaderOptions?.settingsManager);
  });

  it("resumes named fresh sessions by re-resolving the current named agent from the recorded cwd", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    const agentPath = path.join(cwd, ".pi", "agents", "reviewer.md");
    await mkdir(path.dirname(agentPath), { recursive: true });
    await writeFile(agentPath, "---\ndescription: Reviews\nagentsMd: auto\nskills: none\n---\n\nFresh reviewer body.\n", "utf8");
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const childSession = path.join(`${parentSession}.subagents`, "child.jsonl");
    const oldAgentPath = path.join(root, "old-agents", "reviewer.md");
    await writeChildSessionHeader(childSession, "named-fresh-session", cwd);
    await writeManifestRecord(parentSession, startedManifestRecord({ sessionId: "named-fresh-session", agent: "reviewer", cwd, context: "fresh", sessionFile: childSession, agentFile: oldAgentPath }));
    const { deps } = fakeDeps(root);

    const result = await runSubagentResume({ sessionId: "named-fresh-session", message: "continue review" }, undefined, undefined, fakeContext(cwd, parentSession), { deps });

    expectSubagentResult(result, "## Subagent reviewer result");
    const loaderCalls = (deps.createResourceLoader as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls;
    const loaderOptions = loaderCalls[0]?.[0];
    expect(loaderOptions).toMatchObject({ cwd, agentDir: path.join(root, "agent"), noSkills: true });
    expect(loaderOptions?.noContextFiles).toBeUndefined();
    expect((loaderOptions?.appendSystemPromptOverride as (base: string[]) => string[])(["base"])).toEqual(["base", "Fresh reviewer body."]);
    const manifest = await readManifestRecords(`${parentSession}.subagents/manifest.jsonl`);
    expect(manifest).toContainEqual(expect.objectContaining({ type: "resume_started", episodeId: "run-1", sessionId: "named-fresh-session", agentFile: agentPath }));
    expect(manifest).not.toContainEqual(expect.objectContaining({ type: "resume_started", agentFile: oldAgentPath }));
  });

  it("fails clearly when a named fresh resume can no longer resolve its agent", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const childSession = path.join(`${parentSession}.subagents`, "child.jsonl");
    await writeChildSessionHeader(childSession, "missing-agent-session", cwd);
    await writeManifestRecord(parentSession, startedManifestRecord({ sessionId: "missing-agent-session", agent: "reviewer", cwd, context: "fresh", sessionFile: childSession, agentFile: path.join(cwd, ".pi", "agents", "reviewer.md") }));
    const { deps } = fakeDeps(root);

    await expect(runSubagentResume({ sessionId: "missing-agent-session", message: "continue" }, undefined, undefined, fakeContext(cwd, parentSession), { deps })).rejects.toThrow(`Subagent 'reviewer' not found for ${cwd}.`);
  });

  it("resumes fork sessions with raw follow-up text and no fresh resource overrides", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const childSession = path.join(`${parentSession}.subagents`, "fork-child.jsonl");
    await writeChildSessionHeader(childSession, "fork-session", cwd);
    await writeManifestRecord(parentSession, startedManifestRecord({ sessionId: "fork-session", agent: "reviewer", cwd, context: "fork", sessionFile: childSession, agentFile: path.join(cwd, ".pi", "agents", "reviewer.md") }));
    const { deps, fakeSession } = fakeDeps(root);

    const result = await runSubagentResume({ sessionId: "fork-session", message: "plain follow-up" }, undefined, undefined, fakeContext(cwd, parentSession, { model: { id: "parent-model" } }), { deps });

    expect(fakeSession.promptedWith).toBe("plain follow-up");
    expectSubagentResult(result, "## Subagent reviewer result");
    const loaderCalls = (deps.createResourceLoader as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls;
    const loaderOptions = loaderCalls[0]?.[0];
    expect(loaderOptions).toMatchObject({ cwd, agentDir: path.join(root, "agent") });
    expect(loaderOptions?.noContextFiles).toBeUndefined();
    expect(loaderOptions?.noSkills).toBeUndefined();
    expect(loaderOptions?.skillsOverride).toBeUndefined();
    expect(loaderOptions?.appendSystemPromptOverride).toBeUndefined();

    const sessionCalls = (deps.createAgentSession as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls;
    expect(sessionCalls[0]?.[0]).not.toHaveProperty("model");
  });

  it("records aborted resume lifecycle and returns a recovery capsule on parent abort", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const childSession = path.join(`${parentSession}.subagents`, "child.jsonl");
    await writeChildSessionHeader(childSession, "abort-resume-session", cwd);
    await writeManifestRecord(parentSession, startedManifestRecord({ sessionId: "abort-resume-session", cwd, sessionFile: childSession }));
    const abortController = new AbortController();
    const { deps, fakeSession } = fakeDeps(root, {
      promptImpl: async () => new Promise<void>(() => undefined),
    });
    deps.createEpisodeId = vi.fn(() => "resume-1");
    const updates: unknown[] = [];

    const running = runSubagentResume({ sessionId: "abort-resume-session", message: "continue" }, abortController.signal, (partial) => updates.push(partial), fakeContext(cwd, parentSession), { deps });
    await vi.waitFor(() => expect(fakeSession.promptCount).toBe(1));
    abortController.abort();

    const message = await rejectedMessage(running);
    expectInterruptedCapsule(message, "abort-resume-session");
    expect(fakeSession.abortCount).toBe(1);
    expect(fakeSession.unsubscribeCount).toBe(1);
    expect(fakeSession.disposeCount).toBe(1);
    expect(updates.at(-1)).toMatchObject({ details: { run: { episodeId: "resume-1", sessionId: "abort-resume-session", status: "aborted", activity: "interrupted" } } });
    const manifest = await readManifestRecords(`${parentSession}.subagents/manifest.jsonl`);
    expect(manifest.at(-1)).toMatchObject({ type: "resume_finished", episodeId: "resume-1", sessionId: "abort-resume-session", status: "aborted", error: "Interrupted by parent abort." });
  });

  it("does not create a child session for an already-aborted parent signal", async () => {
    const root = await tempRoot();
    const { deps } = fakeDeps(root);
    const abortController = new AbortController();
    abortController.abort();

    await expect(runSubagent({ task: "hello" }, abortController.signal, undefined, fakeContext(root, path.join(root, "parent.jsonl")), { deps })).rejects.toThrow("aborted before child execution");

    expect(deps.createFreshSessionManager).not.toHaveBeenCalled();
  });

  it("fails clearly for missing fresh cwd", async () => {
    const root = await tempRoot();
    const { deps } = fakeDeps(root);

    await expect(runSubagent({ task: "hello", cwd: "missing" }, undefined, undefined, fakeContext(root, path.join(root, "parent.jsonl")), { deps })).rejects.toThrow("cwd does not exist or is not a directory");
  });

  it("explains when explicit cwd hides a named project agent available from the caller cwd", async () => {
    const root = await tempRoot();
    const project = path.join(root, "project");
    const scratch = path.join(root, "scratch", "experiment-1");
    const agentPath = path.join(project, ".pi", "agents", "history.md");
    await mkdir(path.dirname(agentPath), { recursive: true });
    await mkdir(scratch, { recursive: true });
    await writeFile(agentPath, "---\ndescription: Project history\n---\n\nHistory body.\n", "utf8");
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const { deps } = fakeDeps(root);

    let thrown: unknown;
    try {
      await runSubagent({ agent: "history", task: "inspect scratch", cwd: scratch }, undefined, undefined, fakeContext(project, parentSession), { deps });
    } catch (error: unknown) {
      thrown = error;
    }

    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toContain(`Subagent 'history' was not found from explicit cwd:\n${scratch}`);
    expect(message).toContain(`But it is available from the current session cwd:\n${agentPath}`);
    expect(message).toContain("omit cwd");
    expect(deps.createFreshSessionManager).not.toHaveBeenCalled();
  });

  it("rejects nested runs beyond the nesting-depth guard", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const subagentsDir = `${parentSession}.subagents`;
    const nestedSession = path.join(subagentsDir, "level-4.jsonl");
    await mkdir(subagentsDir, { recursive: true });
    await writeFile(path.join(subagentsDir, "manifest.jsonl"), [
      JSON.stringify({ type: "started", episodeId: "run-a", sessionId: "session-a", parentEpisodeId: null, agent: "subagent", cwd, context: "fresh", sessionFile: path.join(subagentsDir, "level-1.jsonl"), activityLog: path.join(subagentsDir, "subagents.live.md"), agentFile: null, startedAt: "now" }),
      JSON.stringify({ type: "started", episodeId: "run-b", sessionId: "session-b", parentEpisodeId: "run-a", agent: "subagent", cwd, context: "fresh", sessionFile: path.join(subagentsDir, "level-2.jsonl"), activityLog: path.join(subagentsDir, "subagents.live.md"), agentFile: null, startedAt: "now" }),
      JSON.stringify({ type: "started", episodeId: "run-c", sessionId: "session-c", parentEpisodeId: "run-b", agent: "subagent", cwd, context: "fresh", sessionFile: path.join(subagentsDir, "level-3.jsonl"), activityLog: path.join(subagentsDir, "subagents.live.md"), agentFile: null, startedAt: "now" }),
      JSON.stringify({ type: "started", episodeId: "run-d", sessionId: "session-d", parentEpisodeId: "run-c", agent: "subagent", cwd, context: "fresh", sessionFile: nestedSession, activityLog: path.join(subagentsDir, "subagents.live.md"), agentFile: null, startedAt: "now" }),
      "",
    ].join("\n"), "utf8");
    const { deps } = fakeDeps(root);

    await expect(runSubagent({ task: "too deep" }, undefined, undefined, fakeContext(cwd, nestedSession), { deps })).rejects.toThrow("Subagent nesting limit exceeded");

    expect(deps.createFreshSessionManager).not.toHaveBeenCalled();
  });

  it("fails clearly when a nested session is missing its manifest parent record", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const nestedSession = path.join(root, "parent.jsonl.subagents", "orphan-child.jsonl");
    const { deps } = fakeDeps(root);

    await expect(runSubagent({ task: "nested" }, undefined, undefined, fakeContext(cwd, nestedSession), { deps })).rejects.toThrow("Could not determine parent subagent episode");

    expect(deps.createFreshSessionManager).not.toHaveBeenCalled();
  });

  it("reconstructs nested activity-log paths from manifest lineage", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const subagentsDir = `${parentSession}.subagents`;
    const parentChildSession = path.join(subagentsDir, "parent-child.jsonl");
    const activityLog = path.join(subagentsDir, "subagents.live.md");
    await mkdir(subagentsDir, { recursive: true });
    await writeFile(path.join(subagentsDir, "manifest.jsonl"), `${JSON.stringify({
      type: "started",
      episodeId: "parent-run",
      sessionId: "parent-session-id",
      parentEpisodeId: null,
      agent: "experiment",
      cwd,
      context: "fresh",
      sessionFile: parentChildSession,
      activityLog,
      agentFile: null,
      startedAt: "2026-01-01T00:00:00.000Z",
    })}\n`, "utf8");
    const { deps } = fakeDeps(root);

    const result = await runSubagent({ task: "nested from manifest" }, undefined, undefined, fakeContext(cwd, parentChildSession), { deps });

    expect(result.details.run.activityLog).toBe(activityLog);
    const activityText = await readFile(activityLog, "utf8");
    expect(activityText).toContain("started experiment -> subagent — episode run-1 — session:");
    expect(activityText).toContain("completed experiment -> subagent — 0 turns — session:");
  });

  it("ignores partial update callback failures so UI delivery cannot change tool semantics", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const { deps } = fakeDeps(root, {
      events: [event({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta: "stream" } })],
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await runSubagent({ task: "answer despite UI" }, undefined, () => { throw new Error("frontend disconnected"); }, fakeContext(cwd, parentSession), { deps });

    expectSubagentResult(result);
    const manifest = await readManifestRecords(`${parentSession}.subagents/manifest.jsonl`);
    expect(manifest.at(-1)).toMatchObject({ type: "finished", episodeId: "run-1", status: "completed" });
    expect(consoleError).toHaveBeenCalledWith("subagent partial update callback failed", expect.any(Error));
    consoleError.mockRestore();
  });

  it("runs omitted-agent fresh sessions, records artifacts, and returns the child answer with session metadata", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const { deps, fakeSession } = fakeDeps(root);
    const updates: unknown[] = [];
    const createSettingsManager = vi.spyOn(SettingsManager, "create");

    const result = await runSubagent({ task: "answer briefly" }, undefined, (partial) => updates.push(partial), fakeContext(cwd, parentSession), { deps });

    expect(fakeSession.promptedWith).toBe("answer briefly");
    expectSubagentResult(result);
    expect(result.content[0]?.text).not.toContain("subagents.live.md");
    expect(result.content[0]?.text).not.toContain(".subagents");
    expect(result.content[0]?.text).not.toContain(".jsonl");
    const sessionId = result.details.run.sessionId;
    const expectedActivityLog = path.join(`${parentSession}.subagents`, "subagents.live.md");
    expect(result.details.run).toMatchObject({ episodeId: "run-1", sessionId, agent: "subagent", status: "completed", activityLog: expectedActivityLog });
    expect(updates.at(-1)).toMatchObject({ details: { run: { status: "completed", sessionId, activityLog: expectedActivityLog } } });

    const manifest = await readManifestRecords(`${parentSession}.subagents/manifest.jsonl`);
    expect(manifest).toEqual([
      expect.objectContaining({ type: "started", episodeId: "run-1", sessionId, parentEpisodeId: null, agent: "subagent", agentFile: null, cwd, context: "fresh", sessionFile: expect.stringMatching(/parent\.jsonl\.subagents\/.+\.jsonl$/), activityLog: expectedActivityLog }),
      expect.objectContaining({ type: "finished", episodeId: "run-1", status: "completed" }),
    ]);

    const loaderOptions = (deps.createResourceLoader as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls[0]?.[0];
    const sessionOptions = (deps.createAgentSession as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls[0]?.[0];
    expect(createSettingsManager).toHaveBeenCalledWith(cwd, path.join(root, "agent"), { projectTrusted: true });
    expectProjectTrustedSettingsManager(loaderOptions?.settingsManager);
    expect(sessionOptions?.settingsManager).toBe(loaderOptions?.settingsManager);
  });

  it("streams child activity as portable partial updates and append-only activity-log entries", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const { deps } = fakeDeps(root, {
      events: [
        event({ type: "message_update", message: {}, assistantMessageEvent: { type: "thinking_delta", delta: "hmm" } }),
        event({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: { command: "npm test\n-- --run" } }),
        event({ type: "tool_execution_update", toolCallId: "tool-1", toolName: "bash", args: { command: `npm test ${"x".repeat(300)}` }, partialResult: {} }),
        event({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "bash", result: {}, isError: false }),
        event({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta: "Partial answer" } }),
        event({ type: "turn_end", message: {}, toolResults: [] }),
      ],
    });
    const updates: any[] = [];

    const result = await runSubagent({ task: "observable" }, undefined, (partial) => updates.push(partial), fakeContext(cwd, parentSession), { deps });

    expect(updates.some((update) => update.details.run.activity === "thinking")).toBe(true);
    expect(updates.some((update) => update.details.run.activity.startsWith("using bash"))).toBe(true);
    expect(updates.some((update) => update.details.run.turnCount === 1)).toBe(true);
    expect(updates.every((update) => update.content[0]?.text.startsWith("Active log:"))).toBe(true);
    expect(updates.every((update) => update.content[0]?.text.includes("\nSubagents:\n- subagent"))).toBe(true);
    expect(updates.every((update) => !update.content[0]?.text.includes("Activity log:"))).toBe(true);
    expect(updates.every((update) => !update.content[0]?.text.includes("ctx"))).toBe(true);
    expect(updates.some((update) => update.content[0]?.text.includes("- subagent (1 turn): turn completed"))).toBe(true);
    expectSubagentResult(result);
    expect(result.content[0]?.text).not.toContain("Activity log:");
    expect(result.details.run).toMatchObject({ status: "completed", turnCount: 1 });

    const activityLog = result.details.run.activityLog;
    expect(activityLog).toBe(path.join(`${parentSession}.subagents`, "subagents.live.md"));
    const artifactFiles = await readdir(`${parentSession}.subagents`);
    expect(artifactFiles.filter((file) => file.endsWith(".live.md"))).toEqual(["subagents.live.md"]);
    const activityText = await readFile(activityLog, "utf8");
    expect(activityText).toContain("started subagent — episode run-1 — session:");
    expect(activityText).toContain("thinking");
    expect(activityText).toContain("using bash");
    expect(activityText).toContain("finished bash");
    expect(activityText).toContain("responding");
    expect(activityText).not.toContain("Partial answer");
    expect(activityText).not.toContain("## Assistant");
    expect(activityText).toContain("completed subagent — 1 turn — session:");
  });

  it("shows child context usage from Pi's session API in progress and final run details", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const contextUsage = { tokens: 12_400, contextWindow: 200_000, percent: 6.2 };
    const { deps, fakeSession } = fakeDeps(root, {
      contextUsage,
      events: [event({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta: "stream" } })],
    });
    const updates: any[] = [];

    const result = await runSubagent({ task: "context usage" }, undefined, (partial) => updates.push(partial), fakeContext(cwd, parentSession), { deps });

    expect(fakeSession.contextUsageCallCount).toBeGreaterThan(0);
    expect(updates.some((update) => update.content[0]?.text.includes("- subagent (6% ctx, 0 turns): responding"))).toBe(true);
    expect(updates.at(-1)?.content[0]?.text).toContain("- subagent (6% ctx, 0 turns): completed");
    expect(result.details.run.contextUsage).toEqual(contextUsage);
  });

  it("renders unknown child context usage without guessing", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const contextUsage = { tokens: null, contextWindow: 200_000, percent: null };
    const { deps } = fakeDeps(root, {
      contextUsage,
      events: [event({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta: "stream" } })],
    });
    const updates: any[] = [];

    const result = await runSubagent({ task: "unknown context" }, undefined, (partial) => updates.push(partial), fakeContext(cwd, parentSession), { deps });

    expect(updates.some((update) => update.content[0]?.text.includes("- subagent (? ctx, 0 turns): responding"))).toBe(true);
    expect(result.details.run.contextUsage).toEqual(contextUsage);
  });

  it("does not let context usage refresh failures change tool semantics", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { deps } = fakeDeps(root, {
      getContextUsageImpl: () => { throw new Error("usage unavailable"); },
      events: [event({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta: "stream" } })],
    });
    const updates: any[] = [];

    const result = await runSubagent({ task: "usage failure" }, undefined, (partial) => updates.push(partial), fakeContext(cwd, parentSession), { deps });

    expectSubagentResult(result);
    expect(updates.every((update) => !update.content[0]?.text.includes("ctx"))).toBe(true);
    expect(result.details.run.contextUsage).toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith("subagent context usage refresh failed", expect.any(Error));
    consoleError.mockRestore();
  });

  it("propagates nested subagent run trees without pasting nested output into the parent result", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const nestedRun = {
      episodeId: "child-1",
      sessionId: "session-child-1",
      agent: "scout",
      status: "running",
      turnCount: 0,
      lastActivityAt: "2026-01-01T00:00:01.000Z",
      activity: "using read",
      activityLog: path.join(`${parentSession}.subagents`, "subagents.live.md"),
      contextUsage: { tokens: 24_800, contextWindow: 200_000, percent: 12.4 },
      children: [],
    };
    const completedNestedRun = { ...nestedRun, status: "completed", activity: "completed" };
    const { deps } = fakeDeps(root, {
      contextUsage: { tokens: 12_400, contextWindow: 200_000, percent: 6.2 },
      events: [
        event({ type: "tool_execution_update", toolCallId: "nested", toolName: "subagent", args: { task: "inspect" }, partialResult: { details: { run: nestedRun }, content: [{ type: "text", text: "nested live output" }] } }),
        event({ type: "tool_execution_end", toolCallId: "nested", toolName: "subagent", result: { details: { run: completedNestedRun }, content: [{ type: "text", text: "nested final output" }] }, isError: false }),
      ],
    });
    const updates: any[] = [];

    const result = await runSubagent({ task: "parent" }, undefined, (partial) => updates.push(partial), fakeContext(cwd, parentSession), { deps });

    expect(result.details.run.children).toHaveLength(1);
    expect(result.details.run.children[0]).toMatchObject({ episodeId: "child-1", status: "completed", activityLog: nestedRun.activityLog });
    expectSubagentResult(result);
    expect(result.content[0]?.text).not.toContain("nested final output");
    expect(updates.some((update) => update.content[0]?.text.includes("- subagent (6% ctx, 0 turns) -> scout (12% ctx, 0 turns): using read"))).toBe(true);
    expect(updates.every((update) => !update.content[0]?.text.includes("Activity log:"))).toBe(true);

    const activityText = await readFile(result.details.run.activityLog, "utf8");
    expect(activityText).toContain("using subagent");
    expect(activityText).not.toContain("  - activity log:");
    expect(activityText).not.toContain("nested final output");
  });

  it("fails named-skill resource validation before creating a child session", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    const agentPath = path.join(cwd, ".pi", "agents", "needs-skill.md");
    await mkdir(path.dirname(agentPath), { recursive: true });
    await writeFile(agentPath, "---\ndescription: Needs skill\nskills: missing\n---\n\nBody.\n", "utf8");
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const { deps } = fakeDeps(root);
    deps.createResourceLoader = vi.fn(() => ({
      reload: vi.fn(async () => { throw new Error("Unavailable skill(s) for subagent 'needs-skill': missing"); }),
      getExtensions: vi.fn(),
      getSkills: vi.fn(),
      getPrompts: vi.fn(),
      getThemes: vi.fn(),
      getAgentsFiles: vi.fn(),
      getSystemPrompt: vi.fn(),
      getAppendSystemPrompt: vi.fn(),
      extendResources: vi.fn(),
    } as unknown as ResourceLoader));

    await expect(runSubagent({ agent: "needs-skill", task: "skill" }, undefined, undefined, fakeContext(cwd, parentSession), { deps })).rejects.toThrow("Unavailable skill(s)");

    expect(deps.createFreshSessionManager).not.toHaveBeenCalled();
  });

  it("loads an explicit agent named subagent from markdown rather than using omitted mode", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    const agentPath = path.join(cwd, ".pi", "agents", "subagent.md");
    await mkdir(path.dirname(agentPath), { recursive: true });
    await writeFile(agentPath, "---\ndescription: Literal named subagent\n---\n\nNamed body.\n", "utf8");
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const { deps } = fakeDeps(root);

    const result = await runSubagent({ agent: "subagent", task: "use the named file" }, undefined, undefined, fakeContext(cwd, parentSession), { deps });

    expectSubagentResult(result, "## Subagent subagent result");
    const manifest = await readManifestRecords(`${parentSession}.subagents/manifest.jsonl`);
    expect(manifest[0]).toMatchObject({ type: "started", agent: "subagent", agentFile: agentPath });
  });

  it("treats a final assistant stopReason aborted as a failed subagent run", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const { deps } = fakeDeps(root, { messages: [{ role: "assistant", stopReason: "aborted" }] });

    const message = await rejectedMessage(runSubagent({ task: "abort" }, undefined, undefined, fakeContext(cwd, parentSession), { deps }));

    const manifest = await readManifestRecords(`${parentSession}.subagents/manifest.jsonl`);
    const sessionId = manifest[0]?.type === "started" ? manifest[0].sessionId : "";
    expectRecoverableFailure(message, sessionId, "Child subagent was aborted.");
    expect(message).not.toContain("## Subagent interrupted");
    expect(manifest.at(-1)).toMatchObject({ type: "finished", episodeId: "run-1", status: "failed", error: "Child subagent was aborted." });
  });

  it("records retry activity through runner partial updates and activity logs", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const { deps } = fakeDeps(root, {
      events: [
        event({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, errorMessage: "rate limited" }),
        event({ type: "agent_end", willRetry: true }),
        event({ type: "auto_retry_end", attempt: 1, success: true }),
      ],
    });
    const updates: any[] = [];

    const result = await runSubagent({ task: "retry succeeds" }, undefined, (partial) => updates.push(partial), fakeContext(cwd, parentSession), { deps });

    expect(result.details.run.status).toBe("completed");
    expect(updates.some((update) => update.details.run.activity === "retrying attempt 1/3 after rate limited")).toBe(true);
    expect(updates.some((update) => update.details.run.activity === "retry pending")).toBe(true);
    expect(updates.some((update) => update.details.run.activity === "retry attempt 1 succeeded")).toBe(true);
    const activityText = await readFile(result.details.run.activityLog, "utf8");
    expect(activityText).toContain("retrying attempt 1/3 after rate limited");
    expect(activityText).toContain("retry pending");
    expect(activityText).toContain("retry attempt 1 succeeded");
  });

  it("treats a final assistant stopReason error as a failed subagent run", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const { deps } = fakeDeps(root, {
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "provider exhausted retries" }],
      events: [
        event({ type: "auto_retry_start", attempt: 2, maxAttempts: 3, errorMessage: "provider overloaded" }),
        event({ type: "agent_end", willRetry: true }),
        event({ type: "auto_retry_end", attempt: 2, success: false, finalError: "provider exhausted retries" }),
      ],
    });
    const updates: any[] = [];

    const message = await rejectedMessage(runSubagent({ task: "fail after retries" }, undefined, (partial) => updates.push(partial), fakeContext(cwd, parentSession), { deps }));

    expect(updates.some((update) => update.details.run.activity === "retry pending")).toBe(true);
    expect(updates.at(-1)).toMatchObject({ details: { run: { status: "failed" } } });
    const manifest = await readManifestRecords(`${parentSession}.subagents/manifest.jsonl`);
    const sessionId = manifest[0]?.type === "started" ? manifest[0].sessionId : "";
    expectRecoverableFailure(message, sessionId, "provider exhausted retries");
    expect(manifest.at(-1)).toMatchObject({ type: "finished", episodeId: "run-1", status: "failed", error: "provider exhausted retries" });
    const activityText = await readFile(`${parentSession}.subagents/subagents.live.md`, "utf8");
    expect(activityText).toContain("retrying attempt 2/3 after provider overloaded");
    expect(activityText).toContain("retry attempt 2 failed: provider exhausted retries");
    expect(activityText).toContain("failed subagent — 0 turns — error: provider exhausted retries — session:");
  });

  it("records failure artifacts, emits a failed partial update, and cleans up resources", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const { deps, fakeSession } = fakeDeps(root, { promptImpl: async () => { throw new Error("model auth failed"); } });
    const updates: unknown[] = [];

    const message = await rejectedMessage(runSubagent({ task: "fail" }, undefined, (partial) => updates.push(partial), fakeContext(cwd, parentSession), { deps }));

    expect(fakeSession.unsubscribeCount).toBe(1);
    expect(fakeSession.disposeCount).toBe(1);
    expect(updates.at(-1)).toMatchObject({ details: { run: { status: "failed" } } });
    const manifest = await readManifestRecords(`${parentSession}.subagents/manifest.jsonl`);
    const sessionId = manifest[0]?.type === "started" ? manifest[0].sessionId : "";
    expectRecoverableFailure(message, sessionId, "model auth failed");
    expect(manifest.at(-1)).toMatchObject({ type: "finished", episodeId: "run-1", status: "failed", error: "model auth failed" });

    const childSessionFile = manifest[0]?.type === "started" ? manifest[0].sessionFile : "";
    const childHeader = JSON.parse((await readFile(childSessionFile, "utf8")).split("\n")[0]!);
    expect(childHeader).toMatchObject({ type: "session", id: sessionId, cwd });
    const resumed = fakeDeps(root);
    resumed.deps.createEpisodeId = vi.fn(() => "resume-1");
    const result = await runSubagentResume({ sessionId, message: "recover after auth setup" }, undefined, undefined, fakeContext(cwd, parentSession), { deps: resumed.deps });
    expectSubagentResult(result);
    expect(result.details.run).toMatchObject({ episodeId: "resume-1", sessionId, status: "completed" });
  });

  it("records a failed run when child session creation fails after artifacts start", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const { deps } = fakeDeps(root);
    deps.createAgentSession = vi.fn(async () => { throw new Error("sdk session failed"); });
    const updates: unknown[] = [];

    const message = await rejectedMessage(runSubagent({ task: "create failure" }, undefined, (partial) => updates.push(partial), fakeContext(cwd, parentSession), { deps }));

    expect(updates.at(-1)).toMatchObject({ details: { run: { status: "failed", activity: "failed" } } });
    const manifest = await readManifestRecords(`${parentSession}.subagents/manifest.jsonl`);
    const sessionId = manifest[0]?.type === "started" ? manifest[0].sessionId : "";
    expectRecoverableFailure(message, sessionId, "sdk session failed");
    expect(manifest).toEqual([
      expect.objectContaining({ type: "started", episodeId: "run-1", sessionId }),
      expect.objectContaining({ type: "finished", episodeId: "run-1", status: "failed", error: "sdk session failed" }),
    ]);
    const childSessionFile = manifest[0]?.type === "started" ? manifest[0].sessionFile : "";
    const childHeader = JSON.parse((await readFile(childSessionFile, "utf8")).split("\n")[0]!);
    expect(childHeader).toMatchObject({ type: "session", id: sessionId, cwd });
    const activityText = await readFile(`${parentSession}.subagents/subagents.live.md`, "utf8");
    expect(activityText).toContain("failed subagent — 0 turns — error: sdk session failed — session:");
  });

  it("disposes a child session when extension binding fails", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const { deps, fakeSession } = fakeDeps(root, { bindImpl: async () => { throw new Error("bind failed"); } });

    const message = await rejectedMessage(runSubagent({ task: "bind failure" }, undefined, undefined, fakeContext(cwd, parentSession), { deps }));

    expect(fakeSession.promptCount).toBe(0);
    expect(fakeSession.unsubscribeCount).toBe(0);
    expect(fakeSession.disposeCount).toBe(1);
    const manifest = await readManifestRecords(`${parentSession}.subagents/manifest.jsonl`);
    const sessionId = manifest[0]?.type === "started" ? manifest[0].sessionId : "";
    expectRecoverableFailure(message, sessionId, "bind failed");
    expect(manifest.at(-1)).toMatchObject({ type: "finished", episodeId: "run-1", status: "failed", error: "bind failed" });
  });

  it("does not let cleanup errors mask the original child failure", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { deps, fakeSession } = fakeDeps(root, {
      promptImpl: async () => { throw new Error("primary failure"); },
      unsubscribeImpl: () => { throw new Error("unsubscribe failed"); },
      disposeImpl: () => { throw new Error("dispose failed"); },
    });

    await expect(runSubagent({ task: "cleanup failure" }, undefined, undefined, fakeContext(cwd, parentSession), { deps })).rejects.toThrow("primary failure");

    expect(fakeSession.unsubscribeCount).toBe(1);
    expect(fakeSession.disposeCount).toBe(1);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("unsubscribe subagent activity listener"), expect.any(Error));
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("dispose subagent child session"), expect.any(Error));
    consoleError.mockRestore();
  });

  it("continues when manifest writes degrade", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const logger = vi.fn();
    const { deps } = fakeDeps(root);
    Object.assign(deps, { artifactOptions: { manifest: { appendFile: async () => { throw new Error("manifest disk full"); }, logger } } });

    const result = await runSubagent({ task: "manifest degraded" }, undefined, undefined, fakeContext(cwd, parentSession), { deps });

    expectSubagentResult(result);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("Could not append subagent manifest"), expect.any(Error));
  });

  it("continues when activity-log writes degrade", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const logger = vi.fn();
    const { deps } = fakeDeps(root);
    Object.assign(deps, { artifactOptions: { activityLog: { appendFile: async () => { throw new Error("log disk full"); }, logger } } });

    const result = await runSubagent({ task: "activity log degraded" }, undefined, undefined, fakeContext(cwd, parentSession), { deps });

    expectSubagentResult(result);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("Could not append subagent activity log"), expect.any(Error));
  });

  it("lets an in-process nested run find its parent when the outer manifest start append degraded", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    let outerChildSessionFile = "";
    const nested = fakeDeps(root, { lastAssistantText: "inner answer" });
    nested.deps.createEpisodeId = vi.fn(() => "run-2");
    const outer = fakeDeps(root, {
      promptImpl: async () => {
        await runSubagent({ task: "inner" }, undefined, undefined, fakeContext(cwd, outerChildSessionFile), { deps: nested.deps });
      },
    });
    Object.assign(outer.deps, { artifactOptions: { manifest: { appendFile: async () => { throw new Error("manifest unavailable"); }, logger: vi.fn() } } });
    outer.deps.createAgentSession = vi.fn(async (options: any) => {
      outerChildSessionFile = options.sessionManager.getSessionFile() ?? "";
      return { session: outer.fakeSession as unknown as AgentSession };
    });

    const result = await runSubagent({ task: "outer" }, undefined, undefined, fakeContext(cwd, parentSession), { deps: outer.deps });

    expectSubagentResult(result);
    const manifest = await readManifestRecords(`${parentSession}.subagents/manifest.jsonl`);
    const expectedActivityLog = path.join(`${parentSession}.subagents`, "subagents.live.md");
    expect(manifest).toContainEqual(expect.objectContaining({ type: "started", episodeId: "run-2", parentEpisodeId: "run-1", activityLog: expectedActivityLog }));
    const activityText = await readFile(expectedActivityLog, "utf8");
    expect(activityText).toContain("started subagent — episode run-1 — session:");
    expect(activityText).toContain("started subagent -> subagent — episode run-2 — session:");
    expect(activityText).toContain("completed subagent -> subagent — 0 turns — session:");
  });

  it("propagates parent aborts to the child session and reports an interrupted capsule", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const abortController = new AbortController();
    const { deps, fakeSession } = fakeDeps(root, { promptImpl: async () => { abortController.abort(); } });

    const message = await rejectedMessage(runSubagent({ task: "abortable" }, abortController.signal, undefined, fakeContext(cwd, parentSession), { deps }));
    const manifest = await readManifestRecords(`${parentSession}.subagents/manifest.jsonl`);
    const sessionId = manifest[0]?.type === "started" ? manifest[0].sessionId : "";

    expectInterruptedCapsule(message, sessionId);
    expect(fakeSession.abortCount).toBe(1);
    expect(fakeSession.unsubscribeCount).toBe(1);
    expect(fakeSession.disposeCount).toBe(1);
  });

  it("does not prompt a child if the parent aborts after session creation but before prompting", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const abortController = new AbortController();
    const { deps, fakeSession } = fakeDeps(root);
    deps.createAgentSession = vi.fn(async () => {
      abortController.abort();
      return { session: fakeSession as unknown as AgentSession };
    });

    const message = await rejectedMessage(runSubagent({ task: "abort race" }, abortController.signal, undefined, fakeContext(cwd, parentSession), { deps }));
    const manifest = await readManifestRecords(`${parentSession}.subagents/manifest.jsonl`);
    const sessionId = manifest[0]?.type === "started" ? manifest[0].sessionId : "";

    expectInterruptedCapsule(message, sessionId);
    expect(manifest.at(-1)).toMatchObject({ type: "finished", episodeId: "run-1", status: "aborted", error: "Interrupted by parent abort." });
    expect(fakeSession.abortCount).toBe(1);
    expect(fakeSession.promptCount).toBe(0);
    expect(fakeSession.unsubscribeCount).toBe(1);
    expect(fakeSession.disposeCount).toBe(1);
  });

  it("rejects promptly with a path-free interrupted capsule when parent aborts even if child prompt never settles", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const abortController = new AbortController();
    const { deps, fakeSession } = fakeDeps(root, {
      promptImpl: async () => new Promise<void>(() => undefined),
    });
    const updates: unknown[] = [];

    const running = runSubagent({ task: "never settles" }, abortController.signal, (partial) => updates.push(partial), fakeContext(cwd, parentSession), { deps });
    await vi.waitFor(() => expect(fakeSession.promptCount).toBe(1));
    const manifestBeforeAbort = await readManifestRecords(`${parentSession}.subagents/manifest.jsonl`);
    const sessionId = manifestBeforeAbort[0]?.type === "started" ? manifestBeforeAbort[0].sessionId : "";
    abortController.abort();

    const message = await rejectedMessage(running);
    expectInterruptedCapsule(message, sessionId);
    expect(fakeSession.abortCount).toBe(1);
    expect(fakeSession.unsubscribeCount).toBe(1);
    expect(fakeSession.disposeCount).toBe(1);
    expect(updates.at(-1)).toMatchObject({ details: { run: { episodeId: "run-1", sessionId, status: "aborted", activity: "interrupted" } } });
    const manifest = await readManifestRecords(`${parentSession}.subagents/manifest.jsonl`);
    expect(manifest.at(-1)).toMatchObject({ type: "finished", episodeId: "run-1", status: "aborted", error: "Interrupted by parent abort." });
    const started = manifest[0]?.type === "started" ? manifest[0] : undefined;
    expect(started).toBeDefined();
    const childHeader = JSON.parse((await readFile(started!.sessionFile, "utf8")).split("\n")[0]!);
    expect(childHeader).toMatchObject({ type: "session", id: sessionId, cwd });
    const activityText = await readFile(`${parentSession}.subagents/subagents.live.md`, "utf8");
    expect(activityText).toContain("aborted subagent — 0 turns — error: Interrupted by parent abort. — session:");
  });

  it("logs rejected child aborts without creating unhandled cleanup failures", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const abortController = new AbortController();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { deps, fakeSession } = fakeDeps(root, {
      promptImpl: async () => { abortController.abort(); },
      abortImpl: async () => { throw new Error("abort transport failed"); },
    });

    const message = await rejectedMessage(runSubagent({ task: "abort reject" }, abortController.signal, undefined, fakeContext(cwd, parentSession), { deps }));

    expect(message).toContain("interrupted");
    expect(fakeSession.abortCount).toBe(1);
    await vi.waitFor(() => expect(consoleError).toHaveBeenCalledWith("subagent child abort failed", expect.any(Error)));
    consoleError.mockRestore();
  });

  it("rejects cwd overrides for fork runs", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const { deps } = fakeDeps(root);

    await expect(runSubagent({ task: "fork", context: "fork", cwd: "." }, undefined, undefined, fakeContext(cwd, parentSession), { deps })).rejects.toThrow("cwd is not supported with context 'fork'");

    expect(deps.openSessionManager).not.toHaveBeenCalled();
    expect(deps.createFreshSessionManager).not.toHaveBeenCalled();
  });

  it("requires a current leaf for fork runs", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const { deps } = fakeDeps(root);

    await expect(runSubagent({ task: "fork", context: "fork" }, undefined, undefined, fakeContext(cwd, parentSession, { leafId: null }), { deps })).rejects.toThrow("subagent fork execution requires a current session leaf");

    expect(deps.openSessionManager).not.toHaveBeenCalled();
    expect(deps.createFreshSessionManager).not.toHaveBeenCalled();
  });

  it("reports stale fork leaf failures with the leaf id", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const forkManager = new FakeForkSessionManager(cwd, parentSession, undefined, new Error("Entry stale-leaf not found"));
    const { deps } = fakeDeps(root);
    deps.openSessionManager = vi.fn(() => forkManager as unknown as SessionManager);

    await expect(runSubagent({ task: "fork", context: "fork" }, undefined, undefined, fakeContext(cwd, parentSession, { leafId: "stale-leaf" }), { deps })).rejects.toThrow("Could not fork subagent from current session leaf 'stale-leaf': Entry stale-leaf not found");

    expect(forkManager.branchedFrom).toBe("stale-leaf");
    expect(deps.createFreshSessionManager).not.toHaveBeenCalled();
  });

  it("runs omitted-agent fork sessions from a branched current leaf", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const childSession = path.join(`${parentSession}.subagents`, "fork-child.jsonl");
    const forkManager = new FakeForkSessionManager(cwd, parentSession, childSession);
    const { deps, fakeSession } = fakeDeps(root);
    deps.openSessionManager = vi.fn(() => forkManager as unknown as SessionManager);

    const result = await runSubagent({ task: "continue from here", context: "fork" }, undefined, undefined, fakeContext(cwd, parentSession, { leafId: "leaf-current" }), { deps });

    expect(deps.openSessionManager).toHaveBeenCalledWith(parentSession, `${parentSession}.subagents`);
    expect(forkManager.branchedFrom).toBe("leaf-current");
    expect(deps.createFreshSessionManager).not.toHaveBeenCalled();
    expect(fakeSession.promptedWith).toBe("continue from here");
    expectSubagentResult(result);

    const manifest = await readManifestRecords(`${parentSession}.subagents/manifest.jsonl`);
    expect(manifest[0]).toMatchObject({ type: "started", episodeId: "run-1", parentEpisodeId: null, agent: "subagent", agentFile: null, cwd, context: "fork", sessionFile: childSession });
  });

  it("runs named-agent fork prompts as user text without fresh resource overrides or model overrides", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    const agentPath = path.join(cwd, ".pi", "agents", "reviewer.md");
    await mkdir(path.dirname(agentPath), { recursive: true });
    await writeFile(agentPath, "---\ndescription: Reviews\nagentsMd: none\nskills: missing\n---\n\nReview body.\n", "utf8");
    const parentSession = path.join(root, "sessions", "parent.jsonl");
    const forkManager = new FakeForkSessionManager(cwd, parentSession);
    const { deps, fakeSession } = fakeDeps(root);
    const createSettingsManager = vi.spyOn(SettingsManager, "create");
    deps.openSessionManager = vi.fn(() => forkManager as unknown as SessionManager);

    const result = await runSubagent({ agent: "reviewer", task: "inspect the branch", context: "fork" }, undefined, undefined, fakeContext(cwd, parentSession, { model: { id: "parent-model" } }), { deps });

    expect(fakeSession.promptedWith).toBe("Subagent instructions from `reviewer`:\nReview body.\n\nTask:\ninspect the branch");
    expectSubagentResult(result, "## Subagent reviewer result");

    const loaderCalls = (deps.createResourceLoader as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls;
    const loaderOptions = loaderCalls[0]?.[0];
    expect(loaderOptions).toBeDefined();
    expect(loaderOptions).toMatchObject({ cwd, agentDir: path.join(root, "agent") });
    expect(loaderOptions?.noContextFiles).toBeUndefined();
    expect(loaderOptions?.noSkills).toBeUndefined();
    expect(loaderOptions?.skillsOverride).toBeUndefined();
    expect(loaderOptions?.appendSystemPromptOverride).toBeUndefined();
    expect(loaderOptions?.appendSystemPrompt).toBeUndefined();
    expect(loaderOptions?.systemPromptOverride).toBeUndefined();

    const sessionCalls = (deps.createAgentSession as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls;
    const sessionOptions = sessionCalls[0]?.[0];
    expect(sessionOptions).toBeDefined();
    expect(sessionOptions).not.toHaveProperty("model");
    expect(createSettingsManager).toHaveBeenCalledWith(cwd, path.join(root, "agent"), { projectTrusted: true });
    expectProjectTrustedSettingsManager(loaderOptions?.settingsManager);
    expect(sessionOptions?.settingsManager).toBe(loaderOptions?.settingsManager);
  });
});
