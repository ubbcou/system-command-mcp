# Windows x64：交给 AI Agent 的安装指南

本文件供 Windows 设备上的 AI coding agent 执行。目标是安装一个固定版本的 `system-command-mcp`，并让 Codex 与 DSH 使用 Managed Installation，而不是 Git checkout。

## 一句话安装指令

复制下面整段给目标设备上的 AI agent：

> 请读取并严格执行 https://raw.githubusercontent.com/ubbcou/system-command-mcp/main/docs/install/windows-agent.md 。自主完成环境识别、版本化 Managed Installation、Manifest 生成、Codex/DSH 配置备份与切换，以及真实验收；除非遇到缺少凭据、软件或权限等外部阻塞，否则不要让我手动操作。不要执行 npm publish 或创建 GitHub Release。

## Agent 执行契约

1. 先确认 `process.platform=win32`、`process.arch=x64`、Node.js `>=20`；不符合则停止并报告。
2. 所有配置修改前先读取原文件并创建时间戳备份。
3. 使用最新稳定 tag；若仓库还没有 tag，则固定当前 `main` commit，并在安装记录中写入 commit SHA。不要部署一个会随 Git checkout 变化的入口。
4. 不复制其他设备的 `node_modules`。在本机用 npm tarball 安装生产依赖。
5. 不删除旧版本安装；升级通过新增版本目录和切换稳定 launcher 完成，以便回滚。
6. Root 只授权执行请求的 `cwd`，不是文件系统 sandbox。
7. Windows `.cmd`/`.bat` 是 `cmd-reparsed`，不得声称其参数具有原生 literal argv 保真度。
8. 禁止 `npm publish`、GitHub Release，以及无备份覆盖 Host 配置。

## 目标布局

使用当前用户目录，不硬编码指南作者的用户名：

```text
%USERPROFILE%\.local\share\system-command-mcp\<version>\
%USERPROFILE%\.local\bin\system-command-mcp.cmd
%USERPROFILE%\.config\system-command-mcp\manifest.json
%USERPROFILE%\.config\system-command-mcp\INSTALLATION.md
%USERPROFILE%\.local\state\system-command-mcp\artifacts\
```

## 安装步骤

### 1. 发现环境

使用宿主系统工具确定：

- `node`、`npm`、`git`、可选 `pnpm`/`yarn` 的真实绝对路径；
- 有效 `CODEX_HOME`，优先环境变量，否则 `%USERPROFILE%\.codex`；
- 有效 `DSH_HOME`，优先环境变量，否则 `%USERPROFILE%\.dsh`；
- DSH Web profile 是否为 `%DSH_HOME%\profiles\web\cordis.patch.yml`；
- 用户希望授权的项目父目录。没有其他上下文时，采用当前工作目录的合适项目父目录，不要默认授权整个系统盘。

GUI Host 可能与终端拥有不同 PATH，因此 Manifest 和 launcher 必须使用绝对路径。

### 2. 获取并固定源码

克隆或更新权威仓库：

```text
https://github.com/ubbcou/system-command-mcp.git
```

在干净 checkout 中执行：

```powershell
npm ci
npm test
npm pack
```

记录版本、commit SHA 和 tarball integrity。若测试失败，停止安装，不切换 Host。

### 3. 建立版本化安装

将 tarball 安装到：

```powershell
$install = Join-Path $HOME ".local\share\system-command-mcp\<version>"
npm install --prefix $install --omit=dev --ignore-scripts <tarball>
```

确认以下文件存在：

```text
<install>\node_modules\system-command-mcp\dist\src\cli.js
```

创建稳定 launcher `%USERPROFILE%\.local\bin\system-command-mcp.cmd`：

```bat
@echo off
"<absolute-node.exe>" "<absolute-versioned-install>\node_modules\system-command-mcp\dist\src\cli.js" %*
```

launcher 只能指向固定版本目录，不得指向 Desktop、临时目录或 Git checkout。

### 4. 生成本机 Manifest

优先使用固定 CLI 的受控发现：

```powershell
& "$HOME\.local\bin\system-command-mcp.cmd" init `
  "$HOME\.config\system-command-mcp\manifest.json" `
  --yes --force --root "<authorized-root>"
```

审阅结果并满足：

- `allowInheritedPath: false`；
- Candidates 是本机绝对路径；
- `node` 为 `required: true`；
- 需要完整验收时，为 `node.policy` 设置 `artifactPolicy: "always"`；
- 只保留实际需要的 Programs；
- 不复制 Windows 之外设备的路径。

创建私有 Artifact 目录：

```text
%USERPROFILE%\.local\state\system-command-mcp\artifacts
```

运行静态验证：

```powershell
system-command-mcp.cmd doctor --manifest <manifest> --root <authorized-root>
```

`doctor` 必须成功后才可修改 Host。

### 5. 备份并配置 Codex

读取有效 `$CODEX_HOME\config.toml`。修改前复制为：

```text
config.toml.system-command-backup-YYYYMMDD-HHMMSS
```

添加或替换唯一的配置块：

```toml
[mcp_servers.system-command]
command = 'C:\Users\<user>\.local\bin\system-command-mcp.cmd'
args = ['serve', '--manifest', 'C:\Users\<user>\.config\system-command-mcp\manifest.json', '--root', '<authorized-root>', '--artifact-dir', 'C:\Users\<user>\.local\state\system-command-mcp\artifacts']
cwd = '<authorized-root>'
startup_timeout_sec = 30
tool_timeout_sec = 300
```

使用真实绝对路径，避免重复 `[mcp_servers.system-command]`。

验证：

```powershell
codex mcp get system-command --json
codex mcp list --json
```

如果 Codex 已具备可用模型凭据，执行一次真实 `system_environment` 调用，并确认：

- server/tool 为 `system-command/system_environment`；
- `platform=win32`、`arch=x64`、`mode=configured`；
- Programs 与 Manifest 一致。

没有模型凭据时，明确记录“注册验证完成，真实模型调用未执行”，不得伪造成功。

### 6. 备份并配置 DSH

读取有效 Web profile patch。修改前复制为：

```text
cordis.patch.yml.system-command-backup-YYYYMMDD-HHMMSS
```

在顶层数组中确保只有一个对应实例：

```yaml
- insert:
    - id: mcp-system-command
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: system-command
        transport: stdio
        command: 'C:\Users\<user>\.local\bin\system-command-mcp.cmd'
        args:
          - serve
          - --manifest
          - 'C:\Users\<user>\.config\system-command-mcp\manifest.json'
          - --root
          - '<authorized-root>'
          - --artifact-dir
          - 'C:\Users\<user>\.local\state\system-command-mcp\artifacts'
        cwd: '<authorized-root>'
        toolCallTimeoutMs: 30000
        failOnStartupError: true
        reconnect:
          enabled: true
          initialDelayMs: 500
          maxDelayMs: 30000
          maxAttempts: 10
```

运行 `dsh --profile web --dump-config`，确认合成配置指向稳定 launcher。若本机有源码 checkout，可使用仓库中的锁定验收脚本做无模型验证；否则至少通过 MCP SDK/DSH ToolRuntime 验证精确工具名：

```text
mcp__system-command__system_environment
mcp__system-command__system_exec
mcp__system-command__system_output
```

完整验证应覆盖 success、exit 7、timeout、Artifact publication、`system_output` 以及断线重连后无重复注册。

## 完成报告

在 `%USERPROFILE%\.config\system-command-mcp\INSTALLATION.md` 记录：

- OS/architecture、Node 版本；
- package version、commit SHA、tarball integrity；
- Managed Installation、launcher、Manifest、Artifact 路径；
- Codex/DSH 配置及备份路径；
- Root；
- doctor、Codex、DSH 各项实际结果；
- 未执行项及原因。

最终回复只报告已经验证的事实。不得把 Root 称为 sandbox，也不得把成功启动后的非零退出或 timeout 称为 MCP tool error。

## 更新与回滚

更新时安装到新的 `<version>` 目录，先完成 doctor 和 Host 验收，再原子替换 launcher 指向。保留旧目录和 Host 配置备份。

回滚时恢复时间戳 Host 配置，或把 launcher 改回上一版本，再重跑 `doctor`、Codex registration 和 DSH composed-config 检查。不要通过修改旧版本目录内容进行“原地升级”。
