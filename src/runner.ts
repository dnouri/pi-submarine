import { mkdir, open, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DefaultResourceLoader,
  createAgentSession,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentToolUpdateCallback,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  type ExtensionContext,
  type ExtensionFactory,
  type ResourceLoader,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { MissingMarkdownAgentError, resolveMarkdownAgent } from "./agents.js";
import { cloneRunView, createActivityState, createInitialRunView, reduceActivityEvent } from "./activity.js";
import { QueuedActivityLogWriter, appendActivityLogFinished, appendActivityLogStarted, ensureActivityLogHeader, type DegradedActivityLogOptions } from "./activity-log.js";
import { appendManifestRecord, findLatestEpisodeStartedRecordBySessionFile, readManifestRecords, requireUniqueStartedRecordBySessionId, type DegradedAppendOptions, type EpisodeStartedManifestRecord, type StartedManifestRecord } from "./manifest.js";
import { errorHeading, namedAgentSelection, omittedAgentSelection, renderSubagentInterrupted, renderSubagentProgress, renderSubagentRecoverableError, renderSubagentResult } from "./render.js";
import { assertDirectoryExists, manifestPathForSubagentsRoot, resolveFreshCwd, resolveSubagentsRoot, type SubagentsRoot } from "./sessions.js";
import { namedForkPrompt } from "./tool-prompts.js";
import { OMITTED_AGENT_LABEL, type AgentSelection, type MarkdownAgent, type SubagentContextMode, type SubagentContextUsage, type SubagentParams, type SubagentResumeParams, type SubagentToolDetails, type TextToolResult } from "./types.js";

type DefaultResourceLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];
type ProjectTrustedSettingsManager = ReturnType<typeof SettingsManager.create>;
type ChildAgentSession = Pick<AgentSession, "prompt" | "getLastAssistantText" | "getContextUsage" | "subscribe" | "bindExtensions" | "abort" | "dispose" | "messages">;
type ChildSessionResult = Pick<CreateAgentSessionResult, "session">;
type ManifestRecords = Awaited<ReturnType<typeof readManifestRecords>>;

export interface SubagentPromptProfile {
  selection: AgentSelection;
  agentName: string;
  agentFile?: string;
  agentBody?: string;
  agentsMd: "none" | "auto";
  skills: MarkdownAgent["skills"];
}

export interface RunnerOptions {
  deps?: Partial<RunnerDependencies>;
  extensionFactories?: ExtensionFactory[];
}

export interface RunnerDependencies {
  now: () => string;
  createEpisodeId: () => string;
  getAgentDir: () => string;
  createFreshSessionManager: (cwd: string, sessionDir: string) => SessionManager;
  openSessionManager: (sessionFile: string, sessionDir: string) => SessionManager;
  createResourceLoader: (options: DefaultResourceLoaderOptions) => ResourceLoader;
  createAgentSession: (options: CreateAgentSessionOptions) => Promise<ChildSessionResult>;
  artifactOptions?: {
    activityLog?: DegradedActivityLogOptions;
    manifest?: DegradedAppendOptions;
  };
}

interface BaseRunPlan {
  context: SubagentContextMode;
  effectiveCwd: string;
  profile: SubagentPromptProfile;
  root: SubagentsRoot;
  manifestPath: string;
  parentDepth: number;
  parentPath: string[];
  agentDir: string;
  settingsManager: ProjectTrustedSettingsManager;
  resourceLoader: ResourceLoader;
  userPrompt: string;
}

interface FreshRunPlan extends BaseRunPlan {
  context: "fresh";
  inheritParentModel: true;
}

interface ForkRunPlan extends BaseRunPlan {
  context: "fork";
  currentLeafId: string;
  sourceSessionManager: SessionManager;
  inheritParentModel: false;
}

type RunPlan = FreshRunPlan | ForkRunPlan;

type ChildSessionPlan = Pick<BaseRunPlan, "effectiveCwd" | "agentDir" | "settingsManager" | "resourceLoader"> & {
  inheritParentModel: boolean;
};

interface ResumeRunPlan extends ChildSessionPlan {
  profile: SubagentPromptProfile;
  manifestPath: string;
  parentEpisodeId: string | null;
  parentDepth: number;
  startedRecord: StartedManifestRecord;
  childSessionManager: SessionManager;
  childSessionFile: string;
  activityPath: string[];
  rootSessionFile: string;
  activityLogPath: string;
  userPrompt: string;
}

interface StartedRun {
  run: SubagentToolDetails["run"];
  childSessionManager: SessionManager;
  childSessionFile: string;
  activityPath: string[];
}

const MAX_SUBAGENT_DEPTH = 4;
const PARENT_ABORT_ERROR = "Interrupted by parent abort.";
const runtimeEpisodeBySessionFile = new Map<string, string>();
const runtimeSessionFileByEpisode = new Map<string, string>();
const runtimeEpisodeDepthByEpisode = new Map<string, number>();
const runtimeActivityPathByEpisode = new Map<string, string[]>();
const activeChildSessionFiles = new Set<string>();

class SubagentInterruptedError extends Error {
  constructor() {
    super(PARENT_ABORT_ERROR);
    this.name = "SubagentInterruptedError";
  }
}

function isSubagentInterruptedError(error: unknown): error is SubagentInterruptedError {
  return error instanceof SubagentInterruptedError;
}

export function omittedSubagentProfile(): SubagentPromptProfile {
  return {
    selection: omittedAgentSelection(),
    agentName: OMITTED_AGENT_LABEL,
    agentsMd: "none",
    skills: "auto",
  };
}

export function namedSubagentProfile(agent: MarkdownAgent): SubagentPromptProfile {
  return {
    selection: namedAgentSelection(agent.name, agent.filePath),
    agentName: agent.name,
    agentFile: agent.filePath,
    agentBody: agent.body,
    agentsMd: agent.agentsMd,
    skills: agent.skills,
  };
}

export function buildFreshResourceLoaderOptions(profile: SubagentPromptProfile, options: { cwd: string; agentDir: string; settingsManager?: ProjectTrustedSettingsManager; extensionFactories?: ExtensionFactory[] }): DefaultResourceLoaderOptions {
  const loaderOptions: DefaultResourceLoaderOptions = {
    cwd: options.cwd,
    agentDir: options.agentDir,
  };

  if (options.settingsManager) loaderOptions.settingsManager = options.settingsManager;
  if (options.extensionFactories && options.extensionFactories.length > 0) loaderOptions.extensionFactories = options.extensionFactories;
  if (profile.agentsMd === "none") loaderOptions.noContextFiles = true;
  if (profile.agentBody) loaderOptions.appendSystemPromptOverride = (base) => [...base, profile.agentBody ?? ""];

  if (profile.skills === "none") {
    loaderOptions.noSkills = true;
  } else if (typeof profile.skills === "object") {
    const requestedNames = profile.skills.names;
    loaderOptions.skillsOverride = (base) => {
      const visibleByName = new Map(base.skills.filter((skill) => !skill.disableModelInvocation).map((skill) => [skill.name, skill]));
      const missing = requestedNames.filter((name) => !visibleByName.has(name));
      if (missing.length > 0) {
        throw new Error(`Unavailable skill(s) for subagent '${profile.agentName}': ${missing.join(", ")}`);
      }
      return {
        skills: requestedNames.map((name) => visibleByName.get(name)).filter((skill): skill is Skill => skill !== undefined),
        diagnostics: base.diagnostics,
      };
    };
  }

  return loaderOptions;
}

export function buildForkResourceLoaderOptions(options: { cwd: string; agentDir: string; settingsManager?: ProjectTrustedSettingsManager; extensionFactories?: ExtensionFactory[] }): DefaultResourceLoaderOptions {
  const loaderOptions: DefaultResourceLoaderOptions = {
    cwd: options.cwd,
    agentDir: options.agentDir,
  };

  if (options.settingsManager) loaderOptions.settingsManager = options.settingsManager;
  if (options.extensionFactories && options.extensionFactories.length > 0) loaderOptions.extensionFactories = options.extensionFactories;
  return loaderOptions;
}

function createProjectTrustedSettingsManager(cwd: string, agentDir: string): ProjectTrustedSettingsManager {
  // pi-submarine intentionally approves project-local Pi inputs for child sessions.
  // This keeps .pi settings/resources/packages, project .agents skills, and markdown agents
  // available without relying on Pi SDK defaults or a child CLI --approve flag.
  return SettingsManager.create(cwd, agentDir, { projectTrusted: true });
}

export function buildForkPrompt(profile: SubagentPromptProfile, task: string): string {
  if (profile.selection.kind === "omitted") return task;
  return namedForkPrompt(profile.agentName, profile.agentBody, task);
}

export async function runSubagent(
  params: SubagentParams,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<SubagentToolDetails> | undefined,
  ctx: ExtensionContext,
  options: RunnerOptions = {},
): Promise<TextToolResult & { details: SubagentToolDetails }> {
  const deps = { ...productionRunnerDependencies, ...options.deps };
  const requestedSelection = params.agent === undefined ? omittedAgentSelection() : namedAgentSelection(params.agent.trim() || params.agent);
  let plan: RunPlan | undefined;
  let run: SubagentToolDetails["run"] | undefined;
  let startedRun: StartedRun | undefined;
  let childSession: ChildAgentSession | undefined;
  let unsubscribe: (() => void) | undefined;
  let detachAbortHandler: (() => void) | undefined;
  let reservedChildSessionFile: string | undefined;
  let activityLogWriter: QueuedActivityLogWriter | undefined;

  try {
    plan = await prepareRun(params, signal, ctx, deps, options.extensionFactories);
    throwIfAborted(signal, "Subagent run was aborted before child execution.");

    startedRun = await startRunArtifacts(plan, deps);
    run = startedRun.run;
    reservedChildSessionFile = reserveActiveChildSession(startedRun.childSessionFile, run.sessionId);
    throwIfInterrupted(signal);
    emitUpdate(onUpdate, run);

    childSession = await createChildSession(plan, startedRun.childSessionManager, deps, ctx);
    await bindChildExtensions(childSession);
    const activeChildSession = childSession;
    const abortState = attachAbortHandler(signal, activeChildSession);
    detachAbortHandler = abortState.detach;
    activityLogWriter = new QueuedActivityLogWriter(run.activityLog, startedRun.activityPath, startedRun.childSessionFile, deps.artifactOptions?.activityLog);
    const activityState = createActivityState(run);
    unsubscribe = activeChildSession.subscribe((event) => {
      const reduction = reduceActivityEvent(activityState, event, deps.now());
      if (reduction.changed) {
        refreshContextUsage(activityState.run, activeChildSession);
        activityLogWriter?.appendStatus(activityState.run.lastActivityAt, activityState.run.activity);
        emitUpdate(onUpdate, activityState.run);
      }
    });

    const answer = await promptChildAndExtractAnswer(activeChildSession, startedRun.childSessionManager, plan.userPrompt, abortState);
    refreshContextUsage(run, activeChildSession);
    await activityLogWriter.drain();
    await completeRun(plan.manifestPath, startedRun, deps, onUpdate, activityLogWriter);
    forgetRuntimeEpisode(startedRun.run.episodeId);

    return {
      content: [{ type: "text", text: renderSubagentResult(plan.profile.selection, run.sessionId, answer) }],
      details: { run: cloneRunView(run) },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const interrupted = isSubagentInterruptedError(error);
    await activityLogWriter?.drain();
    if (run && childSession) refreshContextUsage(run, childSession);
    if (startedRun) await materializeChildSessionFile(startedRun.childSessionManager);
    if (startedRun && plan) {
      if (interrupted) await abortRun(plan.manifestPath, startedRun, deps, onUpdate, activityLogWriter);
      else await failRun(plan.manifestPath, startedRun, message, deps, onUpdate, activityLogWriter);
    }
    if (run) forgetRuntimeEpisode(run.episodeId);
    const selection = run ? agentSelectionFromRun(run, requestedSelection) : requestedSelection;
    if (interrupted && run) throw new Error(renderSubagentInterrupted(selection, run.sessionId));
    if (run) throw new Error(renderSubagentRecoverableError(selection, run.sessionId, message));
    throw new Error(`${errorHeading(selection)}\n\n${message}`);
  } finally {
    releaseActiveChildSession(reservedChildSessionFile);
    runCleanup("remove subagent abort listener", detachAbortHandler);
    runCleanup("unsubscribe subagent activity listener", unsubscribe);
    runCleanup("dispose subagent child session", () => childSession?.dispose());
  }
}

export async function runSubagentResume(
  params: SubagentResumeParams,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<SubagentToolDetails> | undefined,
  ctx: ExtensionContext,
  options: RunnerOptions = {},
): Promise<TextToolResult & { details: SubagentToolDetails }> {
  const deps = { ...productionRunnerDependencies, ...options.deps };
  let plan: ResumeRunPlan | undefined;
  let run: SubagentToolDetails["run"] | undefined;
  let childSession: ChildAgentSession | undefined;
  let unsubscribe: (() => void) | undefined;
  let detachAbortHandler: (() => void) | undefined;
  let reservedChildSessionFile: string | undefined;
  let activityLogWriter: QueuedActivityLogWriter | undefined;

  try {
    plan = await prepareResumeRun(params, signal, ctx, deps, options.extensionFactories, (sessionFile, sessionId) => {
      reservedChildSessionFile = reserveActiveChildSession(sessionFile, sessionId);
    });
    const startedAt = deps.now();
    run = createInitialRunView({
      episodeId: deps.createEpisodeId(),
      sessionId: plan.startedRecord.sessionId,
      agent: plan.startedRecord.agent,
      activityLog: plan.activityLogPath,
      now: startedAt,
    });
    await ensureActivityLogHeader(run.activityLog, plan.rootSessionFile, startedAt, deps.artifactOptions?.activityLog);
    await appendActivityLogStarted(run.activityLog, { timestamp: startedAt, path: plan.activityPath, episodeId: run.episodeId, sessionFile: plan.childSessionFile }, deps.artifactOptions?.activityLog);
    await appendManifestRecord(plan.manifestPath, {
      type: "resume_started",
      episodeId: run.episodeId,
      sessionId: run.sessionId,
      parentEpisodeId: plan.parentEpisodeId,
      agent: plan.profile.agentName,
      cwd: plan.startedRecord.cwd,
      context: plan.startedRecord.context,
      sessionFile: plan.childSessionFile,
      activityLog: run.activityLog,
      agentFile: plan.profile.agentFile ?? null,
      startedAt,
    }, deps.artifactOptions?.manifest);
    rememberRuntimeEpisode(plan.childSessionFile, run.episodeId, plan.parentDepth + 1, plan.activityPath);
    activityLogWriter = new QueuedActivityLogWriter(run.activityLog, plan.activityPath, plan.childSessionFile, deps.artifactOptions?.activityLog);
    emitUpdate(onUpdate, run);
    throwIfInterrupted(signal);

    childSession = await createChildSession(plan, plan.childSessionManager, deps, ctx);
    await bindChildExtensions(childSession);
    const activeChildSession = childSession;
    const abortState = attachAbortHandler(signal, activeChildSession);
    detachAbortHandler = abortState.detach;
    const activityState = createActivityState(run);
    unsubscribe = activeChildSession.subscribe((event) => {
      const reduction = reduceActivityEvent(activityState, event, deps.now());
      if (reduction.changed) {
        refreshContextUsage(activityState.run, activeChildSession);
        activityLogWriter?.appendStatus(activityState.run.lastActivityAt, activityState.run.activity);
        emitUpdate(onUpdate, activityState.run);
      }
    });

    const answer = await promptChildAndExtractAnswer(activeChildSession, plan.childSessionManager, plan.userPrompt, abortState);
    refreshContextUsage(run, activeChildSession);
    await activityLogWriter.drain();
    await completeResumeRun(plan.manifestPath, run, deps.now(), deps, onUpdate, activityLogWriter);

    return {
      content: [{ type: "text", text: renderSubagentResult(plan.profile.selection, run.sessionId, answer) }],
      details: { run: cloneRunView(run) },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const interrupted = isSubagentInterruptedError(error);
    await activityLogWriter?.drain();
    if (run && childSession) refreshContextUsage(run, childSession);
    if (plan) await materializeChildSessionFile(plan.childSessionManager);
    if (run && plan) {
      if (interrupted) await abortResumeRun(plan.manifestPath, run, deps.now(), deps, onUpdate, activityLogWriter);
      else await failResumeRun(plan.manifestPath, run, deps.now(), message, deps, onUpdate, activityLogWriter);
    }
    if (interrupted && run && plan) throw new Error(renderSubagentInterrupted(plan.profile.selection, run.sessionId));
    if (run && plan) throw new Error(renderSubagentRecoverableError(plan.profile.selection, run.sessionId, message));
    const heading = plan ? errorHeading(plan.profile.selection) : "## Subagent resume error";
    throw new Error(`${heading}\n\n${message}`);
  } finally {
    if (run) forgetRuntimeEpisode(run.episodeId);
    releaseActiveChildSession(reservedChildSessionFile);
    runCleanup("remove subagent resume abort listener", detachAbortHandler);
    runCleanup("unsubscribe subagent resume activity listener", unsubscribe);
    runCleanup("dispose resumed subagent child session", () => childSession?.dispose());
  }
}

async function prepareRun(
  params: SubagentParams,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
  deps: RunnerDependencies,
  extensionFactories: ExtensionFactory[] | undefined,
): Promise<RunPlan> {
  const context = params.context ?? "fresh";
  if (context === "fresh") return prepareFreshRun(params, signal, ctx, deps, extensionFactories);
  if (context === "fork") return prepareForkRun(params, signal, ctx, deps, extensionFactories);
  throw new Error(`Unsupported subagent context: ${String(context)}`);
}

async function prepareResumeRun(
  params: SubagentResumeParams,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
  deps: RunnerDependencies,
  extensionFactories: ExtensionFactory[] | undefined,
  reserveSession: (sessionFile: string, sessionId: string) => void,
): Promise<ResumeRunPlan> {
  throwIfAborted(signal, "Subagent resume was aborted before child execution.");

  const parentSessionFile = ctx.sessionManager.getSessionFile();
  if (!parentSessionFile) throw new Error("subagent_resume requires a persisted parent Pi session.");

  const { root, manifestPath, parentDepth, parentPath, records } = await resolveArtifactRoot(parentSessionFile);
  const startedRecord = requireUniqueStartedRecordBySessionId(records, params.sessionId);
  assertUsableStartedRecord(startedRecord, params.sessionId);
  assertSessionFileInSubagentsRoot(startedRecord.sessionFile, root.subagentsDir, params.sessionId);
  assertActivityLogMatchesCanonicalPath(startedRecord.activityLog, root.activityLogPath, params.sessionId);
  if (path.resolve(parentSessionFile) === path.resolve(startedRecord.sessionFile)) {
    throw new Error(`Subagent session '${params.sessionId}' is the current session; send a normal message instead of resuming it through subagent_resume.`);
  }
  reserveSession(startedRecord.sessionFile, params.sessionId);
  const header = await readVerifiedSessionHeader(startedRecord.sessionFile, params.sessionId);
  assertSessionCwdMatchesManifest(header.cwd, startedRecord.cwd, params.sessionId);

  const childSessionManager = deps.openSessionManager(startedRecord.sessionFile, root.subagentsDir);
  if (childSessionManager.getSessionId() !== params.sessionId) {
    throw new Error(`Opened subagent session ID '${childSessionManager.getSessionId()}' does not match requested session ID '${params.sessionId}'.`);
  }
  const childSessionFile = childSessionManager.getSessionFile();
  if (!childSessionFile) throw new Error(`Could not open a persisted child session for subagent session '${params.sessionId}'.`);
  if (path.resolve(childSessionFile) !== path.resolve(startedRecord.sessionFile)) {
    throw new Error(`Opened subagent session '${params.sessionId}' did not preserve the recorded child session file.`);
  }

  const effectiveCwd = startedRecord.cwd;
  await assertDirectoryExists(effectiveCwd);
  throwIfAborted(signal, "Subagent resume was aborted before child execution.");

  const agentDir = deps.getAgentDir();
  const settingsManager = createProjectTrustedSettingsManager(effectiveCwd, agentDir);
  const userAgentsDir = path.join(agentDir, "agents");
  const profile = await resolveResumeProfile(startedRecord, effectiveCwd, userAgentsDir);
  const loaderContext = extensionFactories === undefined
    ? { cwd: effectiveCwd, agentDir, settingsManager }
    : { cwd: effectiveCwd, agentDir, settingsManager, extensionFactories };
  const resourceLoader = deps.createResourceLoader(startedRecord.context === "fresh"
    ? buildFreshResourceLoaderOptions(profile, loaderContext)
    : buildForkResourceLoaderOptions(loaderContext));
  await resourceLoader.reload();

  return {
    effectiveCwd,
    profile,
    manifestPath,
    parentEpisodeId: root.parentEpisodeId,
    parentDepth,
    startedRecord,
    childSessionManager,
    childSessionFile,
    activityPath: [...parentPath, startedRecord.agent],
    rootSessionFile: root.rootSessionFile,
    activityLogPath: root.activityLogPath,
    agentDir,
    settingsManager,
    resourceLoader,
    userPrompt: params.message,
    inheritParentModel: false,
  };
}

async function prepareFreshRun(
  params: SubagentParams,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
  deps: RunnerDependencies,
  extensionFactories: ExtensionFactory[] | undefined,
): Promise<FreshRunPlan> {
  throwIfAborted(signal, "Subagent run was aborted before child execution.");

  const parentSessionFile = ctx.sessionManager.getSessionFile();
  if (!parentSessionFile) throw new Error("subagent execution requires a persisted parent Pi session.");

  const effectiveCwd = resolveFreshCwd(params, ctx.cwd);
  await assertDirectoryExists(effectiveCwd);
  throwIfAborted(signal, "Subagent run was aborted before child execution.");

  const agentDir = deps.getAgentDir();
  const settingsManager = createProjectTrustedSettingsManager(effectiveCwd, agentDir);
  const userAgentsDir = path.join(agentDir, "agents");
  const profile = await resolveAgentProfile(params, effectiveCwd, profileResolutionOptions(userAgentsDir, params, ctx));
  const { root, manifestPath, parentDepth, parentPath } = await resolveArtifactRoot(parentSessionFile);
  const loaderContext = extensionFactories === undefined
    ? { cwd: effectiveCwd, agentDir, settingsManager }
    : { cwd: effectiveCwd, agentDir, settingsManager, extensionFactories };
  const resourceLoader = deps.createResourceLoader(buildFreshResourceLoaderOptions(profile, loaderContext));
  await resourceLoader.reload();

  return {
    context: "fresh",
    effectiveCwd,
    profile,
    root,
    manifestPath,
    parentDepth,
    parentPath,
    agentDir,
    settingsManager,
    resourceLoader,
    userPrompt: params.task,
    inheritParentModel: true,
  };
}

async function prepareForkRun(
  params: SubagentParams,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
  deps: RunnerDependencies,
  extensionFactories: ExtensionFactory[] | undefined,
): Promise<ForkRunPlan> {
  if (params.cwd !== undefined) throw new Error("cwd is not supported with context 'fork'.");
  throwIfAborted(signal, "Subagent run was aborted before child execution.");

  const parentSessionFile = ctx.sessionManager.getSessionFile();
  if (!parentSessionFile) throw new Error("subagent execution requires a persisted parent Pi session.");

  const currentLeafId = ctx.sessionManager.getLeafId();
  if (!currentLeafId) throw new Error("subagent fork execution requires a current session leaf.");

  const { root, manifestPath, parentDepth, parentPath } = await resolveArtifactRoot(parentSessionFile);
  const sourceSessionManager = deps.openSessionManager(parentSessionFile, root.subagentsDir);
  const effectiveCwd = sourceSessionManager.getCwd();
  await assertDirectoryExists(effectiveCwd);
  throwIfAborted(signal, "Subagent run was aborted before child execution.");

  const agentDir = deps.getAgentDir();
  const settingsManager = createProjectTrustedSettingsManager(effectiveCwd, agentDir);
  const userAgentsDir = path.join(agentDir, "agents");
  const profile = await resolveAgentProfile(params, effectiveCwd, { userAgentsDir });
  const loaderContext = extensionFactories === undefined
    ? { cwd: effectiveCwd, agentDir, settingsManager }
    : { cwd: effectiveCwd, agentDir, settingsManager, extensionFactories };
  const resourceLoader = deps.createResourceLoader(buildForkResourceLoaderOptions(loaderContext));
  await resourceLoader.reload();

  return {
    context: "fork",
    effectiveCwd,
    profile,
    root,
    manifestPath,
    parentDepth,
    parentPath,
    agentDir,
    settingsManager,
    resourceLoader,
    userPrompt: buildForkPrompt(profile, params.task),
    currentLeafId,
    sourceSessionManager,
    inheritParentModel: false,
  };
}

interface ResolveAgentProfileOptions {
  userAgentsDir: string;
  callerCwdHint?: string;
}

function profileResolutionOptions(userAgentsDir: string, params: SubagentParams, ctx: ExtensionContext): ResolveAgentProfileOptions {
  if (params.cwd === undefined || !ctx.cwd) return { userAgentsDir };
  return { userAgentsDir, callerCwdHint: path.resolve(ctx.cwd) };
}

async function resolveAgentProfile(params: SubagentParams, cwd: string, options: ResolveAgentProfileOptions): Promise<SubagentPromptProfile> {
  if (params.agent === undefined) return omittedSubagentProfile();

  try {
    return namedSubagentProfile(await resolveMarkdownAgent(params.agent, { cwd, userAgentsDir: options.userAgentsDir }));
  } catch (error: unknown) {
    if (!(error instanceof MissingMarkdownAgentError) || !options.callerCwdHint) throw error;
    if (path.resolve(cwd) === options.callerCwdHint) throw error;

    let callerAgent: MarkdownAgent;
    try {
      callerAgent = await resolveMarkdownAgent(error.agentName, { cwd: options.callerCwdHint, userAgentsDir: options.userAgentsDir });
    } catch {
      throw error;
    }

    throw new Error(formatExplicitCwdMissingAgentHint(error, callerAgent));
  }
}

async function resolveResumeProfile(record: StartedManifestRecord, cwd: string, userAgentsDir: string): Promise<SubagentPromptProfile> {
  if (record.agentFile === null || record.agentFile === undefined) return omittedSubagentProfile();
  if (record.context === "fresh") {
    return namedSubagentProfile(await resolveMarkdownAgent(record.agent, { cwd, userAgentsDir }));
  }

  return {
    selection: namedAgentSelection(record.agent, record.agentFile),
    agentName: record.agent,
    agentFile: record.agentFile,
    agentsMd: "none",
    skills: "auto",
  };
}

function formatExplicitCwdMissingAgentHint(error: MissingMarkdownAgentError, fallbackAgent: MarkdownAgent): string {
  return [
    `Subagent '${error.agentName}' was not found from explicit cwd:`,
    error.cwd,
    "",
    "But it is available from the current session cwd:",
    fallbackAgent.filePath,
    "",
    "If you meant to use that project agent, omit cwd and pass scratch or external paths inside task:",
    `  subagent({ agent: "${error.agentName}", task: "Use the external path explicitly here." })`,
    "",
    "Use cwd only when you intentionally want that other directory's project agents, AGENTS.md, skills, and prompt resources.",
  ].join("\n");
}

function assertUsableStartedRecord(record: StartedManifestRecord, sessionId: string): void {
  if (typeof record.episodeId !== "string"
    || typeof record.sessionId !== "string"
    || typeof record.agent !== "string"
    || typeof record.cwd !== "string"
    || (record.context !== "fresh" && record.context !== "fork")
    || typeof record.sessionFile !== "string"
    || typeof record.activityLog !== "string") {
    throw new Error(`Subagent session '${sessionId}' has an invalid manifest record.`);
  }
}

function assertSessionFileInSubagentsRoot(sessionFile: string, subagentsDir: string, sessionId: string): void {
  const relative = path.relative(path.resolve(subagentsDir), path.resolve(sessionFile));
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Subagent session '${sessionId}' points outside the current parent/root subagents directory.`);
  }
}

function assertActivityLogMatchesCanonicalPath(activityLog: string, expectedActivityLog: string, sessionId: string): void {
  if (path.resolve(activityLog) !== path.resolve(expectedActivityLog)) {
    throw new Error(`Subagent session '${sessionId}' has an invalid activity-log manifest path.`);
  }
}

interface VerifiedSessionHeader {
  id: string;
  cwd: string;
}

async function readVerifiedSessionHeader(sessionFile: string, expectedSessionId: string): Promise<VerifiedSessionHeader> {
  let fileHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fileHandle = await open(sessionFile, "r");
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.toString("utf8", 0, bytesRead).split("\n")[0]?.trim();
    if (!firstLine) throw new Error(`Subagent session '${expectedSessionId}' has an empty child session header.`);

    let header: unknown;
    try {
      header = JSON.parse(firstLine);
    } catch {
      throw new Error(`Subagent session '${expectedSessionId}' has an unreadable child session header.`);
    }

    if (!isObject(header) || header.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string") {
      throw new Error(`Subagent session '${expectedSessionId}' has an invalid child session header.`);
    }
    if (header.id !== expectedSessionId) {
      throw new Error(`Recorded subagent session ID '${expectedSessionId}' does not match the child session header ID '${header.id}'.`);
    }
    return { id: header.id, cwd: header.cwd };
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      throw new Error(`Subagent session '${expectedSessionId}' is recorded, but its child session file is missing.`);
    }
    throw error;
  } finally {
    await fileHandle?.close().catch((error: unknown) => {
      console.error("subagent session header file close failed", error);
    });
  }
}

function assertSessionCwdMatchesManifest(headerCwd: string, manifestCwd: string, sessionId: string): void {
  if (path.resolve(headerCwd) !== path.resolve(manifestCwd)) {
    throw new Error(`Subagent session '${sessionId}' has a child session cwd that does not match its manifest record.`);
  }
}

async function resolveArtifactRoot(parentSessionFile: string): Promise<{ root: SubagentsRoot; manifestPath: string; parentDepth: number; parentPath: string[]; records: ManifestRecords }> {
  const provisionalRoot = resolveSubagentsRoot(parentSessionFile, null);
  const manifestPath = manifestPathForSubagentsRoot(provisionalRoot.subagentsDir);
  const isNestedRun = path.dirname(path.resolve(parentSessionFile)) === path.resolve(provisionalRoot.subagentsDir);
  const records = await readManifestRecords(manifestPath);
  let parentEpisodeId: string | null = null;
  if (isNestedRun) {
    parentEpisodeId = runtimeEpisodeBySessionFile.get(path.resolve(parentSessionFile)) ?? null;
    if (parentEpisodeId === null) {
      const parentRecord = findLatestEpisodeStartedRecordBySessionFile(records, parentSessionFile);
      if (parentRecord) {
        assertActivityLogMatchesCanonicalPath(parentRecord.activityLog, provisionalRoot.activityLogPath, parentRecord.sessionId);
        parentEpisodeId = parentRecord.episodeId;
      }
    }
  }
  if (isNestedRun && parentEpisodeId === null) {
    throw new Error(`Could not determine parent subagent episode for nested session: ${parentSessionFile}`);
  }

  const parentDepth = parentEpisodeId === null ? 0 : runtimeEpisodeDepthByEpisode.get(parentEpisodeId) ?? episodeDepth(parentEpisodeId, records);
  if (parentDepth >= MAX_SUBAGENT_DEPTH) {
    throw new Error(`Subagent nesting limit exceeded: maximum depth is ${MAX_SUBAGENT_DEPTH}.`);
  }

  const parentPath = parentEpisodeId === null ? [] : activityPathForEpisode(parentEpisodeId, records);
  if (isNestedRun && parentPath === undefined) {
    throw new Error(`Could not determine parent subagent path for nested session: ${parentSessionFile}`);
  }

  const root = resolveSubagentsRoot(parentSessionFile, parentEpisodeId);
  return { root, manifestPath: manifestPathForSubagentsRoot(root.subagentsDir), parentDepth, parentPath: parentPath ?? [], records };
}

async function startRunArtifacts(
  plan: RunPlan,
  deps: RunnerDependencies,
): Promise<StartedRun> {
  const episodeId = deps.createEpisodeId();
  const startedAt = deps.now();
  const activityLog = plan.root.activityLogPath;
  const activityPath = [...plan.parentPath, plan.profile.agentName];
  const childSessionManager = createChildSessionManager(plan, deps);
  const childSessionFile = childSessionManager.getSessionFile();
  if (!childSessionFile) throw new Error("Could not create a persisted child subagent session.");
  const sessionId = childSessionManager.getSessionId();

  const run = createInitialRunView({ episodeId, sessionId, agent: plan.profile.agentName, activityLog, now: startedAt });
  await ensureActivityLogHeader(activityLog, plan.root.rootSessionFile, startedAt, deps.artifactOptions?.activityLog);
  await appendActivityLogStarted(activityLog, { timestamp: startedAt, path: activityPath, episodeId, sessionFile: childSessionFile }, deps.artifactOptions?.activityLog);
  await appendManifestRecord(plan.manifestPath, {
    type: "started",
    episodeId,
    sessionId,
    parentEpisodeId: plan.root.parentEpisodeId,
    agent: plan.profile.agentName,
    cwd: plan.effectiveCwd,
    context: plan.context,
    sessionFile: childSessionFile,
    activityLog,
    agentFile: plan.profile.agentFile ?? null,
    startedAt,
  }, deps.artifactOptions?.manifest);
  rememberRuntimeEpisode(childSessionFile, episodeId, plan.parentDepth + 1, activityPath);

  return { run, childSessionManager, childSessionFile, activityPath };
}

function createChildSessionManager(plan: RunPlan, deps: RunnerDependencies): SessionManager {
  if (plan.context === "fresh") return deps.createFreshSessionManager(plan.effectiveCwd, plan.root.subagentsDir);

  let childSessionFile: string | undefined;
  try {
    childSessionFile = plan.sourceSessionManager.createBranchedSession(plan.currentLeafId);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not fork subagent from current session leaf '${plan.currentLeafId}': ${message}`);
  }

  if (!childSessionFile) throw new Error("Could not create a persisted forked child subagent session.");
  return plan.sourceSessionManager;
}

async function materializeChildSessionFile(childSessionManager: SessionManager): Promise<void> {
  const sessionFile = childSessionManager.getSessionFile();
  if (!sessionFile) return;

  const inspectable = childSessionManager as unknown as { getHeader?: () => unknown; getEntries?: () => unknown[]; flushed?: boolean };
  if (typeof inspectable.getHeader !== "function" || typeof inspectable.getEntries !== "function") return;

  try {
    const header = inspectable.getHeader();
    if (!header) return;
    const entries = [header, ...inspectable.getEntries()];
    await mkdir(path.dirname(sessionFile), { recursive: true });
    await writeFile(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
    // Pi defers writing new sessions until the first assistant message. On early failure
    // there may be a valid public session ID but no JSONL file yet, so flush the
    // current header/entries and keep SessionManager's append bookkeeping consistent.
    inspectable.flushed = true;
  } catch (error: unknown) {
    console.error("subagent child session materialization failed", error);
  }
}

async function createChildSession(
  plan: ChildSessionPlan,
  childSessionManager: SessionManager,
  deps: RunnerDependencies,
  ctx: ExtensionContext,
): Promise<ChildAgentSession> {
  const created = await deps.createAgentSession({
    cwd: plan.effectiveCwd,
    agentDir: plan.agentDir,
    modelRegistry: ctx.modelRegistry,
    ...(plan.inheritParentModel && ctx.model !== undefined ? { model: ctx.model } : {}),
    settingsManager: plan.settingsManager,
    resourceLoader: plan.resourceLoader,
    sessionManager: childSessionManager,
  });
  return created.session;
}

async function bindChildExtensions(childSession: ChildAgentSession): Promise<void> {
  await childSession.bindExtensions({ onError: (error: unknown) => console.error("subagent extension error", error) });
}

function refreshContextUsage(run: SubagentToolDetails["run"], childSession: ChildAgentSession): void {
  let usage: ReturnType<ChildAgentSession["getContextUsage"]>;
  try {
    usage = childSession.getContextUsage();
  } catch (error: unknown) {
    console.error("subagent context usage refresh failed", error);
    delete run.contextUsage;
    return;
  }

  if (usage === undefined) {
    delete run.contextUsage;
    return;
  }

  run.contextUsage = copyContextUsage(usage);
}

function copyContextUsage(contextUsage: SubagentContextUsage): SubagentContextUsage {
  return {
    tokens: contextUsage.tokens,
    contextWindow: contextUsage.contextWindow,
    percent: contextUsage.percent,
  };
}

function attachAbortHandler(signal: AbortSignal | undefined, childSession: ChildAgentSession): { wasAborted: () => boolean; aborted: Promise<void>; detach: () => void } {
  let abortRequested = false;
  let resolveAbort!: () => void;
  const aborted = new Promise<void>((resolve) => {
    resolveAbort = resolve;
  });
  const abortChild = () => {
    abortRequested = true;
    resolveAbort();
    void childSession.abort().catch((error: unknown) => {
      console.error("subagent child abort failed", error);
    });
  };

  signal?.addEventListener("abort", abortChild, { once: true });
  if (signal?.aborted) abortChild();

  return {
    wasAborted: () => abortRequested,
    aborted,
    detach: () => {
      if (signal) signal.removeEventListener("abort", abortChild);
    },
  };
}

async function promptChildAndExtractAnswer(childSession: ChildAgentSession, childSessionManager: SessionManager, task: string, abortState: { wasAborted: () => boolean; aborted: Promise<void> }): Promise<string> {
  if (abortState.wasAborted()) throw new SubagentInterruptedError();
  const leafBeforePrompt = childSessionManager.getLeafId();
  const assistantCountBeforePrompt = assistantMessages(childSession.messages ?? []).length;
  const promptPromise = childSession.prompt(task);
  const winner = await Promise.race([
    promptPromise.then(() => "prompt" as const),
    abortState.aborted.then(() => "abort" as const),
  ]);
  if (winner === "abort") {
    void promptPromise.catch((error: unknown) => console.error("subagent child prompt failed after abort", error));
    throw new SubagentInterruptedError();
  }

  if (abortState.wasAborted()) throw new SubagentInterruptedError();
  const newAssistantMessages = assistantMessagesAfterLeaf(childSessionManager, leafBeforePrompt)
    ?? assistantMessages(childSession.messages ?? []).slice(assistantCountBeforePrompt);
  const modelError = finalAssistantFailure(newAssistantMessages);
  if (modelError) throw new Error(modelError);
  if (newAssistantMessages.length === 0) throw new Error("Child subagent finished without a new assistant response.");

  const answer = childSession.getLastAssistantText()?.trim();
  if (!answer) throw new Error("Child subagent finished without an assistant response.");
  return answer;
}

type TerminalRunStatus = Exclude<SubagentToolDetails["run"]["status"], "running">;

async function completeRun(
  manifestPath: string,
  started: StartedRun,
  deps: RunnerDependencies,
  onUpdate: AgentToolUpdateCallback<SubagentToolDetails> | undefined,
  activityLogWriter?: QueuedActivityLogWriter,
): Promise<void> {
  await finishRun(manifestPath, started, "completed", deps.now(), deps, onUpdate, activityLogWriter);
}

async function failRun(
  manifestPath: string,
  started: StartedRun,
  message: string,
  deps: RunnerDependencies,
  onUpdate: AgentToolUpdateCallback<SubagentToolDetails> | undefined,
  activityLogWriter?: QueuedActivityLogWriter,
): Promise<void> {
  await finishRun(manifestPath, started, "failed", deps.now(), deps, onUpdate, activityLogWriter, message);
}

async function abortRun(
  manifestPath: string,
  started: StartedRun,
  deps: RunnerDependencies,
  onUpdate: AgentToolUpdateCallback<SubagentToolDetails> | undefined,
  activityLogWriter?: QueuedActivityLogWriter,
): Promise<void> {
  await finishRun(manifestPath, started, "aborted", deps.now(), deps, onUpdate, activityLogWriter, PARENT_ABORT_ERROR);
}

async function finishRun(
  manifestPath: string,
  started: StartedRun,
  status: TerminalRunStatus,
  finishedAt: string,
  deps: RunnerDependencies,
  onUpdate: AgentToolUpdateCallback<SubagentToolDetails> | undefined,
  activityLogWriter: QueuedActivityLogWriter | undefined,
  errorMessage?: string,
): Promise<void> {
  const run = started.run;
  run.status = status;
  run.activity = terminalActivity(status);
  run.lastActivityAt = finishedAt;
  if (activityLogWriter) {
    activityLogWriter.appendFinished(finishedAt, run, errorMessage);
    await activityLogWriter.drain();
  } else {
    await appendActivityLogFinished(run.activityLog, finishedAt, started.activityPath, started.childSessionFile, run, errorMessage, deps.artifactOptions?.activityLog);
  }
  await appendManifestRecord(manifestPath, {
    type: "finished",
    episodeId: run.episodeId,
    status,
    finishedAt,
    ...(errorMessage === undefined ? {} : { error: errorMessage }),
  }, deps.artifactOptions?.manifest);
  emitUpdate(onUpdate, run);
}

async function completeResumeRun(
  manifestPath: string,
  run: SubagentToolDetails["run"],
  completedAt: string,
  deps: RunnerDependencies,
  onUpdate: AgentToolUpdateCallback<SubagentToolDetails> | undefined,
  activityLogWriter: QueuedActivityLogWriter,
): Promise<void> {
  await finishResumeRun(manifestPath, run, "completed", completedAt, deps, onUpdate, activityLogWriter);
}

async function failResumeRun(
  manifestPath: string,
  run: SubagentToolDetails["run"],
  failedAt: string,
  errorMessage: string,
  deps: RunnerDependencies,
  onUpdate: AgentToolUpdateCallback<SubagentToolDetails> | undefined,
  activityLogWriter: QueuedActivityLogWriter | undefined,
): Promise<void> {
  await finishResumeRun(manifestPath, run, "failed", failedAt, deps, onUpdate, activityLogWriter, errorMessage);
}

async function abortResumeRun(
  manifestPath: string,
  run: SubagentToolDetails["run"],
  abortedAt: string,
  deps: RunnerDependencies,
  onUpdate: AgentToolUpdateCallback<SubagentToolDetails> | undefined,
  activityLogWriter: QueuedActivityLogWriter | undefined,
): Promise<void> {
  await finishResumeRun(manifestPath, run, "aborted", abortedAt, deps, onUpdate, activityLogWriter, PARENT_ABORT_ERROR);
}

async function finishResumeRun(
  manifestPath: string,
  run: SubagentToolDetails["run"],
  status: TerminalRunStatus,
  finishedAt: string,
  deps: RunnerDependencies,
  onUpdate: AgentToolUpdateCallback<SubagentToolDetails> | undefined,
  activityLogWriter: QueuedActivityLogWriter | undefined,
  errorMessage?: string,
): Promise<void> {
  run.status = status;
  run.activity = terminalActivity(status);
  run.lastActivityAt = finishedAt;
  if (activityLogWriter) {
    activityLogWriter.appendFinished(finishedAt, run, errorMessage);
    await activityLogWriter.drain();
  }
  await appendManifestRecord(manifestPath, {
    type: "resume_finished",
    episodeId: run.episodeId,
    sessionId: run.sessionId,
    status,
    finishedAt,
    ...(errorMessage === undefined ? {} : { error: errorMessage }),
  }, deps.artifactOptions?.manifest);
  emitUpdate(onUpdate, run);
}

function terminalActivity(status: TerminalRunStatus): string {
  if (status === "aborted") return "interrupted";
  return status;
}

function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
  if (signal?.aborted) throw new Error(message);
}

function throwIfInterrupted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new SubagentInterruptedError();
}

function runCleanup(label: string, cleanup: (() => void) | undefined): void {
  if (!cleanup) return;
  try {
    cleanup();
  } catch (error: unknown) {
    console.error(`Could not ${label}`, error);
  }
}

function rememberRuntimeEpisode(sessionFile: string, episodeId: string, depth: number, activityPath: readonly string[]): void {
  const normalized = path.resolve(sessionFile);
  runtimeEpisodeBySessionFile.set(normalized, episodeId);
  runtimeSessionFileByEpisode.set(episodeId, normalized);
  runtimeEpisodeDepthByEpisode.set(episodeId, depth);
  runtimeActivityPathByEpisode.set(episodeId, [...activityPath]);
}

function reserveActiveChildSession(sessionFile: string, sessionId: string): string {
  const normalized = path.resolve(sessionFile);
  assertChildSessionNotActive(normalized, sessionId);
  activeChildSessionFiles.add(normalized);
  return normalized;
}

function assertChildSessionNotActive(sessionFile: string, sessionId: string): void {
  if (activeChildSessionFiles.has(path.resolve(sessionFile))) {
    throw new Error(`Subagent session '${sessionId}' is already active; wait for the current run or resume to finish before continuing it.`);
  }
}

function releaseActiveChildSession(normalizedSessionFile: string | undefined): void {
  if (normalizedSessionFile) activeChildSessionFiles.delete(normalizedSessionFile);
}

function forgetRuntimeEpisode(episodeId: string): void {
  const sessionFile = runtimeSessionFileByEpisode.get(episodeId);
  if (sessionFile) runtimeEpisodeBySessionFile.delete(sessionFile);
  runtimeSessionFileByEpisode.delete(episodeId);
  runtimeEpisodeDepthByEpisode.delete(episodeId);
  runtimeActivityPathByEpisode.delete(episodeId);
}

function activityPathForEpisode(episodeId: string, records: ManifestRecords): string[] | undefined {
  const runtimePath = runtimeActivityPathByEpisode.get(episodeId);
  if (runtimePath) return [...runtimePath];

  const byEpisodeId = startedRecordsByEpisodeId(records);
  const pathSegments: string[] = [];
  const seen = new Set<string>();
  let current: string | null = episodeId;
  while (current) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    const record = byEpisodeId.get(current);
    if (!record) return undefined;
    pathSegments.unshift(record.agent);
    current = record.parentEpisodeId;
  }
  return pathSegments;
}

function episodeDepth(episodeId: string, records: ManifestRecords): number {
  const byEpisodeId = startedRecordsByEpisodeId(records);
  let depth = 1;
  let current = byEpisodeId.get(episodeId)?.parentEpisodeId ?? null;
  const seen = new Set<string>([episodeId]);
  while (current) {
    if (seen.has(current)) return MAX_SUBAGENT_DEPTH;
    seen.add(current);
    depth += 1;
    current = byEpisodeId.get(current)?.parentEpisodeId ?? null;
  }
  return depth;
}

function startedRecordsByEpisodeId(records: ManifestRecords): Map<string, EpisodeStartedManifestRecord> {
  return new Map(records.filter((record): record is EpisodeStartedManifestRecord => record.type === "started" || record.type === "resume_started").map((record) => [record.episodeId, record]));
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const productionRunnerDependencies: RunnerDependencies = {
  now: () => new Date().toISOString(),
  createEpisodeId: () => crypto.randomUUID().replace(/-/g, "").slice(0, 12),
  getAgentDir,
  createFreshSessionManager: (cwd, sessionDir) => SessionManager.create(cwd, sessionDir),
  openSessionManager: (sessionFile, sessionDir) => SessionManager.open(sessionFile, sessionDir),
  createResourceLoader: (options) => new DefaultResourceLoader(options),
  createAgentSession,
};

function emitUpdate(onUpdate: AgentToolUpdateCallback<SubagentToolDetails> | undefined, run: SubagentToolDetails["run"]): void {
  if (!onUpdate) return;
  const snapshot = cloneRunView(run);
  try {
    onUpdate({
      content: [{ type: "text", text: renderSubagentProgress(snapshot) }],
      details: { run: snapshot },
    });
  } catch (error: unknown) {
    console.error("subagent partial update callback failed", error);
  }
}

function finalAssistantFailure(messages: readonly unknown[]): string | undefined {
  const finalAssistant = assistantMessages(messages).at(-1);
  if (!finalAssistant || (finalAssistant.stopReason !== "error" && finalAssistant.stopReason !== "aborted")) return undefined;
  if (finalAssistant.stopReason === "aborted") return finalAssistant.errorMessage ?? extractText(finalAssistant.content) ?? "Child subagent was aborted.";
  return finalAssistant.errorMessage ?? extractText(finalAssistant.content) ?? "Child subagent ended with a model error.";
}

function assistantMessagesAfterLeaf(childSessionManager: SessionManager, leafBeforePrompt: string | null): unknown[] | undefined {
  const branch = childSessionManager.getBranch();
  if (branch.length === 0 && leafBeforePrompt === null) return undefined;

  const leafIndex = leafBeforePrompt === null ? -1 : branch.findIndex((entry) => entry.id === leafBeforePrompt);
  if (leafIndex === -1 && leafBeforePrompt !== null) return undefined;

  return branch
    .slice(leafIndex + 1)
    .flatMap((entry) => entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []);
}

function assistantMessages(messages: readonly unknown[]): Array<{ role?: string; stopReason?: string; errorMessage?: string; content?: unknown }> {
  return messages.filter((message): message is { role?: string; stopReason?: string; errorMessage?: string; content?: unknown } => {
    return typeof message === "object" && message !== null && (message as { role?: string }).role === "assistant";
  });
}

function extractText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((part) => typeof part === "object" && part !== null && "text" in part ? String((part as { text: unknown }).text) : "")
    .join("")
    .trim();
  return text || undefined;
}

function agentSelectionFromRun(run: SubagentToolDetails["run"], fallback: AgentSelection): AgentSelection {
  if (fallback.kind === "named") return fallback;
  return run.agent === OMITTED_AGENT_LABEL ? omittedAgentSelection() : namedAgentSelection(run.agent);
}
