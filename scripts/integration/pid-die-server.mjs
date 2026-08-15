import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "pid-die", version: "1.0.0" });
const result = () => ({ content: [{ type: "text", text: String(process.pid) }] });
server.registerTool("pid", { inputSchema: {} }, result);
server.registerTool("die", { inputSchema: {} }, () => {
  setTimeout(() => process.exit(0), 25);
  return result();
});
await server.connect(new StdioServerTransport());
