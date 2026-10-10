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
// The host's own durable-row admission (session format v4). It is the gate that
// failed live turns when the plugin stamped the retired `kind: 'plugin'`
// wrapper on its injected instruction.
import { assertV4RowAdmission } from '@deepseek-ai/dsh-session-format-v3-to-v4'
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

/**
 * An agent face good enough for tool/command execution. The runtime agent
 * carries `id` equal to its session id (the registry enforces that equality),
 * `session` — the public face — and `inject`, which is how a plugin rides
 * model-facing context on the next step.
 */
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
  // Deliberately NOT registered: an arm is the user's intent for the SESSION,
  // and the host disposes agents on owner unload every time the session is
  // navigated away from or the page reloads. Clearing on disposal silently
  // cancelled the arm, so the instruction never reached the model.
  check('no agent disposal listener (the arm outlives one agent instance)',
    (listeners.get('agent/disposed') ?? []).length === 0)
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
  // A durable message source must be producer-owned: `kind: 'plugin'` is a
  // retired v3 wrapper, and the host refuses the row — failing the whole turn
  // with "format v4 message requires a producer-owned source kind". Validate
  // with the host's own admission function rather than a copy of its rule.
  const injectedMessage = injected[0]
  let admissionError
  try {
    assertV4RowAdmission({ type: 'user/message', data: injectedMessage })
  } catch (error) {
    admissionError = error.message
  }
  check('the injected message is admissible as a format-v4 row', admissionError === undefined,
    String(admissionError))
  check('the injected source is producer-owned, not the retired plugin wrapper',
    injectedMessage?.source?.kind === 'plugin:dsh-task-worktree',
    String(injectedMessage?.source?.kind))
  let refusedRetired = false
  try {
    assertV4RowAdmission({
      type: 'user/message',
      data: { ...injectedMessage, source: { kind: 'plugin', plugin: 'dsh-task-worktree', form: 'instructions' } },
    })
  } catch {
    refusedRetired = true
  }
  check('the retired wrapper is still refused (the admission check has teeth)', refusedRetired)
  listeners.get('agent/inbox/inserted')[0]({ agent, message: { source: { kind: 'tool' } } })
  check('a producer-supplied message injects nothing', injected.length === 1)
  listeners.get('agent/inbox/inserted')[0]({ agent, message: { source: { kind: 'user' } } })
  check('the arm is single-shot', injected.length === 1)

  console.log('base branch selection (worktree mode start point)')
  // The panel no longer names the branch: the user picks a BASE branch and the
  // model proposes the worktree branch name. The base rides the arm so the
  // injected instruction can pin worktree_create's baseCommit.
  const baseArm = await commands.get('worktree').handler({
    rawInput: 'mode-on --base main',
    agent: agentFor('s-base', repo),
  })
  check('mode-on --base arms the session', baseArm.kind === 'success', JSON.stringify(baseArm))
  check('the arm acknowledgement names the base branch', /main/.test(baseArm.text), String(baseArm.text))
  const baseInjected = []
  const baseAgent = { ...agentFor('s-base', repo), inject: (message) => baseInjected.push(message) }
  listeners.get('agent/inbox/inserted')[0]({ agent: baseAgent, message: { source: { kind: 'user' } } })
  const baseText = JSON.stringify(baseInjected[0] ?? null)
  check('the instruction pins baseCommit to the chosen base branch',
    baseInjected.length === 1 && baseText.includes('baseCommit') && baseText.includes('main'),
    baseText.slice(0, 300))
  check('a base-only arm still lets the model name the branch',
    baseText.includes('worktree/') && !baseText.includes('分支名为'), baseText.slice(0, 300))

  // A base that does not resolve must fail the arm instead of injecting an
  // instruction whose worktree_create would fail mid-turn.
  const badArm = await commands.get('worktree').handler({
    rawInput: 'mode-on --base no-such-branch-here',
    agent: agentFor('s-bad', repo),
  })
  check('an unresolvable base branch fails the command', badArm.kind === 'error', JSON.stringify(badArm))
  const badInjected = []
  listeners.get('agent/inbox/inserted')[0]({
    agent: { ...agentFor('s-bad', repo), inject: (message) => badInjected.push(message) },
    message: { source: { kind: 'user' } },
  })
  check('a refused arm injects nothing', badInjected.length === 0, `${badInjected.length} injection(s)`)

  console.log('the arm outlives the agent it was set on')
  // The observed live failure: arm on the agent serving the session, then the
  // host disposes that agent (owner unload / page reload / client release) and a
  // fresh agent serves the next message. The instruction must still ride it.
  const lifecycleInjected = []
  const firstAgent = { ...agentFor('s-host', repo), inject: (message) => lifecycleInjected.push(message) }
  const lifecycleArmed = await commands.get('worktree').handler({
    rawInput: 'mode-on worktree/lifecycle',
    agent: firstAgent,
  })
  check('mode-on arms the session for the lifecycle case', lifecycleArmed.kind === 'success')
  for (const handler of listeners.get('agent/disposed') ?? []) handler({ agent: firstAgent })
  const secondAgent = { ...agentFor('s-host', repo), inject: (message) => lifecycleInjected.push(message) }
  listeners.get('agent/inbox/inserted')[0]({ agent: secondAgent, message: { source: { kind: 'user' } } })
  check('a replacement agent still carries the creation instruction',
    lifecycleInjected.length === 1
    && JSON.stringify(lifecycleInjected[0]).includes('worktree/lifecycle'),
    `${lifecycleInjected.length} injection(s)`)
  const disarmed = await commands.get('worktree').handler({ rawInput: 'mode-off', agent: secondAgent })
  check('mode-off disarms explicitly', disarmed.kind === 'success')
  listeners.get('agent/inbox/inserted')[0]({ agent: secondAgent, message: { source: { kind: 'user' } } })
  check('a disarmed session injects nothing', lifecycleInjected.length === 1)

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
