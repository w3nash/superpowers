#!/usr/bin/env node
import { spawnSync } from "node:child_process";

function git(args, { allowed = [0], inherit = false } = {}) {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    stdio: inherit ? "inherit" : "pipe",
    timeout: 120_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.error) throw result.error;
  if (!allowed.includes(result.status)) {
    throw new Error(
      `git ${args[0]} failed (${result.status}): ${result.stderr?.trim() ?? "see output"}`,
    );
  }
  return { status: result.status, text: result.stdout?.trim() ?? "" };
}

try {
  const [upstream, tag, branch, separator, command, ...commandArgs] =
    process.argv.slice(2);
  if (
    !upstream ||
    upstream.startsWith("-") ||
    !/^v\d+\.\d+\.\d+$/.test(tag ?? "") ||
    !branch ||
    branch.startsWith("-") ||
    separator !== "--" ||
    !command ||
    command.startsWith("-")
  ) {
    throw new Error(
      "Usage: node scripts/sync-upstream.mjs <upstream> <vX.Y.Z> <branch> -- <verification command> [args...]",
    );
  }
  git(["check-ref-format", `refs/heads/${branch}`]);
  git(["check-ref-format", `refs/tags/${tag}`]);
  if (git(["rev-parse", "--is-inside-work-tree"]).text !== "true") {
    throw new Error("Run in a disposable working checkout.");
  }
  if (git(["rev-parse", "--is-shallow-repository"]).text !== "false") {
    throw new Error("A complete Git history is required.");
  }
  if (git(["status", "--porcelain", "--untracked-files=all"]).text) {
    throw new Error(
      "Checkout contains local changes; refusing to discard them.",
    );
  }
  if (
    git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], { allowed: [0, 1] })
      .status === 0
  ) {
    throw new Error("Finish the existing merge before syncing.");
  }

  git(["fetch", "--no-tags", "origin", `refs/heads/${branch}`]);
  const base = git(["rev-parse", "FETCH_HEAD^{commit}"]).text;
  git(["fetch", "--no-tags", upstream, `refs/tags/${tag}`]);
  const release = git(["rev-parse", "FETCH_HEAD^{commit}"]).text;
  if (
    git(["merge-base", "--is-ancestor", release, base], { allowed: [0, 1] })
      .status === 0
  ) {
    console.log(`${tag} is already integrated into ${branch}.`);
    process.exit(0);
  }

  git(["checkout", "--detach", base]);
  const merge = git(
    ["merge", "--no-ff", "--no-edit", "-m", `Merge upstream ${tag}`, release],
    { allowed: [0, 1], inherit: true },
  );
  if (merge.status !== 0) {
    if (
      git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], { allowed: [0, 1] })
        .status === 0
    )
      git(["merge", "--abort"]);
    throw new Error(
      `Upstream ${tag} conflicts with ${branch}; remote branch is unchanged.`,
    );
  }
  const candidate = git(["rev-parse", "HEAD"]).text;
  const verification = spawnSync(command, commandArgs, {
    stdio: "inherit",
    timeout: 600_000,
  });
  if (verification.error) throw verification.error;
  if (verification.status !== 0)
    throw new Error(
      `Verification failed (${verification.status}); remote branch is unchanged.`,
    );
  if (
    git(["rev-parse", "HEAD"]).text !== candidate ||
    git(["status", "--porcelain", "--untracked-files=all"]).text
  ) {
    throw new Error(
      "Verification changed HEAD or the checkout; refusing to publish.",
    );
  }
  const current = git([
    "ls-remote",
    "--heads",
    "origin",
    `refs/heads/${branch}`,
  ]).text.split(/\s+/)[0];
  if (current !== base)
    throw new Error(
      "Remote branch advanced during verification; refusing to overwrite it.",
    );
  git(["push", "origin", `${candidate}:refs/heads/${branch}`], {
    inherit: true,
  });
  console.log(`Published ${tag} to ${branch} after verification.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
