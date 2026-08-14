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

## MCP 配置

```json
{
  "mcpServers": {
    "system-command": {
      "command": "node",
      "args": [
        "/absolute/path/system-command-mcp/dist/src/cli.js",
        "--root",
        "/absolute/path/to/workspace"
      ]
    }
  }
}
```

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
