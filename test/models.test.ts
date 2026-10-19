import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { parseModelChain, resolveRecordedSubagentModel, resolveSubagentModel, resolveSubagentThinkingLevel } from "../src/models.js";

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

describe("model chain parsing", () => {
  it("parses one explicit candidate", () => {
    expect(parseModelChain("provider/a@off")).toEqual([{ reference: "provider/a", level: "off" }]);
  });

  it("parses two and three explicit candidates in order", () => {
    expect(parseModelChain("provider/a@low,provider/b@high")).toEqual([
      { reference: "provider/a", level: "low" }, { reference: "provider/b", level: "high" },
    ]);
    expect(parseModelChain("provider/a@low,provider/b@high,provider/c@max")).toEqual([
      { reference: "provider/a", level: "low" }, { reference: "provider/b", level: "high" }, { reference: "provider/c", level: "max" },
    ]);
  });

  it.each([4, 64])("parses a long chain of %i explicit candidates in order", (count) => {
    const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
    const candidates = Array.from({ length: count }, (_, index) => ({
      reference: `provider/model-${index + 1}`,
      level: levels[index % levels.length]!,
    }));

    expect(parseModelChain(candidates.map(({ reference, level }) => `${reference}@${level}`).join(","))).toEqual(candidates);
  });

  it.each(["off", "minimal", "low", "medium", "high", "xhigh", "max"])("accepts the %s suffix", (level) => {
    expect(parseModelChain(`a@${level}`)).toEqual([{ reference: "a", level }]);
  });

  it("trims candidate and suffix whitespace without splitting slashes or colons", () => {
    expect(parseModelChain("  provider/family/a:variant @ high  , b @ off ")).toEqual([
      { reference: "provider/family/a:variant", level: "high" }, { reference: "b", level: "off" },
    ]);
  });

  it.each([
    "@cf/openai/gpt-oss-120b",
    "cloudflare-workers-ai/@cf/openai/gpt-oss-120b",
    "cloudflare-ai-gateway/workers-ai/@cf/moonshotai/kimi-k2.5",
  ])("preserves literal namespace @ signs in %s", (reference) => {
    expect(parseModelChain(`${reference}@high`)).toEqual([{ reference, level: "high" }]);
  });

  it.each([
    "a", "a,b", "a,b@high", "a@low,b",
    "a,b@high,c@off", "a@low,b,c@off", "a@low,b@high,c",
    "a@low,b@high,c@off,d@low,e",
    " @cf/openai/gpt-oss-120b ",
  ])("rejects a missing suffix anywhere in %s", (chain) => {
    expect(() => parseModelChain(chain)).toThrow("requires an explicit @effort suffix");
  });

  it.each([
    ["a@", "thinking level ''"],
    ["a@  ", "thinking level ''"],
    ["a@turbo", "thinking level 'turbo'"],
    ["", "empty or invalid candidate"],
    ["a@low,,b@high", "empty or invalid candidate"],
    ["a@low,", "empty or invalid candidate"],
    ["@high", "empty or invalid candidate"],
    ["a@low@high", "empty or invalid candidate"],
    ["a@low,b@off,c@high,d@low,e@turbo", "thinking level 'turbo'"],
    ["a@low,b@off,c@high,d@low,", "empty or invalid candidate"],
  ])("rejects invalid chain %s", (chain, reason) => {
    expect(() => parseModelChain(chain)).toThrow(reason);
  });
});

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

  it("supports explicit off for a non-reasoning model", () => {
    expect(resolveSubagentThinkingLevel("off", model("zai", "glm-5.3-flash"))).toBe("off");
  });

  it("rejects max on SDK 0.79.1 rather than clamping even when a model map advertises it", () => {
    expect(() => resolveSubagentThinkingLevel("max", reasoningModel)).toThrow(
      "Subagent thinking level 'max' is not supported by model 'zai/glm-5.3'. Supported levels: low, high.",
    );
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
