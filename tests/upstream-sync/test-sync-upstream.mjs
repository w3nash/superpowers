import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../scripts/sync-upstream.mjs",
);
const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Sync test",
  GIT_AUTHOR_EMAIL: "sync@example.test",
  GIT_COMMITTER_NAME: "Sync test",
  GIT_COMMITTER_EMAIL: "sync@example.test",
};

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "upstream-sync-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const upstream = join(directory, "upstream");
  const origin = join(directory, "origin.git");
  const work = join(directory, "work");
  git(directory, "init", "-q", "-b", "main", upstream);
  await writeFile(join(upstream, "shared.txt"), "base\n");
  git(upstream, "add", ".");
  git(upstream, "commit", "-qm", "Base");
  git(upstream, "tag", "v1.0.0");
  git(directory, "clone", "-q", "--bare", upstream, origin);
  git(directory, "clone", "-q", origin, work);
  git(work, "switch", "-qc", "omp");
  await writeFile(join(work, "omp.txt"), "Keep OMP support\n");
  git(work, "add", ".");
  git(work, "commit", "-qm", "OMP support");
  git(work, "push", "-q", "origin", "HEAD:refs/heads/omp");
  const original = git(origin, "rev-parse", "refs/heads/omp");
  await writeFile(join(upstream, "release.txt"), "New stable release\n");
  git(upstream, "add", ".");
  git(upstream, "commit", "-qm", "Release");
  git(upstream, "tag", "v1.1.0");
  return { directory, upstream, origin, work, original };
}

function sync(f, code = "process.exit(0)", tag = "v1.1.0") {
  return spawnSync(
    process.execPath,
    [script, f.upstream, tag, "omp", "--", process.execPath, "-e", code],
    { cwd: f.work, env, encoding: "utf8" },
  );
}

test("successful update preserves fork files and publishes the validated merge", async (t) => {
  const f = await fixture(t);
  const marker = join(f.directory, "validated");
  const result = sync(
    f,
    `require('fs').writeFileSync(${JSON.stringify(marker)}, 'yes')`,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(marker, "utf8"), "yes");
  assert.equal(git(f.origin, "show", "omp:omp.txt"), "Keep OMP support");
  assert.equal(git(f.origin, "show", "omp:release.txt"), "New stable release");
  git(
    f.work,
    "merge-base",
    "--is-ancestor",
    f.original,
    git(f.origin, "rev-parse", "omp"),
  );
});

test("already integrated release does not invoke validation or change the branch", async (t) => {
  const f = await fixture(t);
  const result = sync(f, "process.exit(77)", "v1.0.0");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(f.origin, "rev-parse", "omp"), f.original);
});

test("conflicting release preserves the published branch and aborts the merge", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.work, "shared.txt"), "fork choice\n");
  git(f.work, "commit", "-qam", "Fork shared change");
  git(f.work, "push", "-q", "origin", "HEAD:omp");
  const remoteBefore = git(f.origin, "rev-parse", "omp");
  await writeFile(join(f.upstream, "shared.txt"), "upstream choice\n");
  git(f.upstream, "commit", "-qam", "Upstream shared change");
  git(f.upstream, "tag", "v1.2.0");
  const result = sync(f, "process.exit(0)", "v1.2.0");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /conflicts with omp/);
  assert.equal(git(f.origin, "rev-parse", "omp"), remoteBefore);
  assert.equal(git(f.work, "status", "--porcelain"), "");
});

test("failing verification leaves the published branch unchanged", async (t) => {
  const f = await fixture(t);
  const result = sync(f, "process.exit(42)");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Verification failed \(42\)/);
  assert.equal(git(f.origin, "rev-parse", "omp"), f.original);
});

test("concurrent remote update is preserved instead of overwritten", async (t) => {
  const f = await fixture(t);
  const other = join(f.directory, "other");
  git(f.directory, "clone", "-q", "-b", "omp", f.origin, other);
  await writeFile(join(other, "concurrent.txt"), "Keep concurrent change\n");
  git(other, "add", ".");
  git(other, "commit", "-qm", "Concurrent change");
  const concurrent = git(other, "rev-parse", "HEAD");
  const result = sync(
    f,
    `require('child_process').execFileSync('git', ['push','-q','origin','HEAD:omp'], {cwd:${JSON.stringify(other)}})`,
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Remote branch advanced/);
  assert.equal(git(f.origin, "rev-parse", "omp"), concurrent);
});

test("dirty initial checkout is preserved and rejected", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.work, "user-work.txt"), "Do not discard\n");
  const result = sync(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Checkout contains local changes/);
  assert.equal(
    await readFile(join(f.work, "user-work.txt"), "utf8"),
    "Do not discard\n",
  );
  assert.equal(git(f.work, "rev-parse", "HEAD"), f.original);
  assert.equal(git(f.origin, "rev-parse", "omp"), f.original);
});

test("verification cannot publish a changed checkout or changed HEAD", async (t) => {
  for (const commit of [false, true]) {
    await t.test(
      commit ? "committed validation changes" : "untracked validation output",
      async (t) => {
        const f = await fixture(t);
        const code =
          "require('fs').writeFileSync('unexpected.txt','changed');" +
          (commit
            ? "require('child_process').execFileSync('git',['add','.']);require('child_process').execFileSync('git',['commit','-qm','Unexpected']);"
            : "");
        const result = sync(f, code);
        assert.notEqual(result.status, 0);
        assert.match(
          result.stderr,
          /Verification changed HEAD or the checkout/,
        );
        assert.equal(git(f.origin, "rev-parse", "omp"), f.original);
      },
    );
  }
});
