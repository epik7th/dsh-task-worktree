window.__ModuleLoader__.load({ id: "dsh-task-worktree", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
let react = require("react");
let __deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
let react_jsx_runtime = require("react/jsx-runtime");

//#region src/client/gitRefs.ts
/** `ref: refs/heads/main` → `main`; a detached `HEAD` names no branch. */
function parseHead(text) {
	return /^ref:\s*refs\/heads\/(.+)$/mu.exec(text.trim())?.[1]?.trim() ?? void 0;
}
/** `gitdir: /repo/.git/worktrees/x` → the path exactly as written. */
function parseGitDirFile(text) {
	return /^gitdir:\s*(.+)$/mu.exec(text.trim())?.[1]?.trim() ?? void 0;
}
/** Branch refs declared by a `packed-refs` file; tags and peeled rows are not branches. */
function parsePackedRefs(text) {
	const found = [];
	for (const line of text.split("\n")) {
		const match = /^[0-9a-f]{40,64}\s+(refs\/(?:heads|remotes)\/.+)$/u.exec(line.trim());
		if (match === null) continue;
		const ref = match[1];
		if (ref.startsWith("refs/heads/")) found.push({
			name: ref.slice(11),
			remote: false
		});
		else found.push({
			name: ref.slice(13),
			remote: true
		});
	}
	return found;
}
/** Normalize a `/`-separated path, resolving `.` and `..` segments. */
function normalizePath(value) {
	const absolute = value.startsWith("/");
	const segments = [];
	for (const segment of value.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			segments.pop();
			continue;
		}
		segments.push(segment);
	}
	const joined = segments.join("/");
	if (absolute) return `/${joined}`;
	return joined === "" ? "." : joined;
}
/** Join segments with `/`. */
function joinPath(...parts) {
	return normalizePath(parts.filter((part) => part !== "").join("/"));
}
/** `target` expressed relative to `root`, or undefined when it lies outside. */
function relativeTo(root, target) {
	const base = normalizePath(root);
	const full = normalizePath(target);
	if (full === base) return "";
	return full.startsWith(`${base}/`) ? full.slice(base.length + 1) : void 0;
}
/** Current branch first, then locals, then remotes; alphabetical inside each group. */
function compareBranches(left, right) {
	if (left.current !== right.current) return left.current ? -1 : 1;
	if (left.remote !== right.remote) return left.remote ? 1 : -1;
	return left.name.localeCompare(right.name);
}
/**
* Branch names under one refs directory, recursing into name namespaces
* (`refs/heads/claude/x`). A directory the Remote refuses contributes nothing:
* loose refs outside the workspace root are simply not discovered.
*/
async function listRefs(files, sessionId, root, directory, prefix, signal, depth) {
	if (depth > 4 || root === void 0) return [];
	const scope = relativeTo(root, directory);
	if (scope === void 0 || scope === "") return [];
	const listing = await files.list(sessionId, scope, signal);
	if (!listing.ok) return [];
	const names = [];
	for (const entry of listing.value.entries) {
		if (entry.type === "directory") {
			names.push(...await listRefs(files, sessionId, root, joinPath(directory, entry.name), `${prefix}${entry.name}/`, signal, depth + 1));
			continue;
		}
		names.push(`${prefix}${entry.name}`);
	}
	return names;
}
/**
* Locate the git directory for a working directory. A session may target a
* subdirectory of its workspace, so the search walks up — stopping at the
* workspace root when it is known, so an unrelated repository above the
* workspace is never adopted.
*/
async function locateGitDir(files, sessionId, cwd, root, signal) {
	const stop = root === void 0 || root === "" ? void 0 : normalizePath(root);
	let directory = normalizePath(cwd);
	for (let depth = 0; depth < 8; depth += 1) {
		const dotGit = joinPath(directory, ".git");
		const direct = await files.read(sessionId, joinPath(dotGit, "HEAD"), {}, signal);
		if (direct.ok) return {
			gitDir: dotGit,
			head: direct.value.text
		};
		const pointer = await files.read(sessionId, dotGit, {}, signal);
		if (pointer.ok) {
			const linked = parseGitDirFile(pointer.value.text);
			if (linked !== void 0) {
				const gitDir = normalizePath(linked.startsWith("/") ? linked : joinPath(directory, linked));
				const linkedHead = await files.read(sessionId, joinPath(gitDir, "HEAD"), {}, signal);
				return {
					gitDir,
					head: linkedHead.ok ? linkedHead.value.text : void 0
				};
			}
		}
		if (directory === stop) break;
		const parent = normalizePath(`${directory}/..`);
		if (parent === directory) break;
		directory = parent;
	}
}
/**
* Read the session repository's branches. Never rejects: a missing file
* service, a directory that is not a repository, and unreadable ref files all
* come back as an unavailable listing so the composer can keep working with
* the host's `HEAD` default.
* @param input - session identity, workspace scope, cwd, and the file face.
* @returns the listing the base-branch picker renders.
*/
async function readBranches(input) {
	const { sessionId, root, cwd, files, signal } = input;
	const unavailable = (reason) => ({
		available: false,
		current: void 0,
		branches: [],
		reason
	});
	if (files === void 0) return unavailable("unavailable");
	if (typeof cwd !== "string" || cwd === "") return unavailable("not-a-repo");
	const located = await locateGitDir(files, sessionId, cwd, root, signal);
	if (located === void 0) return unavailable("not-a-repo");
	const { gitDir, head } = located;
	let refsHome = gitDir;
	const common = await files.read(sessionId, joinPath(gitDir, "commondir"), {}, signal);
	if (common.ok) {
		const value = common.value.text.trim();
		if (value !== "") refsHome = normalizePath(value.startsWith("/") ? value : joinPath(gitDir, value));
	}
	const current = head === void 0 ? void 0 : parseHead(head);
	const byName = /* @__PURE__ */ new Map();
	const add = (name$1, remote) => {
		if (name$1 === "") return;
		if (remote && name$1.endsWith("/HEAD")) return;
		if (!byName.has(name$1)) byName.set(name$1, {
			name: name$1,
			remote,
			current: name$1 === current
		});
	};
	for (const name$1 of await listRefs(files, sessionId, root, joinPath(refsHome, "refs", "heads"), "", signal, 0)) add(name$1, false);
	for (const name$1 of await listRefs(files, sessionId, root, joinPath(refsHome, "refs", "remotes"), "", signal, 0)) add(name$1, true);
	const packed = await files.read(sessionId, joinPath(refsHome, "packed-refs"), {}, signal);
	if (packed.ok) for (const ref of parsePackedRefs(packed.value.text)) add(ref.name, ref.remote);
	if (current !== void 0) add(current, false);
	return {
		available: true,
		current,
		branches: [...byName.values()].sort(compareBranches),
		reason: void 0
	};
}

//#endregion
//#region src/client/locales.ts
/**
* Locale dictionaries for the dsh-task-worktree client half.
* Product copy is Chinese; the English side exists for parity.
*/
const zh = {
	panelTitle: "工作树",
	worktreeLabel: "worktree",
	worktreeMode: "Worktree模式",
	baseBranchLabel: "起点分支",
	baseFallback: "HEAD",
	branchSearch: "搜索分支…",
	branchEmpty: "没有匹配的分支",
	branchUnavailable: "无法读取分支列表",
	switching: "正在切换…",
	fail: "命令未执行成功",
	badgeTooltip: "本对话使用的 worktree",
	badgeFallback: "worktree"
};
const en = {
	panelTitle: "Worktrees",
	worktreeLabel: "worktree",
	worktreeMode: "Worktree mode",
	baseBranchLabel: "Base branch",
	baseFallback: "HEAD",
	branchSearch: "Search branches…",
	branchEmpty: "No matching branch",
	branchUnavailable: "Branch list unavailable",
	switching: "Switching…",
	fail: "Command failed",
	badgeTooltip: "Worktree used by this conversation",
	badgeFallback: "worktree"
};

//#endregion
//#region src/client/worktreeLedger.ts
/**
* Client-side worktree recognition helpers.
*
* The plugin no longer registers a workspace per worktree (that cluttered the
* sidebar); each conversation is *labelled* instead. The label comes from the
* worktree declaration store (armed via start-in-worktree-mode) or from the
* session cwd when it runs inside a managed checkout.
*
* dsh 0.1.2 note: the transcript-scanning helper (`worktreeNameOfSnapshot`)
* was removed — `@deepseek-ai/dsh-client-runtime` and its ConversationNode
* model no longer exist; the badge derives the label from the store plus cwd.
*/
/** Registry path marker: <root>/.dsh-worktrees/worktree/<name...>. */
const WORKTREE_PATH$1 = /[\\/]\.dsh-worktrees[\\/]worktree[\\/](.+)$/u;
/**
* Derive the worktree name from a session cwd running inside a managed
* checkout, or undefined for a local session.
*/
function worktreeNameOfCwd(cwd) {
	if (typeof cwd !== "string" || cwd === "") return void 0;
	const match = WORKTREE_PATH$1.exec(cwd);
	return match === null ? void 0 : match[1].replace(/[\\/]+$/u, "");
}

//#endregion
//#region \0dsh-css:src/client/WorktreePanel.module.css.mjs
const css = ".Y0CJ8q_root{z-index:8;box-sizing:border-box;width:min(var(--dsh-composer-card-max-width,780px), calc(100% - 32px));min-height:28px;color:var(--dsw-alias-label-primary,#1f1f1f);pointer-events:none;align-self:center;align-items:center;gap:8px;padding-left:8px;font-size:13px;display:flex;position:relative}.Y0CJ8q_branchTrigger{max-width:260px;min-height:28px;color:inherit;font:inherit;white-space:nowrap;cursor:pointer;border:1px solid var(--dsw-alias-border-l2,#0000001f);pointer-events:auto;background:0 0;border-radius:7px;align-items:center;gap:5px;padding:3px 8px;font-weight:500;line-height:18px;display:inline-flex}.Y0CJ8q_branchTrigger:hover,.Y0CJ8q_branchTrigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover,#0000000e)}.Y0CJ8q_branchTrigger:disabled{cursor:default;opacity:.5}.Y0CJ8q_branchName{text-overflow:ellipsis;overflow:hidden}.Y0CJ8q_toggle{pointer-events:auto;min-height:28px}.Y0CJ8q_icon{color:var(--dsw-alias-label-secondary,#5f6368);flex:none}.Y0CJ8q_chevron{color:var(--dsw-alias-label-caption,#8a8f98);flex:none;transition:transform .14s}.Y0CJ8q_chevronOpen{transform:rotate(180deg)}.Y0CJ8q_branchTrigger:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4f73ff);outline-offset:1px}.Y0CJ8q_branchOption:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4f73ff);outline-offset:1px}.Y0CJ8q_search:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4f73ff);outline-offset:1px}.Y0CJ8q_popover{z-index:60;width:288px;color:var(--dsw-alias-label-primary,#1f1f1f);background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l2,#0000001f);pointer-events:auto;border-radius:7px;flex-direction:column;display:flex;position:absolute;top:calc(100% + 6px);left:8px;overflow:hidden;box-shadow:0 10px 28px #00000021,0 2px 8px #00000014}.Y0CJ8q_searchRow{border-bottom:1px solid var(--dsw-alias-border-l2,#0000001a);align-items:center;gap:6px;padding:6px 9px;display:flex}.Y0CJ8q_search{min-width:0;height:22px;color:inherit;font:inherit;background:0 0;border:0;outline:none;flex:1}.Y0CJ8q_search::placeholder{color:var(--dsw-alias-label-caption,#8a8f98)}.Y0CJ8q_branchList{max-height:264px;padding:4px;overflow-y:auto}.Y0CJ8q_branchOption{width:100%;min-height:28px;color:inherit;font:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:5px;align-items:center;gap:6px;padding:5px 8px;line-height:18px;display:flex}.Y0CJ8q_branchOption:hover,.Y0CJ8q_branchOption.Y0CJ8q_selected{background:var(--dsw-alias-interactive-bg-hover,#0000000e)}.Y0CJ8q_branchOptionName{text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;overflow:hidden}.Y0CJ8q_branchOption[data-remote=true] .Y0CJ8q_branchOptionName{color:var(--dsw-alias-label-secondary,#5f6368)}.Y0CJ8q_branchCheck{color:var(--dsw-alias-state-business-primary,#4f73ff);flex:none}.Y0CJ8q_branchEmpty{color:var(--dsw-alias-label-caption,#8a8f98);padding:8px;font-size:12px}.Y0CJ8q_notice{color:var(--dsw-alias-state-error,#c93b3b);white-space:nowrap;pointer-events:auto;margin-left:2px;font-size:12px}.Y0CJ8q_notice[data-tone=info]{color:var(--dsw-alias-label-secondary,#5f6368)}.Y0CJ8q_badge{max-width:200px;min-height:20px;color:var(--dsw-alias-label-secondary,#5f6368);white-space:nowrap;border:1px solid var(--dsw-alias-border-l2,#0000001a);border-radius:999px;align-items:center;gap:4px;padding:1px 7px;font-size:11px;line-height:16px;display:inline-flex;overflow:hidden}.Y0CJ8q_badge>span{text-overflow:ellipsis;overflow:hidden}.Y0CJ8q_badgeIcon{color:var(--dsw-alias-state-business-primary,#4f73ff);flex:none}[data-phase=hero] .Y0CJ8q_root{width:auto;max-width:calc(100% - 32px);margin-top:var(--worktree-hero-lift,0px);margin-left:var(--worktree-hero-inset,20px);flex:none;align-self:flex-start;padding-left:0;display:inline-flex}[data-phase=hero] .Y0CJ8q_popover{left:0}@media (max-width:720px){.Y0CJ8q_root{width:calc(100% - 20px);padding-left:0}.Y0CJ8q_popover{left:0}}";
const tagId = "dsh-task-worktree/WorktreePanel.module.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
	const tag = document.createElement("style");
	tag.dataset.plugin = "dsh-task-worktree";
	tag.dataset.pluginCss = tagId;
	tag.textContent = css;
	document.head.appendChild(tag);
}
var WorktreePanel_module_css_default = {
	"badge": "Y0CJ8q_badge",
	"badgeIcon": "Y0CJ8q_badgeIcon",
	"branchCheck": "Y0CJ8q_branchCheck",
	"branchEmpty": "Y0CJ8q_branchEmpty",
	"branchList": "Y0CJ8q_branchList",
	"branchName": "Y0CJ8q_branchName",
	"branchOption": "Y0CJ8q_branchOption",
	"branchOptionName": "Y0CJ8q_branchOptionName",
	"branchTrigger": "Y0CJ8q_branchTrigger",
	"chevron": "Y0CJ8q_chevron",
	"chevronOpen": "Y0CJ8q_chevronOpen",
	"icon": "Y0CJ8q_icon",
	"notice": "Y0CJ8q_notice",
	"popover": "Y0CJ8q_popover",
	"root": "Y0CJ8q_root",
	"search": "Y0CJ8q_search",
	"searchRow": "Y0CJ8q_searchRow",
	"selected": "Y0CJ8q_selected",
	"toggle": "Y0CJ8q_toggle"
};

//#endregion
//#region src/client/WorktreeBadge.tsx
/**
* Conversation-header worktree badge: renders a branch icon next to the
* session title when this conversation is in worktree mode — armed from the
* composer (store) or running inside a checkout (cwd). Marks the conversation
* in the Qoder style without consuming a workspace entry.
*
* The worktree branch name is model-chosen, so it only reaches this badge
* through the session cwd (once a checkout owns the conversation); an armed
* mode with an unknown name shows the generic label.
*/
/** Render the branch badge; nothing when the staged conversation has no worktree. */
function WorktreeBadge(props) {
	const { currentCwd, store, t } = props;
	(0, react.useSyncExternalStore)(store.subscribe, store.getVersion);
	const sessionId = props.sessionIdOf();
	const cwdName = worktreeNameOfCwd(currentCwd());
	const declared = store.stateOf(sessionId);
	const fallback = declared.worktree ? t("badgeFallback") : void 0;
	const name$1 = cwdName ?? fallback;
	window.__dshTaskWorktreeDebug = {
		sessionId,
		base: declared.base,
		declaredWorktree: declared.worktree,
		cwd: cwdName,
		label: name$1
	};
	if (name$1 === void 0) return null;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: WorktreePanel_module_css_default.badge,
		role: "status",
		title: `${t("badgeTooltip")}: ${name$1}`,
		"data-testid": "worktree-badge",
		"data-worktree": name$1,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.IconBranchOutlineRegular, {
			size: 13,
			className: WorktreePanel_module_css_default.badgeIcon
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: name$1 })]
	});
}

//#endregion
//#region src/client/WorktreePanel.tsx
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
const WORKTREE_PATH = /[\\/]\.dsh-worktrees[\\/]worktree[\\/]/u;
function currentMode(injected) {
	const cwd = injected.currentCwd();
	return typeof cwd === "string" && WORKTREE_PATH.test(cwd) ? "worktree" : "local";
}
function WorktreePanel(props) {
	const { t, store, sessionIdOf } = props;
	const rootRef = (0, react.useRef)(null);
	const [open, setOpen] = (0, react.useState)(false);
	const [query, setQuery] = (0, react.useState)("");
	const [listing, setListing] = (0, react.useState)(void 0);
	const [picked, setPicked] = (0, react.useState)(void 0);
	const [busy, setBusy] = (0, react.useState)(null);
	const [notice, setNotice] = (0, react.useState)(null);
	(0, react.useSyncExternalStore)(store.subscribe, store.getVersion);
	const sessionId = sessionIdOf();
	const declared = store.stateOf(sessionId);
	const hero = props.currentBlank();
	const mode = declared.worktree || currentMode(props) === "worktree" ? "worktree" : "local";
	const selectedBase = picked ?? declared.base ?? listing?.current ?? void 0;
	(0, react.useEffect)(() => {
		if (!hero) return () => {};
		let live = true;
		props.listBranches().then((next) => {
			if (live) setListing(next);
		}).catch(() => {
			if (live) setListing(void 0);
		});
		return () => {
			live = false;
		};
	}, [hero]);
	window.__dshTaskWorktreePanelDebug = {
		sessionId,
		mode,
		hero,
		declaredWorktree: declared.worktree,
		base: selectedBase,
		branches: listing?.branches.length ?? 0
	};
	(0, react.useLayoutEffect)(() => {
		const root = rootRef.current;
		const heroRow = root?.parentElement?.previousElementSibling;
		if (root === null || root === void 0 || !(heroRow instanceof HTMLElement) || root.closest("[data-phase=\"hero\"]") === null) {
			root?.style.removeProperty("--worktree-hero-inset");
			root?.style.removeProperty("--worktree-hero-lift");
			return;
		}
		const reposition = () => {
			root.style.removeProperty("--worktree-hero-inset");
			root.style.removeProperty("--worktree-hero-lift");
			const heroRect = heroRow.getBoundingClientRect();
			const rootRect = root.getBoundingClientRect();
			const rightEdge = Array.from(heroRow.querySelectorAll("*")).reduce((right, element) => {
				const rect = element.getBoundingClientRect();
				return rect.width > 0 && rect.height > 0 ? Math.max(right, rect.right) : right;
			}, rootRect.left);
			const inset = Math.max(0, Math.ceil(rightEdge - rootRect.left + 6));
			const lift = Math.round(rootRect.top + rootRect.height / 2 - (heroRect.top + heroRect.height / 2));
			root.style.setProperty("--worktree-hero-inset", `${inset}px`);
			root.style.setProperty("--worktree-hero-lift", `${lift}px`);
		};
		reposition();
		const resizeObserver = new ResizeObserver(reposition);
		const mutationObserver = new MutationObserver(reposition);
		resizeObserver.observe(heroRow);
		mutationObserver.observe(heroRow, {
			childList: true,
			subtree: true,
			characterData: true
		});
		window.addEventListener("resize", reposition);
		return () => {
			resizeObserver.disconnect();
			mutationObserver.disconnect();
			window.removeEventListener("resize", reposition);
		};
	}, []);
	const closeMenu = () => {
		setOpen(false);
		setQuery("");
	};
	(0, react.useEffect)(() => {
		if (!open) return () => {};
		const onPointerDown = (event) => {
			if (rootRef.current?.contains(event.target) !== true) closeMenu();
		};
		const onKeyDown = (event) => {
			if (event.key === "Escape") closeMenu();
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown, true);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);
	const showFailure = () => {
		setNotice(t("fail"));
		window.setTimeout(() => setNotice(null), 1800);
	};
	/** Legacy: leave a session actually running inside a worktree checkout. */
	const switchLocal = () => {
		if (busy !== null) return;
		setBusy("local");
		setNotice(t("switching"));
		props.openLocalWorkspace().then(() => {
			setNotice(null);
		}).catch(() => {
			setNotice(null);
			showFailure();
		}).finally(() => {
			setBusy(null);
		});
	};
	const disarmMode = () => {
		if (busy !== null) return;
		setBusy("disarm");
		props.disarmWorktreeMode().catch(() => {
			showFailure();
		}).finally(() => {
			setBusy(null);
		});
	};
	/**
	* The checkbox is the mode switch: checking arms the host with the selected
	* base branch, unchecking disarms — or, for a session that physically runs
	* inside a checkout, opens the owning local workspace.
	*/
	const toggleMode = (next) => {
		if (busy !== null) return;
		if (next) {
			if (declared.worktree) return;
			setBusy("arm");
			props.armWorktreeMode(selectedBase).catch(() => {
				showFailure();
			}).finally(() => {
				setBusy(null);
			});
			return;
		}
		if (declared.worktree) {
			disarmMode();
			return;
		}
		if (mode === "worktree") switchLocal();
	};
	/** Pick a start point; an already armed session is re-armed with it. */
	const selectBranch = (name$1) => {
		setPicked(name$1);
		closeMenu();
		if (!declared.worktree) return;
		props.armWorktreeMode(name$1).catch(() => {
			showFailure();
		});
	};
	if (!hero) return null;
	const branches = listing?.branches ?? [];
	const needle = query.trim().toLowerCase();
	const visible = needle === "" ? branches : branches.filter((branch) => branch.name.toLowerCase().includes(needle));
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		ref: rootRef,
		className: WorktreePanel_module_css_default.root,
		"data-testid": "worktree-panel",
		"data-mode": mode,
		"aria-label": t("panelTitle"),
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: WorktreePanel_module_css_default.branchTrigger,
				"data-testid": "worktree-branch-trigger",
				"aria-haspopup": "listbox",
				"aria-expanded": open,
				"aria-label": t("baseBranchLabel"),
				title: t("baseBranchLabel"),
				disabled: busy !== null,
				onClick: () => setOpen((value) => !value),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.IconBranchOutlineRegular, {
						size: 14,
						className: WorktreePanel_module_css_default.icon
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: WorktreePanel_module_css_default.branchName,
						children: selectedBase ?? t("baseFallback")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutlineRegular, {
						size: 12,
						className: `${WorktreePanel_module_css_default.chevron} ${open ? WorktreePanel_module_css_default.chevronOpen : ""}`
					})
				]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Checkbox, {
				checked: mode === "worktree",
				onChange: toggleMode,
				label: t("worktreeLabel"),
				disabled: busy !== null,
				title: t("worktreeMode"),
				className: WorktreePanel_module_css_default.toggle
			}),
			open && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: WorktreePanel_module_css_default.popover,
				"data-testid": "worktree-branch-menu",
				role: "listbox",
				"aria-label": t("baseBranchLabel"),
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: WorktreePanel_module_css_default.searchRow,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.IconSearchOutlineRegular, {
						size: 14,
						className: WorktreePanel_module_css_default.icon
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						className: WorktreePanel_module_css_default.search,
						"data-testid": "worktree-branch-search",
						value: query,
						onChange: (event) => setQuery(event.target.value),
						placeholder: t("branchSearch"),
						"aria-label": t("branchSearch")
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: WorktreePanel_module_css_default.branchList,
					children: [visible.map((branch) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						role: "option",
						"aria-selected": branch.name === selectedBase,
						"data-testid": `worktree-branch-option-${branch.name}`,
						"data-remote": branch.remote ? "true" : void 0,
						className: `${WorktreePanel_module_css_default.branchOption} ${branch.name === selectedBase ? WorktreePanel_module_css_default.selected : ""}`,
						onClick: () => selectBranch(branch.name),
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: WorktreePanel_module_css_default.branchOptionName,
							children: branch.name
						}), branch.name === selectedBase && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.IconCheckOutlineRegular, {
							size: 13,
							className: WorktreePanel_module_css_default.branchCheck
						})]
					}, branch.name)), visible.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: WorktreePanel_module_css_default.branchEmpty,
						children: listing?.available === false ? t("branchUnavailable") : t("branchEmpty")
					})]
				})]
			}),
			notice !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: WorktreePanel_module_css_default.notice,
				"data-tone": busy === "local" ? "info" : "error",
				role: "status",
				children: notice
			})
		]
	});
}

//#endregion
//#region src/client/worktreeStore.ts
function createWorktreeStore() {
	let byId = /* @__PURE__ */ new Map();
	let version = 0;
	const listeners = /* @__PURE__ */ new Set();
	const bump = (next) => {
		byId = next;
		version += 1;
		for (const listener of listeners) listener();
	};
	return {
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		getVersion() {
			return version;
		},
		stateOf(sessionId) {
			if (sessionId === void 0) return {
				base: void 0,
				worktree: false
			};
			return byId.get(sessionId) ?? {
				base: void 0,
				worktree: false
			};
		},
		declare(sessionId, base) {
			if (sessionId === void 0) return;
			const current = byId.get(sessionId);
			const next = {
				base: base ?? void 0,
				worktree: true
			};
			if (current !== void 0 && current.base === next.base && current.worktree === next.worktree) return;
			const cloned = new Map(byId);
			cloned.set(sessionId, next);
			bump(cloned);
		},
		clear(sessionId) {
			if (sessionId === void 0) return;
			if (!byId.has(sessionId)) return;
			const cloned = new Map(byId);
			cloned.delete(sessionId);
			bump(cloned);
		}
	};
}

//#endregion
//#region src/client/index.ts
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
const NS = "dsh-task-worktree";
const name = "dsh-task-worktree";
const inject = [
	"slots",
	"locale",
	"sessions",
	"workspaces"
];
function apply(ctx) {
	ctx.effect(() => ctx.locale.register(NS, {
		zh,
		en
	}), `${NS}: dictionaries`);
	const t = (key) => ctx.locale.bind(NS)(key);
	/** Reactive store for worktree-mode declarations. */
	const store = createWorktreeStore();
	/**
	* The main-view session row — the conversation the GUI's main view retains.
	*
	* dsh 0.1.6 dropped `sessions.current` (navigation belongs to the view
	* owners), so the current conversation is derived from the retention source
	* counts instead; this is the same derivation the shell's own title/chrome
	* and upstream ui-workspace's `mainSessionId` use. The Host list order
	* decides between several retained rows.
	*/
	const currentRow = () => {
		const snapshot = ctx.sessions.list.getSnapshot();
		for (const id of snapshot.ids) {
			const row = snapshot.byId[id];
			if (row !== void 0 && (row.retainedBy.mainView ?? 0) > 0) return row;
		}
	};
	/** Resolve the current session id (the staged conversation). */
	const currentSessionId = () => currentRow()?.id;
	/** Resolve the current session face through the main-view row. */
	const currentSession = () => {
		const current = currentSessionId();
		if (current === void 0) return void 0;
		return ctx.sessions.binding(current)?.session;
	};
	/** Resolve the current cwd from the list summary (the outward session face intentionally omits it). */
	const currentCwd = () => currentRow()?.cwd;
	/** Whether the staged session is still blank (host-computed empty-log bit). */
	const currentBlank = () => currentRow()?.blank === true;
	/**
	* The staged session's workspace root. `workspaceFiles.list` resolves
	* relative paths against it (and refuses targets outside it), and a session
	* row carries no workspace id of its own — the registry's Session
	* membership is the only mapping the Client exposes.
	*/
	const currentWorkspaceRoot = () => {
		const current = currentRow()?.id;
		if (current === void 0) return void 0;
		for (const view of ctx.workspaces.list.getSnapshot().items) if (view.sessionIds.includes(current)) return view.path;
	};
	/** Open the local workspace that owns the current worktree checkout. */
	const openLocalWorkspace = async () => {
		const cwd = currentCwd();
		if (typeof cwd !== "string" || cwd === "") throw new Error("无法确定当前工作区路径");
		const marker = /[\\/]\.dsh-worktrees[\\/]worktree[\\/]/u.exec(cwd);
		const localPath = marker !== null ? cwd.slice(0, marker.index) : cwd;
		const workspace = await ctx.workspaces.create({ path: localPath });
		await ctx.sessions.create({ workspaceId: workspace.workspaceId });
	};
	/**
	* Arm this conversation for worktree mode: the host injects the creation
	* instruction with the NEXT genuine user message (no separate prompt, no
	* workspace registration). The base branch is the one the composer's picker
	* chose; the model names the worktree branch itself. On success the session
	* is declared worktree-mode in the store (the badge switches on immediately).
	*/
	const armWorktreeMode = async (rawBase) => {
		const sessionId = currentSessionId();
		const session = currentSession();
		if (session === void 0 || sessionId === void 0) throw new Error("当前没有可注入的对话");
		const base = rawBase?.trim() ?? "";
		const line = base === "" ? "/worktree mode-on" : `/worktree mode-on --base ${base}`;
		const result = await session.command(line);
		if (!result.ok || result.value.matched !== true) throw new Error("指令未执行成功");
		store.declare(sessionId, base === "" ? void 0 : base);
	};
	/**
	* Read the repository's branches for the base-branch picker. The shell's
	* `workspaceFiles` Remote is optional (a minimal preset and a third-party
	* composition may omit it), so the lookup is soft and a missing service
	* degrades to an unavailable listing instead of failing the panel.
	*/
	const listBranches = async () => {
		const sessionId = currentSessionId();
		const files = ctx.get?.("remote.workspaceFiles");
		if (sessionId === void 0 || files === void 0) return {
			available: false,
			current: void 0,
			branches: [],
			reason: "unavailable"
		};
		return readBranches({
			sessionId,
			root: currentWorkspaceRoot(),
			cwd: currentCwd(),
			files
		});
	};
	/** Disarm worktree mode for the current conversation. */
	const disarmWorktreeMode = async () => {
		const sessionId = currentSessionId();
		const session = currentSession();
		if (session === void 0 || sessionId === void 0) throw new Error("当前没有可注入的对话");
		const result = await session.command("/worktree mode-off");
		if (!result.ok || result.value.matched !== true) throw new Error("指令未执行成功");
		store.clear(sessionId);
	};
	ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
		name: "conversation.input.dock",
		id: "worktree",
		order: 10,
		locale: NS
	}, () => (0, react.createElement)(WorktreePanel, {
		currentSession,
		currentCwd,
		currentBlank,
		openLocalWorkspace,
		armWorktreeMode,
		disarmWorktreeMode,
		listBranches,
		store,
		sessionIdOf: currentSessionId,
		t
	})));
	ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
		name: "conversation.session.header.actions",
		id: "worktree-badge",
		order: -30,
		locale: NS
	}, () => (0, react.createElement)(WorktreeBadge, {
		store,
		sessionIdOf: currentSessionId,
		currentCwd,
		t
	})));
}

//#endregion
exports.apply = apply;
exports.inject = inject;
exports.name = name;
return module.exports; } });
//# sourceMappingURL=client.js.map