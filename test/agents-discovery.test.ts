import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverMarkdownAgents, findNearestProjectAgentsDir, resolveMarkdownAgent } from "../src/agents.js";

const tempRoots: string[] = [];

async function tempRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "pi-submarine-agents-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeAgent(filePath: string, description: string, body = "You are useful.") {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `---\ndescription: ${description}\n---\n\n${body}\n`, "utf8");
}

describe("cwd-scoped markdown agent discovery", () => {
  it("loads user agents from the configured user agents directory", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    const userAgentsDir = path.join(root, "agent", "agents");
    await mkdir(cwd, { recursive: true });
    await writeAgent(path.join(userAgentsDir, "reviewer.md"), "User reviewer");

    const result = await discoverMarkdownAgents({ cwd, userAgentsDir });

    expect(result.agents.map((agent) => agent.name)).toEqual(["reviewer"]);
    expect(result.agents[0]?.description).toBe("User reviewer");
    expect(result.agents[0]?.source).toBe("user");
    expect(result.sourceCounts).toEqual({ user: 1, project: 0 });
    expect(result.agentDirectories).toEqual({ user: userAgentsDir, project: null });
  });

  it("uses the nearest ancestor .pi/agents directory for project agents", async () => {
    const root = await tempRoot();
    const farProjectAgents = path.join(root, ".pi", "agents");
    const nearProjectAgents = path.join(root, "workspace", ".pi", "agents");
    const cwd = path.join(root, "workspace", "app", "src");
    await mkdir(cwd, { recursive: true });
    await writeAgent(path.join(farProjectAgents, "far.md"), "Far agent");
    await writeAgent(path.join(nearProjectAgents, "near.md"), "Near agent");

    await expect(findNearestProjectAgentsDir(cwd)).resolves.toBe(nearProjectAgents);
    const result = await discoverMarkdownAgents({ cwd, userAgentsDir: path.join(root, "missing-user-agents") });

    expect(result.agents.map((agent) => agent.name)).toEqual(["near"]);
    expect(result.agents[0]?.source).toBe("project");
    expect(result.sourceCounts).toEqual({ user: 0, project: 1 });
    expect(result.agentDirectories).toEqual({ user: path.join(root, "missing-user-agents"), project: nearProjectAgents });
  });

  it("lets project agents override user agents with the same filename stem", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    const userAgentsDir = path.join(root, "agent", "agents");
    await mkdir(cwd, { recursive: true });
    await writeAgent(path.join(userAgentsDir, "reviewer.md"), "User reviewer");
    await writeAgent(path.join(cwd, ".pi", "agents", "reviewer.md"), "Project reviewer");
    await writeAgent(path.join(userAgentsDir, "researcher.md"), "User researcher");

    const result = await discoverMarkdownAgents({ cwd, userAgentsDir });

    expect(result.agents.map((agent) => `${agent.name}:${agent.source}:${agent.description}`)).toEqual([
      "researcher:user:User researcher",
      "reviewer:project:Project reviewer",
    ]);
    expect(result.sourceCounts).toEqual({ user: 1, project: 1 });
  });

  it("treats an invalid same-stem project override as fatal", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    const userAgentsDir = path.join(root, "agent", "agents");
    await mkdir(cwd, { recursive: true });
    await writeAgent(path.join(userAgentsDir, "reviewer.md"), "User reviewer");
    await mkdir(path.join(cwd, ".pi", "agents"), { recursive: true });
    await writeFile(path.join(cwd, ".pi", "agents", "reviewer.md"), "---\ndescription: \"Bad\"\n---\nBody\n", "utf8");

    await expect(discoverMarkdownAgents({ cwd, userAgentsDir })).rejects.toThrow("Invalid project agent override");
  });

  it("ignores files outside the markdown-agent discovery rules", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    const agentsDir = path.join(cwd, ".pi", "agents");
    await mkdir(path.join(agentsDir, "nested"), { recursive: true });
    await writeAgent(path.join(agentsDir, "valid.md"), "Valid");
    await writeAgent(path.join(agentsDir, ".hidden.md"), "Hidden");
    await writeAgent(path.join(agentsDir, "upper.MD"), "Upper");
    await writeAgent(path.join(agentsDir, "flow.chain.md"), "Chain");
    await writeAgent(path.join(agentsDir, "nested", "nested.md"), "Nested");

    const result = await discoverMarkdownAgents({ cwd, userAgentsDir: path.join(root, "missing-user-agents") });

    expect(result.agents.map((agent) => agent.name)).toEqual(["valid"]);
  });

  it("warns and skips invalid non-overriding files during broad discovery", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    const agentsDir = path.join(cwd, ".pi", "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeAgent(path.join(agentsDir, "valid.md"), "Valid");
    await writeFile(path.join(agentsDir, "bad.md"), "---\ndescription: \"Bad\"\n---\nBody\n", "utf8");

    const result = await discoverMarkdownAgents({ cwd, userAgentsDir: path.join(root, "missing-user-agents") });

    expect(result.agents.map((agent) => agent.name)).toEqual(["valid"]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("bad.md");
  });

  it("resolves a requested named agent with source and makes invalid requested files fatal", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "project");
    const userAgentsDir = path.join(root, "agent", "agents");
    const agentsDir = path.join(cwd, ".pi", "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeAgent(path.join(userAgentsDir, "researcher.md"), "User researcher");
    await writeAgent(path.join(agentsDir, "reviewer.md"), "Project reviewer");
    await writeFile(path.join(agentsDir, "broken.md"), "---\ndescription: \"Bad\"\n---\nBody\n", "utf8");

    await expect(resolveMarkdownAgent(" researcher ", { cwd, userAgentsDir })).resolves.toMatchObject({
      name: "researcher",
      description: "User researcher",
      source: "user",
    });
    await expect(resolveMarkdownAgent(" reviewer ", { cwd, userAgentsDir })).resolves.toMatchObject({
      name: "reviewer",
      description: "Project reviewer",
      source: "project",
    });
    await expect(resolveMarkdownAgent("broken", { cwd, userAgentsDir })).rejects.toThrow("quoted values are invalid");
  });
});
