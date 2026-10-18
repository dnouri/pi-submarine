import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { IsObject } from "typebox";
import { afterEach, assert, describe, expect, it } from "vitest";
import register, { subagentListTool, subagentResumeTool, subagentTool } from "../src/index.js";
import { TOOL_PROMPTS } from "../src/tool-prompts.js";

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
        agentsMd: { type: "string", enum: ["none", "auto"] },
        context: { type: "string", enum: ["fresh", "fork"], default: "fresh" },
        cwd: { type: "string" },
      },
    });

    assert(subagent && IsObject(subagent.parameters));
    expect(Object.keys(subagent.parameters.properties).sort()).toEqual(["agent", "agentsMd", "context", "cwd", "model", "task"]);
    expect(subagent.parameters.properties.agentsMd).not.toHaveProperty("default");

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
    assert(subagentResume && IsObject(subagentResume.parameters));
    assert(subagentList && IsObject(subagentList.parameters));
    expect(Object.keys(subagentResume.parameters.properties).sort()).toEqual(["message", "sessionId"]);
    expect(Object.keys(subagentList.parameters.properties)).toEqual(["cwd"]);
  });

  it.each([
    { task: "review", thinkingLevel: "low" },
    { task: "review", agentsMd: "bogus" },
    { task: "review", unknown: true },
  ])("rejects invalid public arguments through Pi's validator (%j)", (args) => {
    expect(() => validateToolArguments(subagentTool, { type: "toolCall", id: "invalid", name: "subagent", arguments: args })).toThrow();
  });

  it.each(["none", "auto"])("accepts agentsMd %s through Pi's validator", (agentsMd) => {
    const args = { task: "review", agentsMd };
    expect(validateToolArguments(subagentTool, { type: "toolCall", id: "valid", name: "subagent", arguments: args })).toEqual(args);
  });

  it("registers model-facing help from TOOL_PROMPTS for every tool and parameter", () => {
    const tools = registeredToolsFromFactory();
    for (const [name, prompt] of [
      ["subagent", TOOL_PROMPTS.subagent],
      ["subagent_resume", TOOL_PROMPTS.subagentResume],
      ["subagent_list", TOOL_PROMPTS.subagentList],
    ] as const) {
      const tool = tools.find((tool) => tool.name === name);
      assert(tool && IsObject(tool.parameters));
      expect(tool.description.trim().length).toBeGreaterThan(0);
      expect(tool.promptSnippet?.trim().length).toBeGreaterThan(0);
      expect(tool.promptGuidelines?.length).toBeGreaterThan(0);
      expect(tool.promptGuidelines?.every((guideline) => guideline.trim().length > 0)).toBe(true);
      expect(tool).toMatchObject({
        description: prompt.description,
        promptSnippet: prompt.promptSnippet,
        promptGuidelines: prompt.promptGuidelines,
      });
      expect(Object.keys(tool.parameters.properties).sort()).toEqual(
        Object.keys(prompt.parameterDescriptions).sort(),
      );
      for (const [parameterName, description] of Object.entries(prompt.parameterDescriptions)) {
        const parameter = tool.parameters.properties[parameterName];
        expect(parameter).toHaveProperty("description", expect.stringMatching(/\S/));
        expect(parameter).toMatchObject({ description });
      }
    }
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
