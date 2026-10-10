/**
 * Compact worktree control mounted above the composer.
 *
 * The `worktree` checkbox switches the mode: checking it arms the host with the
 * picked base branch (the creation instruction then rides the next user
 * message), unchecking disarms. The branch button always shows the start point
 * a new worktree would use and opens a searchable list of the repository's
 * local and remote-tracking branches. The worktree branch itself is named by
 * the model — there is deliberately no name field here.
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import {
  // dsh-client-ui-primitives 0.1.7 renamed the icon sizes: Regular (1px
  // stroke) replaces the numbered 14/16 artwork words. `Checkbox` is the
  // shell's own control, so the mode switch matches the rest of the composer.
  Checkbox,
  IconBranchOutlineRegular,
  IconCheckOutlineRegular,
  IconChevronDownOutlineRegular,
  IconSearchOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { BranchListing } from './gitRefs.ts'
import type { WorktreeKey } from './locales.ts'
import type { WorktreeStore } from './worktreeStore.ts'
import css from './WorktreePanel.module.css'

const WORKTREE_PATH = /[\\/]\.dsh-worktrees[\\/]worktree[\\/]/u
/** Gap between the last hero chip and this panel's row. */
const CHIP_GAP = 6

/** Minimal console/debug hook exposed for in-GUI diagnosis. */
declare global {
  interface Window {
    __dshTaskWorktreePanelDebug?: {
      sessionId: string | undefined
      mode: string
      hero: boolean
      declaredWorktree: boolean
      base: string | undefined
      branches: number
      layout?: { inset: number; lift: number; chipsRight: number; rootLeft: number }
    }
  }
}

/** Injected callbacks (from the plugin apply closure — components never see ctx). */
export interface WorktreePanelInjected {
  /** Resolve the current session face (or undefined when absent). */
  currentSession(): SessionFace | undefined
  /** Resolve the current session's workspace cwd from the session-list summary. */
  currentCwd(): string | undefined
  /** Whether the staged session is a blank (empty-log) conversation. */
  currentBlank(): boolean
  /** Open a fresh session in the local workspace that owns the current worktree (legacy checkout sessions). */
  openLocalWorkspace(): Promise<void>
  /** Arm worktree mode with the picked base branch (undefined: the host's HEAD). */
  armWorktreeMode(base: string | undefined): Promise<void>
  /** Disarm worktree mode. */
  disarmWorktreeMode(): Promise<void>
  /** Read the repository's branches for the base-branch picker. */
  listBranches(): Promise<BranchListing>
}

export interface WorktreePanelProps extends WorktreePanelInjected {
  /** Locale-bound strings for the action labels. */
  t: (key: keyof WorktreeKey) => string
  /** The declared-worktree store. */
  store: WorktreeStore
  /** Resolve the staged session id. */
  sessionIdOf(): string | undefined
}

function currentMode(injected: WorktreePanelInjected): 'local' | 'worktree' {
  const cwd = injected.currentCwd()
  return typeof cwd === 'string' && WORKTREE_PATH.test(cwd) ? 'worktree' : 'local'
}

export function WorktreePanel(props: WorktreePanelProps): ReactNode {
  const { t, store, sessionIdOf } = props
  const rootRef = useRef<HTMLDivElement>(null)
  // Geometry the hero placement decided, exposed for in-GUI diagnosis.
  const layoutRef = useRef<{ inset: number; lift: number; chipsRight: number; rootLeft: number } | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [listing, setListing] = useState<BranchListing | undefined>(undefined)
  const [picked, setPicked] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  useSyncExternalStore(store.subscribe, store.getVersion)
  const sessionId = sessionIdOf()
  const declared = store.stateOf(sessionId)
  // Blank-hero bit still tracked for layout/debugging; the control itself is
  // driven purely by the mode and the repository listing.
  const hero = props.currentBlank()
  // A conversation declared (or runs inside) a worktree shows worktree mode.
  const mode = declared.worktree || currentMode(props) === 'worktree' ? 'worktree' : 'local'
  // Precedence: the branch picked in this panel, then the armed base, then the
  // repository's checked-out branch (the host's own default when unknown).
  const selectedBase = picked ?? declared.base ?? listing?.current ?? undefined

  // Read the ref database once the control is on a blank conversation. A
  // failure is not fatal: the host still defaults a new worktree to HEAD.
  useEffect(() => {
    if (!hero) return () => {}
    let live = true
    void props.listBranches().then((next) => {
      if (live) setListing(next)
    }).catch(() => {
      if (live) setListing(undefined)
    })
    return () => {
      live = false
    }
  }, [hero])

  window.__dshTaskWorktreePanelDebug = {
    sessionId,
    mode,
    hero,
    declaredWorktree: declared.worktree,
    base: selectedBase,
    branches: listing?.branches.length ?? 0,
    layout: layoutRef.current,
  }

  useLayoutEffect(() => {
    const root = rootRef.current
    // The shell renders the hero's workspace/mode chips in the row that precedes
    // this panel's container; sharing that line is a purely geometric decision.
    const heroRow = root?.parentElement?.previousElementSibling
    if (root === null || root === undefined || !(heroRow instanceof HTMLElement) || root.closest('[data-phase="hero"]') === null) {
      root?.style.removeProperty('--worktree-hero-inset')
      root?.style.removeProperty('--worktree-hero-lift')
      return
    }

    /** Right edge of the chips' content, in viewport coordinates. */
    const chipsRight = (): number => Array.from(heroRow.querySelectorAll<HTMLElement>('*')).reduce((right, element) => {
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 ? Math.max(right, rect.right) : right
    }, 0)

    const reposition = (): void => {
      // Measure from the unshifted position, so repeated passes cannot drift.
      root.style.removeProperty('--worktree-hero-inset')
      root.style.removeProperty('--worktree-hero-lift')
      const heroRect = heroRow.getBoundingClientRect()
      const rootRect = root.getBoundingClientRect()
      // `lift` is a margin, so it must be the delta that moves us UP: the
      // distance from our centre to the chips' centre.
      const lift = Math.round(heroRect.top + heroRect.height / 2 - (rootRect.top + rootRect.height / 2))
      let inset = Math.max(0, Math.ceil(chipsRight() - rootRect.left + CHIP_GAP))
      root.style.setProperty('--worktree-hero-lift', `${lift}px`)
      root.style.setProperty('--worktree-hero-inset', `${inset}px`)

      // Closed loop. The chips are slots owned by other plugins and the shell
      // itself: a preset label, a workspace title, and a webfont all settle
      // after this effect runs, and an attribute-only re-render does not even
      // reach the observers. Verify the geometry we actually got and nudge
      // right until the row truly clears the chips, so a stale first estimate
      // cannot leave the control overlapping the mode chip.
      for (let pass = 0; pass < 3; pass += 1) {
        const applied = root.getBoundingClientRect().left
        const deficit = Math.ceil(chipsRight() + CHIP_GAP - applied)
        if (deficit <= 0) break
        inset += deficit
        root.style.setProperty('--worktree-hero-inset', `${inset}px`)
      }
      layoutRef.current = { inset, lift, chipsRight: Math.round(chipsRight()), rootLeft: Math.round(root.getBoundingClientRect().left) }
    }

    reposition()
    // Every descendant is observed, not just the row: a chip that grows without
    // resizing the row (an async label, a font swap) must re-trigger us.
    const resizeObserver = new ResizeObserver(reposition)
    const observeChips = (): void => {
      resizeObserver.disconnect()
      resizeObserver.observe(heroRow)
      for (const element of heroRow.querySelectorAll<HTMLElement>('*')) resizeObserver.observe(element)
    }
    observeChips()
    const mutationObserver = new MutationObserver(() => {
      observeChips()
      reposition()
    })
    mutationObserver.observe(heroRow, { childList: true, subtree: true, characterData: true, attributes: true })
    const frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(reposition) : undefined
    // A webfont swap changes text metrics without a resize event.
    void document.fonts?.ready.then(() => reposition())
    window.addEventListener('resize', reposition)
    return () => {
      if (frame !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
      resizeObserver.disconnect()
      mutationObserver.disconnect()
      window.removeEventListener('resize', reposition)
    }
  }, [])

  const closeMenu = (): void => {
    setOpen(false)
    setQuery('')
  }

  useEffect(() => {
    if (!open) return () => {}
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current?.contains(event.target as Node) !== true) closeMenu()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeMenu()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const showFailure = (): void => {
    setNotice(t('fail'))
    window.setTimeout(() => setNotice(null), 1800)
  }

  /** Legacy: leave a session actually running inside a worktree checkout. */
  const switchLocal = (): void => {
    if (busy !== null) return
    setBusy('local')
    setNotice(t('switching'))
    void props.openLocalWorkspace().then(() => {
      setNotice(null)
    }).catch(() => {
      setNotice(null)
      showFailure()
    }).finally(() => {
      setBusy(null)
    })
  }

  const disarmMode = (): void => {
    if (busy !== null) return
    setBusy('disarm')
    void props.disarmWorktreeMode().catch(() => {
      showFailure()
    }).finally(() => {
      setBusy(null)
    })
  }

  /**
   * The checkbox is the mode switch: checking arms the host with the selected
   * base branch, unchecking disarms — or, for a session that physically runs
   * inside a checkout, opens the owning local workspace.
   */
  const toggleMode = (next: boolean): void => {
    if (busy !== null) return
    if (next) {
      if (declared.worktree) return
      setBusy('arm')
      void props.armWorktreeMode(selectedBase).catch(() => {
        showFailure()
      }).finally(() => {
        setBusy(null)
      })
      return
    }
    if (declared.worktree) {
      disarmMode()
      return
    }
    if (mode === 'worktree') switchLocal()
  }

  /** Pick a start point; an already armed session is re-armed with it. */
  const selectBranch = (name: string): void => {
    setPicked(name)
    closeMenu()
    if (!declared.worktree) return
    void props.armWorktreeMode(name).catch(() => {
      showFailure()
    })
  }

  // The mode control only matters before the conversation starts; after the
  // first message the header badge carries the mode indication instead, and a
  // workspace that is not a repository has nothing a worktree could be made
  // from. Unknown is not "no": until the ref read settles (and when the shell
  // exposes no file service) the control stays available, and the host still
  // falls back to HEAD.
  if (!hero) return null
  if (listing?.available === false && listing.reason === 'not-a-repo') return null

  const branches = listing?.branches ?? []
  const needle = query.trim().toLowerCase()
  const visible = needle === '' ? branches : branches.filter((branch) => branch.name.toLowerCase().includes(needle))

  return (
    <div
      ref={rootRef}
      className={css.root}
      data-testid="worktree-panel"
      data-mode={mode}
      aria-label={t('panelTitle')}
    >
      <button
        type="button"
        className={css.branchTrigger}
        data-testid="worktree-branch-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('baseBranchLabel')}
        title={t('baseBranchLabel')}
        disabled={busy !== null}
        onClick={() => setOpen(value => !value)}
      >
        <IconBranchOutlineRegular size={14} className={css.icon} />
        <span className={css.branchName}>{selectedBase ?? t('baseFallback')}</span>
        <IconChevronDownOutlineRegular
          size={12}
          className={`${css.chevron} ${open ? css.chevronOpen : ''}`}
        />
      </button>

      <Checkbox
        checked={mode === 'worktree'}
        onChange={toggleMode}
        label={t('worktreeLabel')}
        disabled={busy !== null}
        title={t('worktreeMode')}
        className={css.toggle}
      />

      {open && (
        <div
          className={css.popover}
          data-testid="worktree-branch-menu"
          role="listbox"
          aria-label={t('baseBranchLabel')}
        >
          <div className={css.searchRow}>
            <IconSearchOutlineRegular size={14} className={css.icon} />
            <input
              className={css.search}
              data-testid="worktree-branch-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('branchSearch')}
              aria-label={t('branchSearch')}
            />
          </div>
          <div className={css.branchList}>
            {visible.map((branch) => (
              <button
                key={branch.name}
                type="button"
                role="option"
                aria-selected={branch.name === selectedBase}
                data-testid={`worktree-branch-option-${branch.name}`}
                data-remote={branch.remote ? 'true' : undefined}
                className={`${css.branchOption} ${branch.name === selectedBase ? css.selected : ''}`}
                onClick={() => selectBranch(branch.name)}
              >
                <span className={css.branchOptionName}>{branch.name}</span>
                {branch.name === selectedBase && <IconCheckOutlineRegular size={13} className={css.branchCheck} />}
              </button>
            ))}
            {visible.length === 0 && (
              <div className={css.branchEmpty}>
                {listing?.available === false ? t('branchUnavailable') : t('branchEmpty')}
              </div>
            )}
          </div>
        </div>
      )}

      {notice !== null && (
        <span className={css.notice} data-tone={busy === 'local' ? 'info' : 'error'} role="status">{notice}</span>
      )}
    </div>
  )
}
