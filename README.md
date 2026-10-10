# dsh-task-worktree

[![stars](https://img.shields.io/github/stars/epik7th/dsh-task-worktree?style=flat&label=stars&color=blue)](https://github.com/epik7th/dsh-task-worktree)
[![license](https://img.shields.io/github/license/epik7th/dsh-task-worktree?style=flat&label=license&color=blue)](LICENSE)
[![docs](https://img.shields.io/badge/docs-English%20%7C%20%E4%B8%AD%E6%96%87-0075cc?style=flat&labelColor=555555)](https://github.com/epik7th/dsh-task-worktree/blob/main/README.zh.md)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

**Complete Git worktree support for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**

A community plugin that gives DSH the **task-scoped worktree workflow** of Qoder / Codex / Claude Code: each task gets its own isolated `git worktree` checkout on its own branch, recorded in a per-repo manifest so it **survives sessions and restarts**. The main workspace stays untouched; conversations that use a worktree are marked with a **branch badge** on the session header (no workspace entry is created), and the changes can be **brought back** (Move to local) or **committed directly** on the worktree branch — always under explicit human control.

It follows the design of Qoder's `Worktree` execution environment, Codex's `codex worktree create --permanent`, and Claude Code's `--worktree` sessions, adapted to DSH's session/workspace model.

> **Fork notice.** This is a fork of
> [Letter2025/dsh-task-worktree](https://github.com/Letter2025/dsh-task-worktree)
> (MIT, same package name) that targets the **dsh 0.2.0 host line**. The
> upstream `0.4.3` release declares `^0.1.7-rc.2` host peers, so the 0.2.0
> compatibility preflight refuses to load it; on top of that its browser half
> still read `sessions.current`, a session-list field dsh **0.1.6** removed, so
> the GUI mode selector and the header badge had lost their anchor. This fork
> raises the peer range and derives the current session from main-view
> retention, exactly as the shell itself does. Design, tools, commands and
> safety model are upstream's — see
> [the migration record](docs/decisions/implemented/2026-10-04-migrate-to-dsh-0-2-0.md).

## Design

| Concept (this plugin) | Qoder | Codex | Claude Code |
| --- | --- | --- | --- |
| Task-scoped isolated checkout | Worktree execution environment | `codex worktree create --permanent` | `claude --worktree <name>` |
| Worktrees live in `<repo>/.dsh-worktrees/` | background worktree checkout | `.codex/worktrees/` | `.claude/worktrees/` |
| Durable registry survives restarts | per-session | global index | session binding |
| Own branch per task | branch selector | — | `worktree-<name>` |
| Pick the branch the task starts from | worktree base-branch picker | `codex worktree create --base` | branch selector |
| Open as a DSH workspace from the GUI | panel selector | `codex worktree open` | launches into the worktree |
| Mark the conversation using the worktree | session badge | — | — |
| Bring changes back to main | Move to local | — | exit/cleanup prompt |
| Direct commit on the worktree branch | Review & commit panel | commit in the worktree session | commit in the worktree |
| Carry uncommitted main changes in | Include uncommitted changes toggle | — | `.worktreeinclude` |
| Auto-ignore the worktree directory | — | — | `.gitignore` tip |

## How it works

```
Blank conversation: tick the "worktree" checkbox in the dock (before the
conversation starts) → pick the base branch in the picker beside it
   │  send the first message → the host injects an instructions context block
   ▼  the model calls worktree_create on that same turn
   │  git worktree add -b worktree/<name> <repo>/.dsh-worktrees/worktree/worktree/<name> <base>
   │  NO workspace is registered, NO conversation switch — the session header
   │  badge marks the worktree this conversation uses
   ▼  work continues in the same conversation (the model uses absolute paths
      inside the checkout); when done the model reminds you how to clean up
   │
   ├─ /worktree bring-back worktree/<name>   → merge the branch into the main branch
   │                                            (requires a clean main workspace)
   ├─ /worktree finish worktree/<name> <msg>  → commit on the worktree branch, keep it
   └─ /worktree remove worktree/<name> --force→ delete the worktree + branch
                                                (--force also deletes uncommitted changes)
```

1. **Start in worktree mode**: on a blank conversation the dock shows a
   `worktree` checkbox and a branch picker. The picker always displays the
   branch a new task worktree would start from (the repository's current
   branch by default) and opens a searchable list of local and
   remote-tracking branches — the choice is passed to the host as
   `mode-on --base <branch>` and pinned as `worktree_create`'s `baseCommit`.
   Ticking the checkbox ARMS the session; the branch itself is always named by
   the model (`worktree/…`), so there is no name field. The control disappears
   once the conversation starts; the session-header badge takes over the
   indication. The picker reads `<repo>/.git` (`HEAD`, loose refs,
   `packed-refs`) through the shell's `workspaceFiles` Remote; when that
   service is absent — or the session works inside a checkout whose loose refs
   live outside its workspace root — the picker says so and the host falls
   back to `HEAD`. A workspace that is not a Git repository is not offered
   worktree mode at all: the control disappears once the ref read settles
   (before that it renders, since "unknown" is not "no").
2. **Send your first message** — the host injects one `instructions` context
   block (shown as 上下文注入) right before your message: create the worktree
   with a `worktree/`-prefixed branch, work inside the checkout path, and at
   the end remind the user with copy-paste cleanup commands
   (`bring-back` or `remove --force`).
3. Or skip the mode and ask the agent directly: **"用 worktree 隔离干活，任务叫 xxx"**
   — the model calls `worktree_create`; the name is both the branch and the
   relative path (slashes allowed).
4. No workspace entry is created, so the sidebar stays uncluttered. The badge
   on the session header shows the branch name while the conversation is in
   worktree mode.
5. When done: `bring-back` / `finish` / `remove` (all human-only, as above);
   `/worktree list` / `status` / `prune` inspect and clean up (`prune` also
   drops stale workspace registrations for removed checkouts).

## Install

Install the fork from its public Git repository (package name `dsh-task-worktree`)
into the profile that runs your Web GUI:

```bash
dsh plugin --profile desktop add github:epik7th/dsh-task-worktree
```

The plugin manager's install field accepts the same address
(`github:epik7th/dsh-task-worktree`) if you prefer the GUI. Running the plugin
also requires the `dsh.bundle` patch to be composed, which `add` wires up.

Requires: DeepSeek Harness **`0.2.0-rc.1`** host line (rc.2 and the `0.2.0`
release included), Git 2.31+, Node 20+.

> Installing the upstream npm package (`dsh-task-worktree@0.4.3`) alongside this
> fork is not supported: the host keys the client bundle by package name, and two
> active sources resolving to one name are rejected. Uninstall one before
> installing the other.

## Model tools

| Tool | Purpose |
| --- | --- |
| `worktree_create {name, baseCommit?, includeUncommitted?}` | Create a task worktree (name = branch and relative path, slashes allowed); optionally carry uncommitted main-workspace changes in |
| `worktree_list` | List the repository's managed worktrees (state / dirty / branch) |
| `worktree_status {name?}` | Status of one worktree, or the one the current session is inside |

Delivery and cleanup actions (finish / bring-back / remove) stay **human-only** — the model never reaches them.

## Human commands

```
/worktree mode-on [<name>] [--base <branch>]
                               arm worktree mode (injection with the next
                               message); --base pins the start point, <name>
                               fixes the branch instead of letting the model name it
/worktree mode-off             disarm worktree mode
/worktree create <name> [<base>] [--carry]
/worktree list
/worktree status [<name>]
/worktree finish <name> <message>
/worktree bring-back <name> [<message>]
/worktree remove <name> [--force]
/worktree prune
```

## Safety model

- `@deepseek-ai/*` are **peerDependencies only** — the host supplies them; the plugin never installs infrastructure copies into a profile (a second instance breaks `TOOL_RUNTIME_SCHEDULER`'s unique symbol and kills tool calls).
- `bring-back` requires a clean main workspace (`MAIN_DIRTY`) and refuses to run from inside the worktree.
- `remove` refuses the worktree the current session is working inside (`IN_USE`).
- All git operations go through `ctx.subprocess` (harness-managed); the test path uses a child_process runner.
- Manifest writes are atomic (tmp + rename); `prune` drops records whose checkout no longer exists.

## Local development

```bash
npm install
npm run typecheck     # client sources (tsc)
npm run build:client  # rebuild the committed client bundle
npm test              # host smoke + host-compatibility preflight + client bundle
```

`npm test` runs four suites: `test/smoke.mjs` (full worktree lifecycle on a
scratch repository), `test/host.mjs` (the real plugin entry mounted on a stubbed
cordis context: tool/command registration, the `ctx.subprocess` seam and the
worktree-mode instruction injection), `test/preflight.mjs` (the declared host
peer range against the versions the 0.2.0 line ships) and `test/client.mjs` (the
built browser bundle against stubbed loader/ctx faces, pinning the main-view
current-session derivation). The client bundle is committed; CI rebuilds it and fails on any
diff, so run `npm run build:client` before committing client changes.

## License

MIT — see [LICENSE](LICENSE)