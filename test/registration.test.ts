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
      expect.stringContaining("Run one focused task"),
      expect.stringContaining("Continue an existing child Pi session"),
      expect.stringContaining("List pi-submarine markdown agents"),
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

    expect(subagent?.description).toContain("foreground child Pi session");
    expect(subagent?.description).toContain("one focused task");
    expect(subagent?.description).toContain("compact session metadata");
    expect(subagent?.promptSnippet).toContain("foreground pi-submarine child session");
    const guidelines = subagent?.promptGuidelines?.join("\n") ?? "";
    expect(guidelines).toContain("subagent is pi-submarine's foreground-only delegation tool");
    expect(guidelines).toContain("one child Pi session");
    expect(guidelines).toContain("does not provide async/background jobs, chains, dashboards, or a workflow engine");
    expect(guidelines).toContain("nearest project .pi/agents/*.md overrides user agents");
    expect(guidelines).toContain("intentionally approve project-local Pi inputs");
    expect(guidelines).toContain(".pi/settings.json");
    expect(guidelines).toContain("generic default mode only when agent is omitted");
    expect(guidelines).toContain("context defaults to fresh");
    expect(guidelines).toContain("cwd controls project-agent discovery, AGENTS.md / CLAUDE.md, skills, and prompt resources");

    expect(subagent?.parameters).toMatchObject({
      properties: {
        agent: { description: expect.stringContaining(".pi/agents/<name>.md") },
        task: { description: expect.stringContaining("single child Pi session") },
        context: { description: expect.stringContaining("defaults to fresh") },
        cwd: { description: expect.stringContaining("Relative paths resolve from the caller cwd") },
      },
    });
    expect(subagentResume?.description).toContain("Continue an existing child Pi session");
    expect(subagentResume?.description).toContain("session ID");
    expect(subagentResume?.description).toContain("compact session metadata");
    expect(subagentResume?.promptSnippet).toContain("Continue an existing pi-submarine child session");
    const resumeGuidelines = subagentResume?.promptGuidelines?.join("\n") ?? "";
    expect(resumeGuidelines).toContain("subagent_resume continues an existing child Pi session");
    expect(resumeGuidelines).toContain("current parent/root session");
    expect(resumeGuidelines).toContain("does not search globally, fork, or copy the child session");
    expect(resumeGuidelines).toContain("approved project-local resource policy for the recorded cwd");
    expect(resumeGuidelines).toContain("Use subagent for unrelated work");
    expect(resumeGuidelines).toContain("You were interrupted. Continue work exactly where you left off.");
    expect(resumeGuidelines).toContain("Good. Now also check the edge cases you mentioned and update your recommendation.");
    expect(resumeGuidelines).toContain("Please summarize what you did so far for a handoff so we can continue later.");
    expect(subagentResume?.parameters).toMatchObject({
      properties: {
        sessionId: { description: expect.stringContaining("child Pi session ID from an earlier subagent or subagent_resume result") },
        message: { description: expect.stringContaining("append") },
      },
    });
    expect(subagentList?.promptSnippet).toContain("Inspect visible pi-submarine subagents");
    expect(subagentList?.promptGuidelines?.join("\n") ?? "").toContain("Usually omit cwd for subagent_list");
  });

  it("keeps registration model-free while execution requires a persisted parent session", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-submarine-registration-"));
    const agentDir = await mkdtemp(path.join(tmpdir(), "pi-submarine-registration-agent-"));
    tempRoots.push(cwd, agentDir);
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const listResult = await (async () => {
      try {
        return await subagentListTool.execute("tool-call-2", {}, undefined, undefined, { cwd } as ExtensionContext);
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
    });
  });
});
