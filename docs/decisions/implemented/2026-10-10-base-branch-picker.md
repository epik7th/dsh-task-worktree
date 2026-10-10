# DR: composer-level base-branch choice, model-named worktree branches, checkbox mode switch

Status: implemented

## Problem

### 1. The composer asked for a branch *name*, not a start point

The blank-conversation control armed worktree mode with an optional typed name
(`/worktree mode-on <name>`, auto-prefixed `worktree/`). The user-facing need
was the opposite: the branch a task worktree is *created from* is the choice
that matters (usually `main` or `origin/main`), while the new branch name is
mechanical and better left to the model. The typed field also forced the user to
invent a name before they had described the task.

### 2. Mode selection was a two-item dropdown

`[Worktree mode ▾] → [Local mode | Worktree mode]` spent a popover on a boolean
and put mode and name in two different visual languages. The reference
behaviour (Claude Desktop) is a plain `worktree` checkbox next to the branch
that the worktree will start from.

### 3. The browser half has no host channel of its own

Reading branches needs the repository, which only the host can see. The gateway
admits **no plugin-owned Remote namespace**: `ctx.remote.$mount()` registers a
*generated* Host-for-Client contribution, and
`@deepseek-ai/dsh-typert-generator` runs in the monorepo — "SRC markers have no
Client type projection and are not normal Client contribution inputs". A
third-party plugin therefore cannot publish `worktree.branches()` for its own
client half.

## Decision

### 1. Base branch rides `mode-on --base <branch>`

`/worktree mode-on [<name>] [--base <branch>]` arms a session with
`{ name, base }`. The panel sends `--base` only; `<name>` stays supported for
scripts and power users. `mode-on` resolves `--base` through
`manager.resolveBase()` (`git rev-parse --verify <base>^{commit}`) *before*
arming, so an unresolvable base fails the command the user just issued instead
of failing the model's `worktree_create` inside the next turn. The injected
instruction keeps the "name it yourself, `worktree/…`" clause and adds
`请把 baseCommit 设为 "<base>"`, so the model cannot silently pick a different
start point.

### 2. Branches are read as ref files through the shell's own Remote

`src/client/gitRefs.ts` reads `HEAD`, loose `refs/heads/**` / `refs/remotes/**`,
and `packed-refs` through `ctx.get('remote.workspaceFiles')`
(`@deepseek-ai/dsh-api-workspace-files`, mounted by the `dsh-web-app` bundle).
That is a read-only, already-audited client-facing file service, so the plugin
adds no new transport, no permission prompt, and no git dependency in the
browser. Two asymmetries of that face shape the reader and are documented in
the module:

- `list` speaks **workspace paths** and refuses anything outside the Session's
  workspace root, while `read` accepts **absolute** paths (which is why
  `packed-refs` still reaches a checkout session whose `.git` is a file pointing
  into the main repository);
- a linked-worktree session therefore degrades to `packed-refs` + `HEAD`: its
  loose refs live outside its own workspace root and are not invented. The
  checked-out branch is always offered, taken from `HEAD`;
- a session whose cwd is a *subdirectory* of its workspace has its repository
  in an ancestor, so the `.git` lookup walks up — stopping at the workspace root
  when the registry knows it, so an unrelated repository above the workspace is
  never adopted.

The lookup is soft (`ctx.get(...)`, no `inject` entry in the Cordis plugin face)
because a minimal preset may not mount the package: a missing service, a
non-repository directory, and unreadable refs all produce
`{ available: false, reason }`, and the panel keeps working with the host's
`HEAD` default. `dsh.client.inject` names the package for load ordering.

### 3. UI: checkbox + always-visible branch picker

The panel is `[worktree ☑] [⑂ main ▾]` in its own hero row, using the shell's
own `Checkbox` primitive and icons. The picker shows the branch a new worktree
would start from (picked → armed base → repository `HEAD`) and opens a
searchable list of local + remote-tracking branches, current selection marked.
Ticking the box arms the host with the shown branch; a branch change re-arms
(`mode-on` is idempotent); unticking disarms, or — for a session that
physically runs inside a checkout — keeps the previous "open the owning local
workspace" behaviour. There is no name field and no mode dropdown.

Two layout facts this control has to respect, both learned live:

- On the hero the shell renders the workspace and mode chips in the row that
  precedes the panel's container, and `.root` turns pointer events off so the
  row never eats clicks meant for the composer card behind it. The lift onto
  the chip line is measured, not hardcoded: the panel publishes
  `--worktree-hero-inset` (content right edge of that row + gap) and
  `--worktree-hero-lift` (vertical centre delta), recomputed on resize and on a
  mutation of that row, from an unshifted measurement so repeated passes cannot
  drift.
- Every interactive child must opt back into pointer events. The shell's
  `Checkbox` primitive ships **no** `pointer-events` rule (the built bundle
  contains none at all), so `.root { pointer-events: none }` silently made the
  mode switch unclickable until `.toggle` re-enabled it. The client suite now
  asserts the resolved rules for the row, the checkbox, the branch trigger, and
  the branch menu, so that class of regression cannot ship again.

## Alternatives considered

- **Hand-written Typert Remote contribution** (`ctx.typertGateway` +
  `ctx.remote.$mount()`): rejected. The contribution descriptors are generated
  from a monorepo FaceModel; hand-writing them means owning codecs, lookups, and
  wire framing across host releases, and the gateway's own documentation says
  client-supplied fields without strict generated codecs fail to mount.
- **`remote.terminal` + `git branch`**: rejected. It spawns a PTY through the
  shell's terminal controller for a read that the file service already offers,
  and it makes branch listing depend on terminal permissions and output
  parsing.
- **Host-side `/worktree branches` writing a cache file the client reads**:
  rejected as strictly worse than reading the repository through the same file
  service — two round-trips, a stale-cache lifetime, and a write path where a
  read suffices.
- **Keep the name field as an override**: rejected. The name is the model's job
  and the field is what made the control noisy; `/worktree mode-on <name>`
  remains for anyone who wants a fixed branch.
- **A `<select>` for the branch**: rejected. Repositories routinely carry
  dozens of branches (the reference screenshot did), and a native select has no
  search.

## Consequences

- The header badge loses the declared branch name: an armed session with no
  checkout yet shows the generic `worktree` label until the session's cwd
  reveals a checkout path. The name the model chose is in the transcript
  (`worktree_create` returns `name` / `path`), and the badge never claimed to be
  the source of truth.
- The store keys sessions by **base branch** instead of name
  (`WorktreeSessionState { base, worktree }`).
- Branch discovery is best-effort by construction: an empty repository, a
  repository whose loose refs are out of scope, and a host without the
  `workspaceFiles` package all yield a smaller list — never an error and never
  a broken arm.
- `test/client.mjs` now renders the slot component against stub hooks and
  asserts on the intended controls (`primitive:Checkbox` props, picker
  contents, the exact `/worktree …` line each interaction issues) plus the ref
  reader over an in-memory `workspaceFiles` stand-in, so this behaviour is
  verified without a browser.
