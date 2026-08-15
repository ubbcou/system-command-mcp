import { spawnSync } from "node:child_process";

const toolNames = ["system_environment", "system_exec", "system_output"];
const callName = tool => `mcp__system-command__${tool}`;
const codex = process.platform === "win32" ? "codex.cmd" : "codex";
const fail = code => { throw new Error(code); };
const check = (value, code = "EVIDENCE_ASSERTION_FAILED") => { if (!value) fail(code); };
const run = (command, args, required = true) => {
  let result;
  try {
    const commandArgs = process.platform === "win32" && command === codex ? args.map(value => `"${value.replaceAll("\"", "\\\"")}"`) : args;
    result = spawnSync(command, commandArgs, { encoding: "utf8", shell: process.platform === "win32" });
  } catch { fail("COMMAND_FAILED"); }
  if (required && result.status !== 0) fail("COMMAND_FAILED");
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};
const json = (text, code) => {
  try { return JSON.parse(text); } catch { fail(code); }
};
const jsonl = text => text.trim().split(/\r?\n/).filter(Boolean).map(line => json(line, "CODEX_JSONL_INVALID"));
const contentText = value => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(contentText).join("");
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  return contentText(value.content ?? value.value?.content);
};
const resultJson = call => json(contentText(call.result), "MCP_RESULT_JSON_INVALID");
const canonical = value => ({
  completedWithoutError: true,
  exitCode: value.exitCode,
  timedOut: value.timedOut,
  cancelled: value.cancelled,
  stdout: Object.fromEntries(["truncated", "totalBytes", "omittedBytes", "lossyUtf8"].map(key => [key, value.stdout?.[key]])),
  stderr: Object.fromEntries(["truncated", "totalBytes", "omittedBytes", "lossyUtf8"].map(key => [key, value.stderr?.[key]])),
  artifact: { status: value.artifact?.status, published: Boolean(value.artifact?.id) },
});
const expectedTools = ["system_environment", "system_exec", "system_exec", "system_exec", "system_output"];
const mcpCalls = events => {
  const calls = new Map();
  for (const event of events) {
    if (event.item?.type !== "mcp_tool_call") continue;
    check(event.type === "item.started" || event.type === "item.completed", "MCP_EVENT_INVALID");
    check(typeof event.item.id === "string", "MCP_IDENTIFIER_INVALID");
    const call = calls.get(event.item.id) ?? {};
    check(call[event.type] === undefined, "MCP_LIFECYCLE_INVALID");
    call[event.type] = event.item;
    calls.set(event.item.id, call);
  }
  check(calls.size === 5, "MCP_CALL_COUNT_INVALID");
  const lifecycle = [...calls.values()];
  for (const call of lifecycle) {
    check(call["item.started"] !== undefined && call["item.completed"] !== undefined, "MCP_CALL_INCOMPLETE");
    check(call["item.started"].server === "system-command" && call["item.completed"].server === "system-command", "MCP_SERVER_INVALID");
    check(call["item.started"].tool === call["item.completed"].tool, "MCP_LIFECYCLE_INVALID");
    check(call["item.started"].error === null && call["item.completed"].status === "completed" && call["item.completed"].error === null, "MCP_CALL_FAILED");
  }
  const started = lifecycle.map(call => call["item.started"]);
  const completed = lifecycle.map(call => call["item.completed"]);
  check(JSON.stringify(started.map(call => call.tool)) === JSON.stringify(expectedTools), "MCP_SEQUENCE_INVALID");
  check(JSON.stringify(completed.map(call => call.tool)) === JSON.stringify(expectedTools), "MCP_SEQUENCE_INVALID");
  return completed;
};
const main = () => {
  const version = run(codex, ["--version"]);
  const listed = json(run(codex, ["mcp", "list", "--json"]).stdout, "REGISTRATION_LIST_JSON_INVALID");
  const registered = json(run(codex, ["mcp", "get", "system-command", "--json"]).stdout, "REGISTRATION_GET_JSON_INVALID");
  check(registered.name === "system-command" && registered.enabled === true && registered.transport?.type === "stdio", "REGISTRATION_INVALID");
  check(listed.some(item => item.name === "system-command" && item.enabled && item.transport?.type === "stdio"), "REGISTRATION_INVALID");
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
    const calls = mcpCalls(jsonl(execution.stdout));
    check(JSON.stringify(calls[0].arguments) === "{}", "MCP_ARGUMENTS_INVALID");
    for (const call of calls.slice(1, 4)) check(call.arguments?.program === "node", "MCP_ARGUMENTS_INVALID");
    const environment = resultJson(calls[0]);
    check(environment.mode === "configured", "ENVIRONMENT_MODE_INVALID");
    check(JSON.stringify(Object.keys(environment.programs ?? {}).sort()) === JSON.stringify(["node"]), "ENVIRONMENT_PROGRAMS_INVALID");
    const executions = calls.slice(1, 4).map(resultJson);
    const [success, nonzero, timeout] = [executions.find(value => value.exitCode === 0), executions.find(value => value.exitCode === 7), executions.find(value => value.timedOut === true)];
    check(success && nonzero && timeout, "EXECUTION_RESULTS_INVALID");
    check(success.timedOut === false && success.cancelled === false && success.artifact?.status === "published" && success.artifact?.id, "SUCCESS_RESULT_INVALID");
    check(nonzero.timedOut === false && nonzero.cancelled === false && nonzero.artifact?.status === "published", "NONZERO_RESULT_INVALID");
    check(timeout.cancelled === false && timeout.artifact?.status === "published", "TIMEOUT_RESULT_INVALID");
    check(calls[4].arguments?.id === success.artifact.id, "OUTPUT_ARTIFACT_INVALID");
    const page = resultJson(calls[4]);
    check(page.encoding === "utf8" && typeof page.text === "string" && page.text.startsWith("SYSTEM_COMMAND_SUCCESS_MARKER"), "OUTPUT_PAGE_INVALID");
    evidence.fullAcceptance = true;
    evidence.tools = toolNames.map(callName);
    evidence.environment = { platform: environment.platform, arch: environment.arch, mode: environment.mode, programNames: Object.keys(environment.programs ?? {}).sort() };
    evidence.executions = { success: canonical(success), nonzero: canonical(nonzero), timeout: canonical(timeout) };
    evidence.outputPage = { completedWithoutError: true, bytes: page.bytes, nextOffset: page.nextOffset, eof: page.eof, encoding: page.encoding, textPrefix: page.text.slice(0, 16), lossyUtf8: page.lossyUtf8 };
  }
  console.log(JSON.stringify(evidence));
};
try { main(); } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "CODEX_EVIDENCE_FAILED"}\n`); process.exitCode = 1; }
