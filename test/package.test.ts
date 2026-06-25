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

  it("declares npm provenance and package gallery metadata", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    const galleryBaseUrl = `https://raw.githubusercontent.com/dnouri/pi-submarine/${packageJson.version}/media/pi-submarine`;

    expect(packageJson.author).toBe("Daniel Nouri");
    expect(packageJson.repository).toEqual({
      type: "git",
      url: "https://github.com/dnouri/pi-submarine",
    });
    expect(packageJson.homepage).toBe("https://github.com/dnouri/pi-submarine#readme");
    expect(packageJson.bugs).toEqual({ url: "https://github.com/dnouri/pi-submarine/issues" });
    expect(packageJson.pi.video).toBe(`${galleryBaseUrl}.mp4`);
    expect(packageJson.pi.image).toBe(`${galleryBaseUrl}.jpg`);
  });

  it("uses Pi peer dependencies without bundling Pi runtime packages", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

    expect(packageJson.peerDependencies).toEqual({
      "@earendil-works/pi-ai": "*",
      "@earendil-works/pi-coding-agent": "*",
      typebox: "*",
    });
    expect(packageJson.devDependencies["@earendil-works/pi-coding-agent"]).toBe("0.79.1");
    expect(packageJson.dependencies ?? {}).toEqual({});
  });

  it("publishes source and README", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

    expect(packageJson.files).toEqual(["src/", "README.md"]);
  });
});
