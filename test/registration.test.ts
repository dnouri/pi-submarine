import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import register, { subagentListTool, subagentResumeTool, subagentTool } from "../src/index.js";

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function registeredToolsFromFactory(): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  const fakePi = {
    registerTool(tool: RegisteredTool) {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI;

  register(fakePi);
  return tools;
}

describe("pi-submarine extension registration", () => {
  it("registers the public tool surface", () => {
    const tools = registeredToolsFromFactory();

    expect(tools.map((tool) => tool.name)).toEqual(["subagent", "subagent_resume", "subagent_list"]);
    expect(tools.map((tool) => tool.label)).toEqual(["Subagent", "Resume subagent", "List subagents"]);
    expect(tools.map((tool) => tool.description)).toEqual([
      expect.stringContaining("Delegate one focused task"),
      expect.stringContaining("Continue an existing child Pi session"),
      expect.stringContaining("List specialized markdown"),
    ]);
  });

  it("registers strict parameter schemas for all tools", () => {
    const [subagent, subagentResume, subagentList] = registeredToolsFromFactory();

    expect(subagent?.parameters).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["task"],
      properties: {
        agent: { type: "string" },
        task: { type: "string", minLength: 1 },
        model: { type: "string", minLength: 1 },
        thinkingLevel: { type: "string", enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
        context: { type: "string", enum: ["fresh", "fork"], default: "fresh" },
        cwd: { type: "string" },
      },
    });

    expect(subagentResume?.parameters).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["sessionId", "message"],
      properties: {
        sessionId: { type: "string", minLength: 1 },
        message: { type: "string", minLength: 1 },
      },
    });

    expect(subagentList?.parameters).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        cwd: { type: "string" },
      },
    });
  });

  it("presents the subagent contract in model-facing metadata", () => {
    const [subagent, subagentResume, subagentList] = registeredToolsFromFactory();

    expect(subagent?.description).toContain("Delegate one focused task to a new subagent");
    expect(subagent?.description).toContain("compact session metadata");
    expect(subagent?.promptSnippet).toContain("synchronous subagent");
    const guidelines = subagent?.promptGuidelines?.join("\n") ?? "";
    expect(guidelines).toContain("Common calls");
    expect(guidelines).toContain("subagent({ task: \"...\" })");
    expect(guidelines).toContain("subagent({ model: \"acme/acme-5v-turbo\", task: \"Read screenshots/login.png and return its contents\" })");
    expect(guidelines).toContain("subagent({ context: \"fork\", task: \"...\" })");
    expect(guidelines).toContain("do not see the parent conversation");
    expect(guidelines).toContain("foreground child");
    expect(guidelines).toContain("not a background job or workflow engine");
    expect(guidelines).toContain("project .pi/agents/*.md overrides same-named user agents");
    expect(guidelines).toContain("Omit `agent` for default mode");
    expect(guidelines).toContain("Role text inside `task` does not select an agent");
    expect(guidelines).toContain("Usually omit `cwd`");
    expect(guidelines).toContain("Call-level `model`/`thinkingLevel` are usually only for the default agent");
    expect(guidelines).toContain("An explicit `thinkingLevel` must be supported by the resolved child model");
    expect(guidelines).toContain("Prefer a new `subagent` for follow-up or related work");

    expect(subagent?.parameters).toMatchObject({
      properties: {
        agent: { description: expect.stringContaining("project agents from the effective `cwd`") },
        task: { description: expect.stringContaining("does not see the parent conversation") },
        model: { description: expect.stringContaining("Usually only for the default agent") },
        thinkingLevel: { description: expect.stringContaining("must be supported by the resolved model") },
        context: { description: expect.stringContaining("Defaults to `fresh`") },
        cwd: { description: expect.stringContaining("Omit to inherit the caller cwd") },
      },
    });
    expect(subagentResume?.description).toContain("Continue an existing child Pi session");
    expect(subagentResume?.description).toContain("recover an interrupted or failed child");
    expect(subagentResume?.description).toContain("user explicitly asks to resume that exact child session");
    expect(subagentResume?.description).toContain("otherwise use a new `subagent`");
    expect(subagentResume?.promptSnippet).toContain("Recover an interrupted or failed child");
    expect(subagentResume?.promptSnippet).toContain("explicit request");
    const resumeGuidelines = subagentResume?.promptGuidelines?.join("\n") ?? "";
    expect(resumeGuidelines).toContain("subagent_resume({ sessionId: \"...\", message: \"...\" })");
    expect(resumeGuidelines).toContain("recover an interrupted or failed child when its result includes a session ID");
    expect(resumeGuidelines).toContain("user explicitly asks to resume that exact child session");
    expect(resumeGuidelines).toContain("`subagent_resume` continues an existing child subagent session");
    expect(resumeGuidelines).toContain("does not create a new child context");
    expect(resumeGuidelines).not.toContain("completed result that needs a follow-up");
    expect(subagentResume?.parameters).toMatchObject({
      properties: {
        sessionId: { description: expect.stringContaining("from an earlier `subagent` or `subagent_resume` result") },
        message: { description: expect.stringContaining("existing child conversation") },
      },
    });
    expect(subagentList?.promptSnippet).toContain("Inspect visible subagents");
    const listGuidelines = subagentList?.promptGuidelines?.join("\n") ?? "";
    expect(listGuidelines).toContain("subagent_list({})");
    expect(listGuidelines).toContain("subagent_list({ cwd: \"/path\" })");
    expect(listGuidelines).toContain("do not call it first if you already know the agent name");
    expect(subagentList?.parameters).toMatchObject({
      properties: {
        cwd: { description: expect.stringContaining("intentionally inspecting another directory") },
      },
    });
  });

  it("keeps registration model-free while execution requires a persisted parent session", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-submarine-registration-"));
    const agentDir = await mkdtemp(path.join(tmpdir(), "pi-submarine-registration-agent-"));
    tempRoots.push(cwd, agentDir);
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const listResult = await (async () => {
      try {
        return await subagentListTool.execute("tool-call-2", {}, undefined, undefined, {
          cwd,
          modelRegistry: { getAll: () => [], hasConfiguredAuth: () => false },
        } as unknown as ExtensionContext);
      } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    })();

    await expect(subagentTool.execute("tool-call-1", { task: "say hi" }, undefined, undefined, {
      cwd,
      sessionManager: { getSessionFile: () => undefined },
      modelRegistry: {},
      model: undefined,
    } as unknown as ExtensionContext)).rejects.toThrow("requires a persisted parent Pi session");
    await expect(subagentResumeTool.execute("tool-call-resume", { sessionId: "session-1", message: "continue" }, undefined, undefined, {
      cwd,
      sessionManager: { getSessionFile: () => undefined },
      modelRegistry: {},
      model: undefined,
    } as unknown as ExtensionContext)).rejects.toThrow("subagent_resume requires a persisted parent Pi session");
    expect(listResult.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining(`Available subagents for ${cwd}:`),
    });
    expect(listResult.details).toEqual({
      status: "listed",
      count: 0,
      cwd,
      sourceCounts: { user: 0, project: 0 },
      agentDirectories: { user: path.join(agentDir, "agents"), project: null },
      models: [],
      currentModel: null,
    });
  });
});
