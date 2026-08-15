import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const toolNames = ["system_environment", "system_exec", "system_output"];
const callName = tool => `mcp__system-command__${tool}`;
const codex = process.platform === "win32" ? "codex.cmd" : "codex";
const run = (command, args, required = true) => {
  const commandArgs = process.platform === "win32" && command === codex ? args.map(value => `"${value.replaceAll("\"", "\\\"")}"`) : args;
  const result = spawnSync(command, commandArgs, { encoding: "utf8", shell: process.platform === "win32" });
  if (required && result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status})\n${result.stderr}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};
const json = (text, command) => {
  try { return JSON.parse(text); } catch { throw new Error(`${command} did not return JSON`); }
};
const jsonl = text => text.trim().split(/\r?\n/).filter(Boolean).map((line, index) => {
  try { return JSON.parse(line); } catch { throw new Error(`codex exec --json emitted invalid JSONL at line ${index + 1}`); }
});
const contentText = value => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(contentText).join("");
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  return contentText(value.content ?? value.value?.content);
};
const resultJson = call => json(contentText(call.result), `${call.tool} result`);
const canonical = value => ({
  isError: false,
  exitCode: value.exitCode,
  timedOut: value.timedOut,
  cancelled: value.cancelled,
  stdout: Object.fromEntries(["truncated", "totalBytes", "omittedBytes", "lossyUtf8"].map(key => [key, value.stdout?.[key]])),
  stderr: Object.fromEntries(["truncated", "totalBytes", "omittedBytes", "lossyUtf8"].map(key => [key, value.stderr?.[key]])),
  artifact: { status: value.artifact?.status, published: Boolean(value.artifact?.id) },
});
const assertCall = (call, tool) => {
  assert.equal(call.server, "system-command");
  assert.equal(call.tool, tool);
  assert.equal(call.status, "completed");
  assert.equal(call.error, null);
};
const version = run(codex, ["--version"]);
const listed = json(run(codex, ["mcp", "list", "--json"]).stdout, "codex mcp list --json");
const registered = json(run(codex, ["mcp", "get", "system-command", "--json"]).stdout, "codex mcp get system-command --json");
assert.equal(registered.name, "system-command");
assert.equal(registered.enabled, true);
assert.equal(registered.transport?.type, "stdio");
assert.equal(listed.some(item => item.name === "system-command" && item.enabled && item.transport?.type === "stdio"), true);
const evidence = {
  evidenceSource: "credentialed-local-real-codex",
  testedTree: run("git", ["write-tree"]).stdout?.trim(),
  headParent: run("git", ["rev-parse", "HEAD"]).stdout?.trim(),
  commands: ["codex --version", "codex mcp list --json", "codex mcp get system-command --json"],
  codex: { version: version.stdout.trim(), registration: { listed: true, systemCommand: true } },
  fullAcceptance: false,
};
if (process.env.CODEX_ACCEPTANCE_FULL === "1") {
  const prompt = `Use only these exact system-command MCP tools: ${callName("system_environment")} once; ${callName("system_exec")} three times with program node for a successful stdout marker, exit code 7, and a timeout; then ${callName("system_output")} once to read the success artifact stdout. Do not call any other system-command tool. Complete all calls even if a command exits nonzero. Do not report tool JSON; a brief completion message is enough.`;
  const execution = run(codex, ["exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", prompt]);
  evidence.commands.push("codex exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox <environment-and-execution-scenarios>");
  const calls = jsonl(execution.stdout).filter(event => event.type === "item.completed" && event.item?.type === "mcp_tool_call").map(event => event.item);
  assert.equal(calls.length, 5, `expected exactly five system-command MCP calls, got ${calls.length}: ${JSON.stringify(calls.map(call => ({ tool: call.tool, status: call.status, error: call.error, arguments: call.arguments })))}`);
  assertCall(calls[0], "system_environment");
  for (const call of calls.slice(1, 4)) assertCall(call, "system_exec");
  assertCall(calls[4], "system_output");
  assert.deepEqual(calls.map(call => call.tool), ["system_environment", "system_exec", "system_exec", "system_exec", "system_output"]);
  assert.deepEqual(calls[0].arguments, {});
  for (const call of calls.slice(1, 4)) assert.equal(call.arguments?.program, "node");
  const environment = resultJson(calls[0]);
  const executions = calls.slice(1, 4).map(resultJson);
  const [success, nonzero, timeout] = [executions.find(value => value.exitCode === 0), executions.find(value => value.exitCode === 7), executions.find(value => value.timedOut === true)];
  assert.ok(success, "missing successful system_exec result");
  assert.ok(nonzero, "missing nonzero system_exec result");
  assert.ok(timeout, "missing timeout system_exec result");
  assert.equal(success.timedOut, false); assert.equal(success.cancelled, false); assert.equal(success.artifact?.status, "published"); assert.ok(success.artifact?.id);
  assert.equal(nonzero.timedOut, false); assert.equal(nonzero.cancelled, false); assert.equal(nonzero.artifact?.status, "published");
  assert.equal(timeout.cancelled, false); assert.equal(timeout.artifact?.status, "published");
  assert.equal(calls[4].arguments?.id, success.artifact.id, "system_output must use the success artifact identity");
  const page = resultJson(calls[4]);
  assert.equal(page.encoding, "utf8"); assert.equal(typeof page.text, "string"); assert.ok(page.text.startsWith("SYSTEM_COMMAND_SUCCESS_MARKER"));
  evidence.fullAcceptance = true;
  evidence.tools = toolNames.map(callName);
  evidence.environment = { platform: environment.platform, arch: environment.arch, mode: environment.mode, programNames: Object.keys(environment.programs ?? {}).sort() };
  evidence.executions = { success: canonical(success), nonzero: canonical(nonzero), timeout: canonical(timeout) };
  evidence.outputPage = { bytes: page.bytes, nextOffset: page.nextOffset, eof: page.eof, encoding: page.encoding, textPrefix: page.text.slice(0, 16), lossyUtf8: page.lossyUtf8 };
}
console.log(JSON.stringify(evidence));
