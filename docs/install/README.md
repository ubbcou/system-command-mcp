# AI Agent 安装指南

选择目标系统，并将对应的“一句话安装指令”复制给该设备上的 AI coding agent：

- [Windows x64](windows-agent.md)
- [macOS arm64](macos-agent.md)

这些指南要求 Agent：识别实际环境、使用版本化 Managed Installation、创建独立 Manifest、在修改 Codex/DSH 前生成时间戳备份、执行真实验证，并在结果不满足要求时停止而不是静默降级。

安装指南不会执行 `npm publish`、创建 GitHub Release，或把 Working Directory Root 描述为文件系统 sandbox。
