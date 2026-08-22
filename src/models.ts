import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

type SubagentModelRegistry = Pick<ModelRegistry, "getAll" | "hasConfiguredAuth">;

export function resolveRecordedSubagentModel(
  provider: string,
  modelId: string,
  modelRegistry: SubagentModelRegistry,
): Model<Api> {
  const model = modelRegistry.getAll().find(
    (candidate) => candidate.provider === provider && candidate.id === modelId,
  );
  if (!model) {
    throw new Error(`Recorded subagent model '${provider}/${modelId}' not found in Pi's model catalog.`);
  }
  return requireAuthenticatedModel(model, modelRegistry);
}

export function resolveSubagentModel(
  rawReference: string | undefined,
  modelRegistry: SubagentModelRegistry,
  preferredProvider?: string,
): Model<Api> | undefined {
  if (rawReference === undefined) return undefined;

  const reference = rawReference.trim();
  if (!reference) {
    throw new Error("Invalid subagent model: provide a non-empty model ID or provider/model ID.");
  }

  const models = modelRegistry.getAll();
  const normalizedReference = reference.toLowerCase();
  const canonicalMatches = models.filter(
    (model) => `${model.provider}/${model.id}`.toLowerCase() === normalizedReference,
  );
  if (canonicalMatches.length > 0) {
    return requireSingleAuthenticatedModel(reference, canonicalMatches, modelRegistry);
  }

  const idMatches = models.filter((model) => model.id.toLowerCase() === normalizedReference);
  if (idMatches.length === 0) {
    throw new Error(`Subagent model '${reference}' not found. Use a model ID or provider/model ID from Pi's model catalog.`);
  }

  const authenticatedMatches = idMatches.filter((model) => modelRegistry.hasConfiguredAuth(model));
  if (preferredProvider) {
    const preferredMatches = authenticatedMatches.filter(
      (model) => model.provider.toLowerCase() === preferredProvider.toLowerCase(),
    );
    if (preferredMatches.length === 1) return preferredMatches[0];
  }

  if (authenticatedMatches.length === 1) return authenticatedMatches[0];
  if (authenticatedMatches.length === 0) {
    if (idMatches.length === 1) return requireAuthenticatedModel(idMatches[0]!, modelRegistry);
    throw new Error(
      `No authentication configured for any subagent model matching '${reference}'. Candidates: ${formatCandidates(idMatches)}.`,
    );
  }

  throw new Error(
    `Subagent model '${reference}' is ambiguous. Use a provider/model ID: ${formatCandidates(authenticatedMatches)}.`,
  );
}

function requireSingleAuthenticatedModel(
  reference: string,
  matches: Model<Api>[],
  modelRegistry: SubagentModelRegistry,
): Model<Api> {
  if (matches.length !== 1) {
    throw new Error(`Subagent model '${reference}' is ambiguous. Candidates: ${formatCandidates(matches)}.`);
  }
  return requireAuthenticatedModel(matches[0]!, modelRegistry);
}

function requireAuthenticatedModel(model: Model<Api>, modelRegistry: SubagentModelRegistry): Model<Api> {
  if (!modelRegistry.hasConfiguredAuth(model)) {
    throw new Error(`No authentication configured for subagent model '${model.provider}/${model.id}'.`);
  }
  return model;
}

function formatCandidates(models: Model<Api>[]): string {
  return models
    .map((model) => `${model.provider}/${model.id}`)
    .sort((left, right) => left.localeCompare(right))
    .join(", ");
}
