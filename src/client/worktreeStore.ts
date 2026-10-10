/**
 * Reactive per-session worktree mode store.
 *
 * The composer's worktree checkbox arms the host immediately
 * (`/worktree mode-on [--base <branch>]`); the store mirrors that intent for
 * the panel and the conversation badge. Slot components read it through
 * useSyncExternalStore.
 */
/** State the components need for the current session. */
export interface WorktreeSessionState {
  /** Base branch the next worktree starts from, or undefined (the host's HEAD). */
  base: string | undefined
  /** Worktree mode selected/armed (checkbox + badge on). */
  worktree: boolean
}

/** Plain observable store keyed by session id. */
export interface WorktreeStore {
  subscribe(listener: () => void): () => void
  getVersion(): number
  stateOf(sessionId: string | undefined): WorktreeSessionState
  /** Arm the host: worktree mode + optional base branch. */
  declare(sessionId: string | undefined, base: string | undefined): void
  clear(sessionId: string | undefined): void
}

export function createWorktreeStore(): WorktreeStore {
  let byId = new Map<string, WorktreeSessionState>()
  let version = 0
  const listeners = new Set<() => void>()

  const bump = (next: Map<string, WorktreeSessionState>): void => {
    byId = next
    version += 1
    for (const listener of listeners) listener()
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getVersion() {
      return version
    },
    stateOf(sessionId) {
      if (sessionId === undefined) return { base: undefined, worktree: false }
      return byId.get(sessionId) ?? { base: undefined, worktree: false }
    },
    declare(sessionId, base) {
      if (sessionId === undefined) return
      const current = byId.get(sessionId)
      const next = { base: base ?? undefined, worktree: true }
      if (current !== undefined && current.base === next.base && current.worktree === next.worktree) return
      const cloned = new Map(byId)
      cloned.set(sessionId, next)
      bump(cloned)
    },
    clear(sessionId) {
      if (sessionId === undefined) return
      if (!byId.has(sessionId)) return
      const cloned = new Map(byId)
      cloned.delete(sessionId)
      bump(cloned)
    },
  }
}