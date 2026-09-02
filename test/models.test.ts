import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { resolveRecordedSubagentModel, resolveSubagentModel, resolveSubagentThinkingLevel } from "../src/models.js";

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

describe("subagent thinking-level resolution", () => {
  const reasoningModel = {
    provider: "zai",
    id: "glm-5.3",
    name: "GLM-5.3",
    reasoning: true,
    thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
  } as unknown as Model<any>;

  it("passes through a level supported by the resolved model", () => {
    expect(resolveSubagentThinkingLevel("high", reasoningModel)).toBe("high");
  });

  it("returns undefined when no level was requested", () => {
    expect(resolveSubagentThinkingLevel(undefined, reasoningModel)).toBeUndefined();
  });

  it("skips model validation when no model was resolved", () => {
    expect(resolveSubagentThinkingLevel("high", undefined)).toBe("high");
  });

  it("rejects an unsupported level with the supported list", () => {
    const plainModel = model("zai", "glm-5.3-flash");

    expect(() => resolveSubagentThinkingLevel("high", plainModel)).toThrow(
      "Subagent thinking level 'high' is not supported by model 'zai/glm-5.3-flash'. Supported levels: off.",
    );
  });
});

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
