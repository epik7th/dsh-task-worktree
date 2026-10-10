/**
 * Branch discovery for the composer's base-branch picker.
 *
 * The browser half has no git, and the gateway admits no plugin-owned Remote
 * namespace (contributions are generated from the monorepo, so a third-party
 * plugin cannot publish one). The repository's ref database is therefore read
 * as plain files through the shell's own `workspaceFiles` Remote
 * (`@deepseek-ai/dsh-api-workspace-files`): `HEAD`, loose `refs/heads/**` and
 * `refs/remotes/**`, plus `packed-refs`.
 *
 * Two Remote asymmetries shape the reader: `list` speaks workspace paths and
 * refuses anything outside the Session's workspace root, while `read` accepts
 * absolute paths. A session running inside a managed checkout consequently
 * degrades to `packed-refs` + `HEAD`, because that checkout's loose refs live
 * in the main repository, outside its own workspace root.
 *
 * Everything here is a pure function over that face, so the reader is
 * exercised without a harness.
 *
 * @module dsh-task-worktree/client/gitRefs
 */

/** One unary `workspaceFiles` outcome: a call never rejects for a carrier problem. */
export type RemoteOutcome<Value> =
  | { ok: true; value: Value }
  | { ok: false; error: { code?: string; message?: string } }

/** One direct child of a listed directory, as the Remote reports it. */
export interface RemoteDirectoryEntry {
  name: string
  type: 'file' | 'directory' | 'other' | string
}

/** The slice of `ctx.remote.workspaceFiles` this module calls. */
export interface WorkspaceFilesFace {
  list(
    sessionId: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<RemoteOutcome<{ entries: readonly RemoteDirectoryEntry[] }>>
  read(
    sessionId: string,
    path: string,
    range: { offset?: number; limit?: number },
    signal?: AbortSignal,
  ): Promise<RemoteOutcome<{ text: string }>>
}

/** One selectable start point for a new worktree. */
export interface BranchOption {
  /** Branch name as git prints it: `main`, `claude/x`, `origin/main`. */
  name: string
  /** Remote-tracking branch (`origin/...`). */
  remote: boolean
  /** The branch `HEAD` points at. */
  current: boolean
}

/** Why a listing carries no branches. */
export type BranchListingReason = 'unavailable' | 'not-a-repo'

/** Outcome of one ref-database read; never a rejection. */
export interface BranchListing {
  /** False when the shell exposed no file service, or the session has no repository. */
  available: boolean
  /** The current branch, absent on a detached `HEAD`. */
  current: string | undefined
  /** Selectable bases: the current branch first, then locals, then remotes. */
  branches: BranchOption[]
  /** Set exactly when `available` is false. */
  reason: BranchListingReason | undefined
}

/** What one read needs: the session identity, its scope, and the shell's file face. */
export interface BranchReadInput {
  sessionId: string
  /** Session workspace root — the scope `list` resolves relative paths against. */
  root: string | undefined
  /** Session working directory — where the repository is looked for. */
  cwd: string | undefined
  /** The shell's `workspaceFiles` face, when the shell mounted that package. */
  files: WorkspaceFilesFace | undefined
  signal?: AbortSignal
}

/** `ref: refs/heads/main` → `main`; a detached `HEAD` names no branch. */
export function parseHead(text: string): string | undefined {
  const match = /^ref:\s*refs\/heads\/(.+)$/mu.exec(text.trim())
  return match?.[1]?.trim() ?? undefined
}

/** `gitdir: /repo/.git/worktrees/x` → the path exactly as written. */
export function parseGitDirFile(text: string): string | undefined {
  const match = /^gitdir:\s*(.+)$/mu.exec(text.trim())
  return match?.[1]?.trim() ?? undefined
}

/** Branch refs declared by a `packed-refs` file; tags and peeled rows are not branches. */
export function parsePackedRefs(text: string): { name: string; remote: boolean }[] {
  const found: { name: string; remote: boolean }[] = []
  for (const line of text.split('\n')) {
    const match = /^[0-9a-f]{40,64}\s+(refs\/(?:heads|remotes)\/.+)$/u.exec(line.trim())
    if (match === null) continue
    const ref = match[1]
    if (ref.startsWith('refs/heads/')) found.push({ name: ref.slice('refs/heads/'.length), remote: false })
    else found.push({ name: ref.slice('refs/remotes/'.length), remote: true })
  }
  return found
}

/** Normalize a `/`-separated path, resolving `.` and `..` segments. */
export function normalizePath(value: string): string {
  const absolute = value.startsWith('/')
  const segments: string[] = []
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  const joined = segments.join('/')
  if (absolute) return `/${joined}`
  return joined === '' ? '.' : joined
}

/** Join segments with `/`. */
export function joinPath(...parts: string[]): string {
  return normalizePath(parts.filter((part) => part !== '').join('/'))
}

/** `target` expressed relative to `root`, or undefined when it lies outside. */
export function relativeTo(root: string, target: string): string | undefined {
  const base = normalizePath(root)
  const full = normalizePath(target)
  if (full === base) return ''
  return full.startsWith(`${base}/`) ? full.slice(base.length + 1) : undefined
}

/** Current branch first, then locals, then remotes; alphabetical inside each group. */
function compareBranches(left: BranchOption, right: BranchOption): number {
  if (left.current !== right.current) return left.current ? -1 : 1
  if (left.remote !== right.remote) return left.remote ? 1 : -1
  return left.name.localeCompare(right.name)
}

/**
 * Branch names under one refs directory, recursing into name namespaces
 * (`refs/heads/claude/x`). A directory the Remote refuses contributes nothing:
 * loose refs outside the workspace root are simply not discovered.
 */
async function listRefs(
  files: WorkspaceFilesFace,
  sessionId: string,
  root: string | undefined,
  directory: string,
  prefix: string,
  signal: AbortSignal | undefined,
  depth: number,
): Promise<string[]> {
  if (depth > 4 || root === undefined) return []
  const scope = relativeTo(root, directory)
  if (scope === undefined || scope === '') return []
  const listing = await files.list(sessionId, scope, signal)
  if (!listing.ok) return []
  const names: string[] = []
  for (const entry of listing.value.entries) {
    if (entry.type === 'directory') {
      names.push(...await listRefs(files, sessionId, root, joinPath(directory, entry.name), `${prefix}${entry.name}/`, signal, depth + 1))
      continue
    }
    names.push(`${prefix}${entry.name}`)
  }
  return names
}

/**
 * Read the session repository's branches. Never rejects: a missing file
 * service, a directory that is not a repository, and unreadable ref files all
 * come back as an unavailable listing so the composer can keep working with
 * the host's `HEAD` default.
 * @param input - session identity, workspace scope, cwd, and the file face.
 * @returns the listing the base-branch picker renders.
 */
export async function readBranches(input: BranchReadInput): Promise<BranchListing> {
  const { sessionId, root, cwd, files, signal } = input
  const unavailable = (reason: BranchListingReason): BranchListing =>
    ({ available: false, current: undefined, branches: [], reason })
  if (files === undefined) return unavailable('unavailable')
  if (typeof cwd !== 'string' || cwd === '') return unavailable('not-a-repo')

  // A working tree has a `.git` directory; a linked worktree has a `.git` file
  // naming its per-worktree git directory.
  const dotGit = joinPath(cwd, '.git')
  let gitDir: string | undefined
  let head: string | undefined
  const direct = await files.read(sessionId, joinPath(dotGit, 'HEAD'), {}, signal)
  if (direct.ok) {
    gitDir = dotGit
    head = direct.value.text
  } else {
    const pointer = await files.read(sessionId, dotGit, {}, signal)
    if (!pointer.ok) return unavailable('not-a-repo')
    const linked = parseGitDirFile(pointer.value.text)
    if (linked === undefined) return unavailable('not-a-repo')
    gitDir = normalizePath(linked.startsWith('/') ? linked : joinPath(cwd, linked))
    const linkedHead = await files.read(sessionId, joinPath(gitDir, 'HEAD'), {}, signal)
    if (linkedHead.ok) head = linkedHead.value.text
  }

  // Ref namespaces live in the common directory of a linked worktree.
  let refsHome = gitDir
  const common = await files.read(sessionId, joinPath(gitDir, 'commondir'), {}, signal)
  if (common.ok) {
    const value = common.value.text.trim()
    if (value !== '') refsHome = normalizePath(value.startsWith('/') ? value : joinPath(gitDir, value))
  }

  const current = head === undefined ? undefined : parseHead(head)
  const byName = new Map<string, BranchOption>()
  const add = (name: string, remote: boolean): void => {
    if (name === '') return
    // `<remote>/HEAD` is the remote's default-branch symref, not a base branch.
    if (remote && name.endsWith('/HEAD')) return
    if (!byName.has(name)) byName.set(name, { name, remote, current: name === current })
  }

  for (const name of await listRefs(files, sessionId, root, joinPath(refsHome, 'refs', 'heads'), '', signal, 0)) add(name, false)
  for (const name of await listRefs(files, sessionId, root, joinPath(refsHome, 'refs', 'remotes'), '', signal, 0)) add(name, true)
  const packed = await files.read(sessionId, joinPath(refsHome, 'packed-refs'), {}, signal)
  if (packed.ok) for (const ref of parsePackedRefs(packed.value.text)) add(ref.name, ref.remote)
  // HEAD outlives a loose ref file that the workspace scope hid: the checked-out
  // branch is always a legitimate start point.
  if (current !== undefined) add(current, false)

  return { available: true, current, branches: [...byName.values()].sort(compareBranches), reason: undefined }
}
