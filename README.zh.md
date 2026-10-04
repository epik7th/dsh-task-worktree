# dsh-task-worktree

[![stars](https://img.shields.io/github/stars/epik7th/dsh-task-worktree?style=flat&label=stars&color=blue)](https://github.com/epik7th/dsh-task-worktree)
[![license](https://img.shields.io/github/license/epik7th/dsh-task-worktree?style=flat&label=license&color=blue)](LICENSE)
[![docs](https://img.shields.io/badge/docs-English%20%7C%20%E4%B8%AD%E6%96%87-0075cc?style=flat&labelColor=555555)](https://github.com/epik7th/dsh-task-worktree/blob/main/README.md)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

**为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供完整的 Git worktree 能力。**

一个社区插件：给 DSH 带来 Qoder / Codex / Claude Code 同款的**任务级 worktree 工作流**。每个任务拥有一个**独立的 `git worktree` checkout**（独立分支），记录在 per-repo manifest 中，**跨会话、跨重启永久保存**。主工作区保持干净；使用 worktree 的对话会在**会话头部显示分支徽标**（不再注册工作区、不打乱侧边栏），干完后**带回到主目录**（Move to local）或**直接提交**在 worktree 分支上——一切收尾都由你（人）显式决定。

设计参考：Qoder 的 `Worktree` 执行环境、Codex 的 `codex worktree create --permanent`、Claude Code 的 `--worktree` 会话，并适配 DSH 的会话/工作区模型。

> **Fork 说明。** 本仓库是
> [Letter2025/dsh-task-worktree](https://github.com/Letter2025/dsh-task-worktree)
> 的 fork（MIT，包名相同），目标宿主线为 **dsh 0.2.0**。上游 `0.4.3` 声明
> `^0.1.7-rc.2` 宿主 peer，会被 0.2.0 的兼容性预检拒绝加载；此外它的浏览器半边仍在读
> `sessions.current`——该字段在 dsh **0.1.6** 已从会话列表状态中移除，导致 GUI 模式选择器与会话头徽标失去锚点。本 fork
> 抬升 peer 范围，并改为按 main-view 保留关系推导当前会话（与宿主自身的推导一致）。设计、工具、命令与安全模型均来自上游，详见
> [迁移记录](docs/decisions/implemented/2026-10-04-migrate-to-dsh-0-2-0.md)。

## 设计对照

| 本插件概念 | Qoder | Codex | Claude Code |
| --- | --- | --- | --- |
| 任务级隔离 checkout | Worktree 执行环境 | `codex worktree create --permanent` | `claude --worktree <名称>` |
| worktree 位于 `<仓库>/.dsh-worktrees/` | 后台 worktree checkout | `.codex/worktrees/` | `.claude/worktrees/` |
| 注册表跨重启持久 | 按会话 | 全局索引 | 会话绑定 |
| 每任务独立分支 | 分支选择器 | — | `worktree-<名称>` |
| 从 GUI 打开（注册为 DSH 工作区） | 面板选择器 | `codex worktree open` | 直接进入 worktree |
| 会话头部徽标标识对话所用 worktree | 会话标识 | — | — |
| 把改动带回主目录 | Move to local | — | 退出/清理询问 |
| 直接在 worktree 分支提交 | Review & commit 面板 | worktree 会话内提交 | worktree 内提交 |
| 携带主目录未提交改动 | Include uncommitted changes | — | `.worktreeinclude` |
| 自动忽略 worktree 目录 | — | — | `.gitignore` 建议 |

## 工作流

```
空白对话：发送前在下拉框选「Worktree模式」（分支名可选，自动加 worktree/ 前缀）
   │  发送第一条消息 → 宿主注入一条「上下文注入」instructions 块
   ▼  模型在同一轮调用 worktree_create
   │  git worktree add -b worktree/<名称> <仓库>/.dsh-worktrees/worktree/worktree/<名称>
   │  不注册工作区、不切换对话；会话头部徽标标记该对话使用的 worktree
   ▼  对话原地继续，模型在 checkout 路径（绝对路径）内干活；完成后模型提醒收尾
   │
   ├─ /worktree bring-back worktree/<名称>   → 合并分支回主分支（要求主目录干净）
   ├─ /worktree finish worktree/<名称> <消息>  → 提交到 worktree 分支并保留
   └─ /worktree remove worktree/<名称> --force → 删除 worktree 与分支
                                                 （--force 连未提交改动一起删）
```

1. **以 Worktree 模式开始**：空白对话、发送前，dock 选择器显示「分支名：」——选「Worktree模式」即武装会话；分支名可选（输入的会自动加 `worktree/` 前缀，留空由模型拟定）。**对话开始后选择器自动隐藏**，由会话头部徽标接管指示。
2. **发送第一条消息** → 宿主在你消息前注入一条 `instructions` 上下文块（界面显示为「上下文注入」）：创建 `worktree/` 前缀分支、在 checkout 路径内干活、任务结束时**给出可复制的收尾命令**（`bring-back` 或 `remove --force`）。
3. 或跳过模式，直接让 agent 隔离任务：**"用 worktree 隔离干活，任务叫 xxx"** —— 模型调用 `worktree_create`，name 同时作分支名与路径（支持斜杠）。
4. **不注册任何工作区**，侧边栏保持干净；worktree 模式下会话头部显示分支徽标。
5. 干完后收尾：`bring-back` / `finish` / `remove`（均仅人工可触发）；`/worktree list` / `status` / `prune` 查看与清理（`prune` 顺带清理已消失 checkout 的工作区注册）。

## 安装

从本 fork 的公开仓库安装（包名仍为 `dsh-task-worktree`），装进你跑 Web GUI 的 profile：

```bash
dsh plugin --profile desktop add github:epik7th/dsh-task-worktree
```

在插件管理器的安装框里填同一个地址（`github:epik7th/dsh-task-worktree`）也可以。`add` 会自动接好 `dsh.bundle` 补丁层。

要求：DeepSeek Harness **`0.2.0-rc.1`** 宿主线（含 rc.2 与 `0.2.0` 正式版）、Git 2.31+、Node 20+。

> 不支持与上游 npm 包（`dsh-task-worktree@0.4.3`）同时安装：宿主按包名给 client bundle 建行，两个解析到同一包名的活跃来源会被拒绝。装一个之前先卸掉另一个。

## 模型工具

| 工具 | 作用 |
| --- | --- |
| `worktree_create {name, baseCommit?, includeUncommitted?}` | 创建任务 worktree（name=分支名与相对路径，支持斜杠分层）；可选把主工作区未提交改动带进去 |
| `worktree_list` | 列出当前仓库所有受管理 worktree（状态 / dirty / 分支） |
| `worktree_status {name?}` | 查看单个 worktree 或当前会话所在 worktree 的状态 |

收尾与清理动作（finish / bring-back / remove）**只有人工可触发**，模型永远够不到。

## 人工命令

```
/worktree mode-on [<名称>]       武装 worktree 模式（下条消息随之注入指引）
/worktree mode-off               关闭 worktree 模式
/worktree create <名称> [<base>] [--carry]
/worktree list
/worktree status [<名称>]
/worktree finish <名称> <消息>
/worktree bring-back <名称> [<消息>]
/worktree remove <名称> [--force]
/worktree prune
```

## 安全模型

- `@deepseek-ai/*` **只作为 peerDependencies**——由宿主提供；插件绝不向 profile 安装基础设施副本（双实例会破坏 `TOOL_RUNTIME_SCHEDULER` 的 unique symbol，导致工具全部失效）。
- `bring-back` 要求主工作区干净（`MAIN_DIRTY`），且拒绝在 worktree 内执行。
- `remove` 拒绝删除当前会话所在的 worktree（`IN_USE`）。
- 所有 git 操作经 `ctx.subprocess`（harness-managed）；测试路径用 child_process runner。
- Manifest 原子写入（tmp + rename）；`prune` 清理 checkout 已不存在的记录。

## 本地开发

```bash
npm install
npm run typecheck     # 客户端源码（tsc）
npm run build:client  # 重新构建随仓库提交的 client bundle
npm test              # 宿主冒烟 + 宿主兼容性预检 + 客户端 bundle
```

`npm test` 跑三个套件：`test/smoke.mjs`（临时仓库上的完整 worktree 生命周期）、`test/preflight.mjs`（声明的宿主 peer 范围对 0.2.0 线各版本）与 `test/client.mjs`（用桩 loader/ctx 跑构建产物，钉住 main-view 当前会话推导）。client bundle 随仓库提交；CI 会重建并对任何差异报错，改动客户端后请先 `npm run build:client`。

## License

MIT — see [LICENSE](LICENSE)