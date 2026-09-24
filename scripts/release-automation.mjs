import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import semver from "semver";

export const releaseBranch = "automation/dependency-release";
export const requiredChecks = [
  "test (ubuntu-latest, 22)", "test (ubuntu-latest, 24)",
  "test (macos-latest, 22)", "test (macos-latest, 24)",
];
const releasePaths = ["package.json", "package-lock.json", "README.md"];
const dependencyFields = ["dependencies", "devDependencies"];
const marker = "terminal-emulator-mcp-dependency-release";
const parse = (files, path) => JSON.parse(files[path]);
const withoutDependencies = (value) => Object.fromEntries(
  Object.entries(value).filter(([key]) => !dependencyFields.includes(key)),
);
const modifiedOnly = (files, allowed) => files.length > 0
  && files.every((file) => file.status === "modified" && allowed.includes(file.filename) && !file.previous_filename);
const actionPath = (path) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path);
const changedPaths = (before, after) => Object.keys(after).filter((path) => before[path] !== after[path]);

export function compatibleVersion(before, after) {
  return semver.valid(before) === before && semver.valid(after) === after
    && semver.gt(after, before) && semver.satisfies(after, `^${before}`);
}

function compatibleRange(before, after) {
  const minimum = semver.minVersion(before)?.version;
  const nextMinimum = semver.minVersion(after)?.version;
  return minimum && nextMinimum && semver.gte(nextMinimum, minimum)
    && semver.subset(before, `^${minimum}`) && semver.subset(after, `^${minimum}`);
}

function compatibleActions(files, before, after) {
  // Requiring identical surrounding text prevents a workflow update from changing commands or permissions.
  const use = /^(\s*(?:-\s*)?uses:\s*["']?[\w.-]+\/[\w./-]+@)v?(\d+\.\d+\.\d+(?:-[\w.-]+)?)(["']?[ \t]*(?:#.*)?)$/;
  let changed = false;
  for (const { filename } of files) {
    const previous = before[filename]?.split("\n");
    const next = after[filename]?.split("\n");
    if (!previous || previous.length !== next?.length) return false;
    for (let line = 0; line < previous.length; line++) {
      if (previous[line] === next[line]) continue;
      const oldUse = previous[line].match(use);
      const newUse = next[line].match(use);
      if (!oldUse || !newUse || oldUse[1] !== newUse[1] || oldUse[3] !== newUse[3]
        || !compatibleVersion(oldUse[2], newUse[2])) return false;
      changed = true;
    }
  }
  return changed;
}

export function ownedPullRequest(pr, repository, defaultBranch, login) {
  return pr.user?.login === login && pr.user?.type === "Bot"
    && pr.base?.repo?.full_name === repository && pr.head?.repo?.full_name === repository
    && pr.base.ref === defaultBranch;
}

export function compatibleDependencyChange(pr, files, before, after, repository, defaultBranch) {
  if (!ownedPullRequest(pr, repository, defaultBranch, "dependabot[bot]")) return false;
  if (files.every((file) => actionPath(file.filename))) {
    return modifiedOnly(files, files.map((file) => file.filename)) && compatibleActions(files, before, after);
  }
  if (!modifiedOnly(files, ["package.json", "package-lock.json"])) return false;
  try {
    const oldPackage = parse(before, "package.json");
    const newPackage = parse(after, "package.json");
    if (!isDeepStrictEqual(withoutDependencies(oldPackage), withoutDependencies(newPackage))) return false;
    for (const field of dependencyFields) {
      const previous = oldPackage[field] ?? {};
      const next = newPackage[field] ?? {};
      if (!isDeepStrictEqual(Object.keys(previous).sort(), Object.keys(next).sort())) return false;
      for (const name of Object.keys(previous)) {
        if (previous[name] !== next[name] && !compatibleRange(previous[name], next[name])) return false;
      }
    }
    const oldLock = parse(before, "package-lock.json");
    const newLock = parse(after, "package-lock.json");
    const { packages: oldPackages, ...oldHeader } = oldLock;
    const { packages: newPackages, ...newHeader } = newLock;
    if (!isDeepStrictEqual(oldHeader, newHeader) || oldHeader.lockfileVersion !== 3) return false;
    if (!isDeepStrictEqual(withoutDependencies(oldPackages[""]), withoutDependencies(newPackages[""]))) return false;
    let directUpdate = false;
    for (const field of dependencyFields) {
      if (!isDeepStrictEqual(newPackages[""][field], newPackage[field])) return false;
      for (const [name, range] of Object.entries(newPackage[field] ?? {})) {
        const previous = oldPackages[`node_modules/${name}`]?.version;
        const next = newPackages[`node_modules/${name}`]?.version;
        if (!next || !semver.satisfies(next, range)) return false;
        if (previous !== next) {
          if (!compatibleVersion(previous, next)) return false;
          directUpdate = true;
        }
      }
    }
    let changed = !isDeepStrictEqual(oldPackage, newPackage);
    for (const path of new Set([...Object.keys(oldPackages), ...Object.keys(newPackages)])) {
      if (!path) continue;
      const previous = oldPackages[path];
      const next = newPackages[path];
      if (isDeepStrictEqual(previous, next)) continue;
      // A compatible direct release owns its internal tree. Lockfile-only updates must themselves be compatible.
      if (!directUpdate && (!previous || !next || !compatibleVersion(previous.version, next.version))) return false;
      if (next && (semver.valid(next.version) !== next.version
        || !next.resolved?.startsWith("https://registry.npmjs.org/") || !next.integrity)) return false;
      changed = true;
    }
    return changed;
  } catch {
    return false;
  }
}

export function ciState(checks) {
  const newest = new Map();
  for (const check of checks) {
    if (check.app?.slug !== "github-actions" || !requiredChecks.includes(check.name)) continue;
    if (!newest.has(check.name) || check.id > newest.get(check.name).id) newest.set(check.name, check);
  }
  if (requiredChecks.some((name) => newest.get(name)?.status !== "completed")) return "pending";
  return requiredChecks.every((name) => newest.get(name).conclusion === "success") ? "passed" : "failed";
}

export function nextRelease(files) {
  const manifest = parse(files, "package.json");
  assert.equal(manifest.name, "terminal-emulator-mcp");
  assert.equal(semver.valid(manifest.version), manifest.version, "Package version must be canonical SemVer");
  assert.equal(semver.prerelease(manifest.version), null, "Automatic patch releases require a stable package version");
  const version = semver.inc(manifest.version, "patch");
  const lock = parse(files, "package-lock.json");
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[""].version, manifest.version);
  const pin = new RegExp(`${manifest.name}@${manifest.version.replaceAll(".", "\\.")}(?![\\w+-]|\\.[\\w])`, "g");
  const readme = files["README.md"].replaceAll(pin, `${manifest.name}@${version}`);
  manifest.version = version;
  lock.version = version;
  lock.packages[""].version = version;
  return {
    version,
    files: {
      "package.json": `${JSON.stringify(manifest, null, 2)}\n`,
      "package-lock.json": `${JSON.stringify(lock, null, 2)}\n`,
      "README.md": readme,
    },
  };
}

export function releasePlan(version, pullRequests) {
  const sources = [...new Set(pullRequests)].sort((left, right) => left - right);
  assert.ok(sources.every((number) => Number.isSafeInteger(number) && number > 0));
  return sources.length ? { version, pullRequests: sources } : null;
}

export function planFromBody(body = "") {
  try {
    const match = body.match(new RegExp(`<!-- ${marker} (.+) -->`));
    if (!match) return null;
    const value = JSON.parse(match[1]);
    const plan = releasePlan(value.version, value.pullRequests);
    return plan && semver.valid(plan.version) === plan.version ? plan : null;
  } catch {
    return null;
  }
}

export function releaseBody(plan) {
  return `Release ${plan.version} with compatible dependency updates from `
    + `${plan.pullRequests.map((number) => `#${number}`).join(", ")}.\n\n`
    + "The package version, lockfile version, and README installation pins are updated together. "
    + "Required CI must pass before merging. npm publication remains controlled by NPM_PUBLISH_ENABLED.\n\n"
    + `<!-- ${marker} ${JSON.stringify(plan)} -->`;
}

export function validReleaseChange(pr, files, before, after, repository, defaultBranch, appLogin) {
  if (!ownedPullRequest(pr, repository, defaultBranch, appLogin) || pr.head.ref !== releaseBranch) return false;
  return versionOnlyChange(files, before, after, planFromBody(pr.body)?.version);
}

function versionOnlyChange(files, before, after, version) {
  if (!modifiedOnly(files, releasePaths)) return false;
  try {
    const expected = nextRelease(before);
    return version === expected.version && isDeepStrictEqual(expected.files, after)
      && isDeepStrictEqual(files.map((file) => file.filename).sort(), changedPaths(before, expected.files).sort());
  } catch {
    return false;
  }
}

async function tagCommit(github, repo, tag) {
  try {
    let object = (await github.rest.git.getRef({ ...repo, ref: `tags/${tag}` })).data.object;
    for (let depth = 0; object.type === "tag" && depth < 10; depth++) {
      object = (await github.rest.git.getTag({ ...repo, tag_sha: object.sha })).data.object;
    }
    assert.equal(object.type, "commit", "Release tag must resolve to a commit");
    return object.sha;
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

export async function ensureTag(github, repo, tag, commit) {
  const existing = await tagCommit(github, repo, tag);
  if (existing !== null) {
    assert.equal(existing, commit, `Tag ${tag} points elsewhere; existing tags are never moved`);
    return false;
  }
  try {
    await github.rest.git.createRef({ ...repo, ref: `refs/tags/${tag}`, sha: commit });
  } catch (error) {
    if (error.status !== 422) throw error;
    assert.equal(await tagCommit(github, repo, tag), commit, `Concurrent tag ${tag} creation has a different target`);
  }
  return true;
}

export async function reconcile({ github, context, core, appSlug }) {
  assert.ok(appSlug && /^[a-z0-9-]+$/.test(appSlug), "Expected the authenticated release App slug");
  const repo = context.repo;
  const repository = `${repo.owner}/${repo.repo}`;
  const appLogin = `${appSlug}[bot]`;
  const defaultBranch = (await github.rest.repos.get(repo)).data.default_branch;
  const pulls = await github.paginate(github.rest.pulls.list, { ...repo, state: "all", per_page: 100 });
  const contents = new Map();
  async function file(ref, path) {
    const key = `${ref}:${path}`;
    if (!contents.has(key)) {
      const { data } = await github.rest.repos.getContent({ ...repo, ref, path });
      assert.equal(data.type, "file");
      assert.equal(data.encoding, "base64");
      contents.set(key, Buffer.from(data.content, "base64").toString("utf8"));
    }
    return contents.get(key);
  }
  async function read(ref, paths = releasePaths) {
    return Object.fromEntries(await Promise.all(paths.map(async (path) => [path, await file(ref, path)])));
  }
  async function change(pr, paths) {
    const files = await github.paginate(github.rest.pulls.listFiles, {
      ...repo, pull_number: pr.number, per_page: 100,
    });
    if (!paths) {
      paths = files.length && files.every((entry) => actionPath(entry.filename))
        ? files.map((entry) => entry.filename) : ["package.json", "package-lock.json"];
      if (!modifiedOnly(files, paths)) return { files, before: {}, after: {} };
    }
    let before;
    let after;
    if (pr.merged_at) {
      const commit = (await github.rest.repos.getCommit({ ...repo, ref: pr.merge_commit_sha })).data;
      before = commit.parents[0].sha;
      after = pr.merge_commit_sha;
    } else {
      before = (await github.rest.repos.compareCommits({
        ...repo, base: pr.base.sha, head: pr.head.sha,
      })).data.merge_base_commit.sha;
      after = pr.head.sha;
    }
    return { files, before: await read(before, paths), after: await read(after, paths) };
  }
  async function checks(pr) {
    return ciState(await github.paginate(github.rest.checks.listForRef, {
      ...repo, ref: pr.head.sha, per_page: 100, filter: "latest",
    }));
  }
  async function mergeVerifiedPull(pr) {
    if (pr.draft) return;
    const latest = (await github.rest.pulls.get({ ...repo, pull_number: pr.number })).data;
    if (latest.head.sha !== pr.head.sha || latest.base.sha !== pr.base.sha || latest.state !== "open" || latest.draft
      || !ownedPullRequest(latest, repository, defaultBranch, pr.user.login)
      || latest.body !== pr.body || await checks(latest) !== "passed") return;
    try {
      // The expected SHA makes a head update fail atomically. Required branch checks still enforce base freshness.
      const { data } = await github.rest.pulls.merge({
        ...repo, pull_number: pr.number, sha: pr.head.sha, merge_method: "squash",
      });
      core.info(data.merged ? `Merged validated PR #${pr.number}.` : `PR #${pr.number} is not ready to merge.`);
    } catch (error) {
      if (error.status !== 405 && error.status !== 409) throw error;
      core.info(`PR #${pr.number} changed or is blocked by branch rules; another event can retry.`);
    }
  }
  const baseSha = (await github.rest.git.getRef({ ...repo, ref: `heads/${defaultBranch}` })).data.object.sha;
  async function reachable(sha) {
    try {
      const { data } = await github.rest.repos.compareCommits({ ...repo, base: sha, head: baseSha });
      return data.status === "ahead" || data.status === "identical";
    } catch (error) {
      if (error.status === 404) return false;
      throw error;
    }
  }
  const appPulls = pulls.filter((pr) => ownedPullRequest(pr, repository, defaultBranch, appLogin)
    && pr.head.ref === releaseBranch);
  for (const pr of appPulls.filter((pr) => pr.merged_at)) {
    const plan = planFromBody(pr.body);
    assert.ok(plan, `App release #${pr.number} has no valid release plan`);
    const tag = `v${plan.version}`;
    const existing = await tagCommit(github, repo, tag);
    if (existing !== null) {
      assert.equal(existing, pr.merge_commit_sha, `Tag ${tag} points elsewhere; existing tags are never moved`);
      continue;
    }
    if (!await reachable(pr.merge_commit_sha)) continue;
    const data = await change(pr, releasePaths);
    assert.ok(validReleaseChange(pr, data.files, data.before, data.after, repository, defaultBranch, appLogin),
      `App release #${pr.number} is not a validated version-only change`);
    assert.equal(await checks(pr), "passed", `App release #${pr.number} lacks successful required CI`);
    await ensureTag(github, repo, tag, pr.merge_commit_sha);
  }

  const baseFiles = await read(baseSha);
  const currentVersion = parse(baseFiles, "package.json").version;
  let boundary;
  // The most recent package version change is a persistent release boundary, including manual releases.
  for await (const page of github.paginate.iterator(github.rest.repos.listCommits, {
    ...repo, sha: baseSha, path: "package.json", per_page: 100,
  })) {
    for (const entry of page.data) {
      if (JSON.parse(await file(entry.sha, "package.json")).version !== currentVersion) continue;
      const parent = entry.parents[0]?.sha;
      let previousVersion;
      if (parent) {
        try {
          previousVersion = JSON.parse(await file(parent, "package.json")).version;
        } catch (error) {
          if (error.status !== 404) throw error;
        }
      }
      if (previousVersion !== currentVersion) {
        boundary = entry.sha;
        break;
      }
    }
    if (boundary) break;
  }
  assert.ok(boundary, "Cannot determine the package version's release boundary");
  const dependencies = pulls.filter((pr) => ownedPullRequest(pr, repository, defaultBranch, "dependabot[bot]"));
  const pending = [];
  let dependencyQueueBusy = false;
  for (const pr of dependencies) {
    if (pr.state !== "open" && !pr.merged_at) continue;
    if (pr.merged_at) {
      if (!await reachable(pr.merge_commit_sha)) continue;
      const comparison = (await github.rest.repos.compareCommits({
        ...repo, base: boundary, head: pr.merge_commit_sha,
      })).data;
      if (comparison.status !== "ahead") continue;
    }
    const data = await change(pr);
    if (!compatibleDependencyChange(pr, data.files, data.before, data.after, repository, defaultBranch)) {
      core.info(`Leaving #${pr.number} for manual review: the dependency transition is breaking or unrecognized.`);
      continue;
    }
    if (pr.merged_at) pending.push(pr.number);
    else if (!pr.draft) {
      const state = await checks(pr);
      if (state === "passed") await mergeVerifiedPull(pr);
      if (state !== "failed") dependencyQueueBusy = true;
    }
  }
  if (!pending.length) {
    core.info("No unreleased compatible dependency merges.");
    return;
  }
  if ((await github.rest.git.getRef({ ...repo, ref: `heads/${defaultBranch}` })).data.object.sha !== baseSha) {
    core.info("The default branch advanced; another event will recompute the release from its new contents.");
    return;
  }
  const expected = nextRelease(baseFiles);
  const plan = releasePlan(expected.version, pending);
  const open = pulls.filter((pr) => pr.state === "open" && pr.head?.ref === releaseBranch
    && pr.head?.repo?.full_name === repository);
  assert.ok(open.length <= 1, "Multiple release PRs require manual reconciliation");
  let active = open[0];
  let unchanged = false;
  let existing;
  try {
    existing = (await github.rest.git.getRef({ ...repo, ref: `heads/${releaseBranch}` })).data.object.sha;
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  if (active) {
    if (existing !== active.head.sha) {
      core.info("The release PR and branch snapshots disagree; another event will validate their current contents.");
      return;
    }
    const data = await change(active, releasePaths);
    assert.ok(validReleaseChange(active, data.files, data.before, data.after, repository, defaultBranch, appLogin),
      "The release PR must be App-owned and contain only the expected version changes");
    const commit = (await github.rest.repos.getCommit({ ...repo, ref: active.head.sha })).data;
    unchanged = commit.parents.length === 1 && commit.parents[0].sha === baseSha
      && isDeepStrictEqual(data.after, expected.files);
  } else if (existing) {
    const orphan = (await github.rest.repos.getCommit({ ...repo, ref: existing })).data;
    assert.equal(orphan.author?.login, appLogin, "The reserved release branch is not App-owned");
    assert.equal(orphan.parents.length, 1, "An orphan release branch must be a version-only commit");
    const previous = orphan.parents[0].sha;
    const { data } = await github.rest.repos.compareCommits({ ...repo, base: previous, head: existing });
    const orphanFiles = await read(existing);
    assert.ok(versionOnlyChange(data.files, await read(previous), orphanFiles,
      parse(orphanFiles, "package.json").version), "An orphan release branch must contain only version-only changes");
    unchanged = orphan.parents.length === 1 && orphan.parents[0].sha === baseSha
      && isDeepStrictEqual(orphanFiles, expected.files);
  }
  if (!unchanged) {
    const base = (await github.rest.repos.getCommit({ ...repo, ref: baseSha })).data;
    const tree = (await github.rest.git.createTree({
      ...repo, base_tree: base.commit.tree.sha,
      tree: changedPaths(baseFiles, expected.files)
        .map((path) => ({ path, mode: "100644", type: "blob", content: expected.files[path] })),
    })).data.sha;
    const commit = (await github.rest.git.createCommit({
      ...repo, message: `Release ${expected.version}`, tree, parents: [baseSha],
    })).data.sha;
    if (existing) {
      if ((await github.rest.git.getRef({ ...repo, ref: `heads/${releaseBranch}` })).data.object.sha !== existing) {
        core.info("The release branch changed during reconciliation; its new contents require validation.");
        return;
      }
      await github.rest.git.updateRef({ ...repo, ref: `heads/${releaseBranch}`, sha: commit, force: true });
    } else {
      await github.rest.git.createRef({ ...repo, ref: `refs/heads/${releaseBranch}`, sha: commit });
    }
  }
  if (!active) {
    active = (await github.rest.pulls.create({
      ...repo, head: releaseBranch, base: defaultBranch, title: `Release ${expected.version}`, body: releaseBody(plan),
    })).data;
    // Creation triggers CI. A later event validates the PR and its checks before merging.
    unchanged = false;
  }
  const body = releaseBody(plan);
  if (active.body !== body || active.title !== `Release ${expected.version}`) {
    await github.rest.pulls.update({
      ...repo, pull_number: active.number, title: `Release ${expected.version}`, body,
    });
    active = { ...active, title: `Release ${expected.version}`, body };
  }
  if (unchanged && !dependencyQueueBusy && await checks(active) === "passed") await mergeVerifiedPull(active);
  core.info(`Release ${expected.version} collects dependency PRs ${pending.join(", ")}; `
    + `${unchanged ? "existing version commit retained" : "waiting for CI on the refreshed version commit"}.`);
}
