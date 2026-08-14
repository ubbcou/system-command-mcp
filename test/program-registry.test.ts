import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectEnvironment, resolveExecutable } from "../src/program-registry.js";

async function executable(dir: string, name: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, "fixture");
  return path;
}

test("resolveExecutable uses candidate priority", async () => {
  const first = await mkdtemp(join(tmpdir(), "system-command-mcp-first-"));
  const second = await mkdtemp(join(tmpdir(), "system-command-mcp-second-"));
  const platform = "win32";
  const expected = await executable(second, "python3.exe");
  await executable(first, "python.exe");
  const actual = await resolveExecutable(["python3", "python"], {
    path: [first, second].join(";"), pathExt: ".EXE", platform,
  });
  assert.equal(actual, expected);
});

test("resolveExecutable uses Windows PATH and PATHEXT semantics", async () => {
  const first = await mkdtemp(join(tmpdir(), "system-command-mcp-win-first-"));
  const second = await mkdtemp(join(tmpdir(), "system-command-mcp-win-second-"));
  const expected = join(second, "tool.exe");
  await writeFile(expected, "");
  const actual = await resolveExecutable(["tool"], {
    path: first + ";" + second,
    pathExt: ".EXE;.CMD",
    platform: "win32",
  });
  assert.equal(actual, expected);
});

test("inspectEnvironment exposes only installed logical programs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "system-command-mcp-registry-"));
  const suffix = process.platform === "win32" ? ".exe" : "";
  const path = await executable(dir, "real-tool" + suffix);
  const snapshot = await inspectEnvironment({
    cwd: dir, path: dir, aliases: { tool: ["real-tool"], missing: ["missing"] },
  });
  assert.equal(snapshot.programs.tool?.executable, path);
  assert.equal(snapshot.programs.missing, undefined);
});
