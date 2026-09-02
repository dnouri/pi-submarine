import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import { listSubagents, resolveListingCwd } from "../src/listing.js";
import type { SubagentModelRegistry } from "../src/models.js";

const tempRoots: string[] = [];

async function tempRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "pi-submarine-listing-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeAgent(filePath: string, description: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `---\ndescription: ${description}\n---\n\nYou help.\n`, "utf8");
}

function fakeModel(fields: {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>;
}): Model<Api> {
  return fields as unknown as Model<Api>;
}

function fakeRegistry(all: Model<Api>[], authenticated: Model<Api>[]): SubagentModelRegistry {
  const authenticatedKeys = new Set(authenticated.map((model) => `${model.provider}/${model.id}`));
  return {
    getAll: () => all,
    hasConfiguredAuth: (model: Model<Api>) => authenticatedKeys.has(`${model.provider}/${model.id}`),
  };
}

const emptyRegistry = fakeRegistry([], []);

describe("subagent_list cwd resolution", () => {
  it("defaults cwd to the calling session cwd", async () => {
    const root = await tempRoot();
    await mkdir(root, { recursive: true });

    await expect(resolveListingCwd({}, { cwd: root, modelRegistry: emptyRegistry })).resolves.toBe(root);
  });

  it("resolves relative cwd from the calling session cwd", async () => {
    const root = await tempRoot();
    const child = path.join(root, "child dir");
    await mkdir(child, { recursive: true });

    await expect(resolveListingCwd({ cwd: "child dir" }, { cwd: root, modelRegistry: emptyRegistry })).resolves.toBe(child);
  });

  it("fails clearly when no cwd is available", async () => {
    await expect(resolveListingCwd({}, { modelRegistry: emptyRegistry })).rejects.toThrow("subagent_list requires a cwd");
  });

  it("fails clearly for missing cwd paths", async () => {
    const root = await tempRoot();

    await expect(resolveListingCwd({ cwd: "missing" }, { cwd: root, modelRegistry: emptyRegistry })).rejects.toThrow(
      "cwd does not exist or is not a directory",
    );
  });
});

describe("subagent_list tool behavior", () => {
  it("lists the special omitted-agent mode even when no markdown agents exist", async () => {
    const root = await tempRoot();
    await mkdir(root, { recursive: true });

    const result = await listSubagents({}, { cwd: root, modelRegistry: emptyRegistry }, { userAgentsDir: path.join(root, "missing-user-agents") });

    expect(result.content[0]?.text).toContain(`Available subagents for ${root}:`);
    expect(result.content[0]?.text).toContain("Special mode:\n- omit agent: run the default `subagent`");
    expect(result.content[0]?.text).toContain("Markdown agents:\n- none found");
    expect(result.details).toEqual({
      status: "listed",
      count: 0,
      cwd: root,
      sourceCounts: { user: 0, project: 0 },
      agentDirectories: { user: path.join(root, "missing-user-agents"), project: null },
      models: [],
      currentModel: null,
    });
  });

  it("lists visible markdown agents with source labels, descriptions, and paths", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    const userAgentsDir = path.join(root, "agent", "agents");
    await mkdir(cwd, { recursive: true });
    await writeAgent(path.join(userAgentsDir, "researcher.md"), "User researcher");
    await writeAgent(path.join(userAgentsDir, "reviewer.md"), "User reviewer");
    await writeAgent(path.join(cwd, ".pi", "agents", "reviewer.md"), "Project reviewer");

    const result = await listSubagents({}, { cwd, modelRegistry: emptyRegistry }, { userAgentsDir });
    const text = result.content[0]?.text ?? "";

    expect(text).toContain("- researcher (user) — User researcher");
    expect(text).toContain(`  path: ${path.join(userAgentsDir, "researcher.md")}`);
    expect(text).toContain("- reviewer (project) — Project reviewer");
    expect(text).toContain(`  path: ${path.join(cwd, ".pi", "agents", "reviewer.md")}`);
    expect(text).not.toContain("User reviewer");
    expect(result.details).toEqual({
      status: "listed",
      count: 2,
      cwd,
      sourceCounts: { user: 1, project: 1 },
      agentDirectories: { user: userAgentsDir, project: path.join(cwd, ".pi", "agents") },
      models: [],
      currentModel: null,
    });
  });

  it("warns when explicit cwd hides project agents visible from the caller cwd", async () => {
    const root = await tempRoot();
    const project = path.join(root, "project");
    const scratch = path.join(root, "scratch", "experiment-1");
    const userAgentsDir = path.join(root, "missing-user-agents");
    const agentPath = path.join(project, ".pi", "agents", "history.md");
    await mkdir(path.dirname(agentPath), { recursive: true });
    await mkdir(scratch, { recursive: true });
    await writeAgent(agentPath, "Project history");

    const result = await listSubagents({ cwd: scratch }, { cwd: project, modelRegistry: emptyRegistry }, { userAgentsDir });
    const text = result.content[0]?.text ?? "";

    expect(text).toContain(`Available subagents for ${scratch}:`);
    expect(text).toContain("Markdown agents:\n- none found");
    expect(text).toContain("Warnings:");
    expect(text).toContain("explicit cwd hides the caller project's agent directory");
    expect(text).toContain(path.join(project, ".pi", "agents"));
    expect(text).toContain("omit cwd");
    expect(text.indexOf("Callable models:")).toBeGreaterThan(-1);
    expect(text.indexOf("Callable models:")).toBeLessThan(text.indexOf("Warnings:"));
  });

  it("does not require a persisted parent session", async () => {
    const root = await tempRoot();
    await mkdir(root, { recursive: true });

    const result = await listSubagents({}, { cwd: root, modelRegistry: emptyRegistry }, { userAgentsDir: path.join(root, "missing-user-agents") });

    expect(result.content[0]?.text).toContain("Available subagents");
  });
});

describe("subagent_list callable models", () => {
  const glm = fakeModel({
    provider: "zai",
    id: "glm-5.3",
    name: "GLM 5.3",
    reasoning: true,
    thinkingLevelMap: { off: null, minimal: null, low: "adaptive", medium: null, high: "adaptive", xhigh: null },
  });
  const glmFlash = fakeModel({ provider: "zai", id: "glm-5.3-flash", name: "GLM 5.3 Flash", reasoning: false });
  const other = fakeModel({ provider: "other", id: "other-model", name: "Other Model", reasoning: true });

  it("renders one line per authenticated model with thinking levels, sorted by provider/id", async () => {
    const root = await tempRoot();
    await mkdir(root, { recursive: true });

    const registry = fakeRegistry([glmFlash, other, glm], [other, glmFlash, glm]);
    const result = await listSubagents(
      {},
      { cwd: root, modelRegistry: registry },
      { userAgentsDir: path.join(root, "missing-user-agents") },
    );
    const text = result.content[0]?.text ?? "";

    expect(text).toContain("Markdown agents:\n- none found\n\nCallable models:");
    expect(text).toContain(
      "Callable models:\n- other/other-model — thinking: off, minimal, low, medium, high\n- zai/glm-5.3 — thinking: low, high\n- zai/glm-5.3-flash — thinking: off",
    );
    expect(text).not.toContain(" — current");
    expect(result.details.models).toEqual([
      { provider: "other", id: "other-model", name: "Other Model", reasoning: true, thinkingLevels: ["off", "minimal", "low", "medium", "high"] },
      { provider: "zai", id: "glm-5.3", name: "GLM 5.3", reasoning: true, thinkingLevels: ["low", "high"] },
      { provider: "zai", id: "glm-5.3-flash", name: "GLM 5.3 Flash", reasoning: false, thinkingLevels: ["off"] },
    ]);
    expect(result.details.currentModel).toBeNull();
  });

  it("filters out models without configured auth", async () => {
    const root = await tempRoot();
    await mkdir(root, { recursive: true });

    const registry = fakeRegistry([glm, glmFlash], [glm]);
    const result = await listSubagents(
      {},
      { cwd: root, modelRegistry: registry },
      { userAgentsDir: path.join(root, "missing-user-agents") },
    );
    const text = result.content[0]?.text ?? "";

    expect(text).toContain("Callable models:\n- zai/glm-5.3 — thinking: low, high");
    expect(text).not.toContain("glm-5.3-flash");
    expect(result.details.models).toEqual([
      { provider: "zai", id: "glm-5.3", name: "GLM 5.3", reasoning: true, thinkingLevels: ["low", "high"] },
    ]);
  });

  it("marks the current model in text and details", async () => {
    const root = await tempRoot();
    await mkdir(root, { recursive: true });

    const registry = fakeRegistry([glm, glmFlash], [glm, glmFlash]);
    const result = await listSubagents(
      {},
      { cwd: root, modelRegistry: registry, model: glmFlash },
      { userAgentsDir: path.join(root, "missing-user-agents") },
    );
    const text = result.content[0]?.text ?? "";
    const lines = text.split("\n");

    expect(lines).toContain("- zai/glm-5.3-flash — thinking: off — current");
    expect(lines).toContain("- zai/glm-5.3 — thinking: low, high");
    expect(result.details.currentModel).toBe("zai/glm-5.3-flash");
  });

  it("renders thinking: off for non-reasoning models", async () => {
    const root = await tempRoot();
    await mkdir(root, { recursive: true });

    const registry = fakeRegistry([glmFlash], [glmFlash]);
    const result = await listSubagents(
      {},
      { cwd: root, modelRegistry: registry },
      { userAgentsDir: path.join(root, "missing-user-agents") },
    );

    expect(result.content[0]?.text).toContain("Callable models:\n- zai/glm-5.3-flash — thinking: off");
  });

  it("renders - none authenticated when no models have configured auth", async () => {
    const root = await tempRoot();
    await mkdir(root, { recursive: true });

    const registry = fakeRegistry([glm, glmFlash], []);
    const result = await listSubagents(
      {},
      { cwd: root, modelRegistry: registry, model: glm },
      { userAgentsDir: path.join(root, "missing-user-agents") },
    );
    const text = result.content[0]?.text ?? "";

    expect(text).toContain("Callable models:\n- none authenticated");
    expect(text).not.toContain(" — current");
    expect(result.details.models).toEqual([]);
    expect(result.details.currentModel).toBe("zai/glm-5.3");
  });
});
