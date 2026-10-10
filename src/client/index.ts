/**
 * dsh-task-worktree browser half.
 *
 * Mounts a compact worktree control into `conversation.input.dock` (a
 * `worktree` checkbox plus the base-branch picker) and a worktree recognition
 * badge into `conversation.session.header.actions`. Both appear on blank
 * conversations only.
 *
 * Workspace discipline: creating a worktree NEVER registers a workspace and
 * NEVER switches the conversation — work continues in-place.
 *
 * Data channels: blank-hero detection reads the host session list (`blank`
 * flag and cwd — window-independent); the badge reads the worktree declaration
 * store (set by the composer's checkbox) plus the session cwd; the
 * base-branch picker reads the repository's ref files through the shell's
 * `workspaceFiles` Remote (see gitRefs.ts). Note: framework session standard
 * props (useSession / useInput) are NOT injected into slot components in the
 * current shell, so nothing depends on them.
 *
 * "Current session" is the main-view row: dsh 0.1.6 dropped `sessions.current`
 * from the list state (navigation belongs to the view owners), so it is
 * derived from retention — the same derivation the shell itself uses.
 *
 * Built by tsdown into the __ModuleLoader__ factory bundle at
 * client/client.js; the only externals are the loader module table's react
 * entries.
 */
import { createElement as h } from 'react'
// dsh 0.1.2 removed `@deepseek-ai/dsh-client-runtime`; the browser faces now
// live on the API-controller/client packages (type-only imports — erased from
// the tsdown bundle, so nothing here needs a module-table entry).
import type { ISessions, SessionFace, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the ui-session declaration merge of
// `SessionReferenceSourceMap` (the `mainView` retention source) into this
// project, so the main-view derivation below typechecks. Erased from the
// bundle; the ui-session bundle itself is a runtime peer the shell owns.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { BranchListing, WorkspaceFilesFace } from './gitRefs.ts'
import { readBranches } from './gitRefs.ts'
import { en, zh } from './locales.ts'
import { WorktreeBadge } from './WorktreeBadge.tsx'
import { WorktreePanel } from './WorktreePanel.tsx'
import { createWorktreeStore } from './worktreeStore.ts'

const NS = 'dsh-task-worktree'

/** The subset of the slots service this plugin touches (structural typing keeps
 * this external package free of monorepo-internal type dependencies). */
interface SlotsService {
  inject(slot: string, register: () => unknown): void
  register(meta: Record<string, unknown>, component: () => unknown): unknown
}

/** The subset of the locale service this plugin touches. */
interface LocaleService {
  register(namespace: string, dicts: { zh: Record<string, string>; en: Record<string, string> }): unknown
  bind(namespace: string): (key: string) => string
}

/** The client cordis context shape this plugin relies on. */
interface WorktreeClientContext {
  effect(callback: () => unknown, label?: string): void
  /** Cordis service lookup: the plugin reads optional services through it. */
  get?(name: string): unknown
  locale: LocaleService
  slots: SlotsService
  sessions: ISessions
  workspaces: IWorkspaces
}

export const name = 'dsh-task-worktree'
export const inject = ['slots', 'locale', 'sessions', 'workspaces']

export function apply(ctx: WorktreeClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${NS}: dictionaries`)

  const t = (key: string): string => ctx.locale.bind(NS)(key)

  /** Reactive store for worktree-mode declarations. */
  const store = createWorktreeStore()

  /**
   * The main-view session row — the conversation the GUI's main view retains.
   *
   * dsh 0.1.6 dropped `sessions.current` (navigation belongs to the view
   * owners), so the current conversation is derived from the retention source
   * counts instead; this is the same derivation the shell's own title/chrome
   * and upstream ui-workspace's `mainSessionId` use. The Host list order
   * decides between several retained rows.
   */
  const currentRow = (): SessionSummary | undefined => {
    const snapshot = ctx.sessions.list.getSnapshot()
    for (const id of snapshot.ids) {
      const row = snapshot.byId[id]
      if (row !== undefined && (row.retainedBy.mainView ?? 0) > 0) return row
    }
    return undefined
  }

  /** Resolve the current session id (the staged conversation). */
  const currentSessionId = (): SessionId | undefined => currentRow()?.id

  /** Resolve the current session face through the main-view row. */
  const currentSession = (): SessionFace | undefined => {
    const current = currentSessionId()
    if (current === undefined) return undefined
    const binding = ctx.sessions.binding(current)
    return binding?.session
  }

  /** Resolve the current cwd from the list summary (the outward session face intentionally omits it). */
  const currentCwd = (): string | undefined => currentRow()?.cwd

  /** Whether the staged session is still blank (host-computed empty-log bit). */
  const currentBlank = (): boolean => currentRow()?.blank === true

  /**
   * The staged session's workspace root. `workspaceFiles.list` resolves
   * relative paths against it (and refuses targets outside it), and a session
   * row carries no workspace id of its own — the registry's Session
   * membership is the only mapping the Client exposes.
   */
  const currentWorkspaceRoot = (): string | undefined => {
    const current = currentRow()?.id
    if (current === undefined) return undefined
    for (const view of ctx.workspaces.list.getSnapshot().items) {
      if (view.sessionIds.includes(current)) return view.path
    }
    return undefined
  }

  /** Open the local workspace that owns the current worktree checkout. */
  const openLocalWorkspace = async (): Promise<void> => {
    const cwd = currentCwd()
    if (typeof cwd !== 'string' || cwd === '') {
      throw new Error('cannot determine the current workspace path')
    }
    const marker = /[\\/]\.dsh-worktrees[\\/]worktree[\\/]/u.exec(cwd)
    const localPath = marker !== null ? cwd.slice(0, marker.index) : cwd
    // dsh 0.1.7: client-owned current-session selection moved to the view
    // owners; `ISessions.open` is gone. The capability keeps its guarantees:
    // the host registers (or adopts) the workspace and catalogues a session
    // inside it — the new session then appears in the session list.
    const workspace = await ctx.workspaces.create({ path: localPath })
    await ctx.sessions.create({ workspaceId: workspace.workspaceId })
  }

  /**
   * Arm this conversation for worktree mode: the host injects the creation
   * instruction with the NEXT genuine user message (no separate prompt, no
   * workspace registration). The base branch is the one the composer's picker
   * chose; the model names the worktree branch itself. On success the session
   * is declared worktree-mode in the store (the badge switches on immediately).
   */
  const armWorktreeMode = async (rawBase: string | undefined): Promise<void> => {
    const sessionId = currentSessionId()
    const session = currentSession()
    if (session === undefined || sessionId === undefined) throw new Error('there is no conversation to inject into')
    const base = rawBase?.trim() ?? ''
    const line = base === '' ? '/worktree mode-on' : `/worktree mode-on --base ${base}`
    const result = await session.command(line)
    if (!result.ok || result.value.matched !== true) throw new Error('the command did not run')
    store.declare(sessionId, base === '' ? undefined : base)
  }

  /**
   * Read the repository's branches for the base-branch picker. The shell's
   * `workspaceFiles` Remote is optional (a minimal preset and a third-party
   * composition may omit it), so the lookup is soft and a missing service
   * degrades to an unavailable listing instead of failing the panel.
   */
  const listBranches = async (): Promise<BranchListing> => {
    const sessionId = currentSessionId()
    const files = ctx.get?.('remote.workspaceFiles') as WorkspaceFilesFace | undefined
    if (sessionId === undefined || files === undefined) {
      return { available: false, current: undefined, branches: [], reason: 'unavailable' }
    }
    return readBranches({ sessionId, root: currentWorkspaceRoot(), cwd: currentCwd(), files })
  }

  /** Disarm worktree mode for the current conversation. */
  const disarmWorktreeMode = async (): Promise<void> => {
    const sessionId = currentSessionId()
    const session = currentSession()
    if (session === undefined || sessionId === undefined) throw new Error('there is no conversation to inject into')
    const result = await session.command('/worktree mode-off')
    if (!result.ok || result.value.matched !== true) throw new Error('the command did not run')
    store.clear(sessionId)
  }

  // ── Slots ──────────────────────────────────────────────────────────────
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'worktree',
    order: 10,
    locale: NS,
  }, () => h(WorktreePanel, {
    currentSession,
    currentCwd,
    currentBlank,
    openLocalWorkspace,
    armWorktreeMode,
    disarmWorktreeMode,
    listBranches,
    store,
    sessionIdOf: currentSessionId,
    t,
  })))

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'worktree-badge',
    // Negative order: static session context precedes interactive actions.
    order: -30,
    locale: NS,
  }, () => h(WorktreeBadge, {
    store,
    sessionIdOf: currentSessionId,
    currentCwd,
    t,
  })))
}