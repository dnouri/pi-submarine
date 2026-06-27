import { stat } from "node:fs/promises";
import path from "node:path";

export interface SubagentsRoot {
  rootSessionFile: string;
  subagentsDir: string;
  activityLogPath: string;
  parentEpisodeId: string | null;
}

export function isSubagentsDirectoryName(name: string): boolean {
  return name.endsWith(".subagents");
}

export function resolveSubagentsRoot(parentSessionFile: string, nestedParentEpisodeId: string | null): SubagentsRoot {
  const sessionFile = path.resolve(parentSessionFile);
  const sessionDir = path.dirname(sessionFile);

  if (isSubagentsDirectoryName(path.basename(sessionDir))) {
    const rootSessionFile = path.join(path.dirname(sessionDir), path.basename(sessionDir, ".subagents"));
    return {
      rootSessionFile,
      subagentsDir: sessionDir,
      activityLogPath: activityLogPathForRootSessionFile(rootSessionFile),
      parentEpisodeId: nestedParentEpisodeId,
    };
  }

  return {
    rootSessionFile: sessionFile,
    subagentsDir: `${sessionFile}.subagents`,
    activityLogPath: activityLogPathForRootSessionFile(sessionFile),
    parentEpisodeId: null,
  };
}

export function manifestPathForSubagentsRoot(subagentsDir: string): string {
  return path.join(subagentsDir, "manifest.jsonl");
}

export function activityLogPathForRootSessionFile(rootSessionFile: string): string {
  return `${path.resolve(rootSessionFile)}.subagents.md`;
}

export function activityLogPathForSubagentsRoot(subagentsDir: string): string {
  return activityLogPathForRootSessionFile(rootSessionFileForSubagentsDirectory(subagentsDir));
}

function rootSessionFileForSubagentsDirectory(subagentsDir: string): string {
  const resolvedSubagentsDir = path.resolve(subagentsDir);
  const directoryName = path.basename(resolvedSubagentsDir);
  if (!isSubagentsDirectoryName(directoryName)) throw new Error(`Invalid subagents directory: ${subagentsDir}`);
  return path.join(path.dirname(resolvedSubagentsDir), directoryName.slice(0, -".subagents".length));
}

export function resolveFreshCwd(input: { cwd?: string }, parentCwd: string | undefined): string {
  if (!parentCwd) throw new Error("subagent fresh execution requires a cwd from the calling session.");
  return path.resolve(parentCwd, input.cwd ?? ".");
}

export async function assertDirectoryExists(cwd: string): Promise<void> {
  try {
    if (!(await stat(cwd)).isDirectory()) throw new Error();
  } catch {
    throw new Error(`cwd does not exist or is not a directory: ${cwd}`);
  }
}
