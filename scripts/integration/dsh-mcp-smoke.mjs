import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dshImport, dshModules } from "./dsh-checkout.mjs";

const [command = process.execPath, ...providedArgs] = process.argv.slice(2);
const defaultArgs = [fileURLToPath(new URL("../../dist/src/cli.js", import.meta.url))];
const args = providedArgs.length ? providedArgs : defaultArgs;
let temporaryRoot;
let temporaryArtifact;
let root = process.env.SYSTEM_COMMAND_ROOT;
let manifest = process.env.SYSTEM_COMMAND_MANIFEST;
if (!manifest) {
  temporaryRoot = await mkdtemp(join(tmpdir(), "system-command-dsh-"));
  temporaryArtifact = join(temporaryRoot, "artifacts");
  root = temporaryRoot;
  manifest = join(temporaryRoot, "manifest.json");
  await writeFile(manifest, JSON.stringify({
    version: 1,
    allowInheritedPath: false,
    programs: { node: { candidates: [process.execPath], required: true, policy: { artifactPolicy: "always", defaultTimeoutMs: 500, maxTimeoutMs: 1_000 } } },
  }));
}
root = resolve(root ?? process.cwd());
manifest = resolve(manifest);
const modules = dshModules();
const { Context } = await dshImport(modules, "@deepseek-ai/cordis/lib/index.js");
const { default: SystemPrompt } = await dshImport(modules, "@deepseek-ai/dsh-system-prompt/lib/index.js");
const { default: ToolRuntime } = await dshImport(modules, "@deepseek-ai/dsh-tools/lib/index.js");
const mcp = await dshImport(modules, "@deepseek-ai/dsh-mcp-client/lib/index.js");
const expected = ["mcp__system-command__system_environment", "mcp__system-command__system_exec", "mcp__system-command__system_output"];
const text = result => result.value?.content?.[0]?.text ?? result.content?.[0]?.text;
const call = async (ctx, name, toolArguments) => {
  const result = await ctx.tools.execute({ callId: crypto.randomUUID(), name, arguments: toolArguments, signal: new AbortController().signal });
  assert.equal(result.isError, false, JSON.stringify(result));
  const value = JSON.parse(text(result));
  return { result, value };
};
const canonical = value => ({
  exitCode: value.exitCode,
  signal: value.signal,
  timedOut: value.timedOut,
  cancelled: value.cancelled,
  stdout: Object.fromEntries(["text", "truncated", "totalBytes", "omittedBytes", "lossyUtf8"].map(key => [key, value.stdout[key]])),
  stderr: Object.fromEntries(["text", "truncated", "totalBytes", "omittedBytes", "lossyUtf8"].map(key => [key, value.stderr[key]])),
  artifact: { status: value.artifact?.status, published: Boolean(value.artifact?.id) },
});
const ctx = new Context();
const prompt = await ctx.plugin(SystemPrompt, {});
const tools = await ctx.plugin(ToolRuntime, { mode: "native" });
const artifactDirectory = process.env.SYSTEM_COMMAND_ARTIFACT_DIR ?? temporaryArtifact;
const client = await ctx.plugin(mcp, { serverName: "system-command", transport: "stdio", command, args: [...args, "serve", "--manifest", manifest, "--root", root, ...(artifactDirectory ? ["--artifact-dir", artifactDirectory] : [])], cwd: root, toolCallTimeoutMs: 30_000, failOnStartupError: true, reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 } });
try {
  assert.deepEqual(ctx.tools.schemas().map(item => item.name ?? item.function?.name).sort(), expected);
  const environment = (await call(ctx, expected[0], {})).value;
  assert.deepEqual(Object.keys(environment.programs).sort(), ["node"]);
  const exec = toolArguments => call(ctx, expected[1], { program: "node", ...toolArguments });
  const success = (await exec({ args: ["-e", "process.stdout.write('DSH_SMOKE_MARKER')"] })).value;
  const nonzero = (await exec({ args: ["-e", "process.exit(7)"] })).value;
  const timeout = (await exec({ args: ["-e", "setTimeout(() => {}, 10_000)"], timeoutMs: 50 })).value;
  for (const value of [success, nonzero, timeout]) {
    assert.equal(value.artifact?.status, "published");
    assert.match(value.artifact?.id ?? "", /^[a-f0-9]{32}$/);
    assert.equal(typeof value.exitCode === "number" || value.exitCode === null, true);
    assert.equal(typeof value.timedOut, "boolean");
    assert.equal(typeof value.cancelled, "boolean");
  }
  assert.equal(success.exitCode, 0); assert.equal(success.stdout.text, "DSH_SMOKE_MARKER");
  assert.equal(nonzero.exitCode, 7); assert.equal(nonzero.timedOut, false); assert.equal(nonzero.cancelled, false);
  assert.equal(timeout.timedOut, true); assert.equal(timeout.cancelled, false);
  const page = (await call(ctx, expected[2], { id: success.artifact.id, stream: "stdout", offset: 0, limit: 5, encoding: "utf8" })).value;
  assert.deepEqual(page, { bytes: 5, nextOffset: 5, eof: false, encoding: "utf8", text: "DSH_S", lossyUtf8: false });
  console.log(JSON.stringify({ tools: expected, environment: { platform: environment.platform, arch: environment.arch, mode: environment.mode, programNames: Object.keys(environment.programs).sort() }, executions: { success: canonical(success), nonzero: canonical(nonzero), timeout: canonical(timeout) }, outputPage: page }));
} finally {
  await client.dispose();
  await tools.dispose();
  await prompt.dispose();
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
}
