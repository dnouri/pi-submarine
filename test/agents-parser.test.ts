import { describe, expect, it } from "vitest";
import { parseMarkdownAgent, validateRequestedAgentName } from "../src/agents.js";

const FILE_PATH = "/repo/.pi/agents/reviewer.md";

function parse(content: string) {
  return parseMarkdownAgent(content, { filePath: FILE_PATH, name: "reviewer", source: "project" });
}

function validAgent(frontmatter = "description: Reviews code", body = "You review code.") {
  return `---\n${frontmatter}\n---\n\n${body}\n`;
}

describe("strict markdown agent parsing", () => {
  it("parses a minimal valid agent with default prompt-resource controls", () => {
    const agent = parse(validAgent());

    expect(agent).toEqual({
      name: "reviewer",
      description: "Reviews code",
      source: "project",
      filePath: FILE_PATH,
      body: "You review code.",
      agentsMd: "none",
      skills: "auto",
    });
  });

  it("parses optional agentsMd and skills controls", () => {
    expect(parse(validAgent("description: Researches\nagentsMd: auto\nskills: none")).agentsMd).toBe("auto");
    expect(parse(validAgent("description: Researches\nskills: research, audit")).skills).toEqual({ names: ["research", "audit"] });
  });

  it("splits frontmatter values after the first colon only", () => {
    const agent = parse(validAgent("description: Reviews code: tests: docs"));

    expect(agent.description).toBe("Reviews code: tests: docs");
  });

  it("accepts CRLF line endings without relaxing delimiter text", () => {
    const agent = parse("---\r\ndescription: Reviews code\r\n---\r\n\r\nYou review code.\r\n");

    expect(agent.description).toBe("Reviews code");
    expect(agent.body).toBe("You review code.");
  });

  it.each([
    ["missing opening delimiter", "description: Reviews\n---\nBody", "start with a line exactly equal to ---"],
    ["opening delimiter has extra text", "--- nope\ndescription: Reviews\n---\nBody", "start with a line exactly equal to ---"],
    ["missing closing delimiter", "---\ndescription: Reviews\nBody", "missing closing delimiter"],
    ["blank frontmatter line", "---\ndescription: Reviews\n\n---\nBody", "blank frontmatter lines are not allowed"],
    ["comment line", "---\ndescription: Reviews\n# no\n---\nBody", "comments are not allowed"],
    ["unknown key", "---\ndescription: Reviews\nmodel: x\n---\nBody", "unknown key 'model'"],
    ["duplicate key", "---\ndescription: Reviews\ndescription: Again\n---\nBody", "duplicate key 'description'"],
    ["missing colon", "---\ndescription Reviews\n---\nBody", "must be in key: value form"],
    ["empty description", "---\ndescription:   \n---\nBody", "description is required"],
    ["quoted double value", "---\ndescription: \"Reviews\"\n---\nBody", "quoted values are invalid"],
    ["quoted single value", "---\ndescription: 'Reviews'\n---\nBody", "quoted values are invalid"],
    ["invalid agentsMd", "---\ndescription: Reviews\nagentsMd: yes\n---\nBody", "agentsMd must be 'none' or 'auto'"],
    ["array syntax", "---\ndescription: Reviews\nskills: [research]\n---\nBody", "YAML arrays are invalid"],
    ["literal block scalar", "---\ndescription: |\n---\nBody", "YAML block scalars are invalid"],
    ["folded block scalar", "---\ndescription: >\n---\nBody", "YAML block scalars are invalid"],
    ["array continuation", "---\ndescription: Reviews\nskills: research\n- audit\n---\nBody", "must be in key: value form"],
    ["empty body", "---\ndescription: Reviews\n---\n   \n", "markdown body is required"],
    ["empty skill item", "---\ndescription: Reviews\nskills: research,,audit\n---\nBody", "skills must not contain empty names"],
  ])("rejects %s", (_name, content, reason) => {
    expect(() => parse(content)).toThrow(FILE_PATH);
    expect(() => parse(content)).toThrow(reason);
  });
});

describe("requested agent name validation", () => {
  it("trims valid names", () => {
    expect(validateRequestedAgentName(" reviewer ")).toBe("reviewer");
  });

  it.each(["", "   ", "../x", "a/b", "a\\b", "has\0nul"])("rejects invalid requested name %#", (name) => {
    expect(() => validateRequestedAgentName(name)).toThrow("Invalid subagent name");
  });
});
