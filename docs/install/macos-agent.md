# macOS arm64：交给 AI Agent 的安装指南

本文件供 Apple Silicon Mac 上的 AI coding agent 执行。目标是安装一个不可变的、固定身份的 `system-command-mcp`，并让 Codex 与 DSH 直接使用该版本化安装，而不是 Git checkout 或稳定 launcher。

## 一句话安装指令

复制下面整段给 Mac mini 上的 AI agent：

> 请读取并严格执行 https://raw.githubusercontent.com/ubbcou/system-command-mcp/main/docs/install/macos-agent.md 。自主完成环境识别、macOS arm64 本机构建、不可变 `<version>-<shortSHA>` Managed Installation、临时 Manifest 验证及受控提升、Codex/DSH 配置备份与切换，以及真实验收和失败回滚；除非遇到缺少凭据、软件或权限等外部阻塞，否则不要让我手动操作。不要复制其他系统的 node_modules，不要执行 npm publish 或创建 GitHub Release。

## Agent 执行契约

1. 先确认 `process.platform=darwin`、`process.arch=arm64`、Node.js `>=20`；不符合则停止并报告。
2. 安装身份必须是 `<version>-<shortSHA>`；`shortSHA` 是记录的完整 Git commit SHA 的短前缀。安装记录同时保存 package version、完整 SHA、tarball integrity。
3. 仅当已存在目录的三项记录均与本次的 version、**完整** SHA、integrity 相同，才可复用它；否则停止，不得覆盖、修改或假定该目录可信。
4. 所有需使用的父目录都必须显式创建。所有已有文件在修改前必须读取；存在时才备份，不存在则在安装记录中写明 `absent`。
5. 必须在目标 Mac 本机安装依赖；禁止复制其他设备的 `node_modules`，且不删除旧身份目录。
6. Host 在版本化 CLI 的 `doctor` 成功前不得切换。Host 切换后的真实验收失败时，立即恢复本次配置备份（或删除本次新建文件），并记录失败。
7. Root 只授权执行请求的 `cwd`，不是文件系统 sandbox。
8. 稳定 launcher 仅供交互便利；Codex/DSH 必须以绝对 node 路径为 `command`，并将绝对版本化 `cli.js` 作为 `args` 的第一项。
9. 禁止 `npm publish`、GitHub Release，以及无备份覆盖 Host 配置。

## 目标布局

```text
~/.local/share/system-command-mcp/<version>-<shortSHA>/
~/.local/bin/system-command-mcp                         # 仅交互便利
~/.config/system-command-mcp/manifest.json              # 已提升的正式 Manifest
~/.config/system-command-mcp/INSTALLATION.md
~/.local/state/system-command-mcp/artifacts/
```

## 安装步骤

### 1. 发现并固定输入

确认 `uname -m`、Node `>=20`，并记录 `node`、`npm`、`git` 和可选程序的真实绝对路径；同时发现 `CODEX_HOME=${CODEX_HOME:-$HOME/.codex}`、`DSH_HOME=${DSH_HOME:-$HOME/.dsh}`、DSH Web profile 和最小授权 Root。不要默认授权 `/` 或整个 `$HOME`。

Codex/DSH 从 GUI 启动时不保证加载交互式 shell profile，因此 Manifest、Host 配置和调用命令均必须使用绝对路径。

在干净 checkout 中运行：

```bash
npm ci
npm test
npm pack
```

取得 package version、`git rev-parse HEAD` 的完整 SHA、短 SHA 和 tarball integrity；测试失败即停止，不切换 Host。

### 2. 建立或复用不可变身份目录

显式创建安装根、配置根、二进制根和 Artifact 根。设定：

```bash
identity='<version>-<shortSHA>'
INSTALL="$HOME/.local/share/system-command-mcp/$identity"
mkdir -p "$HOME/.local/share/system-command-mcp" "$HOME/.config/system-command-mcp" "$HOME/.local/bin" "$HOME/.local/state/system-command-mcp/artifacts"
```

若 `$INSTALL` 已存在，先读取其 `INSTALLATION.md`（或等价记录），仅在 version、完整 SHA、tarball integrity 全部精确匹配时复用；否则停止。若不存在，创建并安装：

```bash
mkdir -p "$INSTALL"
npm install --prefix "$INSTALL" --omit=dev --ignore-scripts ./system-command-mcp-<version>.tgz
```

确认 `$INSTALL/node_modules/system-command-mcp/dist/src/cli.js` 存在。把 version、完整 SHA、integrity 和安装路径写入身份目录的安装记录；不得原地替换其内容。

稳定 launcher 仅供终端交互：

```bash
#!/bin/sh
exec '<absolute-node-path>' \
  '<absolute-versioned-install>/node_modules/system-command-mcp/dist/src/cli.js' \
  "$@"
```

它不是 Codex 或 DSH 的配置目标。

### 3. 临时生成、验证并提升 Manifest

令 `$CLI="$INSTALL/node_modules/system-command-mcp/dist/src/cli.js"`，`$FINAL_MANIFEST="$HOME/.config/system-command-mcp/manifest.json"`，并在**新身份目录**中选择一个不存在的 `$CANDIDATE_MANIFEST`（如 `$INSTALL/manifest.json.new`）。`init` 的输出路径是位置参数，不是 `--manifest`；不要使用 `--force`：

```bash
'<absolute-node-path>' "$CLI" init "$CANDIDATE_MANIFEST" --yes --root '<authorized-root>'
'<absolute-node-path>' "$CLI" doctor --manifest "$CANDIDATE_MANIFEST" --root '<authorized-root>'
```

审阅候选文件：`allowInheritedPath: false`、Candidates 均为本机绝对路径、`node.required: true`；完整验收时设 `node.policy.artifactPolicy: "always"`，且只保留需要的 Programs。

只有上述 `doctor` 成功后，才有意提升：若 `$FINAL_MANIFEST` 存在，读取并备份为 `manifest.json.system-command-backup-$(date +%Y%m%d-%H%M%S)`；若不存在，在安装记录中记为 `absent`。把已验证候选移动为正式 Manifest，随后以相同绝对 node+cli 重新运行 `doctor --manifest "$FINAL_MANIFEST" --root ...`。提升或复验失败时恢复 Manifest 备份（或删除本次新建正式文件），不切换 Host。

### 4. 备份、配置并验收 Codex

读取 `$CODEX_HOME/config.toml`。存在时创建时间戳备份；不存在时创建父目录并记录 `config.toml: absent`。仅在正式 Manifest 的 versioned-CLI doctor 成功后，添加或替换唯一配置：

```toml
[mcp_servers.system-command]
command = "/absolute/path/to/node"
args = [
  "/absolute/path/to/<version>-<shortSHA>/node_modules/system-command-mcp/dist/src/cli.js",
  "serve",
  "--manifest", "/Users/<user>/.config/system-command-mcp/manifest.json",
  "--root", "<authorized-root>",
  "--artifact-dir", "/Users/<user>/.local/state/system-command-mcp/artifacts"
]
cwd = "<authorized-root>"
startup_timeout_sec = 30
tool_timeout_sec = 300
```

运行 `codex mcp get system-command --json` 和 `codex mcp list --json`。如有模型凭据，真实调用 `system_environment`，确认 `platform=darwin`、`arch=arm64`、`mode=configured` 和 Programs；无凭据时如实记录。注册或真实验收失败时恢复配置备份，或删除本次新建的配置文件。

### 5. 备份、配置并验收 DSH

读取 `$DSH_HOME/profiles/web/cordis.patch.yml`。显式创建父目录；存在时创建时间戳备份，不存在则记录 `absent`。仅在 doctor 已通过后，保证顶层数组中只有一个实例：

```yaml
- insert:
    - id: mcp-system-command
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: system-command
        transport: stdio
        command: '/absolute/path/to/node'
        args:
          - '/absolute/path/to/<version>-<shortSHA>/node_modules/system-command-mcp/dist/src/cli.js'
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

执行 `dsh --profile web --dump-config`，确认合成配置使用绝对 node 和版本化 `cli.js`，再验证精确工具名 `mcp__system-command__system_environment`、`system_exec`、`system_output`。完整验收还覆盖 success、exit 7、timeout、Artifact、`system_output` 和重连后无重复注册。任何失败均恢复 DSH 备份或删除本次新文件。

### 6. 验收后提升稳定 launcher

只有正式 Manifest 的 doctor、Codex 验收和 DSH 验收均成功后，才提升交互 launcher。先写入同目录唯一临时文件，`chmod 755` 临时文件，再以 `mv` 在同一文件系统内原子替换稳定 launcher；保留旧 launcher 的时间戳备份。launcher 提升失败不影响已验收 Host，但必须报告，不能声称已提升。

## 完成报告与回滚

在 `~/.config/system-command-mcp/INSTALLATION.md` 记录 OS/Node、identity、完整 SHA、integrity、所有路径、每个 `absent` 或备份、Root、doctor/Codex/DSH 实际结果与未执行原因。只报告已验证事实。

更新总是创建新 `<version>-<shortSHA>` 身份目录并重复流程。验收失败时先恢复相应 Host/Manifest/launcher 备份（或删除本次新建文件），然后重新运行 versioned CLI doctor、Codex 注册和 DSH composed-config 检查；不得覆盖旧身份目录。
