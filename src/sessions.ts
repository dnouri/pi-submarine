import { stat } from "node:fs/promises";
import path from "node:path";

export interface SubagentsRoot {
  subagentsDir: string;
  parentEpisodeId: string | null;
}

export function resolveSubagentsRoot(parentSessionFile: string, nestedParentEpisodeId: string | null): SubagentsRoot {
  const sessionFile = path.resolve(parentSessionFile);
  const sessionDir = path.dirname(sessionFile);

  if (path.basename(sessionDir).endsWith(".subagents")) {
    return { subagentsDir: sessionDir, parentEpisodeId: nestedParentEpisodeId };
  }

  return { subagentsDir: `${sessionFile}.subagents`, parentEpisodeId: null };
}

export function manifestPathForSubagentsRoot(subagentsDir: string): string {
  return path.join(subagentsDir, "manifest.jsonl");
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
