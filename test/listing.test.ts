import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listSubagents, resolveListingCwd } from "../src/listing.js";

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

describe("subagent_list cwd resolution", () => {
  it("defaults cwd to the calling session cwd", async () => {
    const root = await tempRoot();
    await mkdir(root, { recursive: true });

    await expect(resolveListingCwd({}, { cwd: root })).resolves.toBe(root);
  });

  it("resolves relative cwd from the calling session cwd", async () => {
    const root = await tempRoot();
    const child = path.join(root, "child dir");
    await mkdir(child, { recursive: true });

    await expect(resolveListingCwd({ cwd: "child dir" }, { cwd: root })).resolves.toBe(child);
  });

  it("fails clearly when no cwd is available", async () => {
    await expect(resolveListingCwd({}, {})).rejects.toThrow("subagent_list requires a cwd");
  });

  it("fails clearly for missing cwd paths", async () => {
    const root = await tempRoot();

    await expect(resolveListingCwd({ cwd: "missing" }, { cwd: root })).rejects.toThrow("cwd does not exist or is not a directory");
  });
});

describe("subagent_list tool behavior", () => {
  it("lists the special omitted-agent mode even when no markdown agents exist", async () => {
    const root = await tempRoot();
    await mkdir(root, { recursive: true });

    const result = await listSubagents({}, { cwd: root }, { userAgentsDir: path.join(root, "missing-user-agents") });

    expect(result.content[0]?.text).toContain(`Available subagents for ${root}:`);
    expect(result.content[0]?.text).toContain("Special mode:\n- omit agent: run the default `subagent`");
    expect(result.content[0]?.text).toContain("Markdown agents:\n- none found");
    expect(result.details).toEqual({
      status: "listed",
      count: 0,
      cwd: root,
      sourceCounts: { user: 0, project: 0 },
      agentDirectories: { user: path.join(root, "missing-user-agents"), project: null },
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

    const result = await listSubagents({}, { cwd }, { userAgentsDir });
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

    const result = await listSubagents({ cwd: scratch }, { cwd: project }, { userAgentsDir });
    const text = result.content[0]?.text ?? "";

    expect(text).toContain(`Available subagents for ${scratch}:`);
    expect(text).toContain("Markdown agents:\n- none found");
    expect(text).toContain("Warnings:");
    expect(text).toContain("explicit cwd hides the caller project's agent directory");
    expect(text).toContain(path.join(project, ".pi", "agents"));
    expect(text).toContain("omit cwd");
  });

  it("does not require a persisted parent session", async () => {
    const root = await tempRoot();
    await mkdir(root, { recursive: true });

    const result = await listSubagents({}, { cwd: root }, { userAgentsDir: path.join(root, "missing-user-agents") });

    expect(result.content[0]?.text).toContain("Available subagents");
  });
});
