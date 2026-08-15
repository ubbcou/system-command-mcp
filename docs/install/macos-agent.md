# macOS arm64：交给 AI Agent 的安装指南

本文件供 Apple Silicon Mac 上的 AI coding agent 执行。目标是安装固定版本的 `system-command-mcp`，并让 Codex 与 DSH 使用 Managed Installation，而不是源码 checkout。

## 一句话安装指令

复制下面整段给 Mac mini 上的 AI agent：

> 请读取并严格执行 https://raw.githubusercontent.com/ubbcou/system-command-mcp/main/docs/install/macos-agent.md 。自主完成环境识别、macOS arm64 本机构建、版本化 Managed Installation、Manifest 生成、Codex/DSH 配置备份与切换，以及真实验收；除非遇到缺少凭据、软件或权限等外部阻塞，否则不要让我手动操作。不要复制其他系统的 node_modules，不要执行 npm publish 或创建 GitHub Release。

## Agent 执行契约

1. 先确认 `process.platform=darwin`、`process.arch=arm64`、Node.js `>=20`；不符合则停止并报告。
2. 所有配置修改前先读取原文件并创建时间戳备份。
3. 使用最新稳定 tag；若仓库还没有 tag，则固定当前 `main` commit，并记录 SHA。
4. 必须在目标 Mac 本机安装依赖；禁止复制 Windows 或其他设备的 `node_modules`。
5. 不删除旧版本安装。升级采用新版本目录和稳定 launcher 切换，保证可回滚。
6. Root 只授权执行请求的 `cwd`，不是文件系统 sandbox。
7. 禁止 `npm publish`、GitHub Release，以及无备份覆盖 Host 配置。

## 目标布局

```text
~/.local/share/system-command-mcp/<version>/
~/.local/bin/system-command-mcp
~/.config/system-command-mcp/manifest.json
~/.config/system-command-mcp/INSTALLATION.md
~/.local/state/system-command-mcp/artifacts/
```

## 安装步骤

### 1. 发现环境

确认：

```bash
uname -m
node --version
npm --version
command -v node git npm pnpm yarn rg python3
```

记录 `command -v` 返回的真实绝对路径。Apple Silicon Homebrew 通常位于 `/opt/homebrew/bin`；NVM、Volta、asdf 等版本管理器可能把 Node 放入用户版本目录。

Codex/DSH 从 GUI 启动时不会可靠加载交互式 shell profile，因此不得依赖终端 PATH。launcher 和 Manifest 必须使用绝对路径。

发现：

- 有效 `CODEX_HOME=${CODEX_HOME:-$HOME/.codex}`；
- 有效 `DSH_HOME=${DSH_HOME:-$HOME/.dsh}`；
- DSH Web profile 通常为 `$DSH_HOME/profiles/web/cordis.patch.yml`；
- 用户项目的授权 Root，例如 `$HOME/Developer`。没有上下文时不要默认授权 `/` 或整个 `$HOME`。

### 2. 获取并固定源码

克隆或更新：

```text
https://github.com/ubbcou/system-command-mcp.git
```

在干净 checkout 中执行：

```bash
npm ci
npm test
npm pack
```

记录 package version、commit SHA 和 tarball integrity。测试失败时停止，不修改 Host。

### 3. 建立版本化安装

```bash
INSTALL="$HOME/.local/share/system-command-mcp/<version>"
mkdir -p "$INSTALL"
npm install --prefix "$INSTALL" --omit=dev --ignore-scripts ./system-command-mcp-<version>.tgz
```

确认：

```text
$INSTALL/node_modules/system-command-mcp/dist/src/cli.js
```

创建稳定 launcher：

```bash
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/system-command-mcp" <<EOF
#!/bin/sh
exec "<absolute-node-path>" \
  "$HOME/.local/share/system-command-mcp/<version>/node_modules/system-command-mcp/dist/src/cli.js" \
  "\$@"
EOF
chmod 755 "$HOME/.local/bin/system-command-mcp"
```

launcher 只能指向固定版本目录，不得指向 Git checkout。

### 4. 生成本机 Manifest

```bash
mkdir -p "$HOME/.config/system-command-mcp"
mkdir -p "$HOME/.local/state/system-command-mcp/artifacts"

"$HOME/.local/bin/system-command-mcp" init \
  "$HOME/.config/system-command-mcp/manifest.json" \
  --yes --force --root "<authorized-root>"
```

审阅并确保：

- `allowInheritedPath: false`；
- Candidates 是 Mac 本机绝对路径；
- `node` 为 `required: true`；
- 完整验收需要 `node.policy.artifactPolicy: "always"`；
- 不包含 Windows 路径、`.exe`、`.cmd` 或 `.bat`；
- 只保留实际需要的 Programs。

运行：

```bash
"$HOME/.local/bin/system-command-mcp" doctor \
  --manifest "$HOME/.config/system-command-mcp/manifest.json" \
  --root "<authorized-root>"
```

只有 `doctor` 成功后才修改 Host。

### 5. 备份并配置 Codex

读取 `$CODEX_HOME/config.toml`，然后备份：

```bash
cp "$CODEX_HOME/config.toml" \
  "$CODEX_HOME/config.toml.system-command-backup-$(date +%Y%m%d-%H%M%S)"
```

添加或替换唯一配置：

```toml
[mcp_servers.system-command]
command = "/Users/<user>/.local/bin/system-command-mcp"
args = [
  "serve",
  "--manifest", "/Users/<user>/.config/system-command-mcp/manifest.json",
  "--root", "<authorized-root>",
  "--artifact-dir", "/Users/<user>/.local/state/system-command-mcp/artifacts"
]
cwd = "<authorized-root>"
startup_timeout_sec = 30
tool_timeout_sec = 300
```

TOML 中不要依赖 `~`、`$HOME` 展开，必须写绝对路径。

验证：

```bash
codex mcp get system-command --json
codex mcp list --json
```

若 Codex 有模型凭据，真实调用一次 `system_environment` 并确认 `platform=darwin`、`arch=arm64`、`mode=configured` 及 Programs。无凭据时明确记录未执行，不得伪造。

### 6. 备份并配置 DSH

读取 Web profile patch，然后备份：

```bash
cp "$DSH_HOME/profiles/web/cordis.patch.yml" \
  "$DSH_HOME/profiles/web/cordis.patch.yml.system-command-backup-$(date +%Y%m%d-%H%M%S)"
```

确保顶层数组中只有一个实例：

```yaml
- insert:
    - id: mcp-system-command
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: system-command
        transport: stdio
        command: '/Users/<user>/.local/bin/system-command-mcp'
        args:
          - serve
          - --manifest
          - '/Users/<user>/.config/system-command-mcp/manifest.json'
          - --root
          - '<authorized-root>'
          - --artifact-dir
          - '/Users/<user>/.local/state/system-command-mcp/artifacts'
        cwd: '<authorized-root>'
        toolCallTimeoutMs: 30000
        failOnStartupError: true
        reconnect:
          enabled: true
          initialDelayMs: 500
          maxDelayMs: 30000
          maxAttempts: 10
```

执行：

```bash
dsh --profile web --dump-config
```

确认合成配置指向稳定 launcher，并验证精确工具名：

```text
mcp__system-command__system_environment
mcp__system-command__system_exec
mcp__system-command__system_output
```

若使用源码 checkout，执行锁定验收：

```bash
npm ci --prefix acceptance/dsh
npm run acceptance:runtime-portable
npm run acceptance:portable
npm run acceptance:dsh-reconnect
```

DSH rc.6 的 Host 验收需要 Node 22（使用 `Promise.withResolvers`）；这不改变 Server 本身的 Node `>=20` 支持。完整验证覆盖 success、exit 7、timeout、Artifact、`system_output` 和重连后无重复工具。

## 完成报告

写入 `~/.config/system-command-mcp/INSTALLATION.md`：

- macOS/arm64、Node 版本；
- package version、commit SHA、tarball integrity；
- Managed Installation、launcher、Manifest、Artifact 路径；
- Codex/DSH 配置和备份路径；
- Root；
- doctor、Codex、DSH 的实际结果；
- 未执行项与原因。

最终回复只报告已验证事实，不把 Root 称为 sandbox，不把成功启动后的非零退出或 timeout 称为 MCP tool error。

## 更新与回滚

更新时安装到新 `<version>` 目录，完成全部验证后再切换 launcher。保留旧目录和备份。

回滚时恢复 Codex/DSH 时间戳备份，或将 launcher 改回旧版本；随后重跑 doctor、Codex registration 和 DSH composed-config 检查。不要覆盖旧版本目录来进行原地升级。
