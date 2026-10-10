/**
 * Browser-half regression test: runs the built __ModuleLoader__ factory bundle
 * in Node against stubbed loader/react/ctx faces (no harness, no DOM, no
 * browser). It pins the contract that broke silently across host releases:
 * the "current session" is the row the main view retains
 * (`retainedBy.mainView`), NOT the `sessions.current` field that dsh 0.1.6
 * dropped from the session-list state.
 *
 * Run: node test/client.mjs   (after npm run build:client)
 */
import { readFile } from 'node:fs/promises'

let failed = 0
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok  ${label}`)
  } else {
    failed += 1
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

// ── Loader / module-table stubs ────────────────────────────────────────────
// The bundle only reaches the module table for react, react/jsx-runtime and
// the ui-primitives vocabulary. There is no DOM: the panel is "rendered" by
// calling its component function with stub hooks and expanding the returned
// element tree, which is enough to read control props and drive handlers.
function createReactStub() {
  let slots = []
  let cursor = 0
  const slotAt = (index, create) => {
    if (slots.length <= index) slots[index] = create()
    return slots[index]
  }
  return {
    /** Drop every hook slot (a fresh component instance). */
    __reset() {
      slots = []
      cursor = 0
    },
    /** Start one render pass: hooks claim their slots in call order. */
    __begin() {
      cursor = 0
    },
    createElement: (type, props, ...children) => ({
      type,
      props: {
        ...(props ?? {}),
        ...(children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }),
      },
    }),
    useState(initial) {
      const index = cursor++
      const slot = slotAt(index, () => ({ value: typeof initial === 'function' ? initial() : initial }))
      return [slot.value, (next) => {
        slot.value = typeof next === 'function' ? next(slot.value) : next
      }]
    },
    useRef(initial) {
      const index = cursor++
      return slotAt(index, () => ({ current: initial }))
    },
    useEffect(effect) {
      cursor += 1
      effect()
    },
    useLayoutEffect(effect) {
      cursor += 1
      effect()
    },
    useMemo(factory) {
      cursor += 1
      return factory()
    },
    useCallback(callback) {
      cursor += 1
      return callback
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      cursor += 1
      return getSnapshot()
    },
  }
}
const reactStub = createReactStub()
const jsxRuntimeStub = {
  jsx: (type, props) => ({ type, props: props ?? {} }),
  jsxs: (type, props) => ({ type, props: props ?? {} }),
  Fragment: Symbol('Fragment'),
}
// Every primitive export (icons, Checkbox, …) renders as a marker element, so
// a test asserts on what the panel asked the shell for. Memoized per name so
// element `type` identity is stable.
const primitiveStubCache = new Map()
const primitivesStub = new Proxy({}, {
  get: (_target, key) => {
    if (typeof key !== 'string') return undefined
    let component = primitiveStubCache.get(key)
    if (component === undefined) {
      component = (props) => ({ type: `primitive:${key}`, props: props ?? {} })
      primitiveStubCache.set(key, component)
    }
    return component
  },
})

function requireStub(specifier) {
  if (specifier === 'react') return reactStub
  if (specifier === 'react/jsx-runtime') return jsxRuntimeStub
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
  throw new Error(`unexpected module-table request: ${specifier}`)
}

/** Expand an element tree, calling function components in hook order. */
function expandElement(node) {
  if (Array.isArray(node)) return node.map(expandElement)
  if (node === null || node === undefined || typeof node !== 'object') return node
  const { type, props } = node
  if (typeof type === 'function') return expandElement(type(props ?? {}))
  // jsx-runtime fragments carry a symbol type; only their children matter here.
  if (typeof type !== 'string') return expandElement(props?.children)
  return { type, props: { ...props, children: props?.children === undefined ? undefined : expandElement(props.children) } }
}

/** Depth-first search for the first element matching `predicate`. */
function findElement(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findElement(child, predicate)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (predicate(node)) return node
  return findElement(node.props?.children, predicate)
}

/** Collect every element matching `predicate` in document order. */
function collectElements(node, predicate, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, predicate, found)
    return found
  }
  if (predicate(node)) found.push(node)
  collectElements(node.props?.children, predicate, found)
  return found
}

/** Execute the bundle and return its registered factory entry. */
async function loadBundle() {
  const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
  let entry
  const windowStub = {
    __ModuleLoader__: {
      load(registered) { entry = registered },
    },
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle),
    addEventListener() {},
    removeEventListener() {},
  }
  // eslint-disable-next-line no-new-func
  new Function('window', source)(windowStub)
  if (entry === undefined) throw new Error('client/client.js registered no loader entry')
  return entry
}

// ── Client ctx stubs ───────────────────────────────────────────────────────
/**
 * Build a ctx whose session list is `rows`, and capture the registered slots.
 * @param rows - list rows keyed by id (each with cwd/blank/retainedBy).
 * @param commands - receives every `session.command(line)` call.
 * @param options - `{ files?, workspaces? }`: the stubbed
 *   `remote.workspaceFiles` face and the workspace registry snapshot (the
 *   session-to-workspace-root mapping the branch reader resolves against).
 */
function makeCtx(rows, commands = [], options = {}) {
  const registered = []
  const pending = []
  const bindings = new Map()
  for (const id of Object.keys(rows)) {
    bindings.set(id, {
      sessionId: id,
      session: {
        sessionId: id,
        command: async (line) => {
          commands.push({ sessionId: id, line })
          return { ok: true, value: { matched: true } }
        },
      },
    })
  }
  const ctx = {
    effect: (callback) => {
      callback()
      return () => {}
    },
    get: (key) => (key === 'remote.workspaceFiles' ? options.files : undefined),
    locale: { register: () => ({}), bind: () => (key) => key },
    slots: {
      inject: (_slot, register) => pending.push(register),
      register: (meta, component) => {
        registered.push({ meta, component })
        return {}
      },
    },
    sessions: {
      list: {
        getSnapshot: () => ({
          ids: Object.keys(rows),
          byId: rows,
          phase: 'ready',
          projectionsBySession: {},
        }),
      },
      binding: (id) => bindings.get(id),
      create: async () => ({}),
    },
    workspaces: {
      list: { getSnapshot: () => ({ items: options.workspaces ?? [] }) },
      create: async () => ({ workspaceId: 'ws-1' }),
    },
  }
  return { ctx, registered, pending }
}

/** Read one registered slot's injected props by calling its render factory. */
function propsOf(registered, id) {
  const slot = registered.find((candidate) => candidate.meta.id === id)
  if (slot === undefined) throw new Error(`slot ${id} was not registered`)
  return slot.component().props
}

/** Render one registered slot's component (stub hooks) into an element tree. */
function renderSlot(registered, id) {
  const slot = registered.find((candidate) => candidate.meta.id === id)
  if (slot === undefined) throw new Error(`slot ${id} was not registered`)
  reactStub.__begin()
  return expandElement(slot.component())
}

/**
 * An in-memory stand-in for the shell's `remote.workspaceFiles` face: the same
 * two calls the branch reader makes, with the same workspace-relative `list`
 * scope, absolute-or-relative `read`, and the documented error codes.
 * @param root - the Session workspace root `list` resolves against.
 * @param tree - absolute path → `{ kind: 'dir' }` or `{ kind: 'file', text }`.
 */
function fakeWorkspaceFiles(root, tree) {
  const normalize = (value) => {
    const parts = []
    for (const segment of value.split('/')) {
      if (segment === '' || segment === '.') continue
      if (segment === '..') parts.pop()
      else parts.push(segment)
    }
    return `/${parts.join('/')}`
  }
  const dirOf = (value) => normalize(value).replace(/\/[^/]*$/u, '') || '/'
  return {
    async list(_sessionId, path) {
      const abs = normalize(path.startsWith('/') ? path : `${root}/${path}`)
      if (abs !== root && !abs.startsWith(`${root}/`)) {
        return { ok: false, error: { code: 'workspace-file/outside-workspace', message: `outside ${root}` } }
      }
      const node = tree.get(abs)
      if (node === undefined) return { ok: false, error: { code: 'workspace-file/not-found', message: abs } }
      if (node.kind !== 'dir') return { ok: false, error: { code: 'workspace-file/not-directory', message: abs } }
      const entries = []
      for (const [candidate, child] of tree) {
        if (dirOf(candidate) !== abs) continue
        entries.push({ name: candidate.slice(abs === '/' ? 1 : abs.length + 1), type: child.kind === 'dir' ? 'directory' : 'file' })
      }
      entries.sort((left, right) => left.name.localeCompare(right.name))
      return { ok: true, value: { path: abs === root ? '' : abs.slice(root.length + 1), entries, truncated: false } }
    },
    async read(_sessionId, path) {
      const abs = normalize(path.startsWith('/') ? path : `${root}/${path}`)
      const node = tree.get(abs)
      if (node === undefined) return { ok: false, error: { code: 'workspace-file/not-found', message: abs } }
      if (node.kind !== 'file') return { ok: false, error: { code: 'workspace-file/not-regular-file', message: abs } }
      const lines = node.text.split('\n')
      return {
        ok: true,
        value: { absolutePath: abs, version: 'v1', offset: 1, text: node.text, lines: lines.length, eof: true },
      }
    },
  }
}

/** Same members, ignoring order. */
function sameSet(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length
    && expected.every((value) => actual.includes(value))
}

const WORKTREE_CWD = '/repo/.dsh-worktrees/worktree/task-a'

/** All text content of an element subtree. */
function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node === null || node === undefined || typeof node !== 'object') return ''
  return textOf(node.props?.children)
}

/** Flat element/testid outline, for failure details. */
function outline(node, depth = 0, lines = []) {
  if (depth > 5) return lines
  if (typeof node === 'string') {
    lines.push(JSON.stringify(node))
    return lines
  }
  if (Array.isArray(node)) {
    for (const child of node) outline(child, depth, lines)
    return lines
  }
  if (node === null || node === undefined || typeof node !== 'object') return lines
  const testid = node.props?.['data-testid']
  lines.push(`${String(node.type)}${typeof testid === 'string' ? `[${testid}]` : ''}`)
  outline(node.props?.children, depth + 1, lines)
  return lines
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Read a panel slot's branch listing, tolerating a bundle without the reader. */
async function branchesOf(registered) {
  const panel = propsOf(registered, 'worktree')
  if (typeof panel.listBranches !== 'function') return { available: false, reason: 'missing', current: undefined, branches: [] }
  return panel.listBranches()
}

// ── Fixtures ───────────────────────────────────────────────────────────────
const mainViewRows = {
  's-other': { id: 's-other', cwd: '/tmp/other', blank: false, retainedBy: { gateway: 2 } },
  's-main': { id: 's-main', cwd: WORKTREE_CWD, blank: true, retainedBy: { mainView: 1 } },
}
const noMainViewRows = {
  's-other': { id: 's-other', cwd: '/tmp/other', blank: false, retainedBy: { gateway: 2 } },
}

/** The session workspace root the branch reader resolves relative paths against. */
const REPO_ROOT = '/repo'
const repoRows = {
  's-repo': { id: 's-repo', cwd: REPO_ROOT, blank: true, retainedBy: { mainView: 1 } },
}
const repoWorkspaces = [{ workspaceId: 'ws-1', path: REPO_ROOT, sessionIds: ['s-repo'] }]

/** Build the in-memory file tree from absolute paths, creating parent directories. */
function fileTree(entries) {
  const tree = new Map()
  for (const [path, text] of Object.entries(entries)) {
    const segments = path.split('/').filter(Boolean)
    let current = ''
    for (const segment of segments.slice(0, -1)) {
      current += `/${segment}`
      tree.set(current, { kind: 'dir' })
    }
    tree.set(path, { kind: 'file', text })
  }
  return tree
}

const LOOSE_HEAD = 'a'.repeat(40)
const LOOSE_NESTED = 'b'.repeat(40)
const LOOSE_REMOTE = 'c'.repeat(40)
const mainRepoFiles = fakeWorkspaceFiles(REPO_ROOT, fileTree({
  '/repo/.git/HEAD': 'ref: refs/heads/main\n',
  '/repo/.git/refs/heads/main': `${LOOSE_HEAD}\n`,
  '/repo/.git/refs/heads/feature/x': `${LOOSE_NESTED}\n`,
  '/repo/.git/refs/remotes/origin/main': `${LOOSE_REMOTE}\n`,
  '/repo/.git/refs/remotes/origin/HEAD': 'ref: refs/remotes/origin/main\n',
  '/repo/.git/packed-refs': [
    '# pack-refs with: peeled fully-peeled sorted ',
    `${'d'.repeat(40)} refs/heads/claude/a`,
    `${'e'.repeat(40)} refs/remotes/origin/release`,
    `${'f'.repeat(40)} refs/tags/v1`,
    '',
  ].join('\n'),
}))

/** A session inside a managed checkout: `.git` is a file pointing at the repo. */
const WORKTREE_ROOT = `${REPO_ROOT}/.dsh-worktrees/worktree/task-a`
const linkedWorktreeRows = {
  's-linked': { id: 's-linked', cwd: WORKTREE_ROOT, blank: true, retainedBy: { mainView: 1 } },
}
const linkedWorktreeFiles = fakeWorkspaceFiles(WORKTREE_ROOT, fileTree({
  [`${WORKTREE_ROOT}/.git`]: `gitdir: ${REPO_ROOT}/.git/worktrees/task-a\n`,
  '/repo/.git/worktrees/task-a/HEAD': 'ref: refs/heads/worktree/task-a\n',
  '/repo/.git/worktrees/task-a/commondir': '../..\n',
  '/repo/.git/packed-refs': `${'d'.repeat(40)} refs/heads/claude/a\n`,
  // Loose refs of the main repository sit outside the checkout's workspace
  // root, so `list` refuses them: the reader degrades to packed refs + HEAD.
  '/repo/.git/refs/heads/main': `${LOOSE_HEAD}\n`,
}))

const entry = await loadBundle()
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

console.log('bundle registration')
// The Loader keys the row by the resolved manifest package name; an id
// mismatch leaves the entry unimportable.
check('loader id equals the package name', entry.id === manifest.name,
  `id=${entry.id} name=${manifest.name}`)
check('factory returns the client module face', typeof entry.factory === 'function')

const clientModule = entry.factory(requireStub)
// Defined only after materialization: the CSS region inside the factory injects
// a <style> tag when `document` exists, and this stand-in serves the panel's
// outside-pointer listener instead of a DOM.
globalThis.document = { addEventListener() {}, removeEventListener() {} }
check('exports apply/inject/name', typeof clientModule.apply === 'function'
  && Array.isArray(clientModule.inject) && typeof clientModule.name === 'string')

console.log('main-view current-session derivation')
{
  const commands = []
  const { ctx, registered, pending } = makeCtx(mainViewRows, commands)
  clientModule.apply(ctx)
  for (const register of pending) register()
  check('both slots registered', registered.length === 2
    && registered.some((slot) => slot.meta.id === 'worktree')
    && registered.some((slot) => slot.meta.id === 'worktree-badge'))

  const panel = propsOf(registered, 'worktree')
  check('sessionIdOf resolves the main-view row (not the first row)',
    panel.sessionIdOf() === 's-main', `got ${String(panel.sessionIdOf())}`)
  check('currentCwd resolves the main-view row', panel.currentCwd() === WORKTREE_CWD)
  check('currentBlank resolves the main-view row', panel.currentBlank() === true)
  check('currentSession resolves through the binding',
    panel.currentSession()?.sessionId === 's-main')

  const badge = propsOf(registered, 'worktree-badge')
  check('badge shares the same derivation', badge.sessionIdOf() === 's-main'
    && badge.currentCwd() === WORKTREE_CWD)

  await panel.armWorktreeMode('main')
  check('arm sends mode-on with the picked base branch',
    commands.length === 1 && commands[0].sessionId === 's-main'
    && commands[0].line === '/worktree mode-on --base main',
    JSON.stringify(commands))
  await panel.armWorktreeMode(undefined)
  check('arm without a base branch sends a bare mode-on',
    commands.length === 2 && commands[1].line === '/worktree mode-on', JSON.stringify(commands))
  await panel.armWorktreeMode('main')
  check('arm declares the session in the store',
    panel.store.stateOf('s-main').worktree === true
    && panel.store.stateOf('s-main').base === 'main',
    JSON.stringify(panel.store.stateOf('s-main')))
  await panel.disarmWorktreeMode()
  check('disarm clears the store',
    panel.store.stateOf('s-main').worktree === false
    && commands.length === 4 && commands[3].line === '/worktree mode-off')
}

console.log('no main-view row')
{
  const commands = []
  const { ctx, registered, pending } = makeCtx(noMainViewRows, commands)
  clientModule.apply(ctx)
  for (const register of pending) register()
  const panel = propsOf(registered, 'worktree')
  check('sessionIdOf is undefined without a retained main view', panel.sessionIdOf() === undefined)
  check('currentCwd is undefined without a retained main view', panel.currentCwd() === undefined)
  check('currentBlank is false without a retained main view', panel.currentBlank() === false)
  let message
  try {
    await panel.armWorktreeMode('main')
  } catch (error) {
    message = error.message
  }
  check('arm refuses without a current session', message !== undefined && commands.length === 0,
    String(message))
}

console.log('base-branch listing (workspaceFiles Remote)')
{
  const { ctx, registered, pending } = makeCtx(repoRows, [], { files: mainRepoFiles, workspaces: repoWorkspaces })
  clientModule.apply(ctx)
  for (const register of pending) register()
  const panel = propsOf(registered, 'worktree')
  const listing = typeof panel.listBranches === 'function' ? await panel.listBranches() : undefined
  check('the panel exposes a branch reader', listing !== undefined)
  check('a repository with refs yields an available listing',
    listing?.available === true, JSON.stringify(listing))
  check('HEAD resolves the current branch',
    listing?.current === 'main', String(listing?.current))
  const names = (listing?.branches ?? []).map((branch) => branch.name)
  check('the current branch heads the list',
    names[0] === 'main' && listing?.branches?.[0]?.current === true, JSON.stringify(names))
  check('loose local refs, nested branch names included',
    sameSet(names.filter((name) => !name.startsWith('origin/')), ['main', 'claude/a', 'feature/x']),
    JSON.stringify(names))
  check('remote-tracking refs are offered, origin/HEAD is not',
    sameSet(names.filter((name) => name.startsWith('origin/')), ['origin/main', 'origin/release']),
    JSON.stringify(names))
  check('tags stay out of the branch list', !names.includes('v1'), JSON.stringify(names))
  check('remote entries are flagged',
    listing?.branches?.find((branch) => branch.name === 'origin/main')?.remote === true)
}

console.log('base-branch listing walks up to the repository root')
{
  // A session may target a subdirectory of its workspace; git then lives in an
  // ancestor, and only `read` can discover that (there is no stat-only probe).
  const rows = { 's-sub': { id: 's-sub', cwd: `${REPO_ROOT}/packages/app`, blank: true, retainedBy: { mainView: 1 } } }
  const { ctx, registered, pending } = makeCtx(rows, [], {
    files: mainRepoFiles,
    workspaces: [{ workspaceId: 'ws-3', path: REPO_ROOT, sessionIds: ['s-sub'] }],
  })
  clientModule.apply(ctx)
  for (const register of pending) register()
  const listing = await branchesOf(registered)
  check('a subdirectory session still finds the repository above it',
    listing.available === true && listing.current === 'main', JSON.stringify(listing))
  check('its branches come from the repository root',
    sameSet(listing.branches.map((branch) => branch.name), ['main', 'claude/a', 'feature/x', 'origin/main', 'origin/release']),
    JSON.stringify(listing.branches?.map((branch) => branch.name)))
}

console.log('base-branch listing degrades instead of failing')
{
  const noService = makeCtx(repoRows, [], { workspaces: repoWorkspaces })
  clientModule.apply(noService.ctx)
  for (const register of noService.pending) register()
  const listing = await branchesOf(noService.registered)
  check('a missing file service reports itself unavailable',
    listing.available === false && listing.reason === 'unavailable' && listing.branches.length === 0,
    JSON.stringify(listing))

  const noRepo = makeCtx(repoRows, [], {
    files: fakeWorkspaceFiles(REPO_ROOT, fileTree({ '/repo/README.md': '# repo\n' })),
    workspaces: repoWorkspaces,
  })
  clientModule.apply(noRepo.ctx)
  for (const register of noRepo.pending) register()
  const bare = await branchesOf(noRepo.registered)
  check('a directory that is not a repository reports no branch',
    bare.available === false && bare.reason === 'not-a-repo' && bare.branches.length === 0,
    JSON.stringify(bare))

  const linked = makeCtx(linkedWorktreeRows, [], {
    files: linkedWorktreeFiles,
    workspaces: [{ workspaceId: 'ws-2', path: WORKTREE_ROOT, sessionIds: ['s-linked'] }],
  })
  clientModule.apply(linked.ctx)
  for (const register of linked.pending) register()
  const inside = await branchesOf(linked.registered)
  check('a checkout session resolves its own branch through gitdir/commondir',
    inside.available === true && inside.current === 'worktree/task-a'
    && inside.branches.some((branch) => branch.name === 'worktree/task-a' && branch.current === true),
    JSON.stringify(inside))
  check('packed refs of the shared repository still reach the checkout session',
    inside.branches.some((branch) => branch.name === 'claude/a'), JSON.stringify(inside.branches))
  check('loose refs outside the workspace root are not invented',
    !inside.branches.some((branch) => branch.name === 'main'), JSON.stringify(inside.branches))
}

console.log('worktree checkbox and base-branch picker')
{
  reactStub.__reset()
  const commands = []
  const { ctx, registered, pending } = makeCtx(repoRows, commands, { files: mainRepoFiles, workspaces: repoWorkspaces })
  clientModule.apply(ctx)
  for (const register of pending) register()

  let tree = renderSlot(registered, 'worktree')
  const checkbox = findElement(tree, (node) => node.type === 'primitive:Checkbox')
  check('worktree mode is a checkbox, not a select', checkbox !== undefined, outline(tree).join(' > '))
  check('the checkbox starts unchecked outside worktree mode', checkbox?.props.checked === false)
  check('the checkbox carries the worktree label', checkbox?.props.label === 'worktreeLabel',
    String(checkbox?.props.label))
  check('no branch-name input is rendered any more',
    findElement(tree, (node) => node.type === 'input' && node.props?.placeholder === 'heroStartPlaceholder') === undefined,
    outline(tree).join(' > '))

  // The picker reads the repository's branches on mount; the stub effect is
  // synchronous but the Remote call is not, so let the load settle.
  await tick()
  tree = renderSlot(registered, 'worktree')
  const trigger = findElement(tree, (node) => node.props?.['data-testid'] === 'worktree-branch-trigger')
  check('the base-branch picker is always visible', trigger !== undefined, outline(tree).join(' > '))
  check('the picker shows the current branch by default', textOf(trigger) === 'main', textOf(trigger))
  check('the picker is closed until it is opened',
    findElement(tree, (node) => node.props?.['data-testid'] === 'worktree-branch-menu') === undefined)

  // React hands the newest handler to the control on every render; the stand-in
  // renderer must be re-run the same way before each interaction.
  const checkboxNow = () => findElement(renderSlot(registered, 'worktree'), (node) => node.type === 'primitive:Checkbox')
  checkboxNow()?.props.onChange(true)
  await tick()
  check('checking the box arms worktree mode with the picked base',
    commands.length === 1 && commands[0].line === '/worktree mode-on --base main', JSON.stringify(commands))
  tree = renderSlot(registered, 'worktree')
  check('the armed session shows a checked box',
    findElement(tree, (node) => node.type === 'primitive:Checkbox')?.props.checked === true)

  checkboxNow()?.props.onChange(false)
  await tick()
  check('unchecking the box disarms worktree mode',
    commands.length === 2 && commands[1].line === '/worktree mode-off', JSON.stringify(commands))

  checkboxNow()?.props.onChange(true)
  await tick()
  tree = renderSlot(registered, 'worktree')
  findElement(tree, (node) => node.props?.['data-testid'] === 'worktree-branch-trigger')?.props.onClick()
  tree = renderSlot(registered, 'worktree')
  const menu = findElement(tree, (node) => node.props?.['data-testid'] === 'worktree-branch-menu')
  check('opening the picker renders its menu', menu !== undefined, outline(tree).join(' > '))
  const options = collectElements(tree, (node) => typeof node.props?.['data-testid'] === 'string'
    && node.props['data-testid'].startsWith('worktree-branch-option-'))
  check('the menu lists every discovered branch',
    sameSet(options.map((option) => textOf(option)), ['main', 'claude/a', 'feature/x', 'origin/main', 'origin/release']),
    JSON.stringify(options.map((option) => textOf(option))))

  const search = findElement(tree, (node) => node.props?.['data-testid'] === 'worktree-branch-search')
  check('the menu offers a branch search field', search !== undefined, outline(tree).join(' > '))
  search?.props.onChange({ target: { value: 'origin/' } })
  tree = renderSlot(registered, 'worktree')
  const filtered = collectElements(tree, (node) => typeof node.props?.['data-testid'] === 'string'
    && node.props['data-testid'].startsWith('worktree-branch-option-'))
  check('the search filters the branch list',
    sameSet(filtered.map((option) => textOf(option)), ['origin/main', 'origin/release']),
    JSON.stringify(filtered.map((option) => textOf(option))))

  const before = commands.length
  findElement(tree, (node) => node.props?.['data-testid'] === 'worktree-branch-option-origin/release')?.props.onClick()
  await tick()
  check('picking a base branch re-arms worktree mode with it',
    commands.length === before + 1 && commands[commands.length - 1].line === '/worktree mode-on --base origin/release',
    JSON.stringify(commands.slice(before)))
  tree = renderSlot(registered, 'worktree')
  check('the picker shows the newly picked base',
    textOf(findElement(tree, (node) => node.props?.['data-testid'] === 'worktree-branch-trigger')) === 'origin/release',
    textOf(findElement(tree, (node) => node.props?.['data-testid'] === 'worktree-branch-trigger')))
}

console.log('')
if (failed > 0) {
  console.error(`${failed} client check(s) failed`)
  process.exit(1)
}
console.log('client checks passed')
