import { mkdir, open, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
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
import { appendManifestRecord, findParentEpisodeId, readManifestRecords, requireUniqueStartedRecordBySessionId, type DegradedAppendOptions, type EpisodeStartedManifestRecord, type StartedManifestRecord } from "./manifest.js";
import { parseModelChain, resolveRecordedSubagentModel, resolveSubagentModel, resolveSubagentThinkingLevel, type ModelCandidate } from "./models.js";
import { errorHeading, namedAgentSelection, omittedAgentSelection, renderSubagentInterrupted, renderSubagentProgress, renderSubagentRecoverableError, renderSubagentResult } from "./render.js";
import { assertDirectoryExists, manifestPathForSubagentsRoot, resolveFreshCwd, resolveSubagentsRoot, type SubagentsRoot } from "./sessions.js";
import { buildSubagentPromptEnvelope } from "./tool-prompts.js";
import { DEFAULT_AGENT_ALIAS, OMITTED_AGENT_LABEL, type AgentResourceMode, type AgentSelection, type MarkdownAgent, type SubagentContextMode, type SubagentContextUsage, type SubagentParams, type SubagentResumeParams, type SubagentToolDetails, type TextToolResult } from "./types.js";

type DefaultResourceLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];
type ProjectTrustedSettingsManager = ReturnType<typeof SettingsManager.create>;
type ChildAgentSession = Pick<AgentSession, "prompt" | "getLastAssistantText" | "getContextUsage" | "subscribe" | "bindExtensions" | "hasExtensionHandlers" | "extensionRunner" | "abort" | "dispose" | "messages">;
type ChildSessionResult = Pick<CreateAgentSessionResult, "session" | "modelFallbackMessage">;
type ManifestRecords = Awaited<ReturnType<typeof readManifestRecords>>;

export interface SubagentPromptProfile {
  selection: AgentSelection;
  agentName: string;
  agentFile?: string;
  agentBody?: string;
  model?: string;
  agentsMd: AgentResourceMode;
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
  agentDir: string;
  settingsManager: ProjectTrustedSettingsManager;
  resourceLoader: ResourceLoader;
  userPrompt: string;
  model: Model<Api> | undefined;
  thinkingLevel: string | undefined;
  fallbacks: ModelChoice[];
}

interface FreshRunPlan extends BaseRunPlan {
  context: "fresh";
  agentsMdOverride?: AgentResourceMode;
}

interface ForkRunPlan extends BaseRunPlan {
  context: "fork";
  currentLeafId: string;
  sourceSessionManager: SessionManager;
}

type RunPlan = FreshRunPlan | ForkRunPlan;

type ChildSessionPlan = Pick<BaseRunPlan, "effectiveCwd" | "agentDir" | "settingsManager" | "resourceLoader" | "model" | "thinkingLevel">;
type ModelChoice = { model: Model<Api>; thinkingLevel: ModelCandidate["level"] };

interface ResumeRunPlan extends ChildSessionPlan {
  root: SubagentsRoot;
  profile: SubagentPromptProfile;
  manifestPath: string;
  parentEpisodeId: string | null;
  parentDepth: number;
  startedRecord: StartedManifestRecord;
  childSessionManager: SessionManager;
  childSessionFile: string;
  userPrompt: string;
}

interface OwnedSave {
  root: string;
  absoluteFile: string;
  file: string;
  sessionId: string;
  cwd: string;
  label?: string;
}

interface StartedRun {
  run: SubagentToolDetails["run"];
  childSessionManager: SessionManager;
  childSessionFile: string;
  ownedSave: OwnedSave | undefined;
}

const MAX_SUBAGENT_DEPTH = 4;
const PARENT_ABORT_ERROR = "Interrupted by parent abort.";
const runtimeEpisodeBySessionFile = new Map<string, string>();
const runtimeSessionFileByEpisode = new Map<string, string>();
const runtimeEpisodeDepthByEpisode = new Map<string, number>();
const activeChildSessionFiles = new Set<string>();

class SubagentInterruptedError extends Error {
  constructor() {
    super(PARENT_ABORT_ERROR);
    this.name = "SubagentInterruptedError";
  }
}

class FirstTurnProviderError extends Error {}

// The model that served attempt `n`: the planned first choice, then each fallback in order.
function attemptModel(plan: { model: Model<Api> | undefined; fallbacks: readonly ModelChoice[] }, attempt: number): Model<Api> | undefined {
  return attempt === 0 ? plan.model : plan.fallbacks[attempt - 1]?.model;
}

function describeModel(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

function summarizeProviderError(message: string): string {
  const summary = message.replace(/\s+/g, " ").trim();
  return summary.length > 120 ? `${summary.slice(0, 117)}…` : summary;
}

function formatModelNote(model: Model<Api> | undefined, failedAttempts: readonly string[]): string | undefined {
  if (model === undefined) return undefined;
  return failedAttempts.length === 0
    ? `Model: ${describeModel(model)}`
    : `Model: ${describeModel(model)} — after failed attempts: ${failedAttempts.join(", ")}`;
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
    ...(agent.model === undefined ? {} : { model: agent.model }),
    agentsMd: agent.agentsMd,
    skills: agent.skills,
  };
}

export function buildFreshResourceLoaderOptions(profile: SubagentPromptProfile, options: { cwd: string; agentDir: string; settingsManager?: ProjectTrustedSettingsManager; extensionFactories?: ExtensionFactory[] }, agentsMdOverride?: AgentResourceMode): DefaultResourceLoaderOptions {
  const loaderOptions: DefaultResourceLoaderOptions = {
    cwd: options.cwd,
    agentDir: options.agentDir,
  };

  if (options.settingsManager) loaderOptions.settingsManager = options.settingsManager;
  if (options.extensionFactories && options.extensionFactories.length > 0) loaderOptions.extensionFactories = options.extensionFactories;
  if ((agentsMdOverride ?? profile.agentsMd) === "none") loaderOptions.noContextFiles = true;
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

export function buildInitialSubagentPrompt(profile: SubagentPromptProfile, context: SubagentContextMode, task: string, parentDepth: number): string {
  if (profile.selection.kind === "omitted") return buildSubagentPromptEnvelope({ context, task, parentDepth });
  if (profile.agentBody === undefined) return buildSubagentPromptEnvelope({ context, task, parentDepth, agentName: profile.agentName });
  return buildSubagentPromptEnvelope({ context, task, parentDepth, agentName: profile.agentName, agentBody: profile.agentBody });
}

export async function runSubagent(
  params: SubagentParams,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<SubagentToolDetails> | undefined,
  ctx: ExtensionContext,
  options: RunnerOptions = {},
): Promise<TextToolResult<SubagentToolDetails>> {
  const deps = { ...productionRunnerDependencies, ...options.deps };
  const requestedSelection = params.agent === undefined ? omittedAgentSelection() : namedAgentSelection(params.agent.trim() || params.agent);
  let plan: RunPlan | undefined;
  let run: SubagentToolDetails["run"] | undefined;
  let startedRun: StartedRun | undefined;
  let childSession: ChildAgentSession | undefined;
  let childExtensionsStarted = false;
  let unsubscribe: (() => void) | undefined;
  let detachAbortHandler: (() => void) | undefined;
  let reservedChildSessionFile: string | undefined;

  try {
    plan = await prepareRun(params, signal, ctx, deps, options);
    throwIfAborted(signal, "Subagent run was aborted before child execution.");

    startedRun = createStartedRun(plan, deps);
    run = startedRun.run;
    reservedChildSessionFile = reserveActiveChildSession(startedRun.childSessionFile, run.sessionId);
    await startRunArtifacts(plan, startedRun, deps);
    throwIfInterrupted(signal);
    emitUpdate(onUpdate, toolDetails(run, startedRun.ownedSave));

    const created = await createChildSession(plan, startedRun.childSessionManager, deps);
    childSession = created.session;
    throwIfModelFallback(created.modelFallbackMessage);
    childExtensionsStarted = true;
    await bindChildExtensions(childSession);
    let activeChildSession = childSession;
    let abortState = attachAbortHandler(signal, activeChildSession);
    detachAbortHandler = abortState.detach;
    const activityState = createActivityState(run);
    let toolProgress = false;
    const subscribe = (session: ChildAgentSession) => session.subscribe((event) => {
      if (event.type === "tool_execution_start" || event.type === "tool_execution_end"
        || (event.type === "turn_end" && event.toolResults.length > 0)
        || (event.type === "message_end" && event.message.role === "toolResult")) toolProgress = true;
      const reduction = reduceActivityEvent(activityState, event, deps.now());
      if (reduction.changed) {
        refreshContextUsage(activityState.run, session);
        emitUpdate(onUpdate, toolDetails(activityState.run, startedRun?.ownedSave));
      }
    });
    unsubscribe = subscribe(activeChildSession);

    const prePromptLeaf = startedRun.childSessionManager.getLeafId();
    const failedAttempts: string[] = [];
    let answer: string;
    for (let attempt = 0; ; attempt++) {
      const next = plan.fallbacks[attempt];
      try {
        answer = await promptChildAndExtractAnswer(activeChildSession, startedRun.childSessionManager, plan.userPrompt, abortState,
          next ? () => toolProgress : undefined);
        break;
      } catch (error: unknown) {
        if (!(error instanceof FirstTurnProviderError) || !next) throw error;
        throwIfInterrupted(signal);
        const failed = describeModel(attemptModel(plan, attempt)!);
        const reason = summarizeProviderError(error instanceof Error ? error.message : String(error));
        failedAttempts.push(`${failed} (${reason})`);
        // Recreate the AgentSession on the pre-prompt branch so failed requests
        // remain inspectable but do not enter the next model's context.
        runCleanup("remove subagent abort listener", detachAbortHandler);
        detachAbortHandler = undefined;
        runCleanup("unsubscribe subagent activity listener", unsubscribe);
        unsubscribe = undefined;
        await closeChildSession(childSession, childExtensionsStarted, "subagent failed attempt");
        childSession = undefined;
        childExtensionsStarted = false;
        throwIfInterrupted(signal);
        if (prePromptLeaf === null) startedRun.childSessionManager.resetLeaf();
        else startedRun.childSessionManager.branch(prePromptLeaf);
        startedRun.childSessionManager.appendModelChange(next.model.provider, next.model.id);
        startedRun.childSessionManager.appendThinkingLevelChange(next.thinkingLevel);
        // Disposing an AgentSession invalidates its extension runtime.
        await plan.resourceLoader.reload();
        throwIfInterrupted(signal);
        const createdFallback = await createChildSession({ ...plan, ...next }, startedRun.childSessionManager, deps);
        childSession = createdFallback.session;
        throwIfModelFallback(createdFallback.modelFallbackMessage);
        childExtensionsStarted = true;
        await bindChildExtensions(childSession);
        activeChildSession = childSession;
        abortState = attachAbortHandler(signal, activeChildSession);
        detachAbortHandler = abortState.detach;
        toolProgress = false;
        unsubscribe = subscribe(activeChildSession);
      }
    }
    refreshContextUsage(run, activeChildSession);
    await finishRun(plan.manifestPath, run, "completed", deps.now(), deps);
    const details = await bestEffortTerminalDetails(run, startedRun.ownedSave);
    emitUpdate(onUpdate, details);
    forgetRuntimeEpisode(startedRun.run.episodeId);

    return {
      content: [{ type: "text", text: renderSubagentResult(plan.profile.selection, run.sessionId, answer,
        formatModelNote(attemptModel(plan, failedAttempts.length), failedAttempts)) }],
      details,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const interrupted = isSubagentInterruptedError(error);
    if (run && childSession) refreshContextUsage(run, childSession);
    if (startedRun && plan) preservePlannedSelection(plan, startedRun.childSessionManager);
    if (startedRun) await materializeChildSessionFile(startedRun.childSessionManager);
    if (startedRun && plan) {
      await finishRun(plan.manifestPath, startedRun.run, interrupted ? "aborted" : "failed", deps.now(), deps,
        interrupted ? PARENT_ABORT_ERROR : message);
    }
    if (run) {
      const details = await bestEffortTerminalDetails(run, startedRun?.ownedSave);
      emitUpdate(onUpdate, details);
      forgetRuntimeEpisode(run.episodeId);
      const selection = agentSelectionFromRun(run, plan?.profile.selection ?? requestedSelection);
      return {
        content: [{ type: "text", text: interrupted
          ? renderSubagentInterrupted(selection, run.sessionId)
          : renderSubagentRecoverableError(selection, run.sessionId, message) }],
        details,
        isError: true,
      };
    }
    throw new Error(`${errorHeading(plan?.profile.selection ?? requestedSelection)}\n\n${message}`, { cause: error });
  } finally {
    runCleanup("remove subagent abort listener", detachAbortHandler);
    runCleanup("unsubscribe subagent activity listener", unsubscribe);
    await closeChildSession(childSession, childExtensionsStarted, "subagent");
    releaseActiveChildSession(reservedChildSessionFile);
  }
}

export async function runSubagentResume(
  params: SubagentResumeParams,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<SubagentToolDetails> | undefined,
  ctx: ExtensionContext,
  options: RunnerOptions = {},
): Promise<TextToolResult<SubagentToolDetails>> {
  const deps = { ...productionRunnerDependencies, ...options.deps };
  let plan: ResumeRunPlan | undefined;
  let run: SubagentToolDetails["run"] | undefined;
  let ownedSave: OwnedSave | undefined;
  let childSession: ChildAgentSession | undefined;
  let childExtensionsStarted = false;
  let unsubscribe: (() => void) | undefined;
  let detachAbortHandler: (() => void) | undefined;
  let reservedChildSessionFile: string | undefined;

  try {
    plan = await prepareResumeRun(params, signal, ctx, deps, options.extensionFactories, (sessionFile, sessionId) => {
      reservedChildSessionFile = reserveActiveChildSession(sessionFile, sessionId);
    });
    const startedAt = deps.now();
    run = createInitialRunView({
      episodeId: deps.createEpisodeId(),
      sessionId: plan.startedRecord.sessionId,
      agent: plan.startedRecord.agent,
      now: startedAt,
    });
    ownedSave = captureOwnedSave(plan.root.subagentsDir, plan.childSessionManager, plan.profile.agentName);
    await appendManifestRecord(plan.manifestPath, {
      type: "resume_started",
      episodeId: run.episodeId,
      sessionId: run.sessionId,
      parentEpisodeId: plan.parentEpisodeId,
      agent: plan.profile.agentName,
      cwd: plan.startedRecord.cwd,
      context: plan.startedRecord.context,
      sessionFile: plan.childSessionFile,
      agentFile: plan.profile.agentFile ?? null,
      startedAt,
    }, deps.artifactOptions?.manifest);
    rememberRuntimeEpisode(plan.childSessionFile, run.episodeId, plan.parentDepth + 1);
    emitUpdate(onUpdate, toolDetails(run, ownedSave));
    throwIfInterrupted(signal);

    const created = await createChildSession(plan, plan.childSessionManager, deps);
    childSession = created.session;
    throwIfModelFallback(created.modelFallbackMessage);
    childExtensionsStarted = true;
    await bindChildExtensions(childSession);
    const activeChildSession = childSession;
    const abortState = attachAbortHandler(signal, activeChildSession);
    detachAbortHandler = abortState.detach;
    const activityState = createActivityState(run);
    unsubscribe = activeChildSession.subscribe((event) => {
      const reduction = reduceActivityEvent(activityState, event, deps.now());
      if (reduction.changed) {
        refreshContextUsage(activityState.run, activeChildSession);
        emitUpdate(onUpdate, toolDetails(activityState.run, ownedSave));
      }
    });

    const answer = await promptChildAndExtractAnswer(activeChildSession, plan.childSessionManager, plan.userPrompt, abortState);
    refreshContextUsage(run, activeChildSession);
    await finishResumeRun(plan.manifestPath, run, "completed", deps.now(), deps);
    const details = await bestEffortTerminalDetails(run, ownedSave);
    emitUpdate(onUpdate, details);

    return {
      content: [{ type: "text", text: renderSubagentResult(plan.profile.selection, run.sessionId, answer) }],
      details,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const interrupted = isSubagentInterruptedError(error);
    if (run && childSession) refreshContextUsage(run, childSession);
    if (plan) await materializeChildSessionFile(plan.childSessionManager);
    if (run && plan) {
      await finishResumeRun(plan.manifestPath, run, interrupted ? "aborted" : "failed", deps.now(), deps,
        interrupted ? PARENT_ABORT_ERROR : message);
      const details = await bestEffortTerminalDetails(run, ownedSave);
      emitUpdate(onUpdate, details);
      return {
        content: [{ type: "text", text: interrupted
          ? renderSubagentInterrupted(plan.profile.selection, run.sessionId)
          : renderSubagentRecoverableError(plan.profile.selection, run.sessionId, message) }],
        details,
        isError: true,
      };
    }
    const heading = plan ? errorHeading(plan.profile.selection) : "## Subagent resume error";
    throw new Error(`${heading}\n\n${message}`, { cause: error });
  } finally {
    if (run) forgetRuntimeEpisode(run.episodeId);
    runCleanup("remove subagent resume abort listener", detachAbortHandler);
    runCleanup("unsubscribe subagent resume activity listener", unsubscribe);
    await closeChildSession(childSession, childExtensionsStarted, "resumed subagent");
    releaseActiveChildSession(reservedChildSessionFile);
  }
}

async function prepareRun(
  params: SubagentParams,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
  deps: RunnerDependencies,
  options: RunnerOptions,
): Promise<RunPlan> {
  const context = params.context ?? "fresh";
  if (context === "fresh") return prepareFreshRun(params, signal, ctx, deps, options);
  if (context === "fork") return prepareForkRun(params, signal, ctx, deps, options);
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

  const { root, manifestPath, parentDepth, records } = await resolveArtifactRoot(parentSessionFile);
  const startedRecord = requireUniqueStartedRecordBySessionId(records, params.sessionId);
  assertUsableStartedRecord(startedRecord, params.sessionId);
  assertSessionFileInSubagentsRoot(startedRecord.sessionFile, root.subagentsDir, params.sessionId);
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
  const recordedContext = childSessionManager.buildSessionContext();
  const recordedModel = recordedContext.model;
  const thinkingLevel = childSessionManager.getBranch().some((entry) => entry.type === "thinking_level_change")
    ? recordedContext.thinkingLevel
    : undefined;
  const model = recordedModel
    ? resolveRecordedSubagentModel(recordedModel.provider, recordedModel.modelId, ctx.modelRegistry)
    : undefined;
  const loaderContext = extensionFactories === undefined
    ? { cwd: effectiveCwd, agentDir, settingsManager }
    : { cwd: effectiveCwd, agentDir, settingsManager, extensionFactories };
  const resourceLoader = deps.createResourceLoader(startedRecord.context === "fresh"
    ? buildFreshResourceLoaderOptions(profile, loaderContext, startedRecord.agentsMdOverride)
    : buildForkResourceLoaderOptions(loaderContext));
  await resourceLoader.reload();

  return {
    root,
    effectiveCwd,
    profile,
    manifestPath,
    parentEpisodeId: root.parentEpisodeId,
    parentDepth,
    startedRecord,
    childSessionManager,
    childSessionFile,
    agentDir,
    settingsManager,
    resourceLoader,
    userPrompt: params.message,
    model,
    thinkingLevel,
  };
}

async function prepareFreshRun(
  params: SubagentParams,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
  deps: RunnerDependencies,
  { extensionFactories }: RunnerOptions,
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
  const { model, thinkingLevel, fallbacks } = resolveRunModelChoices(params, profile, ctx);
  const { root, manifestPath, parentDepth } = await resolveArtifactRoot(parentSessionFile);
  const loaderContext = extensionFactories === undefined
    ? { cwd: effectiveCwd, agentDir, settingsManager }
    : { cwd: effectiveCwd, agentDir, settingsManager, extensionFactories };
  const resourceLoader = deps.createResourceLoader(buildFreshResourceLoaderOptions(profile, loaderContext, params.agentsMd));
  await resourceLoader.reload();

  return {
    context: "fresh",
    ...(params.agentsMd === undefined ? {} : { agentsMdOverride: params.agentsMd }),
    effectiveCwd,
    profile,
    root,
    manifestPath,
    parentDepth,
    agentDir,
    settingsManager,
    resourceLoader,
    userPrompt: buildInitialSubagentPrompt(profile, "fresh", params.task, parentDepth),
    model,
    thinkingLevel,
    fallbacks,
  };
}

async function prepareForkRun(
  params: SubagentParams,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
  deps: RunnerDependencies,
  { extensionFactories }: RunnerOptions,
): Promise<ForkRunPlan> {
  if (params.cwd !== undefined) throw new Error("cwd is not supported with context 'fork'.");
  if (params.agentsMd !== undefined) throw new Error("agentsMd is not supported with context 'fork'. Use it only with fresh runs.");
  throwIfAborted(signal, "Subagent run was aborted before child execution.");

  const parentSessionFile = ctx.sessionManager.getSessionFile();
  if (!parentSessionFile) throw new Error("subagent execution requires a persisted parent Pi session.");

  const currentLeafId = ctx.sessionManager.getLeafId();
  if (!currentLeafId) throw new Error("subagent fork execution requires a current session leaf.");

  const { root, manifestPath, parentDepth } = await resolveArtifactRoot(parentSessionFile);
  const effectiveCwd = ctx.sessionManager.getCwd();
  await assertDirectoryExists(effectiveCwd);
  throwIfAborted(signal, "Subagent run was aborted before child execution.");

  const agentDir = deps.getAgentDir();
  const settingsManager = createProjectTrustedSettingsManager(effectiveCwd, agentDir);
  const userAgentsDir = path.join(agentDir, "agents");
  const profile = await resolveAgentProfile(params, effectiveCwd, { userAgentsDir });
  const { model, thinkingLevel, fallbacks } = resolveRunModelChoices(params, profile, ctx);
  const sourceSessionManager = deps.openSessionManager(parentSessionFile, root.subagentsDir);
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
    agentDir,
    settingsManager,
    resourceLoader,
    userPrompt: buildInitialSubagentPrompt(profile, "fork", params.task, parentDepth),
    model,
    thinkingLevel,
    fallbacks,
    currentLeafId,
    sourceSessionManager,
  };
}

function resolveRunModelChoices(
  params: SubagentParams,
  profile: SubagentPromptProfile,
  ctx: ExtensionContext,
): { model: Model<Api> | undefined; thinkingLevel: string | undefined; fallbacks: ModelChoice[] } {
  // A call-level model replaces the chain, not just its first candidate.
  const selectedModel = params.model ?? profile.model;
  const candidates = selectedModel === undefined ? [] : parseModelChain(selectedModel);
  const choices = candidates.map(({ reference, level }) => {
    const model = resolveSubagentModel(reference, ctx.modelRegistry, ctx.model?.provider)!;
    return { model, thinkingLevel: resolveSubagentThinkingLevel(level, model) };
  });
  const model = choices[0]?.model ?? ctx.model;
  const thinkingLevel = choices[0]?.thinkingLevel ?? ctx.thinkingLevel;
  return { model, thinkingLevel, fallbacks: choices.slice(1) };
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
    if (isMissingDefaultAgentAlias(error)) return omittedSubagentProfile();
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

// Confused callers pass the reserved name "default" for the omitted mode; when no
// default.md is visible, that request means the omitted profile, not a missing agent.
function isMissingDefaultAgentAlias(error: unknown): boolean {
  return error instanceof MissingMarkdownAgentError && error.agentName === DEFAULT_AGENT_ALIAS;
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
    || (Object.hasOwn(record, "agentsMdOverride")
      && (record.context !== "fresh" || (record.agentsMdOverride !== "none" && record.agentsMdOverride !== "auto")))) {
    throw new Error(`Subagent session '${sessionId}' has an invalid manifest record.`);
  }
}

function assertSessionFileInSubagentsRoot(sessionFile: string, subagentsDir: string, sessionId: string): void {
  const relative = path.relative(path.resolve(subagentsDir), path.resolve(sessionFile));
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Subagent session '${sessionId}' points outside the current parent/root subagents directory.`);
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

async function resolveArtifactRoot(parentSessionFile: string): Promise<{ root: SubagentsRoot; manifestPath: string; parentDepth: number; records: ManifestRecords }> {
  const provisionalRoot = resolveSubagentsRoot(parentSessionFile, null);
  const manifestPath = manifestPathForSubagentsRoot(provisionalRoot.subagentsDir);
  const isNestedRun = path.dirname(path.resolve(parentSessionFile)) === path.resolve(provisionalRoot.subagentsDir);
  const records = await readManifestRecords(manifestPath);
  let parentEpisodeId: string | null = null;
  if (isNestedRun) {
    parentEpisodeId = runtimeEpisodeBySessionFile.get(path.resolve(parentSessionFile)) ?? null;
    if (parentEpisodeId === null) {
      parentEpisodeId = findParentEpisodeId(records, parentSessionFile);
    }
  }
  if (isNestedRun && parentEpisodeId === null) {
    throw new Error(`Could not determine parent subagent episode for nested session: ${parentSessionFile}`);
  }

  const parentDepth = parentEpisodeId === null ? 0 : runtimeEpisodeDepthByEpisode.get(parentEpisodeId) ?? episodeDepth(parentEpisodeId, records);
  if (parentDepth >= MAX_SUBAGENT_DEPTH) {
    throw new Error(`Subagent nesting limit exceeded: maximum depth is ${MAX_SUBAGENT_DEPTH}.`);
  }

  const root = resolveSubagentsRoot(parentSessionFile, parentEpisodeId);
  return { root, manifestPath: manifestPathForSubagentsRoot(root.subagentsDir), parentDepth, records };
}

function createStartedRun(plan: RunPlan, deps: RunnerDependencies): StartedRun {
  const episodeId = deps.createEpisodeId();
  const startedAt = deps.now();
  const childSessionManager = createChildSessionManager(plan, deps);
  const childSessionFile = childSessionManager.getSessionFile();
  if (!childSessionFile) throw new Error("Could not create a persisted child subagent session.");
  const sessionId = childSessionManager.getSessionId();

  const run = createInitialRunView({ episodeId, sessionId, agent: plan.profile.agentName, now: startedAt });
  return { run, childSessionManager, childSessionFile,
    ownedSave: captureOwnedSave(plan.root.subagentsDir, childSessionManager, plan.profile.agentName) };
}

async function startRunArtifacts(plan: RunPlan, started: StartedRun, deps: RunnerDependencies): Promise<void> {
  const { run, childSessionManager, childSessionFile } = started;
  const { episodeId, sessionId, lastActivityAt: startedAt } = run;
  if (plan.context === "fork") {
    if (plan.model) childSessionManager.appendModelChange(plan.model.provider, plan.model.id);
    if (plan.thinkingLevel !== undefined) childSessionManager.appendThinkingLevelChange(plan.thinkingLevel);
  }
  await appendManifestRecord(plan.manifestPath, {
    type: "started",
    episodeId,
    sessionId,
    parentEpisodeId: plan.root.parentEpisodeId,
    agent: plan.profile.agentName,
    cwd: plan.effectiveCwd,
    context: plan.context,
    ...(plan.context === "fresh" && plan.agentsMdOverride !== undefined ? { agentsMdOverride: plan.agentsMdOverride } : {}),
    sessionFile: childSessionFile,
    agentFile: plan.profile.agentFile ?? null,
    startedAt,
  }, deps.artifactOptions?.manifest);
  rememberRuntimeEpisode(childSessionFile, episodeId, plan.parentDepth + 1);
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
    // Pi defers session persistence. Early failure can leave a public session ID
    // without a file, so keep append bookkeeping consistent with this saved snapshot.
    inspectable.flushed = true;
  } catch (error: unknown) {
    console.error("subagent child session materialization failed", error);
  }
}

async function createChildSession(
  plan: ChildSessionPlan,
  childSessionManager: SessionManager,
  deps: RunnerDependencies,
): Promise<ChildSessionResult> {
  return deps.createAgentSession({
    cwd: plan.effectiveCwd,
    agentDir: plan.agentDir,
    ...(plan.model === undefined ? {} : { model: plan.model }),
    ...(plan.thinkingLevel === undefined ? {} : { thinkingLevel: plan.thinkingLevel as NonNullable<CreateAgentSessionOptions["thinkingLevel"]> }),
    settingsManager: plan.settingsManager,
    resourceLoader: plan.resourceLoader,
    sessionManager: childSessionManager,
  });
}

function preservePlannedSelection(plan: ChildSessionPlan, childSessionManager: SessionManager): void {
  try {
    if (plan.model && !childSessionManager.buildSessionContext().model) {
      childSessionManager.appendModelChange(plan.model.provider, plan.model.id);
    }
    if (plan.thinkingLevel !== undefined
      && !childSessionManager.getBranch().some((entry) => entry.type === "thinking_level_change")) {
      childSessionManager.appendThinkingLevelChange(plan.thinkingLevel);
    }
  } catch (error: unknown) {
    console.error("subagent child selection persistence failed", error);
  }
}

function throwIfModelFallback(modelFallbackMessage: string | undefined): void {
  if (modelFallbackMessage) throw new Error(modelFallbackMessage);
}

async function bindChildExtensions(childSession: ChildAgentSession): Promise<void> {
  await childSession.bindExtensions({ onError: (error: unknown) => console.error("subagent extension error", error) });
}

async function closeChildSession(
  childSession: ChildAgentSession | undefined,
  extensionsStarted: boolean,
  label: string,
): Promise<void> {
  if (!childSession) return;

  if (extensionsStarted) {
    try {
      if (childSession.hasExtensionHandlers("session_shutdown")) {
        await childSession.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      }
    } catch (error: unknown) {
      console.error(`Could not shut down ${label} child extensions`, error);
    }
  }

  runCleanup(`dispose ${label} child session`, () => childSession.dispose());
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

interface ChildAbortState {
  wasAborted: () => boolean;
  aborted: Promise<void>;
  settled: Promise<void>;
  detach: () => void;
}

function attachAbortHandler(signal: AbortSignal | undefined, childSession: ChildAgentSession): ChildAbortState {
  let abortRequested = false;
  let resolveAbort!: () => void;
  let resolveSettled!: () => void;
  const aborted = new Promise<void>((resolve) => {
    resolveAbort = resolve;
  });
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  const abortChild = () => {
    if (abortRequested) return;
    abortRequested = true;
    resolveAbort();
    void Promise.resolve()
      .then(() => childSession.abort())
      .catch((error: unknown) => {
        console.error("subagent child abort failed", error);
      })
      .finally(resolveSettled);
  };

  signal?.addEventListener("abort", abortChild, { once: true });
  if (signal?.aborted) abortChild();

  return {
    wasAborted: () => abortRequested,
    aborted,
    settled,
    detach: () => {
      if (signal) signal.removeEventListener("abort", abortChild);
    },
  };
}

async function promptChildAndExtractAnswer(
  childSession: ChildAgentSession,
  childSessionManager: SessionManager,
  task: string,
  abortState: ChildAbortState,
  hasToolProgress?: () => boolean,
): Promise<string> {
  if (abortState.wasAborted()) {
    await abortState.settled;
    throw new SubagentInterruptedError();
  }
  const leafBeforePrompt = childSessionManager.getLeafId();
  const messageCountBeforePrompt = (childSession.messages ?? []).length;
  const promptPromise = childSession.prompt(task);
  const winner = await Promise.race([
    promptPromise.then(() => "prompt" as const),
    abortState.aborted.then(() => "abort" as const),
  ]);
  if (winner === "abort") {
    void promptPromise.catch((error: unknown) => console.error("subagent child prompt failed after abort", error));
    await abortState.settled;
    throw new SubagentInterruptedError();
  }

  if (abortState.wasAborted()) {
    await abortState.settled;
    throw new SubagentInterruptedError();
  }
  const newMessages = messagesAfterLeaf(childSessionManager, leafBeforePrompt)
    ?? (childSession.messages ?? []).slice(messageCountBeforePrompt);
  const newAssistantMessages = assistantMessages(newMessages);
  const modelError = finalAssistantFailure(newAssistantMessages);
  if (modelError) {
    const firstTurnProviderError = hasToolProgress !== undefined && !hasToolProgress()
      && newAssistantMessages.length > 0
      && newAssistantMessages.every((message) => message.stopReason === "error" && !hasToolCall(message.content))
      && !newMessages.some((message) => isToolResult(message));
    if (firstTurnProviderError) throw new FirstTurnProviderError(modelError);
    throw new Error(modelError);
  }
  if (newAssistantMessages.length === 0) throw new Error("Child subagent finished without a new assistant response.");

  const answer = childSession.getLastAssistantText()?.trim();
  if (!answer) throw new Error("Child subagent finished without an assistant response.");
  return answer;
}

type TerminalRunStatus = Exclude<SubagentToolDetails["run"]["status"], "running">;

async function finishRun(
  manifestPath: string,
  run: SubagentToolDetails["run"],
  status: TerminalRunStatus,
  finishedAt: string,
  deps: RunnerDependencies,
  errorMessage?: string,
): Promise<void> {
  run.status = status;
  run.activity = terminalActivity(status);
  run.lastActivityAt = finishedAt;
  await appendManifestRecord(manifestPath, {
    type: "finished",
    episodeId: run.episodeId,
    status,
    finishedAt,
    ...(errorMessage === undefined ? {} : { error: errorMessage }),
  }, deps.artifactOptions?.manifest);
}

async function finishResumeRun(
  manifestPath: string,
  run: SubagentToolDetails["run"],
  status: TerminalRunStatus,
  finishedAt: string,
  deps: RunnerDependencies,
  errorMessage?: string,
): Promise<void> {
  run.status = status;
  run.activity = terminalActivity(status);
  run.lastActivityAt = finishedAt;
  await appendManifestRecord(manifestPath, {
    type: "resume_finished",
    episodeId: run.episodeId,
    sessionId: run.sessionId,
    status,
    finishedAt,
    ...(errorMessage === undefined ? {} : { error: errorMessage }),
  }, deps.artifactOptions?.manifest);
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

function rememberRuntimeEpisode(sessionFile: string, episodeId: string, depth: number): void {
  const normalized = path.resolve(sessionFile);
  runtimeEpisodeBySessionFile.set(normalized, episodeId);
  runtimeSessionFileByEpisode.set(episodeId, normalized);
  runtimeEpisodeDepthByEpisode.set(episodeId, depth);
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
}

function episodeDepth(episodeId: string, records: ManifestRecords): number {
  const byEpisodeId = startedRecordsByEpisodeId(records);
  let depth = 1;
  let current = byEpisodeId.get(episodeId)?.parentEpisodeId ?? null;
  const seen = new Set<string>([episodeId]);
  while (current) {
    if (seen.has(current)) return MAX_SUBAGENT_DEPTH;
    const record = byEpisodeId.get(current);
    if (record === undefined) throw new Error(`Could not determine subagent lineage: episode '${current}' is missing from the manifest.`);
    seen.add(current);
    depth += 1;
    current = record.parentEpisodeId;
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

function safeReferenceText(value: string): boolean {
  return value.length > 0 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}

function containedFile(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function captureOwnedSave(root: string, manager: SessionManager, label: string): OwnedSave | undefined {
  try {
    const header = manager.getHeader();
    const absoluteFile = manager.getSessionFile();
    const sessionId = manager.getSessionId();
    if (!header || header.type !== "session" || header.version !== 3 || header.id !== sessionId
      || !absoluteFile || !path.isAbsolute(root) || root === path.parse(root).root
      || !path.isAbsolute(absoluteFile) || !path.isAbsolute(header.cwd)
      || ![root, absoluteFile, sessionId, header.cwd].every(safeReferenceText)
      || !containedFile(root, absoluteFile)) return undefined;
    const file = path.relative(root, absoluteFile).split(path.sep).join("/");
    if (file.startsWith("~") || file.includes("\\") || file.split("/").some((part) => part === "" || part === "." || part === "..")) return undefined;
    return { root, absoluteFile, file, sessionId, cwd: header.cwd, ...(safeReferenceText(label) ? { label } : {}) };
  } catch {
    return undefined;
  }
}

function toolDetails(run: SubagentToolDetails["run"], save: OwnedSave | undefined): SubagentToolDetails {
  return {
    run: cloneRunView(run),
    ...(save === undefined ? {} : { savedConversations: {
      version: 1 as const,
      root: save.root,
      items: [{ sessionId: save.sessionId, file: save.file, ...(save.label === undefined ? {} : { label: save.label }) }],
    } }),
  };
}

async function bestEffortTerminalDetails(run: SubagentToolDetails["run"], save: OwnedSave | undefined): Promise<SubagentToolDetails> {
  let readable: OwnedSave | undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const root = save ? await realpath(save.root) : undefined;
    if (save && root && root !== path.parse(root).root && containedFile(root, await realpath(save.absoluteFile))) {
      handle = await open(save.absoluteFile, "r");
      const chunks: Buffer[] = [];
      for (;;) {
        const buffer = Buffer.alloc(4096);
        const { bytesRead } = await handle.read(buffer);
        if (bytesRead === 0) break;
        const newline = buffer.subarray(0, bytesRead).indexOf(10);
        chunks.push(buffer.subarray(0, newline === -1 ? bytesRead : newline));
        if (newline === -1) continue;
        const header: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (isObject(header) && header.type === "session" && header.version === 3
          && header.id === save.sessionId && header.cwd === save.cwd) readable = save;
        break;
      }
    }
  } catch {
  } finally {
    await handle?.close().catch(() => undefined);
  }
  return toolDetails(run, readable);
}

function emitUpdate(onUpdate: AgentToolUpdateCallback<SubagentToolDetails> | undefined, details: SubagentToolDetails): void {
  if (!onUpdate) return;
  try {
    onUpdate({
      content: [{ type: "text", text: renderSubagentProgress(details.run) }],
      details: structuredClone(details),
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

function messagesAfterLeaf(childSessionManager: SessionManager, leafBeforePrompt: string | null): unknown[] | undefined {
  const branch = childSessionManager.getBranch();
  if (branch.length === 0 && leafBeforePrompt === null) return undefined;

  const leafIndex = leafBeforePrompt === null ? -1 : branch.findIndex((entry) => entry.id === leafBeforePrompt);
  if (leafIndex === -1 && leafBeforePrompt !== null) return undefined;

  return branch
    .slice(leafIndex + 1)
    .flatMap((entry) => entry.type === "message" ? [entry.message] : []);
}

function assistantMessages(messages: readonly unknown[]): Array<{ role?: string; stopReason?: string; errorMessage?: string; content?: unknown }> {
  return messages.filter((message): message is { role?: string; stopReason?: string; errorMessage?: string; content?: unknown } => {
    return typeof message === "object" && message !== null && (message as { role?: string }).role === "assistant";
  });
}

function isToolResult(message: unknown): boolean {
  return isObject(message) && message.role === "toolResult";
}

function hasToolCall(content: unknown): boolean {
  return Array.isArray(content) && content.some((part) => isObject(part) && part.type === "toolCall");
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
