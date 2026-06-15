import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { formatRunDetails } from "./render.js";
import type { SubagentRunView } from "./types.js";

export type AppendTextFile = (filePath: string, text: string) => Promise<void>;
export type CreateTextFile = (filePath: string, text: string) => Promise<void>;
export type ArtifactLogger = (message: string, error: unknown) => void;

export interface DegradedActivityLogOptions {
  appendFile?: AppendTextFile;
  createFile?: CreateTextFile;
  logger?: ArtifactLogger;
}

export interface ActivityLogStartedEvent {
  timestamp: string;
  path: readonly string[];
  episodeId: string;
  sessionFile: string;
}

// Keep this writer status-only. Child session JSONL files are the canonical transcripts;
// this Markdown file is for tail-friendly lifecycle and activity breadcrumbs.
export class QueuedActivityLogWriter {
  private pending: Promise<void> = Promise.resolve();
  private lastStatus: string | undefined;

  constructor(
    private readonly activityLogPath: string,
    private readonly activityPath: readonly string[],
    private readonly sessionFile: string,
    private readonly options: DegradedActivityLogOptions = {},
  ) {}

  appendStatus(timestamp: string, activity: string): void {
    const status = oneLine(activity);
    if (status === this.lastStatus) return;
    this.lastStatus = status;
    this.enqueue(formatActivityLogStatusLine(timestamp, this.activityPath, status));
  }

  appendFinished(timestamp: string, run: SubagentRunView, errorMessage?: string): void {
    this.enqueue(formatActivityLogFinishedLine(timestamp, this.activityPath, this.sessionFile, run, errorMessage));
  }

  async drain(): Promise<void> {
    await this.pending;
  }

  private enqueue(text: string): void {
    this.pending = this.pending.then(async () => {
      await appendActivityLogText(this.activityLogPath, text, this.options);
    });
  }
}

export async function ensureActivityLogHeader(activityLogPath: string, rootSessionFile: string, createdAt: string, options: DegradedActivityLogOptions = {}): Promise<boolean> {
  const createFile = options.createFile ?? defaultCreateFile;
  const logger = options.logger ?? console.error;
  try {
    await mkdir(path.dirname(activityLogPath), { recursive: true });
    await createFile(activityLogPath, activityLogHeader(activityLogPath, rootSessionFile, createdAt));
    return true;
  } catch (error: unknown) {
    if (isAlreadyExists(error)) return true;
    logger(`Could not create subagent activity log ${activityLogPath}`, error);
    return false;
  }
}

export async function appendActivityLogStarted(activityLogPath: string, event: ActivityLogStartedEvent, options: DegradedActivityLogOptions = {}): Promise<boolean> {
  return appendActivityLogText(activityLogPath, formatActivityLogStartedLine(event), options);
}

export async function appendActivityLogFinished(
  activityLogPath: string,
  timestamp: string,
  activityPath: readonly string[],
  sessionFile: string,
  run: SubagentRunView,
  errorMessage?: string,
  options: DegradedActivityLogOptions = {},
): Promise<boolean> {
  return appendActivityLogText(activityLogPath, formatActivityLogFinishedLine(timestamp, activityPath, sessionFile, run, errorMessage), options);
}

async function appendActivityLogText(filePath: string, text: string, options: DegradedActivityLogOptions = {}): Promise<boolean> {
  const appendFile = options.appendFile ?? defaultAppendFile;
  const logger = options.logger ?? console.error;
  const output = text.endsWith("\n") ? text : `${text}\n`;
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(filePath, output);
    return true;
  } catch (error: unknown) {
    logger(`Could not append subagent activity log ${filePath}`, error);
    return false;
  }
}

function activityLogHeader(activityLogPath: string, rootSessionFile: string, createdAt: string): string {
  return [
    "# Subagents",
    "",
    `Root session: ${rootSessionFile}`,
    `Activity log: ${activityLogPath}`,
    `Created at: ${createdAt}`,
    "",
    "This file is a compact status stream, not a transcript. Child session JSONL files are canonical.",
    "",
    "## Activity",
    "",
  ].join("\n");
}

function formatActivityLogStartedLine(event: ActivityLogStartedEvent): string {
  return `- ${event.timestamp} started ${formatActivityPath(event.path)} — episode ${event.episodeId} — session: ${event.sessionFile}\n`;
}

function formatActivityLogStatusLine(timestamp: string, activityPath: readonly string[], status: string): string {
  return `- ${timestamp} ${formatActivityPath(activityPath)}: ${status}\n`;
}

function formatActivityLogFinishedLine(timestamp: string, activityPath: readonly string[], sessionFile: string, run: SubagentRunView, errorMessage?: string): string {
  const details = [formatRunDetails(run)];
  if (errorMessage) details.push(`error: ${oneLine(errorMessage)}`);
  details.push(`session: ${sessionFile}`);
  return `- ${timestamp} ${run.status} ${formatActivityPath(activityPath)} — ${details.join(" — ")}\n`;
}

function formatActivityPath(activityPath: readonly string[]): string {
  if (activityPath.length === 0) throw new Error("Cannot render an empty subagent activity path.");
  return activityPath.join(" -> ");
}

async function defaultAppendFile(filePath: string, text: string): Promise<void> {
  await appendFile(filePath, text, "utf8");
}

async function defaultCreateFile(filePath: string, text: string): Promise<void> {
  await writeFile(filePath, text, { encoding: "utf8", flag: "wx" });
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST";
}
