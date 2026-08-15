import { spawnSync } from "node:child_process";

const run = (args, required = true) => {
  const result = spawnSync("codex", args, { encoding: "utf8" });
  if (required && result.status !== 0) throw new Error(`codex ${args.join(" ")} failed (${result.status})\n${result.stderr}`);
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
};
const version = run(["--version"]);
const listed = run(["mcp", "list", "--json"]);
const registered = run(["mcp", "get", "system-command", "--json"]);
const evidence = {
  evidenceSource: "credentialed-local-real-codex",
  gitCommitTested: process.env.GIT_COMMIT_TESTED ?? "record-with-GIT_COMMIT_TESTED",
  commands: ["codex --version", "codex mcp list --json", "codex mcp get system-command --json"],
  codex: { version: version.stdout, registrationChecked: true },
  registration: { listed: listed.status === 0, systemCommand: registered.status === 0 },
  environment: { platform: process.platform, arch: process.arch, mode: "configured", programNames: ["node"] },
  toolCallCompleted: false,
};
if (process.env.CODEX_ACCEPTANCE === "1") {
  const execution = run(["exec", "--skip-git-repo-check", "Use the system-command MCP tool system_environment exactly once. Return only its JSON."], false);
  evidence.commands.push("codex exec --skip-git-repo-check <system_environment prompt>");
  evidence.toolCallCompleted = execution.status === 0;
  evidence.codex.execExitCode = execution.status;
}
console.log(JSON.stringify(evidence));
