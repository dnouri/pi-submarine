import { describe, expect, it } from "vitest";
import { buildForkPrompt, buildForkResourceLoaderOptions, buildFreshResourceLoaderOptions, omittedSubagentProfile, namedSubagentProfile } from "../src/runner.js";
import type { MarkdownAgent } from "../src/types.js";
import type { Skill } from "@earendil-works/pi-coding-agent";

const namedAgent: MarkdownAgent = {
  name: "reviewer",
  description: "Reviews code",
  source: "project",
  filePath: "/repo/.pi/agents/reviewer.md",
  body: "Review carefully.",
  agentsMd: "none",
  skills: { names: ["audit"] },
};

describe("subagent prompt-resource profiles", () => {
  it("keeps omitted-agent fresh mode free of markdown lookup and context files while preserving normal skills", () => {
    const profile = omittedSubagentProfile();
    const options = buildFreshResourceLoaderOptions(profile, { cwd: "/repo", agentDir: "/agent" });

    expect(profile.selection).toEqual({ kind: "omitted", label: "subagent" });
    expect(profile.agentName).toBe("subagent");
    expect(profile.agentFile).toBeUndefined();
    expect(profile.agentBody).toBeUndefined();
    expect(options).toMatchObject({ cwd: "/repo", agentDir: "/agent", noContextFiles: true });
    expect(options.noSkills).toBeUndefined();
    expect(options.appendSystemPromptOverride).toBeUndefined();
  });

  it("appends named agent bodies without discarding normal append-prompt resources", () => {
    const profile = namedSubagentProfile(namedAgent);
    const options = buildFreshResourceLoaderOptions(profile, { cwd: "/repo", agentDir: "/agent" });

    expect(profile.selection).toEqual({ kind: "named", name: "reviewer", agentFile: namedAgent.filePath });
    expect(options.noContextFiles).toBe(true);
    expect(options.appendSystemPromptOverride?.(["base append"])).toEqual(["base append", "Review carefully."]);
  });

  it("leaves normal context-file discovery enabled for agentsMd auto", () => {
    const profile = namedSubagentProfile({ ...namedAgent, agentsMd: "auto", skills: "auto" });
    const options = buildFreshResourceLoaderOptions(profile, { cwd: "/repo", agentDir: "/agent" });

    expect(options.noContextFiles).toBeUndefined();
  });

  it("suppresses all skills for skills none", () => {
    const profile = namedSubagentProfile({ ...namedAgent, skills: "none" });
    const options = buildFreshResourceLoaderOptions(profile, { cwd: "/repo", agentDir: "/agent" });

    expect(options.noSkills).toBe(true);
    expect(options.skillsOverride).toBeUndefined();
  });

  it("filters named skills and fails when a requested skill is missing or hidden from model invocation", () => {
    const profile = namedSubagentProfile(namedAgent);
    const options = buildFreshResourceLoaderOptions(profile, { cwd: "/repo", agentDir: "/agent" });
    const base: { diagnostics: []; skills: Skill[] } = {
      diagnostics: [],
      skills: [
        { name: "audit", description: "Audit", filePath: "/skills/audit/SKILL.md", baseDir: "/skills/audit", sourceInfo: { path: "/skills/audit/SKILL.md", source: "local", scope: "project", origin: "top-level" }, disableModelInvocation: false },
        { name: "hidden", description: "Hidden", filePath: "/skills/hidden/SKILL.md", baseDir: "/skills/hidden", sourceInfo: { path: "/skills/hidden/SKILL.md", source: "local", scope: "project", origin: "top-level" }, disableModelInvocation: true },
      ],
    };

    expect(options.skillsOverride?.(base).skills.map((skill) => skill.name)).toEqual(["audit"]);

    const hiddenOptions = buildFreshResourceLoaderOptions(namedSubagentProfile({ ...namedAgent, skills: { names: ["hidden"] } }), { cwd: "/repo", agentDir: "/agent" });
    expect(() => hiddenOptions.skillsOverride?.(base)).toThrow("Unavailable skill(s) for subagent 'reviewer': hidden");
  });
});

describe("fork prompt/resource profiles", () => {
  it("uses the raw task for omitted-agent fork prompts", () => {
    expect(buildForkPrompt(omittedSubagentProfile(), "answer from history")).toBe("answer from history");
  });

  it("prefixes named-agent fork prompts as user-message text", () => {
    expect(buildForkPrompt(namedSubagentProfile(namedAgent), "inspect the branch")).toBe("Subagent instructions from `reviewer`:\nReview carefully.\n\nTask:\ninspect the branch");
  });

  it("keeps fork resource loading free of subagent prompt-resource overrides", () => {
    const options = buildForkResourceLoaderOptions({ cwd: "/repo", agentDir: "/agent" });

    expect(options).toMatchObject({ cwd: "/repo", agentDir: "/agent" });
    expect(options.noContextFiles).toBeUndefined();
    expect(options.noSkills).toBeUndefined();
    expect(options.skillsOverride).toBeUndefined();
    expect(options.appendSystemPromptOverride).toBeUndefined();
    expect(options.appendSystemPrompt).toBeUndefined();
    expect(options.systemPromptOverride).toBeUndefined();
  });
});
