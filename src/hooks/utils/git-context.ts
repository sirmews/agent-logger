import { execFileSync } from "child_process";

const GIT_TIMEOUT_MS = 1000;
const GIT_DEADLINE_MS = 3000;
const MAX_CHANGED_FILES = 200;

export type GitContext = {
  git_root: string | null;
  branch: string | null;
  commit: string | null;
  dirty: boolean | null;
  remote_url: string | null;
  changed_files: {
    files: string[];
    omitted_count: number;
  } | null;
};

function git(args: string[], cwd?: string): string | null {
  try {
    return execFileSync("git", args, {
      encoding: "utf-8",
      timeout: GIT_TIMEOUT_MS,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Captures git repository context at session start (root, branch, commit, dirty, remote).
 * All git calls have a hard 1s timeout and fail silently outside git repos.
 * A global deadline of 3s ensures the hook finishes well within the 5s hooks.json budget.
 */
export function getSessionStartGitContext(cwd?: string): GitContext {
  const start = Date.now();
  const withinBudget = () => Date.now() - start < GIT_DEADLINE_MS;

  const gitRoot = git(["rev-parse", "--show-toplevel"], cwd);
  if (!gitRoot) {
    return {
      git_root: null,
      branch: null,
      commit: null,
      dirty: null,
      remote_url: null,
      changed_files: null,
    };
  }

  const branch = withinBudget() ? git(["rev-parse", "--abbrev-ref", "HEAD"], cwd) : null;
  const commit = withinBudget() ? git(["rev-parse", "--short", "HEAD"], cwd) : null;
  const dirtyStr = withinBudget() ? git(["status", "--porcelain"], cwd) : null;
  const dirty = dirtyStr !== null ? dirtyStr.length > 0 : null;
  const remoteUrl = withinBudget() ? git(["remote", "get-url", "origin"], cwd) : null;

  return {
    git_root: gitRoot,
    branch,
    commit,
    dirty,
    remote_url: remoteUrl,
    changed_files: null,
  };
}

/**
 * Captures git repository context at session stop, including a changed-file summary.
 * Caps the changed-file list to avoid multi-MB records.
 * Shares the 3s deadline with session-start context capture.
 */
export function getStopGitContext(cwd?: string): GitContext {
  const start = Date.now();
  const withinBudget = () => Date.now() - start < GIT_DEADLINE_MS;

  const gitRoot = withinBudget() ? git(["rev-parse", "--show-toplevel"], cwd) : null;
  if (!gitRoot) {
    return {
      git_root: null,
      branch: null,
      commit: null,
      dirty: null,
      remote_url: null,
      changed_files: null,
    };
  }

  const branch = withinBudget() ? git(["rev-parse", "--abbrev-ref", "HEAD"], cwd) : null;
  const commit = withinBudget() ? git(["rev-parse", "--short", "HEAD"], cwd) : null;
  const dirtyStr = withinBudget() ? git(["status", "--porcelain"], cwd) : null;
  const dirty = dirtyStr !== null ? dirtyStr.length > 0 : null;
  const remoteUrl = withinBudget() ? git(["remote", "get-url", "origin"], cwd) : null;

  const ctx: GitContext = {
    git_root: gitRoot,
    branch,
    commit,
    dirty,
    remote_url: remoteUrl,
    changed_files: null,
  };

  if (dirtyStr !== null && dirtyStr.length > 0) {
    const allFiles = dirtyStr.split("\n").map((line) => line.slice(3)).filter(Boolean);
    const files = allFiles.slice(0, MAX_CHANGED_FILES);
    const omitted_count = allFiles.length - files.length;
    ctx.changed_files = { files, omitted_count };
  } else if (dirtyStr !== null) {
    ctx.changed_files = { files: [], omitted_count: 0 };
  }

  return ctx;
}
