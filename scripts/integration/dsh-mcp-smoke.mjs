import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dshImport, dshModules } from "./dsh-checkout.mjs";

const [command = process.execPath, ...providedArgs] = process.argv.slice(2);
const defaultArgs = [fileURLToPath(new URL("../../dist/src/cli.js", import.meta.url))];
const args = providedArgs.length ? providedArgs : defaultArgs;
const root = resolve(process.env.SYSTEM_COMMAND_ROOT ?? process.cwd());
const manifest = process.env.SYSTEM_COMMAND_MANIFEST;
if (!manifest) throw new Error("usage: SYSTEM_COMMAND_MANIFEST=/absolute/manifest.json [SYSTEM_COMMAND_ROOT=/absolute/root] node scripts/integration/dsh-mcp-smoke.mjs [command] [args...]");
const modules = dshModules();
const { Context } = await dshImport(modules, "@deepseek-ai/cordis/lib/index.js");
const { default: SystemPrompt } = await dshImport(modules, "@deepseek-ai/dsh-system-prompt/lib/index.js");
const { default: ToolRuntime } = await dshImport(modules, "@deepseek-ai/dsh-tools/lib/index.js");
const mcp = await dshImport(modules, "@deepseek-ai/dsh-mcp-client/lib/index.js");
const expected = ["mcp__system-command__system_environment", "mcp__system-command__system_exec", "mcp__system-command__system_output"];
const ctx = new Context();
const prompt = await ctx.plugin(SystemPrompt, {});
const tools = await ctx.plugin(ToolRuntime, { mode: "native" });
const client = await ctx.plugin(mcp, { serverName: "system-command", transport: "stdio", command, args: [...args, "serve", "--manifest", resolve(manifest), "--root", root], cwd: root, toolCallTimeoutMs: 30_000, failOnStartupError: true, reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 } });
try {
  assert.deepEqual(ctx.tools.schemas().map(item => item.name ?? item.function?.name).sort(), expected);
  const result = await ctx.tools.execute({ callId: "env-1", name: expected[0], arguments: {}, signal: new AbortController().signal });
  assert.equal(result.isError, false, JSON.stringify(result));
  const environment = JSON.parse(result.value.content[0].text);
  assert.ok(environment.programs?.node, "node not registered");
  console.log(JSON.stringify({ names: expected, commandResultShape: Object.keys(result).sort(), nodeRegistered: true }));
} finally {
  await client.dispose();
  await tools.dispose();
  await prompt.dispose();
}
