import assert from "node:assert/strict";
import { execPath } from "node:process";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("createServer requires explicit roots with a manifest", async () => {
  await assert.rejects(createServer({ manifest: { version: 1, programs: {} } }), /ROOT_REQUIRED/);
});

test("MCP Server transport close cancels active execution once", async () => {
  const server = await createServer({ root: process.cwd() });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handler = (server as unknown as { _registeredTools: Record<string, { handler: (args: { program: string; args: string[]; timeoutMs: number }, extra: { signal: AbortSignal }) => Promise<{ structuredContent: unknown }> }> })._registeredTools.system_exec!.handler;
  await server.connect(serverTransport);
  const running = handler({ program: "node", args: ["-e", "setTimeout(() => {}, 1000)"], timeoutMs: 2_000 }, { signal: new AbortController().signal });
  await new Promise(resolve => setTimeout(resolve, 20));
  await Promise.all([clientTransport.close(), server.close(), server.close()]);
  assert.equal(((await running).structuredContent as { cancelled: boolean }).cancelled, true);
});

test("stdio server lists dynamic programs and executes one", async () => {
  const transport = new StdioClientTransport({
    command: execPath,
    args: ["dist/src/cli.js", "--root", process.cwd()],
    cwd: process.cwd(),
    stderr: "pipe",
  });
  const client = new Client({ name: "system-command-mcp-test", version: "0.1.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ["system_environment", "system_exec"]);
    const execTool = listed.tools.find((tool) => tool.name === "system_exec");
    const programSchema = execTool?.inputSchema.properties?.program as { enum?: string[] } | undefined;
    assert.ok(programSchema?.enum?.includes("node"));
    const environment = await client.callTool({ name: "system_environment", arguments: {} });
    const registered = (environment.structuredContent as { programs: Record<string, { declaredCandidate: string; argumentSemantics: string }> }).programs.node;
    assert.equal(registered?.declaredCandidate, "node");
    assert.equal(registered?.argumentSemantics, "literal-argv");

    const result = await client.callTool({
      name: "system_exec",
      arguments: { program: "node", args: ["--version"] },
    });
    assert.equal(result.isError, false);
    const value = result.structuredContent as { exitCode: number; stdout: { text: string } };
    assert.equal(value.exitCode, 0);
    assert.match(value.stdout.text, /^v\d+/);

    const nonzero = await client.callTool({ name: "system_exec", arguments: { program: "node", args: ["-e", "process.exit(7)"] } });
    assert.equal(nonzero.isError, false);
    assert.equal((nonzero.structuredContent as { exitCode: number }).exitCode, 7);
  } finally {
    await client.close();
  }
});
