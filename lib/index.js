/**
 * dsh-task-worktree plugin entry: complete Git worktree support for
 * DeepSeek Harness, modeled on Qoder / Codex / Claude Code worktrees.
 *
 * Host side:
 * - per-repo manifest under `<repo>/.dsh-worktrees/manifest.json` (durable,
 *   atomic writes) — permanent worktrees survive sessions and restarts;
 * - `git worktree add -b <name>` checkouts (branch-based, so agents can
 *   commit normally inside the worktree), `ctx.subprocess` git runner;
 * - model tools: worktree_create / worktree_list / worktree_status;
 * - human command: /worktree create|list|status|finish|bring-back|remove|prune;
 * - worktree mode: `/worktree mode-on [name]` arms a session; the first
 *   genuine user message then carries an injected instruction (a plugin
 *   `instructions` context block) so the model creates the worktree inline.
 *
 * @module dsh-task-worktree
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { registerWorktreeCommand } from './commands.js'
import { createSubprocessRunner } from './git.js'
import { createWorktreeManager } from './manager.js'
import { registerTools } from './tools.js'

export const name = 'task-worktree'
export const inject = ['tools', 'commands', 'subprocess']

const DEFAULT_DIR_NAME = '.dsh-worktrees'
const PLUGIN_ID = 'dsh-task-worktree'

/** The instruction injected with the first user message of an armed session. */
function buildModeInstruction(name) {
  const named = name !== undefined && name !== ''
    ? `分支名为 "${name}" 的`
    : '一个（分支名请统一以 worktree/ 开头自行拟定，如 worktree/login，遵循 git ref 规则，支持 / 分层）'
  return `本次对话以任务 worktree 模式开始：请在本轮最先调用 worktree_create 创建${named}任务 worktree（分支名统一以 worktree/ 开头），创建后本次对话的工作请在返回的 worktree 路径（用绝对路径）内进行，不要在主工作区散落改动。任务完成后，请主动提醒用户收尾清理：告知实际创建的 worktree 名字与路径，并提供两条可复制命令二选一：/worktree bring-back <名字>（把改动并入主工作区，保留 checkout）；或 /worktree remove <名字> --force（直接强制删除该 worktree 与分支，含未提交改动）。`
}

/**
 * Mount the plugin.
 * @param ctx - cordis context.
 * @param config - optional `{ dirName? }` (profile patch layer).
 */
export function apply(ctx, config = {}) {
  const dirName = config?.dirName?.trim() || DEFAULT_DIR_NAME
  const runner = createSubprocessRunner(ctx)
  const manager = createWorktreeManager({ git: runner, dirName })
  registerTools(ctx, manager)

  // ── Worktree mode: armed sessions inject an instruction with their first user message ──
  const armed = new Map()
  const actions = {
    arm(sessionId, name) {
      armed.set(sessionId, { name: name?.trim() || undefined })
    },
    disarm(sessionId) {
      armed.delete(sessionId)
    },
  }
  // The arm belongs to the SESSION, never to one transient agent instance.
  // The host disposes an agent together with its owning fiber (`agent/disposed`
  // on owner unload, client release or idle recycle) and a fresh agent serves
  // the same session afterwards; dropping the arm there silently cancelled the
  // user's explicit intent, so the creation instruction never rode the next
  // message and no worktree appeared. Entry lifetime is now: consumed by the
  // first genuine user message, or removed by an explicit `/worktree mode-off`.
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    const sessionId = agent?.session?.id
    if (sessionId === undefined) return
    const pending = armed.get(sessionId)
    if (pending === undefined) return
    // Only a genuine human prompt rides the injection; never re-arm on
    // producer-supplied context or tool results.
    if (message?.source?.kind !== 'user') return
    try {
      agent.inject(createUserMessage({
        content: [{ type: 'text', text: buildModeInstruction(pending.name) }],
        source: { kind: 'plugin', plugin: PLUGIN_ID, form: 'instructions' },
      }))
    } catch (error) {
      // The host contains listener failures into a log record, which would make
      // a broken injection invisible here; surface it and keep the arm so the
      // next message can still carry the instruction.
      ctx.logger?.warn?.(`dsh-task-worktree: worktree-mode instruction injection failed: ${String(error)}`)
      return
    }
    armed.delete(sessionId)
  })

  registerWorktreeCommand(ctx, manager, actions)
}