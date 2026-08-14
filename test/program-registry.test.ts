import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectEnvironment, resolveExecutable } from "../src/program-registry.js";

async function executable(dir: string, name: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, "fixture");
  if (process.platform !== "win32") await chmod(path, 0o755);
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
  assert.equal(actual, await realpath(expected));
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
  assert.equal(actual, await realpath(expected));
});

test("resolveExecutable normalizes configured Windows PATHEXT casing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "system-command-mcp-win-case-"));
  const expected = await executable(dir, "tool.EXE");
  const actual = await resolveExecutable(["tool"], { path: dir, pathExt: ".exe", platform: "win32" });
  assert.equal(actual, await realpath(expected));
});

test("inspectEnvironment exposes only installed logical programs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "system-command-mcp-registry-"));
  const suffix = process.platform === "win32" ? ".exe" : "";
  const path = await executable(dir, "real-tool" + suffix);
  const snapshot = await inspectEnvironment({
    cwd: dir, path: dir, aliases: { tool: ["missing-tool", "real-tool"], missing: ["missing"] },
  });
  assert.equal(snapshot.programs.tool?.executable, path);
  assert.equal(snapshot.programs.tool?.declaredCandidate, "real-tool");
  assert.equal(snapshot.programs.missing, undefined);
});

test("inspectEnvironment resolves executable symlinks", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "system-command-mcp-registry-link-"));
  const suffix = process.platform === "win32" ? ".exe" : "";
  const target = await executable(dir, "target" + suffix);
  const link = join(dir, "tool" + suffix);
  try { await symlink(target, link, process.platform === "win32" ? "file" : undefined); } catch (error) { if (process.platform === "win32") return t.skip(`symlink unavailable: ${error}`); throw error; }
  const snapshot = await inspectEnvironment({ cwd: dir, path: dir, aliases: { tool: ["tool"] } });
  assert.equal(snapshot.programs.tool?.executable, await realpath(target));
  assert.equal(snapshot.programs.tool?.declaredCandidate, "tool");
});
