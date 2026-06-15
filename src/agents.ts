import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentResourceMode, AgentSelection, MarkdownAgent, MarkdownAgentSource, SkillResourceMode } from "./types.js";
import { namedAgentSelection, omittedAgentSelection } from "./render.js";

const FRONTMATTER_DELIMITER = "---";
const VALID_FRONTMATTER_KEYS = new Set(["description", "agentsMd", "skills"]);

export interface AgentDiscoveryResult {
  agents: MarkdownAgent[];
  warnings: string[];
  sourceCounts: Record<MarkdownAgentSource, number>;
  agentDirectories: {
    user: string;
    project: string | null;
  };
}

export interface AgentDiscoveryOptions {
  cwd: string;
  userAgentsDir?: string;
}

export class MissingMarkdownAgentError extends Error {
  readonly agentName: string;
  readonly cwd: string;

  constructor(agentName: string, cwd: string) {
    const resolvedCwd = path.resolve(cwd);
    super(`Subagent '${agentName}' not found for ${resolvedCwd}.`);
    this.name = "MissingMarkdownAgentError";
    this.agentName = agentName;
    this.cwd = resolvedCwd;
  }
}

export interface ParseMarkdownAgentOptions {
  filePath: string;
  name: string;
  source: MarkdownAgentSource;
}

export interface ParseMarkdownAgentFileOptions {
  name?: string;
  source: MarkdownAgentSource;
}

interface DirectoryAgentRead {
  name: string;
  filePath: string;
  agent?: MarkdownAgent;
  error?: Error;
}

export function selectOmittedAgent(): AgentSelection {
  return omittedAgentSelection();
}

export function selectNamedAgent(name: string, agentFile?: string): AgentSelection {
  return namedAgentSelection(name, agentFile);
}

export function validateRequestedAgentName(rawName: string): string {
  const name = rawName.trim();
  if (!name || name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new Error("Invalid subagent name: provide a non-empty filename stem without '/', '\\', or NUL. Omit agent for the default subagent mode.");
  }
  return name;
}

export function parseMarkdownAgent(content: string, options: ParseMarkdownAgentOptions): MarkdownAgent {
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const fail = (reason: string): never => {
    throw new Error(`Invalid agent file '${options.filePath}': ${reason}`);
  };

  if (lines[0] !== FRONTMATTER_DELIMITER) {
    fail("file must start with a line exactly equal to ---");
  }

  const closingIndex = lines.indexOf(FRONTMATTER_DELIMITER, 1);
  if (closingIndex === -1) {
    fail("missing closing delimiter line exactly equal to ---");
  }

  const fields = new Map<string, string>();
  for (let lineNumber = 2; lineNumber <= closingIndex; lineNumber++) {
    const line = lines[lineNumber - 1] ?? "";
    if (line === "") fail("blank frontmatter lines are not allowed");
    if (line.trimStart().startsWith("#")) fail("comments are not allowed in frontmatter");

    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) fail(`frontmatter line ${lineNumber} must be in key: value form`);

    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();

    if (!VALID_FRONTMATTER_KEYS.has(key)) fail(`unknown key '${key}'`);
    if (fields.has(key)) fail(`duplicate key '${key}'`);
    if (value.startsWith("\"") || value.startsWith("'")) fail("quoted values are invalid");
    if (value === "|" || value === ">") fail("YAML block scalars are invalid");
    if (value.startsWith("[") || value.endsWith("]")) fail("YAML arrays are invalid");

    fields.set(key, value);
  }

  const description = fields.get("description")?.trim() ?? "";
  if (description === "") fail("description is required and must be non-empty");

  const rawAgentsMd = fields.get("agentsMd") ?? "none";
  const agentsMd: AgentResourceMode = rawAgentsMd === "none" ? "none" : rawAgentsMd === "auto" ? "auto" : fail("agentsMd must be 'none' or 'auto'");

  const skills = parseSkills(fields.get("skills"), fail);
  const body = lines.slice(closingIndex + 1).join("\n").trim();
  if (!body) fail("markdown body is required");

  return {
    name: options.name,
    description,
    source: options.source,
    filePath: options.filePath,
    body,
    agentsMd,
    skills,
  };
}

export async function parseMarkdownAgentFile(filePath: string, options: ParseMarkdownAgentFileOptions): Promise<MarkdownAgent> {
  return parseMarkdownAgent(await readFile(filePath, "utf8"), {
    filePath,
    name: options.name ?? agentNameFromFilePath(filePath),
    source: options.source,
  });
}

export async function findNearestProjectAgentsDir(cwd: string): Promise<string | null> {
  let currentDir = path.resolve(cwd);
  while (true) {
    const candidate = path.join(currentDir, ".pi", "agents");
    if (await isDirectory(candidate)) return candidate;

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

export async function discoverMarkdownAgents(options: AgentDiscoveryOptions): Promise<AgentDiscoveryResult> {
  const userAgentsDir = options.userAgentsDir ?? path.join(getAgentDir(), "agents");
  const projectAgentsDir = await findNearestProjectAgentsDir(options.cwd);
  const warnings: string[] = [];
  const agentMap = new Map<string, MarkdownAgent>();

  const userReads = await readAgentsFromDirectory(userAgentsDir, "user");
  for (const read of userReads) {
    if (read.agent) agentMap.set(read.name, read.agent);
    else if (read.error) warnings.push(read.error.message);
  }

  if (projectAgentsDir) {
    const projectReads = await readAgentsFromDirectory(projectAgentsDir, "project");
    for (const read of projectReads) {
      if (read.agent) {
        agentMap.set(read.name, read.agent);
      } else if (read.error) {
        if (agentMap.has(read.name)) {
          throw new Error(`Invalid project agent override '${read.name}': ${read.error.message}`);
        }
        warnings.push(read.error.message);
      }
    }
  }

  const agents = [...agentMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  return {
    agents,
    warnings,
    sourceCounts: countAgentSources(agents),
    agentDirectories: { user: userAgentsDir, project: projectAgentsDir },
  };
}

export async function resolveMarkdownAgent(rawName: string, options: AgentDiscoveryOptions): Promise<MarkdownAgent> {
  const name = validateRequestedAgentName(rawName);
  const userAgentsDir = options.userAgentsDir ?? path.join(getAgentDir(), "agents");
  const projectAgentsDir = await findNearestProjectAgentsDir(options.cwd);

  const projectFile = projectAgentsDir ? path.join(projectAgentsDir, `${name}.md`) : undefined;
  if (projectFile && await isFile(projectFile)) {
    return parseMarkdownAgentFile(projectFile, { name, source: "project" });
  }

  const userFile = path.join(userAgentsDir, `${name}.md`);
  if (await isFile(userFile)) {
    return parseMarkdownAgentFile(userFile, { name, source: "user" });
  }

  throw new MissingMarkdownAgentError(name, options.cwd);
}

function parseSkills(raw: string | undefined, fail: (reason: string) => never): SkillResourceMode {
  if (raw === undefined) return "auto";
  if (raw === "auto" || raw === "none") return raw;
  if (raw.startsWith("[") || raw.endsWith("]")) fail("YAML arrays are invalid");
  if (raw === "") fail("skills must be 'auto', 'none', or a comma-separated list of skill names");

  const names = raw.split(",").map((item) => item.trim());
  if (names.some((name) => name === "")) fail("skills must not contain empty names");
  return { names };
}

async function readAgentsFromDirectory(dir: string, source: MarkdownAgentSource): Promise<DirectoryAgentRead[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error: unknown) {
    if (isNotFoundError(error)) return [];
    throw error;
  }

  const reads: DirectoryAgentRead[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!isDiscoverableAgentFile(entry.name) || !entry.isFile()) continue;

    const filePath = path.join(dir, entry.name);
    const name = agentNameFromFilePath(filePath);
    try {
      reads.push({ name, filePath, agent: await parseMarkdownAgentFile(filePath, { name, source }) });
    } catch (error: unknown) {
      reads.push({ name, filePath, error: error instanceof Error ? error : new Error(String(error)) });
    }
  }
  return reads;
}

function countAgentSources(agents: MarkdownAgent[]): Record<MarkdownAgentSource, number> {
  const sourceCounts: Record<MarkdownAgentSource, number> = { user: 0, project: 0 };
  for (const agent of agents) sourceCounts[agent.source] += 1;
  return sourceCounts;
}

function isDiscoverableAgentFile(fileName: string): boolean {
  return !fileName.startsWith(".") && fileName.endsWith(".md") && !fileName.endsWith(".chain.md");
}

function agentNameFromFilePath(filePath: string): string {
  return path.basename(filePath, ".md");
}

async function isDirectory(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
