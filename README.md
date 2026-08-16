# system-command-mcp

跨平台系统命令 MCP Server。AI 通过稳定的 `program + args[]` 接口直接调用已注册程序，无需用 `which`、`where`、`command -v` 或 `Get-Command` 探测工具；它不是 Shell，自动发现程序集也明确不包括 PowerShell。

## 工具

### system_exec

`program` 是启动时注册的逻辑程序名；其 Schema 已枚举可用项：

```json
{
  "program": "git",
  "args": ["status", "--short"],
  "cwd": ".",
  "timeoutMs": 30000
}
```

对原生可执行文件，`args` 是逐项传递的字面量参数，不经过 Shell 展开或组合；例如 `$HOME`、`*.ts` 和 `&&` 都只是参数文本。Windows 的 `.cmd` / `.bat` 平台包装程序例外：它们会由 `cmd.exe` 重新解析，且参数中拒绝 `%`、`!`、`&`、`|`、`<`、`>`、`^`、CR、LF 和 NUL；即使被接受，参数保真度也比原生程序更窄。用 `system_environment` 的 `argumentSemantics` 区分 `literal` 与 `cmd-reparsed`。

### system_environment

返回平台、架构、根工作目录、模式、Roots，以及逻辑程序名到真实可执行文件的映射（包括 `kind` 和 `argumentSemantics`）。通常无需先调用；`system_exec.program` 的 Schema 已包含可用程序。

### system_output

以 Execution Artifact 的不透明 `id` 分页读取已完成执行的 `stdout` 或 `stderr` 原始输出。Artifact 不是主机文件路径，不能用主机文件系统工具读取。

## 交给 AI Agent 自动安装

在目标设备上，将对应的一句话复制给 AI coding agent。Agent 会读取仓库中的完整指南，完成版本化 Managed Installation、独立 Manifest、配置备份、Codex/DSH 切换和真实验收：

- [Windows x64 Agent 指南](docs/install/windows-agent.md)
- [macOS arm64 Agent 指南](docs/install/macos-agent.md)

**Windows 一句话：**

> 请读取并严格执行 https://raw.githubusercontent.com/ubbcou/system-command-mcp/main/docs/install/windows-agent.md 。自主完成环境识别、不可变 `<version>-<shortSHA>` Managed Installation、临时 Manifest 验证及受控提升、Codex/DSH 配置备份与切换，以及真实验收和失败回滚；除非遇到缺少凭据、软件或权限等外部阻塞，否则不要让我手动操作。不要执行 npm publish 或创建 GitHub Release。

**macOS 一句话：**

> 请读取并严格执行 https://raw.githubusercontent.com/ubbcou/system-command-mcp/main/docs/install/macos-agent.md 。自主完成环境识别、macOS arm64 本机构建、不可变 `<version>-<shortSHA>` Managed Installation、临时 Manifest 验证及受控提升、Codex/DSH 配置备份与切换，以及真实验收和失败回滚；除非遇到缺少凭据、软件或权限等外部阻塞，否则不要让我手动操作。不要复制其他系统的 node_modules，不要执行 npm publish 或创建 GitHub Release。

## 构建和测试

```bash
npm install
npm run build
npm test
```

需要 Node.js 20 或更高版本。

## 管理 CLI 与 MCP 配置

```bash
# 发现固定的默认自动程序集；--yes 将每个已发现程序写为 Optional，且不会修改 Codex 或 DSH 配置
system-command-mcp init --yes --manifest system-command-manifest.json
# 已有 Manifest 默认拒绝覆盖；仅 --force 可以替换
system-command-mcp init --yes --force --manifest system-command-manifest.json
# 配置模式必须显式提供至少一个 Root；旧的 `--root PATH` 调用在 1.0 前仍兼容，但会发出 stderr 弃用提示
system-command-mcp serve --manifest system-command-manifest.json --root /absolute/path/to/workspace
# 默认构造并关闭配置 Runtime 以静态验证候选项、环境引用和限制，不执行程序；--execute 仅执行 Manifest 明确声明的 probes
system-command-mcp doctor --manifest system-command-manifest.json --root /absolute/path/to/workspace
system-command-mcp doctor --execute --manifest system-command-manifest.json --root /absolute/path/to/workspace
# 仅把对应的配置片段写到 stdout，注意审阅后手动添加
system-command-mcp print-config codex --manifest system-command-manifest.json --root /absolute/path/to/workspace
system-command-mcp print-config dsh --manifest system-command-manifest.json --root /absolute/path/to/workspace
```

Manifest Schema 和示例分别为 `system-command-manifest.schema.json`、`system-command-manifest.example.json`。Schema 用严格 `oneOf` 区分版本：v1 是兼容过渡格式，只接受 `nodeResolution`；v2 只接受可选 `projectNode`，并允许平台对它做完整替换。示例展示 v2。`probes` 仅供 `doctor --execute` 使用，启动 MCP 不会执行它们。Codex 输出说明 `$CODEX_HOME/config.toml` 和实际有效的 `CODEX_HOME`（默认 `~/.codex`）；v0.1.0 有意设置启动超时 30 秒、工具超时 300 秒，并给出 `codex mcp list --json` / `codex mcp get system-command --json` 验证命令。DSH 输出是 rc.6 的 Cordis `@deepseek-ai/dsh-mcp-client` 插件列表行，包含 `serverName`、`transport`、`command`、`args`、`cwd`、30,000 ms `toolCallTimeoutMs`、启动失败致命和有界 reconnect（500/30000/10）。

## Host Guidance

- 一个直接的已注册 Program 调用使用 `system_exec`；
- 管道、重定向、展开及其他 Shell 组合使用宿主 Shell；
- 读写和枚举文件使用宿主文件系统工具；
- Root 只验证执行进程的 cwd，**不是**文件系统沙箱，也不会限制已启动程序能访问的文件。

## 自动发现的逻辑程序

未提供 Manifest 时，自动发现模式仅尝试注册以下逻辑程序，并且只暴露启动环境中实际可解析的程序：

- git、node、npm、pnpm、yarn、bun
- python：依次尝试 `python3`、`python`
- ripgrep：尝试 `rg`

**不自动发现或暴露 PowerShell（`pwsh` / `powershell`）。** 自动发现是向后兼容的零配置模式；它使用继承环境，不能承诺不同宿主间的一致程序身份。`init` 生成的 Manifest 会将上述已发现程序固定为绝对候选路径；配置模式则只注册 Manifest 声明的程序，且默认不继承 `PATH`，除非设置 `allowInheritedPath: true`。

## 当前限制与生命周期

- 仅支持 stdio transport；不支持 Shell 命令字符串、管道、重定向、展开、命令替换或其他 Shell 组合。需要这些语义时，使用宿主 Shell；读写和枚举文件时，使用宿主文件系统工具。
- 执行是有限且非交互式的：不支持 TTY、后台任务或常驻进程。进程成功启动后的非零退出、超时和取消均返回结构化 Execution Result，而不是 MCP 工具错误。
- 默认超时为 30 秒，最多 600 秒；默认最多四个并发执行（可用 `--max-concurrent-executions` 设置）。`stdout` 和 `stderr` 分别保留最多 1 MiB 的 UTF-8 诊断投影，总量硬上限为 8 MiB，`--inline-head-bytes` 必须为正且不超过 `--max-output-bytes`：未截断时保留完整内容；截断时保留头部和尾部，并报告省略的字节数。完整流可按 Program Policy 作为 Execution Artifact 保存：`never` 不请求、`on-truncation`（默认）仅在任一流截断时发布、`always` 每次发布。Artifact 可能因存储不可用、配额或流大小上限（每流最多 100 MiB）而不可用，并受保留期和配额清理；只能在执行完成后通过 `system_output` 和不透明 id 读取。
- cwd 必须在授权的 `--root` 内；多个 Root 时 cwd 必须为授权树内的绝对路径。Root 只验证进程从哪里启动，**不是**文件系统沙箱，也不限制已启动程序可访问的文件。
- 程序、PATH、Manifest 和可用 Node 安装在启动时生成快照，变化都需要重启 Server。Manifest v1 的 `nodeResolution` 仅为兼容过渡；新配置使用 v2 的 `projectNode`，明确给出 `enabledRoots`、`installationRoots` 和精确 `defaultVersion`。每个 enabled Root 必须位于 Host Authorization 内，也是项目声明向上查找的唯一边界；不会读取 `.git`、VCS、package workspace 或 monorepo 逻辑，边界外请求只使用静态 Program。每个符合条件的 `node` / `npm` / `npx` 请求会重新读取 `devEngines.runtime(node)`、`volta.node`、`.nvmrc`、`.node-version` 和祖先 `engines.node`；这是请求输入，不是 Manifest/PATH/安装目录 watching。前四种声明必须是精确 pin，最近目录中的多个 pin 必须一致；`engines.node` 只做兼容性约束，不负责从安装集合挑最高版本。没有 pin 时默认使用 Manifest 的精确 `defaultVersion`；也可显式设置 `whenNoSelector: "active-manager"` 和只含一个条目的 `activeManagerLinks`；数组仅用于平台配置替换。每次请求观察这个唯一且权威的 manager-owned symlink/junction（Windows nvm 常用 `C:\\Program Files\\nodejs`）并选择启动快照中对应版本。权威链接缺失、非链接、损坏或不匹配时立即返回 `PROJECT_NODE_ACTIVE_VERSION_UNAVAILABLE`，不尝试其他链接，也不回退默认版本。冲突、无匹配或 engines 不兼容都静态失败；`default`、`node`、`stable`、`lts/*` 等 manager 默认/别名无效。启动和执行都不会运行版本管理器、安装缺失版本、联网或修改全局状态。选中 Variant 时，逻辑 `npm` / `npx` 必须与同一 Variant 的 canonical `npm-cli.js` / `npx-cli.js` 配对并由该 Variant 的 Node 启动；缺失即失败，不与静态 wrapper 混用。pnpm/yarn 不重定向。
- 超时、取消和 Server 关闭会尝试终止整个 Process Tree，并在结构化 `termination` 字段中报告结果。Unix 使用进程组，后代若另建 session 或进程组会逃逸；Windows 使用每请求 Job Object（禁止 breakaway），但进程创建到加入 Job Object 之间存在无法验证的竞态，早期后代可能逃逸。Windows 无通用的优雅树终止，因此会立即强制终止；任务管理器回退路径也无法确认完整清理。始终检查 `termination.treeCleaned` 和诊断信息，不要把终止请求当作完整树清理的保证。
