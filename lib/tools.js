/**
 * Model-facing task-worktree tools. Destructive and finishing actions (remove,
 * finish, bring-back) are deliberately excluded: they are human commands only,
 * matching Qoder/Codex/Claude Code where acceptance and cleanup stay with the
 * user. The model may create, list, and inspect worktrees.
 *
 * @module dsh-task-worktree/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { renderJson, sessionCwdOf } from './util.js'

function resolveCwd(exec, ctx) {
  return sessionCwdOf(exec.agent) ?? ctx?.get?.('sessions')?.get?.(exec.agent?.session?.id)?.header?.cwd
}

/**
 * Register the safe model-facing worktree tools.
 * @param ctx - cordis context (tools service injected).
 * @param manager - the worktree manager.
 */
export function registerTools(ctx, manager) {
  ctx.tools.register(defineTool({
    name: 'worktree_create',
    description: 'Create a task-isolated worktree: a new independent checkout in the current Git repository. `name` is both the branch name and the relative path (slashes create nesting), under <repo>/.dsh-worktrees/worktree/<name>. Changes never touch the main workspace, and the checkout can later be opened as a session workspace. Comparable to Qoder worktree execution environments and Codex permanent worktrees.',
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: 'Branch name and worktree relative path (slashes create nesting, e.g. refactor/logging → branch refactor/logging, path .dsh-worktrees/worktree/refactor/logging). Follows git ref rules: segments of letters/digits/._- separated by "/", no leading or trailing slash, no "..", no backslash.',
      },
      baseCommit: {
        type: 'string',
        description: 'Start point (commit-ish; defaults to the current HEAD).',
      },
      includeUncommitted: {
        type: 'boolean',
        description: 'Copy uncommitted changes of the main workspace into the new worktree (default false).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          path: { type: 'string', required: true },
          branch: { type: 'string', required: true },
          repoRoot: { type: 'string', required: true },
          baseCommit: { type: 'string', required: true },
          createdAt: { type: 'string', required: true },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args, exec) {
      const cwd = resolveCwd(exec, ctx)
      if (!cwd) throw new Error('cannot determine the current session working directory')
      const result = await manager.create({
        name: args.name,
        baseCommit: args.baseCommit,
        includeUncommitted: args.includeUncommitted === true,
        cwd,
        createdBy: exec.agent?.session?.id ?? null,
        signal: exec.signal,
      })
      return {
        name: result.worktree.name,
        path: result.worktree.path,
        branch: result.worktree.branch,
        repoRoot: result.repoRoot,
        baseCommit: result.worktree.baseCommit,
        createdAt: result.worktree.createdAt,
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Create task worktree', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'worktree_list',
    description: 'List every managed task worktree of the current repository (name, path, branch, commit, dirty state).',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          repoRoot: { type: 'string', required: true },
          worktrees: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                path: { type: 'string', required: true },
                branch: { type: 'string', required: true },
                state: { type: 'string', required: true },
                exists: { type: 'boolean', required: true },
                dirty: { type: 'boolean', required: true },
                head: { type: 'string' },
                permanent: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(_args, exec) {
      const cwd = resolveCwd(exec, ctx)
      if (!cwd) throw new Error('cannot determine the current session working directory')
      const result = await manager.list(cwd, exec.signal)
      return {
        repoRoot: result.repoRoot,
        worktrees: result.worktrees.map((entry) => ({
          name: entry.name,
          path: entry.path,
          branch: entry.branch,
          state: entry.state,
          exists: entry.exists,
          dirty: entry.dirty ?? false,
          ...(entry.head ? { head: entry.head } : {}),
          permanent: entry.permanent,
        })),
      }
    },
    presentCall: () => ({ card: 'generic', title: 'List task worktrees', kind: 'other', rawInput: {} }),
  }))

  ctx.tools.register(defineTool({
    name: 'worktree_status',
    description: 'Report the status of one task worktree, or of the worktree the current session runs in (branch, HEAD, dirty, lifecycle state).',
    parameters: {
      name: { type: 'string', description: 'Worktree name; defaults to the worktree the current session runs in.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          repoRoot: { type: 'string', required: true },
          inWorktree: { type: 'boolean', required: true },
          worktree: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', required: true },
              path: { type: 'string', required: true },
              branch: { type: 'string', required: true },
              state: { type: 'string', required: true },
              exists: { type: 'boolean', required: true },
              dirty: { type: 'boolean', required: true },
              head: { type: 'string' },
              baseCommit: { type: 'string', required: true },
            },
          },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args, exec) {
      const cwd = resolveCwd(exec, ctx)
      if (!cwd) throw new Error('cannot determine the current session working directory')
      const result = await manager.status({ name: args.name, cwd, signal: exec.signal })
      if (!result.worktree) {
        return { repoRoot: result.repoRoot, inWorktree: false }
      }
      const w = result.worktree
      return {
        repoRoot: result.repoRoot,
        inWorktree: true,
        worktree: {
          name: w.name,
          path: w.path,
          branch: w.branch,
          state: w.state,
          exists: w.exists,
          dirty: w.dirty,
          ...(w.head ? { head: w.head } : {}),
          baseCommit: w.baseCommit,
        },
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Task worktree status', kind: 'other', rawInput: {} }),
  }))
}