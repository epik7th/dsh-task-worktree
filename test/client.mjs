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
// the ui-primitives icon vocabulary; the elements it builds never render here,
// so `createElement` returning { type, props } is enough to read the injected
// callbacks straight off the element props.
const reactStub = {
  createElement: (type, props) => ({ type, props }),
}
const jsxRuntimeStub = {
  jsx: (type, props) => ({ type, props }),
  jsxs: (type, props) => ({ type, props }),
  Fragment: Symbol('Fragment'),
}
const primitivesStub = new Proxy({}, {
  get: (_target, key) => (typeof key === 'string' ? function Icon() {} : undefined),
})

function requireStub(specifier) {
  if (specifier === 'react') return reactStub
  if (specifier === 'react/jsx-runtime') return jsxRuntimeStub
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
  throw new Error(`unexpected module-table request: ${specifier}`)
}

/** Execute the bundle and return its registered factory entry. */
async function loadBundle() {
  const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
  let entry
  const windowStub = {
    __ModuleLoader__: {
      load(registered) { entry = registered },
    },
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
 */
function makeCtx(rows, commands = []) {
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
    workspaces: { create: async () => ({ workspaceId: 'ws-1' }) },
  }
  return { ctx, registered, pending }
}

/** Read one registered slot's injected props by calling its render factory. */
function propsOf(registered, id) {
  const slot = registered.find((candidate) => candidate.meta.id === id)
  if (slot === undefined) throw new Error(`slot ${id} was not registered`)
  return slot.component().props
}

const WORKTREE_CWD = '/repo/.dsh-worktrees/worktree/task-a'

// ── Fixtures ───────────────────────────────────────────────────────────────
const mainViewRows = {
  's-other': { id: 's-other', cwd: '/tmp/other', blank: false, retainedBy: { gateway: 2 } },
  's-main': { id: 's-main', cwd: WORKTREE_CWD, blank: true, retainedBy: { mainView: 1 } },
}
const noMainViewRows = {
  's-other': { id: 's-other', cwd: '/tmp/other', blank: false, retainedBy: { gateway: 2 } },
}

const entry = await loadBundle()
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

console.log('bundle registration')
// The Loader keys the row by the resolved manifest package name; an id
// mismatch leaves the entry unimportable.
check('loader id equals the package name', entry.id === manifest.name,
  `id=${entry.id} name=${manifest.name}`)
check('factory returns the client module face', typeof entry.factory === 'function')

const clientModule = entry.factory(requireStub)
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

  await panel.armWorktreeMode('task-b')
  check('arm sends mode-on with the worktree/ branch prefix',
    commands.length === 1 && commands[0].sessionId === 's-main'
    && commands[0].line === '/worktree mode-on worktree/task-b',
    JSON.stringify(commands))
  check('arm declares the session in the store',
    panel.store.stateOf('s-main').worktree === true
    && panel.store.stateOf('s-main').name === 'worktree/task-b')
  await panel.disarmWorktreeMode()
  check('disarm clears the store',
    panel.store.stateOf('s-main').worktree === false
    && commands.length === 2 && commands[1].line === '/worktree mode-off')
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
    await panel.armWorktreeMode('task-c')
  } catch (error) {
    message = error.message
  }
  check('arm refuses without a current session', message !== undefined && commands.length === 0,
    String(message))
}

console.log('')
if (failed > 0) {
  console.error(`${failed} client check(s) failed`)
  process.exit(1)
}
console.log('client checks passed')
