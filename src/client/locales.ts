/**
 * Locale dictionaries for the dsh-task-worktree client half.
 * Product copy is Chinese; the English side exists for parity.
 */

export const zh = {
  panelTitle: '工作树',
  worktreeLabel: 'worktree',
  worktreeMode: 'Worktree模式',
  baseBranchLabel: '起点分支',
  baseFallback: 'HEAD',
  branchSearch: '搜索分支…',
  branchEmpty: '没有匹配的分支',
  branchUnavailable: '无法读取分支列表',
  switching: '正在切换…',
  fail: '命令未执行成功',
  badgeTooltip: '本对话使用的 worktree',
  badgeFallback: 'worktree',
}

export const en = {
  panelTitle: 'Worktrees',
  worktreeLabel: 'worktree',
  worktreeMode: 'Worktree mode',
  baseBranchLabel: 'Base branch',
  baseFallback: 'HEAD',
  branchSearch: 'Search branches…',
  branchEmpty: 'No matching branch',
  branchUnavailable: 'Branch list unavailable',
  switching: 'Switching…',
  fail: 'Command failed',
  badgeTooltip: 'Worktree used by this conversation',
  badgeFallback: 'worktree',
}

export type WorktreeKey = typeof zh
