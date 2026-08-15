# system-command-mcp

跨平台系统命令 MCP Server。AI 使用稳定的 `program + args[]` 接口调用已注册程序，不需要选择 Bash、PowerShell 或 cmd.exe，也不需要用 `which`、`where`、`command -v`、`Get-Command` 探测工具。

## 工具

### system_exec

`program` 枚举在 Server 启动时根据当前 `PATH` 自动生成：

```json
{
  "program": "git",
  "args": ["status", "--short"],
  "cwd": ".",
  "timeoutMs": 30000
}
```

参数不会经过 Shell 展开，`$HOME`、`*.ts`、`&&` 等会原样传递。

### system_environment

返回平台、架构、根工作目录，以及逻辑程序名到真实可执行文件的映射。通常无需先调用；`system_exec.program` 的 Schema 已包含可用程序。

## 构建和测试

```bash
npm install
npm run build
npm test
```

需要 Node.js 20 或更高版本。

## 管理 CLI 与 MCP 配置

```bash
# 生成不可覆盖的确定性 Manifest；不会修改 Codex 或 DSH 配置
system-command-mcp init --manifest system-command-manifest.json
# 显式启动；旧的 `--root PATH` 调用在 1.0 前仍兼容，但会发出 stderr 弃用提示
system-command-mcp serve --manifest system-command-manifest.json --root /absolute/path/to/workspace
# 默认只做静态 JSON/Manifest/Root 检查，不会执行程序；--probe 才会解析程序
system-command-mcp doctor --manifest system-command-manifest.json --root /absolute/path/to/workspace
system-command-mcp doctor --probe --manifest system-command-manifest.json --root /absolute/path/to/workspace
# 仅把对应的配置片段写到 stdout，注意审阅后手动添加
system-command-mcp print-config codex --manifest system-command-manifest.json --root /absolute/path/to/workspace
system-command-mcp print-config dsh --manifest system-command-manifest.json --root /absolute/path/to/workspace
```

Manifest Schema 和示例分别为 `system-command-manifest.schema.json`、`system-command-manifest.example.json`。Codex 输出会识别 `CODEX_HOME`（默认 `~/.codex`），并包含 `command`、`args`、`cwd`、`startup_timeout_sec` 和 `tool_timeout_sec`。DSH 输出包含 `toolCallTimeoutMs`、`failOnStartupError` 和 `reconnect`。

## Host Guidance

- 一个直接的已注册 Program 调用使用 `system_exec`；
- 管道、重定向、展开及其他 Shell 组合使用宿主 Shell；
- 读写和枚举文件使用宿主文件系统工具；
- Root 只验证执行进程的 cwd，**不是**文件系统沙箱，也不会限制已启动程序能访问的文件。

## 默认逻辑程序名

- git、node、npm、pnpm、yarn、bun
- python：依次解析 python3、python
- ripgrep：解析 rg
- powershell：依次解析 pwsh、powershell

只暴露当前环境实际存在的程序。

## 当前限制

- 仅支持 stdio transport；
- 不支持管道、重定向、任意 Shell 脚本、交互式 TTY 或后台常驻进程；
- 默认超时 30 秒，stdout/stderr 分别保留最后 1 MiB；
- cwd 必须位于 --root 内；
- 程序快照在启动时生成，环境变化后需重启 Server；
- 超时和取消只保证终止直接子进程，不保证清理完整进程树。
