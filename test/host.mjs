/**
 * Host-half integration test: mounts the real plugin entry (`lib/index.js`)
 * against a stubbed cordis context whose only real face is the documented
 * `ctx.subprocess` seam, and drives it over a scratch repository. It pins the
 * host surface this plugin depends on — `ctx.tools.register` with the
 * `defineTool` DSL, `ctx.commands.register`, the `agent/inbox/inserted`
 * injection path and `agent.inject` — so an upstream signature change fails
 * here instead of silently in a profile.
 *
 * Run: node test/host.mjs
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.js'

let failed = 0
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok  ${label}`)
  } else {
    failed += 1
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/**
 * `ctx.subprocess` as the host documents it: `spawn({argv, cwd})` returns a
 * handle with `done` and `collected.<stream>.readFrom(0).text`. This stub runs
 * the real `git` so the plugin's git layer is exercised, not mocked.
 */
function subprocessStub() {
  return {
    spawn({ argv, cwd }) {
      const child = spawn(argv[0], argv.slice(1), { cwd })
      const stdout = []
      const stderr = []
      child.stdout.on('data', (chunk) => stdout.push(chunk))
      child.stderr.on('data', (chunk) => stderr.push(chunk))
      const done = new Promise((resolve) => {
        child.on('close', (code) => resolve({ exitCode: code ?? 1, signal: null }))
        child.on('error', () => resolve({ exitCode: 1, signal: null }))
      })
      return {
        done,
        collected: {
          stdout: { readFrom: () => ({ text: Buffer.concat(stdout).toString('utf8') }) },
          stderr: { readFrom: () => ({ text: Buffer.concat(stderr).toString('utf8') }) },
        },
      }
    },
  }
}

/** Capture everything the plugin registers or listens for. */
function makeCtx() {
  const tools = new Map()
  const commands = new Map()
  const listeners = new Map()
  const ctx = {
    get: (name) => (name === 'subprocess' ? subprocessStub() : undefined),
    on: (event, handler) => {
      const handlers = listeners.get(event) ?? []
      handlers.push(handler)
      listeners.set(event, handlers)
    },
    tools: { register: (definition) => tools.set(definition.name, definition) },
    commands: { register: (definition) => commands.set(definition.name, definition) },
  }
  return { ctx, tools, commands, listeners }
}

/** An agent face good enough for tool/command execution. */
function agentFor(sessionId, cwd) {
  return { id: sessionId, session: { id: sessionId, header: { cwd } } }
}

// realpath: on macOS the temp root is a /var -> /private/var symlink, and git
// reports the resolved form, so the fixture must compare like for like.
const base = await realpath(await mkdtemp(path.join(tmpdir(), 'dsh-tw-host-')))
const repo = path.join(base, 'repo')

try {
  await mkdir(repo, { recursive: true })
  const run = (args) => new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: repo })
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`git ${args[0]} failed`))))
    child.on('error', reject)
  })
  await run(['init', '-b', 'main'])
  await run(['config', 'user.email', 'host@test.local'])
  await run(['config', 'user.name', 'host'])
  await run(['commit', '--allow-empty', '-m', 'init'])

  const { ctx, tools, commands, listeners } = makeCtx()
  apply(ctx, {})

  console.log('registration')
  check('three model tools registered',
    ['worktree_create', 'worktree_list', 'worktree_status'].every((name) => tools.has(name)),
    [...tools.keys()].join(','))
  check('the /worktree command registered', commands.has('worktree'))
  check('the inbox insertion listener registered', (listeners.get('agent/inbox/inserted') ?? []).length === 1)
  check('the agent disposal listener registered', (listeners.get('agent/disposed') ?? []).length === 1)
  check('defineTool produced a schema-bearing definition',
    typeof tools.get('worktree_create')?.output?.schema === 'object'
    && typeof tools.get('worktree_create')?.execute === 'function')

  console.log('tool execution over the subprocess seam')
  const created = await tools.get('worktree_create').execute(
    { name: 'worktree/host-test' },
    { agent: agentFor('s-host', repo), signal: undefined },
  )
  check('worktree_create returns the canonical value',
    created?.name === 'worktree/host-test'
    && created?.path === path.join(repo, '.dsh-worktrees', 'worktree', 'worktree', 'host-test')
    && created?.branch === 'worktree/host-test' && created?.repoRoot === repo,
    JSON.stringify(created))
  const listed = await tools.get('worktree_list').execute({}, { agent: agentFor('s-host', repo) })
  check('worktree_list sees the created checkout',
    listed?.worktrees?.length === 1 && listed.worktrees[0].name === 'worktree/host-test',
    JSON.stringify(listed?.worktrees))
  const status = await tools.get('worktree_status').execute({ name: 'worktree/host-test' }, { agent: agentFor('s-host', repo) })
  check('worktree_status reports the checkout',
    status?.inWorktree === true && status?.worktree?.name === 'worktree/host-test'
    && status.worktree.exists === true, JSON.stringify(status))

  console.log('/worktree command surface')
  const cwdInWorktree = created.path
  const armed = await commands.get('worktree').handler({
    rawInput: 'mode-on worktree/host-test',
    agent: agentFor('s-host', cwdInWorktree),
  })
  check('mode-on arms the session', armed.kind === 'success' && /Worktree/.test(armed.text), JSON.stringify(armed))
  const listedText = await commands.get('worktree').handler({ rawInput: 'list', agent: agentFor('s-host', repo) })
  check('list renders the managed worktree',
    listedText.kind === 'success' && listedText.text.includes('worktree/host-test'))
  const unknown = await commands.get('worktree').handler({ rawInput: 'nonsense', agent: agentFor('s-host', repo) })
  check('an unknown verb returns an error result', unknown.kind === 'error')

  console.log('worktree-mode instruction injection')
  const injected = []
  const agent = { ...agentFor('s-host', repo), inject: (message) => injected.push(message) }
  listeners.get('agent/inbox/inserted')[0]({ agent, message: { source: { kind: 'user' } } })
  check('a genuine user message injects the creation instruction', injected.length === 1
    && JSON.stringify(injected[0]).includes('worktree_create')
    && JSON.stringify(injected[0]).includes('worktree/host-test'),
    JSON.stringify(injected[0] ?? null).slice(0, 200))
  listeners.get('agent/inbox/inserted')[0]({ agent, message: { source: { kind: 'tool' } } })
  check('a producer-supplied message injects nothing', injected.length === 1)
  listeners.get('agent/inbox/inserted')[0]({ agent, message: { source: { kind: 'user' } } })
  check('the arm is single-shot', injected.length === 1)

  const removeText = await commands.get('worktree').handler({ rawInput: 'remove worktree/host-test --force', agent: agentFor('s-host', repo) })
  check('remove reports success', removeText.kind === 'success', JSON.stringify(removeText))
} finally {
  await rm(base, { recursive: true, force: true })
}

console.log('')
if (failed > 0) {
  console.error(`${failed} host check(s) failed`)
  process.exit(1)
}
console.log('host checks passed')
