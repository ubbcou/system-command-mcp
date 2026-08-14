import assert from "node:assert/strict";
import { execPath } from "node:process";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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

    const result = await client.callTool({
      name: "system_exec",
      arguments: { program: "node", args: ["--version"] },
    });
    assert.equal(result.isError, false);
    const value = result.structuredContent as { exitCode: number; stdout: { text: string } };
    assert.equal(value.exitCode, 0);
    assert.match(value.stdout.text, /^v\d+/);
  } finally {
    await client.close();
  }
});
