# DR: adapt the fork to the dsh 0.2.0 host line (peer retarget, main-view session derivation)

Status: implemented

## Problem

### 1. The upstream release is refused by the 0.2.0 host

Upstream `dsh-task-worktree@0.4.3` declares `^0.1.7-rc.2` peers on
`dsh-llm` / `dsh-session` / `dsh-subprocess` / `dsh-tools`. A dsh `0.2.0-rc.2`
runtime fails that range, and the host's compatibility preflight
(`@deepseek-ai/dsh-app-boot`, `lib/types/compatibility-preflight.js`) denies any
row whose `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peers do not satisfy the
running version: the row is disabled with
`plugin <name> is incompatible with dsh <version>`. The escape hatch is an
exact-version grant in `<profile>/compatibility.json` (`dsh plugin allow-version`
or the plugin manager), which changes no dependency and no code.

### 2. The browser half was already dead on every host from 0.1.6 on

`src/client/index.ts` derived "the current conversation" from
`sessions.list.getSnapshot().current`. dsh **0.1.6** removed `current` from the
session-list state — navigation belongs to the view owners — so
`currentSessionId()`, `currentCwd()` and `currentBlank()` all returned
`undefined`, `currentSession()` never resolved, the input-dock mode selector and
the header badge lost their anchor, and `armWorktreeMode()` rejected with
「当前没有可注入的对话」. Bumping peer ranges alone would have produced a plugin
that loads and then does nothing in the GUI.

## Decision

### 1. Peer ranges on the 0.2.0 line, devDeps on the proven floor

`peerDependencies` for `dsh-llm` / `dsh-session` / `dsh-subprocess` /
`dsh-tools` become `^0.2.0-rc.1`, which covers `0.2.0-rc.1`, `0.2.0-rc.2` and the
`0.2.0` release (same-major/minor prerelease tuples participate, and the host
evaluates with `includePrerelease: true`). `devDependencies` pin the exact
minimum `0.2.0-rc.1` so a green typecheck/build/test proves the floor rather
than the newest resolution. `@deepseek-ai/cordis` stays `~4.0.4`, matching the
host's vendored pairing.

`@deepseek-ai/dsh-client-ui-session@0.2.0-rc.1` joins devDependencies: its
client types declaration-merge `SessionReferenceSourceMap` with `mainView`, and
a `import type {} from '@deepseek-ai/dsh-client-ui-session/client'` pulls that
merge into the client project so the derivation below typechecks. Type-only —
nothing new appears in the shipped bundle.

### 2. Current session = the main-view row

`currentRow()` scans the session list in Host order and returns the row whose
`retainedBy.mainView > 0`; id, cwd and blank all come from that row. This is the
derivation the shell's own `DocumentTitle` / open-in-app / ui-workspace
`mainSessionId` already use, and it is the same one the sibling
`dsh-git-worktree-fresh` fork adopted for host 0.1.6+.

### 3. Verifiable gates instead of assumptions

- `test/client.mjs` runs the built `client/client.js` under the
  `window.__ModuleLoader__` protocol with stubbed react/ctx faces and pins: the
  loader id equals the package name, both slots register, the main-view row (not
  the first row) supplies id/cwd/blank, arm/disarm send the exact command lines,
  and a list with no retained main view refuses to arm. On the pre-fix bundle
  five of these checks fail, so the regression cannot come back silently.
- `test/host.mjs` mounts the real `lib/index.js` on a stubbed cordis context
  whose only real face is the documented `ctx.subprocess` seam, then drives
  `worktree_create` / `worktree_list` / `worktree_status`, the `/worktree`
  command surface and the `agent/inbox/inserted` → `agent.inject` path over a
  scratch repository. The host half had no coverage at all before this; a
  signature change on `defineTool`, `commands.register` or `subprocess.spawn`
  now fails in CI instead of in a profile.
- `test/preflight.mjs` reimplements the host's peer gate over this manifest and
  asserts it passes on `0.2.0-rc.1` / `0.2.0-rc.2` / `0.2.0`, and that the
  pre-migration `^0.1.7-rc.2` range is rejected on `0.2.0-rc.2`.
- `tsdown.config.ts` derives the loader id from `package.json` instead of a
  hardcoded string: the host keys the client row by the resolved manifest
  package name, so a mismatch would leave the entry unimportable.

### 4. Identity kept for a drop-in swap

The package name stays `dsh-task-worktree` (only the version moves to `0.5.0`),
so the `cordis.patch.yml` row id and the profile bundle entry are unchanged and
a user can replace the npm install with the Git address without touching the
profile. The fork is published as a public GitHub repository
(`epik7th/dsh-task-worktree`) rather than npm.

## Alternatives considered

- **Grant an exact-version exemption and change nothing** (`compatibility.json`:
  `"dsh-task-worktree@0.4.3": ["0.2.0-rc.2"]`): unblocks loading without a fork,
  but leaves the browser half dead (Problem 2) and means accepting a formally
  incompatible plugin on every future runtime by hand. Rejected as the end state;
  still the documented fallback for anyone pinned to the npm release.
- **`devDependencies: ^0.2.0-rc.1`** (follow latest): the lockfile resolves
  `rc.2`, so a green tree proves only rc.2 and the declared floor becomes an
  untested assumption. Rejected.
- **Raise the floor to `0.2.0-rc.2`**: needlessly excludes rc.1 hosts once
  rc.1→rc.2 is verified additive. Rejected.
- **Rename the package** (`-fresh`, `-0-2`): removes any ambiguity with the npm
  release, but breaks the drop-in property and forces every existing profile
  entry to be re-pointed. Rejected in favour of an explicit fork notice.
- **Adopt 0.2.0-only client capabilities** (`dsh.client.external`, new slots):
  not needed for compatibility; widening the change surface only adds regression
  risk. The manifest keeps `dsh.client.inject`, which 0.2 still composes.

## API surface verified before committing to "no host-side rewrite"

Byte/symbol diffs between `0.1.7-rc.2` and `0.2.0-rc.2` for every imported
entry: `dsh-tools` and `dsh-subprocess` ship **identical** lib trees (only
`package.json` differs) — the tool DSL, `ctx.tools.register`,
`ctx.subprocess.spawn/done/collected` are untouched; `dsh-agent` is identical
(`agent.inject`, `agent/inbox/inserted`); `dsh-llm` adds one `MessageSourceMap`
variant; `dsh-session` adds one export; `dsh-commands` changes declaration
strings only; `dsh-client-locale` is identical; `dsh-api-session-controller` adds
one optional `onCreated`; `dsh-api-workspace-controller` changes an internal
subprocess call; `dsh-client-ui-primitives` only adds `MenuGroup` and CSS
tweaks. Slots `conversation.input.dock` / `conversation.session.header.actions`,
the icon vocabulary, `sessions.create/list/binding`, `workspaces.create`,
`locale.register/bind`, `session.command(line)` and the `workspaceRegistry`
host service all still exist with unchanged signatures. The client entry is
resolved through `exports["./client"]`, so the bundle path (`client/client.js`)
needed no move.

## Consequences

1. The plugin loads on unexempted `0.2.0-rc.1`/`rc.2`/`0.2.0` hosts, and its GUI
   affordances work again on every host from 0.1.6 on (the derivation is the
   shell's own).
2. Hosts on the `0.1.x` line are no longer supported — a deliberate hard cut,
   matching the sibling fork's practice.
3. A future `0.3.0` host needs a new range bump; `test/preflight.mjs` fails
   loudly at that point instead of the plugin silently disappearing from the
   profile.
4. The client bundle stays committed and CI-checked (`npm run build:client` then
   `git diff --exit-code -- client`), so a stale bundle cannot ship.
