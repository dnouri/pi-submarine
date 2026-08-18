import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { resolveRecordedSubagentModel, resolveSubagentModel } from "../src/models.js";

function model(provider: string, id: string): Model<any> {
  return { provider, id, name: id } as Model<any>;
}

function registry(
  models: Model<any>[],
  authenticated: Model<any>[] = models,
): Pick<ModelRegistry, "getAll" | "hasConfiguredAuth"> {
  const authenticatedModels = new Set(authenticated);
  return {
    getAll: () => models,
    hasConfiguredAuth: (candidate) => authenticatedModels.has(candidate),
  } as Pick<ModelRegistry, "getAll" | "hasConfiguredAuth">;
}

describe("subagent model resolution", () => {
  it("resolves canonical references without splitting slashes or colons in the model ID", () => {
    const selected = model("openrouter", "z-ai/glm-5v-turbo:free");

    expect(resolveSubagentModel("openrouter/z-ai/glm-5v-turbo:free", registry([selected]))).toBe(selected);
  });

  it("uses the parent provider to disambiguate a bare model ID", () => {
    const global = model("zai", "glm-5v-turbo");
    const china = model("zai-coding-cn", "glm-5v-turbo");

    expect(resolveSubagentModel("glm-5v-turbo", registry([global, china]), "zai-coding-cn")).toBe(china);
  });

  it("selects the only authenticated match for a bare model ID", () => {
    const global = model("zai", "glm-5v-turbo");
    const china = model("zai-coding-cn", "glm-5v-turbo");

    expect(resolveSubagentModel("glm-5v-turbo", registry([global, china], [global]))).toBe(global);
  });

  it("requires a canonical reference when a bare model ID remains ambiguous", () => {
    const global = model("zai", "glm-5v-turbo");
    const china = model("zai-coding-cn", "glm-5v-turbo");

    expect(() => resolveSubagentModel("glm-5v-turbo", registry([global, china]))).toThrow("ambiguous");
    expect(() => resolveSubagentModel("glm-5v-turbo", registry([global, china]))).toThrow("zai/glm-5v-turbo");
    expect(() => resolveSubagentModel("glm-5v-turbo", registry([global, china]))).toThrow("zai-coding-cn/glm-5v-turbo");
  });

  it("does not reinterpret an unavailable recorded model as another provider's raw model ID", () => {
    const gatewayModel = model("vercel-ai-gateway", "zai/glm-5v-turbo");

    expect(() => resolveRecordedSubagentModel("zai", "glm-5v-turbo", registry([gatewayModel]))).toThrow(
      "Recorded subagent model 'zai/glm-5v-turbo' not found",
    );
  });

  it("rejects blank, unknown, and unauthenticated model references", () => {
    const selected = model("zai", "glm-5v-turbo");
    const configuredRegistry = registry([selected]);
    const unauthenticatedRegistry = registry([selected], []);

    expect(() => resolveSubagentModel("   ", configuredRegistry)).toThrow("non-empty");
    expect(() => resolveSubagentModel("missing", configuredRegistry)).toThrow("not found");
    expect(() => resolveSubagentModel("zai/glm-5v-turbo", unauthenticatedRegistry)).toThrow(
      "No authentication configured",
    );
  });
});
