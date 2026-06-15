export const SUBAGENT_TOOL_NAME = "subagent";
export const SUBAGENT_RESUME_TOOL_NAME = "subagent_resume";
export const SUBAGENT_LIST_TOOL_NAME = "subagent_list";
export const OMITTED_AGENT_LABEL = "subagent";

export type SubagentContextMode = "fresh" | "fork";

export interface SubagentParams {
  agent?: string;
  task: string;
  context?: SubagentContextMode;
  cwd?: string;
}

export interface SubagentResumeParams {
  sessionId: string;
  message: string;
}

export interface SubagentListParams {
  cwd?: string;
}

export interface TextToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

export type AgentResourceMode = "none" | "auto";
export type SkillResourceMode = "auto" | "none" | { names: string[] };
export type MarkdownAgentSource = "user" | "project";

export interface MarkdownAgent {
  name: string;
  description: string;
  source: MarkdownAgentSource;
  filePath: string;
  body: string;
  agentsMd: AgentResourceMode;
  skills: SkillResourceMode;
}

export type AgentSelection =
  | { kind: "omitted"; label: typeof OMITTED_AGENT_LABEL }
  | { kind: "named"; name: string; agentFile?: string };

export type SubagentRunStatus = "running" | "completed" | "failed" | "aborted";

export interface SubagentContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface SubagentRunView {
  /** Internal lifecycle episode ID; multiple episodes may share one child sessionId. */
  episodeId: string;
  sessionId: string;
  agent: string;
  status: SubagentRunStatus;
  turnCount: number;
  lastActivityAt: string;
  activity: string;
  activityLog: string;
  contextUsage?: SubagentContextUsage;
  children: SubagentRunView[];
}

export interface SubagentToolDetails {
  run: SubagentRunView;
}

export interface ManifestStartedRecord {
  type: "started";
  episodeId: string;
  sessionId: string;
  parentEpisodeId: string | null;
  agent: string;
  cwd: string;
  context: SubagentContextMode;
  sessionFile: string;
  activityLog: string;
  startedAt: string;
  agentFile?: string | null;
}

export interface ManifestFinishedRecord {
  type: "finished";
  episodeId: string;
  status: "completed" | "failed" | "aborted";
  finishedAt: string;
  error?: string;
}

export interface ManifestResumeStartedRecord {
  type: "resume_started";
  episodeId: string;
  sessionId: string;
  parentEpisodeId: string | null;
  agent: string;
  cwd: string;
  context: SubagentContextMode;
  sessionFile: string;
  activityLog: string;
  startedAt: string;
  agentFile?: string | null;
}

export interface ManifestResumeFinishedRecord {
  type: "resume_finished";
  episodeId: string;
  sessionId: string;
  status: "completed" | "failed" | "aborted";
  finishedAt: string;
  error?: string;
}

export type ManifestRecord = ManifestStartedRecord | ManifestFinishedRecord | ManifestResumeStartedRecord | ManifestResumeFinishedRecord;
