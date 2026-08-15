import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dshImport, dshModules } from "./dsh-checkout.mjs";

const modules = dshModules();
const { Context } = await dshImport(modules, "@deepseek-ai/cordis/lib/index.js");
const { default: SystemPrompt } = await dshImport(modules, "@deepseek-ai/dsh-system-prompt/lib/index.js");
const { default: ToolRuntime } = await dshImport(modules, "@deepseek-ai/dsh-tools/lib/index.js");
const mcp = await dshImport(modules, "@deepseek-ai/dsh-mcp-client/lib/index.js");
const here = fileURLToPath(new URL(".", import.meta.url));
const name = raw => `mcp__pid_die__${raw}`;
const call = async (ctx, raw) => {
  const result = await ctx.tools.execute({ callId: crypto.randomUUID(), name: name(raw), arguments: {}, signal: new AbortController().signal });
  assert.equal(result.isError, false, JSON.stringify(result));
  return Number(result.content[0].text);
};
const waitFor = async check => {
  for (let i = 0; i < 50; i++) {
    try { const value = await check(); if (value) return value; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("MCP child did not reconnect");
};
const ctx = new Context();
const prompt = await ctx.plugin(SystemPrompt, {});
const tools = await ctx.plugin(ToolRuntime, {});
const client = await ctx.plugin(mcp, { transport: "stdio", serverName: "pid_die", command: process.execPath, args: [fileURLToPath(new URL("./pid-die-server.mjs", import.meta.url))], env: {}, cwd: here, toolCallTimeoutMs: 2_000, failOnStartupError: true, reconnect: { initialDelayMs: 10, maxDelayMs: 50, maxAttempts: 10 } });
try {
  const exact = ["mcp__pid_die__die", "mcp__pid_die__pid"];
  assert.deepEqual(ctx.tools.schemas().map(({ name }) => name).sort(), exact);
  assert.deepEqual((await ctx.systemPrompt.assemble()).tools.map(({ name }) => name).sort(), exact);
  const before = await call(ctx, "pid");
  await call(ctx, "die");
  const after = await waitFor(async () => { const pid = await call(ctx, "pid"); return pid !== before && pid; });
  console.log(JSON.stringify({ tools: exact, pidChanged: true, disposedToolsEmpty: true, commandResultShape: ["content", "isError"] }));
} finally {
  await client.dispose();
  assert.deepEqual(ctx.tools.schemas(), []);
  await tools.dispose();
  await prompt.dispose();
}
