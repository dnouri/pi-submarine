import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ManifestRecord } from "./types.js";

export type StartedManifestRecord = Extract<ManifestRecord, { type: "started" }>;
export type EpisodeStartedManifestRecord = Extract<ManifestRecord, { type: "started" | "resume_started" }>;

export type AppendTextFile = (filePath: string, text: string) => Promise<void>;
export type ArtifactLogger = (message: string, error: unknown) => void;

export interface DegradedAppendOptions {
  appendFile?: AppendTextFile;
  logger?: ArtifactLogger;
}

export function serializeManifestRecord(record: ManifestRecord): string {
  return `${JSON.stringify(record)}\n`;
}

export async function appendManifestRecord(filePath: string, record: ManifestRecord, options: DegradedAppendOptions = {}): Promise<boolean> {
  const appendFile = options.appendFile ?? defaultAppendFile;
  const logger = options.logger ?? console.error;
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(filePath, serializeManifestRecord(record));
    return true;
  } catch (error: unknown) {
    logger(`Could not append subagent manifest ${filePath}`, error);
    return false;
  }
}

export async function readManifestRecords(filePath: string): Promise<ManifestRecord[]> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  return content
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as ManifestRecord);
}

export function findLatestEpisodeStartedRecordBySessionFile(records: ManifestRecord[], sessionFile: string): EpisodeStartedManifestRecord | undefined {
  const normalizedSessionFile = path.resolve(sessionFile);
  const matches = records.filter(
    (record): record is EpisodeStartedManifestRecord => (record.type === "started" || record.type === "resume_started") && path.resolve(record.sessionFile) === normalizedSessionFile,
  );
  return matches.at(-1);
}

export function findParentEpisodeId(records: ManifestRecord[], sessionFile: string): string | null {
  return findLatestEpisodeStartedRecordBySessionFile(records, sessionFile)?.episodeId ?? null;
}

export function findStartedRecordsBySessionId(records: ManifestRecord[], sessionId: string): StartedManifestRecord[] {
  return records.filter((record): record is StartedManifestRecord => record.type === "started" && record.sessionId === sessionId);
}

export function requireUniqueStartedRecordBySessionId(records: ManifestRecord[], sessionId: string): StartedManifestRecord {
  const matches = findStartedRecordsBySessionId(records, sessionId);
  if (matches.length === 0) {
    throw new Error(`No subagent session found for session ID '${sessionId}' in the current parent/root session.`);
  }
  if (matches.length > 1) {
    throw new Error(`Multiple subagent sessions found for session ID '${sessionId}' in the current parent/root session.`);
  }
  return matches[0]!;
}

async function defaultAppendFile(filePath: string, text: string): Promise<void> {
  await appendFile(filePath, text, "utf8");
}
