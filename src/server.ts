import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createCommandRuntime, type CommandRuntimeOptions, type RuntimeEnvironment } from "./runtime.js";

export interface ServerOptions extends Omit<CommandRuntimeOptions, "roots"> {
  /** @deprecated Use roots for multiple Working Directory Roots. */
  root?: string;
  roots?: readonly string[];
}

function environmentValue(snapshot: RuntimeEnvironment): Record<string, unknown> {
  return {
    platform: snapshot.platform, arch: snapshot.arch, cwd: snapshot.cwd, mode: snapshot.mode, roots: snapshot.roots,
    programs: Object.fromEntries(Object.entries(snapshot.programs).map(([name, program]) => [name, { executable: program.executable, declaredCandidate: program.declaredCandidate, kind: program.kind, argumentSemantics: program.argumentSemantics, ...(program.variantSet ? { variantSet: program.variantSet } : {}) }])),
  };
}

export async function createServer(options: ServerOptions): Promise<McpServer> {
  if (options.manifest !== undefined && !options.roots?.length && !options.root) throw new Error("ROOT_REQUIRED");
  const roots = options.roots ?? (options.root ? [options.root] : [process.cwd()]);
  const runtime = await createCommandRuntime({ ...options, roots });
  const snapshot = await runtime.inspectEnvironment();
  const programNames = Object.keys(snapshot.programs).sort();
  const programSchema = programNames.length > 0 ? z.enum(programNames as [string, ...string[]]) : z.string().refine(() => false, "No programs are registered");
  const server = new McpServer({ name: "system-command-mcp", version: "0.1.0" });
  let runtimeClose: Promise<void> | undefined;
  const closeRuntime = (): Promise<void> => runtimeClose ??= runtime.close();
  const connect = server.connect.bind(server);
  server.connect = async transport => {
    const onclose = transport.onclose;
    transport.onclose = () => { onclose?.(); void closeRuntime(); };
    await connect(transport);
  };
  const close = server.close.bind(server);
  server.close = async () => { await closeRuntime(); await close(); };
  server.registerTool("system_environment", {
    description: "Return the authoritative Execution Environment and Registered Programs, including argumentSemantics: literal or cmd-reparsed. Program availability is already reflected in system_exec; do not probe with shell discovery commands.",
  }, async () => {
    const value = environmentValue(await runtime.inspectEnvironment());
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value };
  });
  server.registerTool("system_output", {
    description: "Read a bounded raw-output page from a completed Execution Artifact.",
    inputSchema: { id: z.string(), stream: z.enum(["stdout", "stderr"]), offset: z.number().int().nonnegative(), limit: z.number().int().positive().max(1024 * 1024).optional(), encoding: z.enum(["utf8", "base64"]).optional() },
  }, async ({ id, stream, offset, limit, encoding }) => { const value = await runtime.readOutput(id, stream, offset, limit ?? 64 * 1024, encoding ?? "utf8"); return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value as unknown as Record<string, unknown> }; });
  server.registerTool("system_exec", {
    description: "Execute one Registered Program directly. Check system_environment.argumentSemantics: native programs are literal; Windows .cmd/.bat Platform Wrappers are cmd-reparsed and reject %, !, &, |, <, >, ^, CR, LF, and NUL arguments. Even accepted wrapper arguments have narrower fidelity. Shell operators, pipelines, redirects, command substitution, and environment expansion are not supported.",
    inputSchema: {
      program: programSchema.describe("Registered Logical Program name."), args: z.array(z.string()).optional().describe("Native programs receive literal arguments; Windows .cmd/.bat wrapper arguments are restricted and reparsed by cmd.exe."),
      cwd: z.string().optional().describe("Single-root: relative or absolute; multi-root: authorized absolute path."),
      timeoutMs: z.number().optional().describe("Positive timeout in milliseconds within the Program Policy."), input: z.string().optional().describe("Optional bounded Execution Input for a Program that permits it."),
    },
  }, async ({ program, args, cwd, timeoutMs, input }, extra) => {
    const result = await runtime.execute({ program, args, cwd, timeoutMs, input, signal: extra.signal });
    const value = result as unknown as Record<string, unknown>;
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: value, isError: false };
  });
  return server;
}
