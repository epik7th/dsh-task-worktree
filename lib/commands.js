/**
 * `/worktree` human command surface. Finishing actions (finish, bring-back,
 * remove, prune) are user-initiated only — the model never reaches them.
 *
 * @module dsh-task-worktree/commands
 */
import { registerWorkspaceHooks } from './workspace.js'

const USAGE = 'Usage: /worktree mode-on [<name>] [--base <branch>] | mode-off | create <name> [<base>] [--carry] | list | status [<name>] | finish <name> <message> | bring-back <name> [<message>] | remove <name> [--force] | prune'

function formatEntry(entry) {
  const head = entry.head ? entry.head.slice(0, 7) : '—'
  const dirty = entry.dirty ? ' dirty' : ''
  return `${entry.name.padEnd(24)} ${entry.state.padEnd(12)} ${entry.branch} @ ${head}${dirty}  ${entry.path}`
}

function parse(rawInput) {
  const tokens = rawInput.trim().split(/\s+/u).filter(Boolean)
  if (tokens.length === 0) return { kind: 'list' }
  const [verb, ...rest] = tokens
  switch (verb) {
    case 'list':
    case 'ls':
      return { kind: 'list' }
    case 'status':
    case 'info':
      return { kind: 'status', name: rest[0] }
    case 'mode-on': {
      // `mode-on [<name>] [--base <branch>]`: the name is the legacy fixed
      // branch (power users / scripts); the base is the start point the panel's
      // branch picker chose. A bare `mode-on` leaves the name to the model.
      const baseIndex = rest.indexOf('--base')
      const base = baseIndex >= 0 ? rest[baseIndex + 1] : undefined
      const positional = baseIndex < 0
        ? rest
        : rest.filter((_token, index) => index !== baseIndex && index !== baseIndex + 1)
      return { kind: 'modeOn', name: positional[0], base }
    }
    case 'mode-off':
      return { kind: 'modeOff' }
    case 'create': {
      const name = rest[0]
      if (!name) return { kind: 'usage' }
      const carry = rest.includes('--carry') || rest.includes('-c')
      const positional = rest.filter((t) => !t.startsWith('-'))
      const baseCommit = positional[1]
      return { kind: 'create', name, baseCommit, includeUncommitted: carry }
    }
    case 'finish': {
      const name = rest[0]
      const message = rest.slice(1).join(' ')
      if (!name || !message) return { kind: 'usage' }
      return { kind: 'finish', name, message }
    }
    case 'bring-back':
    case 'bringback':
    case 'move-to-local': {
      const name = rest[0]
      const message = rest.slice(1).join(' ')
      if (!name) return { kind: 'usage' }
      return { kind: 'bringBack', name, message: message || undefined }
    }
    case 'remove':
    case 'delete': {
      const name = rest[0]
      if (!name) return { kind: 'usage' }
      return { kind: 'remove', name, force: rest.includes('--force') }
    }
    case 'prune':
      return { kind: 'prune' }
    default:
      return { kind: 'unknown', verb }
  }
}

/**
 * Register the `/worktree` command.
 * @param ctx - cordis context (commands service injected).
 * @param manager - the worktree manager.
 * @param modeActions - `{ arm(sessionId, { name?, base? }), disarm(sessionId) }`
 *   for the worktree-mode toggle (may be omitted when the host half is absent).
 */
export function registerWorktreeCommand(ctx, manager, modeActions = {}) {
  const hooks = registerWorkspaceHooks(ctx, manager)
  ctx.commands.register({
    name: 'worktree',
    description: 'manage task-scoped git worktrees: mode-on/mode-off/create/list/status/finish/bring-back/remove/prune',
    input: { hint: USAGE.replace(/^Usage: /, '') },
    handler: async (invocation) => {
      const parsed = parse(invocation.rawInput)
      const agent = invocation.agent
      const cwd = agent?.session?.header?.cwd ?? agent?.session?.cwd
      const currentDir = cwd
      const sessionId = agent?.session?.id ?? null
      try {
        switch (parsed.kind) {
          case 'usage':
          case 'unknown':
            return { kind: 'error', text: USAGE }
          case 'modeOn': {
            if (sessionId === null) return { kind: 'error', text: 'mode requires an active session' }
            const name = parsed.name?.trim() || undefined
            const base = parsed.base?.trim() || undefined
            // Validate the picked base branch before arming: an unresolvable
            // base must fail here (the user sees it) instead of making the
            // model's worktree_create fail inside the next turn.
            if (base !== undefined) {
              try {
                await manager.resolveBase({ cwd, base })
              } catch (error) {
                return { kind: 'error', text: `cannot use base branch ${JSON.stringify(base)}: ${error instanceof Error ? error.message : String(error)}` }
              }
            }
            modeActions.arm?.(sessionId, { name, base })
            // English only: the host has no locale service, and this text is a
            // durable conversation row the user reads.
            if (name !== undefined) {
              return {
                kind: 'success',
                text: base !== undefined
                  ? `Worktree mode on — branch "${name}", base "${base}"`
                  : `Worktree mode on — branch "${name}"`,
              }
            }
            return {
              kind: 'success',
              text: base !== undefined
                ? `Worktree mode on — the model names the branch, base "${base}"`
                : 'Worktree mode on — the model names the branch',
            }
          }
          case 'modeOff': {
            if (sessionId === null) return { kind: 'error', text: 'mode requires an active session' }
            modeActions.disarm?.(sessionId)
            return { kind: 'success', text: 'Worktree mode off' }
          }
          case 'list': {
            const result = await manager.list(cwd)
            if (result.worktrees.length === 0) {
              return { kind: 'success', text: 'No managed task worktrees in this repository. Create one with /worktree create <name>.' }
            }
            return { kind: 'success', text: [`Task worktrees of ${result.repoRoot} (${result.dir}):`, ...result.worktrees.map(formatEntry)].join('\n') }
          }
          case 'status': {
            const result = await manager.status({ name: parsed.name, cwd })
            if (!result.worktree) {
              return { kind: 'success', text: 'This session is not inside a managed task worktree.' }
            }
            const w = result.worktree
            return {
              kind: 'success',
              text: [
                `worktree: ${w.name}`,
                `  path: ${w.path}`,
                `  branch: ${w.branch}`,
                `  state: ${w.state}${w.permanent ? ' (permanent)' : ''}`,
                `  base: ${w.baseCommit.slice(0, 7)}`,
                `  head: ${w.head ? w.head.slice(0, 7) : 'missing checkout'}`,
                `  dirty: ${w.dirty}`,
              ].join('\n'),
            }
          }
          case 'create': {
            const result = await manager.create({
              name: parsed.name,
              baseCommit: parsed.baseCommit,
              includeUncommitted: parsed.includeUncommitted,
              cwd,
              createdBy: sessionId,
            })
            return {
              kind: 'success',
              text: [
                `Created task worktree "${result.worktree.name}".`,
                `  path: ${result.worktree.path}`,
                `  branch: ${result.worktree.branch}`,
                `  base: ${result.worktree.baseCommit.slice(0, 7)}`,
                'No workspace is registered for this checkout; continue working in this conversation, or open the path as a workspace when you need session isolation.',
              ].join('\n'),
            }
          }
          case 'finish': {
            const result = await manager.finish({ name: parsed.name, message: parsed.message, cwd, sourceSessionId: sessionId })
            return {
              kind: 'success',
              text: result.committed
                ? `Committed worktree "${result.name}" on ${result.branch} as ${(result.commitOid ?? '').slice(0, 7)}.`
                : `Worktree "${result.name}" was already clean on ${result.branch} at ${(result.commitOid ?? '').slice(0, 7)}.`,
            }
          }
          case 'bringBack': {
            const result = await manager.bringBack({ name: parsed.name, cwd, message: parsed.message })
            return {
              kind: 'success',
              text: `Brought back worktree "${result.name}" (${result.branch}) to main workspace; main HEAD is now ${result.mainHead.slice(0, 7)}. The worktree checkout is kept on disk.`,
            }
          }
          case 'remove': {
            const result = await manager.remove({ name: parsed.name, cwd, currentDir, force: parsed.force })
            await hooks.unregister(result.path)
            return { kind: 'success', text: `Removed worktree "${result.name}" (${result.branch}).` }
          }
          case 'prune': {
            const result = await manager.prune({ cwd })
            for (const prunedName of result.pruned) {
              const entry = result.removedEntries?.find((candidate) => candidate.name === prunedName)
              if (entry !== undefined) await hooks.unregister(entry.path).catch(() => {})
            }
            return {
              kind: 'success',
              text: result.pruned.length > 0
                ? `Pruned ${result.pruned.length} stale record(s): ${result.pruned.join(', ')}.`
                : 'No stale worktree records to prune.',
            }
          }
          default:
            return { kind: 'error', text: USAGE }
        }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}