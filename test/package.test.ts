import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("package metadata", () => {
  it("declares the Pi extension package shape", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

    expect(packageJson.name).toBe("pi-submarine");
    expect(packageJson.type).toBe("module");
    expect(packageJson.pi.extensions).toEqual(["./src/index.ts"]);
    expect(packageJson.keywords).toEqual(expect.arrayContaining(["pi-package", "pi-extension", "subagent", "pi"]));
  });

  it("declares npm provenance and keeps media links on the package release", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    const releaseTag = packageJson.version.replace(/\.0$/, "");
    const galleryBaseUrl = `https://raw.githubusercontent.com/dnouri/pi-submarine/${releaseTag}/media/pi-submarine`;

    expect(packageJson.author).toBe("Daniel Nouri");
    expect(packageJson.repository).toEqual({
      type: "git",
      url: "https://github.com/dnouri/pi-submarine",
    });
    expect(packageJson.homepage).toBe("https://github.com/dnouri/pi-submarine#readme");
    expect(packageJson.bugs).toEqual({ url: "https://github.com/dnouri/pi-submarine/issues" });
    expect(packageJson.pi.video).toBeUndefined();
    expect(packageJson.pi.image).toBe(`${galleryBaseUrl}.jpg`);
    expect(readme).toContain(`src="${galleryBaseUrl}.gif"`);
  });

  it("uses Pi peer dependencies without bundling Pi runtime packages", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

    expect(packageJson.peerDependencies).toEqual({
      "@earendil-works/pi-ai": "^1.3.0",
      "@earendil-works/pi-coding-agent": "^1.3.0",
      typebox: "*",
    });
    expect(packageJson.devDependencies["@earendil-works/pi-ai"]).toBe("1.3.0");
    expect(packageJson.devDependencies["@earendil-works/pi-coding-agent"]).toBe("1.3.0");
    expect(packageJson.dependencies ?? {}).toEqual({});
  });

  it("publishes source and README", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

    expect(packageJson.files).toEqual(["src/", "README.md"]);
  });
});
