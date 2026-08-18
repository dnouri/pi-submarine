import { describe, expect, it } from "vitest";
import { buildForkResourceLoaderOptions, buildFreshResourceLoaderOptions, buildInitialSubagentPrompt, omittedSubagentProfile, namedSubagentProfile } from "../src/runner.js";
import { subagentAgentTagName } from "../src/tool-prompts.js";
import type { MarkdownAgent } from "../src/types.js";
import type { Skill } from "@earendil-works/pi-coding-agent";

const namedAgent: MarkdownAgent = {
  name: "reviewer",
  description: "Reviews code",
  source: "project",
  filePath: "/repo/.pi/agents/reviewer.md",
  body: "Review carefully.",
  model: "zai/glm-5v-turbo",
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

  it("keeps named-agent fresh mode resource controls out of the system prompt", () => {
    const profile = namedSubagentProfile(namedAgent);
    const options = buildFreshResourceLoaderOptions(profile, { cwd: "/repo", agentDir: "/agent" });

    expect(profile.selection).toEqual({ kind: "named", name: "reviewer", agentFile: namedAgent.filePath });
    expect(profile.model).toBe("zai/glm-5v-turbo");
    expect(options.noContextFiles).toBe(true);
    expect(options.appendSystemPromptOverride).toBeUndefined();
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

describe("initial subagent prompt envelopes", () => {
  it("wraps omitted-agent fresh prompts with root context", () => {
    expect(buildInitialSubagentPrompt(omittedSubagentProfile(), "fresh", "answer from scratch", 0)).toBe(`<subagent-context>
You are a child subagent. You start without the parent conversation.
You are the first subagent in this tree.
</subagent-context>

<task>
answer from scratch
</task>`);
  });

  it("wraps omitted-agent fork prompts with fork context", () => {
    expect(buildInitialSubagentPrompt(omittedSubagentProfile(), "fork", "answer from history", 0)).toBe(`<subagent-context>
You are a child subagent. You start from a copy of the parent conversation.
You are the first subagent in this tree.
</subagent-context>

<task>
answer from history
</task>`);
  });

  it("includes named-agent markdown bodies in a sanitized user-prompt block", () => {
    expect(buildInitialSubagentPrompt(namedSubagentProfile(namedAgent), "fork", "inspect the branch", 1)).toBe(`<subagent-context>
You are a child subagent. You start from a copy of the parent conversation.
You have one parent subagent above you in this tree.
</subagent-context>

<reviewer-agent>
Review carefully.
</reviewer-agent>

<task>
inspect the branch
</task>`);
  });

  it("sanitizes named-agent XML-style tags", () => {
    expect(subagentAgentTagName("reviewer")).toBe("reviewer-agent");
    expect(subagentAgentTagName("code.review")).toBe("code-review-agent");
    expect(subagentAgentTagName("2nd-pass")).toBe("agent-2nd-pass-agent");
  });

  it("describes deeper nested subagents naturally", () => {
    expect(buildInitialSubagentPrompt(omittedSubagentProfile(), "fresh", "deep task", 3)).toContain("You have 3 parent subagents above you in this tree.");
  });
});

describe("fork resource profiles", () => {
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
