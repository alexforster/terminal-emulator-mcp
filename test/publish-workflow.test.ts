import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

const workflow = readFileSync(new URL("../../.github/workflows/publish.yml", import.meta.url), "utf8");

function scriptFor(step: string): string {
  const start = workflow.indexOf(`- name: ${step}\n`);
  assert.ok(start >= 0, `Missing workflow step: ${step}`);
  const script = workflow.slice(start).match(/node --input-type=module <<'NODE'\n([\s\S]*?)\n          NODE/);
  assert.ok(script, `Missing Node script in ${step}`);
  return script[1];
}

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "terminal-emulator-mcp-release-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = join(directory, "bin");
  mkdirSync(bin);
  function command(name: string, source: string) {
    writeFileSync(join(bin, name), `#!${process.execPath}\n${source}`, { mode: 0o755 });
  }
  function run(script: string, environment: Record<string, string>) {
    return spawnSync(process.execPath, ["--input-type=module"], {
      input: script, encoding: "utf8", cwd: directory, timeout: 10_000,
      env: {
        ...process.env, PATH: `${bin}${delimiter}${dirname(process.execPath)}`,
        GITHUB_OUTPUT: join(directory, "output"), GITHUB_STEP_SUMMARY: join(directory, "summary"),
        RUNNER_TEMP: directory, NPM_PUBLISH_ENABLED: "", ...environment,
      },
    });
  }
  return { directory, command, run };
}

const metadata = scriptFor("Validate release identity");

for (const { version, distTag } of [
  { version: "1.0.0", distTag: "latest" },
  { version: "1.0.0-rc.1", distTag: "preview" },
  { version: "1.0.0+build.1", distTag: null },
  { version: "1.0.0-rc.1+build.1", distTag: null },
]) {
  test(`release identity ${distTag ? "accepts" : "rejects"} ${version}`, (t) => {
    const { directory, command, run } = fixture(t);
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "terminal-emulator-mcp", version }));
    command("git", 'console.log("release-commit");');
    const result = run(metadata, {
      EVENT_NAME: "push", EVENT_REF: `refs/tags/v${version}`, SELECTED_REF: `refs/tags/v${version}`,
      GITHUB_SHA: "release-commit", NPM_PUBLISH_ENABLED: "true",
    });
    assert.ifError(result.error);
    const output = join(directory, "output");
    if (distTag === null) {
      assert.notEqual(result.status, 0, result.stdout);
      assert.match(result.stderr, /without build metadata/);
      assert.equal(existsSync(output), false, "Rejected versions must not enable the publication job");
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.match(readFileSync(output, "utf8"), /publish=true\n/);
      assert.ok(readFileSync(output, "utf8").includes(`dist_tag=${distTag}\n`));
    }
  });
}

for (const scenario of [
  { name: "rejects a moved tag on an old workflow event", head: "replacement", tag: "replacement", event: "original" },
  { name: "rejects a tag moved away from the event commit", head: "original", tag: "replacement", event: "original" },
  { name: "accepts the immutable event commit and matching tag", head: "original", tag: "original", event: "original" },
  { name: "resolves an annotated event tag to its commit", head: "original", tag: "original", event: "original" },
]) {
  test(`release metadata ${scenario.name}`, (t) => {
    const { directory, command, run } = fixture(t);
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "terminal-emulator-mcp", version: "0.9.0" }));
    command("git", `
const ref = process.argv.at(-1);
const commits = {
  "HEAD^{commit}": process.env.HEAD_COMMIT,
  "refs/tags/v0.9.0^{commit}": process.env.TAG_COMMIT,
  [process.env.GITHUB_SHA + "^{commit}"]: process.env.EVENT_COMMIT,
};
if (!commits[ref]) throw new Error("Unexpected git revision: " + ref);
console.log(commits[ref]);
`);
    const result = run(metadata, {
      EVENT_NAME: "push", EVENT_REF: "refs/tags/v0.9.0", SELECTED_REF: "refs/tags/v0.9.0",
      GITHUB_SHA: scenario.name.includes("annotated") ? "annotated-tag-object" : scenario.event,
      HEAD_COMMIT: scenario.head, TAG_COMMIT: scenario.tag, EVENT_COMMIT: scenario.event,
      NPM_PUBLISH_ENABLED: "true",
    });
    assert.ifError(result.error);
    if (scenario.head !== scenario.event || scenario.tag !== scenario.event) {
      assert.notEqual(result.status, 0, result.stdout);
      assert.match(result.stderr, /Checked-out commit must match/);
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.match(readFileSync(join(directory, "output"), "utf8"), /publish=true\n/);
      assert.match(readFileSync(join(directory, "output"), "utf8"), /commit=original\n/);
    }
  });
}

test("a manual dry run may validate a commit other than the workflow event", (t) => {
  const { directory, command, run } = fixture(t);
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "terminal-emulator-mcp", version: "0.9.0" }));
  command("git", `
if (process.argv.at(-1) !== "HEAD^{commit}") throw new Error("Dry run unexpectedly resolved a release tag");
console.log("selected-commit");
`);
  const result = run(metadata, {
    EVENT_NAME: "workflow_dispatch", DRY_RUN: "true", EVENT_REF: "refs/heads/main",
    SELECTED_REF: "other-branch", GITHUB_SHA: "event-commit",
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(directory, "output"), "utf8"), /publish=false\n/);
  assert.match(readFileSync(join(directory, "output"), "utf8"), /candidate=false\n/);
});

const publication = scriptFor("Verify artifact and publish with npm OIDC");
const timersImport = 'import { setTimeout as delay } from "node:timers/promises";';
assert.ok(publication.includes(timersImport));
// Registry propagation is simulated; preserve and verify the production delay without sleeping in tests.
const immediatePublication = publication.replace(timersImport, "const delay = async (ms) => assert.equal(ms, 10_000);");

for (const enabled of ["", "false", "TRUE", "1", " true ", "true"]) {
  for (const event of ["push", "workflow_dispatch"]) {
    test(`npm permission ${JSON.stringify(enabled)} cannot override release identity for ${event}`, (t) => {
      const { directory, command, run } = fixture(t);
      writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "terminal-emulator-mcp", version: "0.9.0" }));
      command("git", 'console.log("release-commit");');
      const result = run(metadata, {
        EVENT_NAME: event, DRY_RUN: "false", EVENT_REF: "refs/tags/v0.9.0", SELECTED_REF: "v0.9.0",
        GITHUB_SHA: "release-commit", NPM_PUBLISH_ENABLED: enabled,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      const output = readFileSync(join(directory, "output"), "utf8");
      assert.match(output, /candidate=true\n/);
      assert.ok(output.includes(`publish=${enabled === "true"}\n`), output);
    });
  }
}

test("disabled npm still rejects an event commit that does not match its tag", (t) => {
  const { directory, command, run } = fixture(t);
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "terminal-emulator-mcp", version: "0.9.0" }));
  command("git", 'console.log(process.argv.at(-1) === "event-commit^{commit}" ? "event-commit" : "moved-tag");');
  const result = run(metadata, {
    EVENT_NAME: "push", EVENT_REF: "refs/tags/v0.9.0", SELECTED_REF: "refs/tags/v0.9.0",
    GITHUB_SHA: "event-commit", NPM_PUBLISH_ENABLED: "false",
  });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /immutable workflow event commit/);
  assert.equal(existsSync(join(directory, "output")), false);
});

for (const enabled of ["", "false", "TRUE", "1", " true "]) {
  test(`publication script rejects npm permission ${JSON.stringify(enabled)} before registry access`, (t) => {
    const { directory, command, run } = fixture(t);
    mkdirSync(join(directory, "release"));
    const bytes = Buffer.from("exact tested tarball");
    writeFileSync(join(directory, "release", "package.tgz"), bytes);
    command("npm", 'require("node:fs").writeFileSync("registry-access", ""); process.exitCode = 2;');
    const result = run(immediatePublication, {
      NPM_PUBLISH_ENABLED: enabled, PACKAGE_FILENAME: "package.tgz", PACKAGE_VERSION: "0.9.0", DIST_TAG: "preview",
      PACKAGE_INTEGRITY: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    });
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /NPM_PUBLISH_ENABLED must equal true/);
    assert.equal(existsSync(join(directory, "registry-access")), false);
  });
}

for (const scenario of [
  { name: "existing matching tag", existing: true, target: "0.9.0", success: true },
  { name: "existing missing latest", existing: true, target: "", success: false, version: "1.0.0", distTag: "latest" },
  { name: "existing older tag", existing: true, target: "0.8.0", success: false },
  { name: "existing newer tag", existing: true, target: "1.0.0", success: false },
  { name: "fresh matching tag", existing: false, target: "0.9.0", success: true },
  { name: "fresh delayed tag", existing: false, target: "0.8.0", success: true, confirmAfter: 3 },
  { name: "fresh missing tag", existing: false, target: "", success: false },
  { name: "fresh different tag", existing: false, target: "1.0.0", success: false },
]) {
  test(`release publication verifies the distribution tag: ${scenario.name}`, (t) => {
    const { directory, command, run } = fixture(t);
    const version = scenario.version ?? "0.9.0";
    mkdirSync(join(directory, "release"));
    const bytes = Buffer.from("exact tested tarball");
    writeFileSync(join(directory, "release", "package.tgz"), bytes);
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    command("npm", `
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
appendFileSync("calls", JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv[2] === "publish") {
  writeFileSync("published", "");
} else if (process.argv[2] === "view" && process.argv[4] === "dist.integrity") {
  if (process.env.EXISTING === "false" && !existsSync("published")) {
    console.log(JSON.stringify({ error: { code: "E404" } }));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(process.env.PACKAGE_INTEGRITY));
  }
} else if (process.argv[2] === "view" && process.argv[4] === "dist-tags") {
  const queries = existsSync("tag-queries") ? Number(readFileSync("tag-queries", "utf8")) + 1 : 1;
  writeFileSync("tag-queries", String(queries));
  const target = queries >= Number(process.env.CONFIRM_AFTER) ? process.env.PACKAGE_VERSION : process.env.TAG_TARGET;
  console.log(JSON.stringify(target ? { [process.env.DIST_TAG]: target } : {}));
} else {
  throw new Error("Unexpected npm command: " + process.argv.slice(2).join(" "));
}
`);
    const result = run(immediatePublication, {
      PACKAGE_FILENAME: "package.tgz", PACKAGE_VERSION: version, PACKAGE_INTEGRITY: integrity,
      DIST_TAG: scenario.distTag ?? "preview", EXISTING: String(scenario.existing), TAG_TARGET: scenario.target,
      CONFIRM_AFTER: String(scenario.confirmAfter ?? 100),
      NPM_PUBLISH_ENABLED: "true",
    });
    assert.ifError(result.error);
    assert.equal(result.status === 0, scenario.success, `${result.stdout}\n${result.stderr}`);
    if (!scenario.success) assert.match(result.stderr, /No distribution tag was repaired/);
    const lines = readFileSync(join(directory, "calls"), "utf8").trim().split("\n");
    const calls: string[][] = lines.map((line) => JSON.parse(line));
    const publishCalls = calls.filter((args) => args[0] === "publish");
    assert.equal(publishCalls.length, scenario.existing ? 0 : 1);
    if (!scenario.existing) assert.equal(publishCalls[0][1], join(directory, "release", "package.tgz"));
    assert.ok(calls.every((args) => args[0] === "view" || args[0] === "publish"), "Tags must never be repaired");
    const tagQueries = Number(readFileSync(join(directory, "tag-queries"), "utf8"));
    assert.equal(tagQueries, scenario.existing || scenario.target === version ? 1 : scenario.confirmAfter ?? 31);
  });
}

for (const scenario of [
  { name: "visibility after more than one minute", visibleAfter: 8, mismatch: false, expectedQueries: 8, success: true },
  { name: "visibility beyond the five-minute budget", visibleAfter: 32, mismatch: false, expectedQueries: 31, success: false },
  { name: "mismatched bytes immediately visible", visibleAfter: 1, mismatch: true, expectedQueries: 1, success: false },
]) {
  test(`registry publication propagation: ${scenario.name}`, (t) => {
    const { directory, command, run } = fixture(t);
    mkdirSync(join(directory, "release"));
    const bytes = Buffer.from("exact tested tarball");
    writeFileSync(join(directory, "release", "package.tgz"), bytes);
    command("npm", `
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
appendFileSync("calls", JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv[2] === "publish") {
  writeFileSync("queries", "0");
} else if (process.argv[2] === "view" && process.argv[4] === "dist.integrity") {
  const queries = existsSync("queries") ? Number(readFileSync("queries", "utf8")) + 1 : 0;
  if (queries) writeFileSync("queries", String(queries));
  if (queries < Number(process.env.VISIBLE_AFTER)) {
    console.log(JSON.stringify({ error: { code: "E404" } }));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(process.env.MISMATCH === "true" ? "sha512-wrong" : process.env.PACKAGE_INTEGRITY));
  }
} else if (process.argv[2] === "view" && process.argv[4] === "dist-tags") {
  console.log(JSON.stringify({ preview: "0.9.1" }));
} else {
  throw new Error("Unexpected npm command: " + process.argv.slice(2).join(" "));
}
`);
    const result = run(immediatePublication, {
      NPM_PUBLISH_ENABLED: "true", PACKAGE_FILENAME: "package.tgz", PACKAGE_VERSION: "0.9.1", DIST_TAG: "preview",
      PACKAGE_INTEGRITY: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      VISIBLE_AFTER: String(scenario.visibleAfter), MISMATCH: String(scenario.mismatch),
    });
    assert.ifError(result.error);
    assert.equal(result.status === 0, scenario.success, result.stderr);
    if (!scenario.success) {
      assert.match(result.stderr, scenario.mismatch ? /different package bytes/ : /Registry must confirm/);
    }
    assert.equal(Number(readFileSync(join(directory, "queries"), "utf8")), scenario.expectedQueries);
    const calls: string[][] = readFileSync(join(directory, "calls"), "utf8").trim().split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(calls.filter((args) => args[0] === "publish").length, 1, "Polling must never republish");
    assert.ok(calls.every((args) => args[0] === "view" || args[0] === "publish"), "Tags must never be repaired");
  });
}

function jobRuns(job: string, needs: Record<string, { result: string; outputs?: Record<string, string> }>,
  vars: Record<string, string> = {}, cancelled = false): boolean {
  const start = workflow.indexOf(`\n  ${job}:\n`);
  assert.ok(start >= 0, `Missing job: ${job}`);
  const source = workflow.slice(start + 1).split(/\n  [\w-]+:\n/)[0];
  const dependencies = source.match(/^    needs: (.+)$/m)?.[1].replace(/[[\]]/g, "").split(/,\s*/) ?? [];
  const condition = source.match(/^    if: (.+)(?:\n {6}.+)*/m)?.[0]
    .replace(/^    if: (?:>-\n)?/, "").replace(/\$\{\{|\}\}/g, "").trim() ?? "success()";
  const success = () => dependencies.every((name) => needs[name]?.result === "success");
  // These workflow conditions use boolean operators and context properties; status functions override implicit success().
  if (!/\b(success|failure|always|cancelled)\(/.test(condition) && !success()) return false;
  const javascript = condition.replace(/\bneeds\.([\w-]+)/g, 'needs["$1"]');
  return new Function("needs", "vars", "success", "cancelled", `return Boolean(${javascript});`)
    (needs, vars, success, () => cancelled) as boolean;
}

for (const enabled of ["", "false", "true"]) {
  test(`publish job independently gates npm permission ${JSON.stringify(enabled)}`, () => {
    const needs = { prepare: { result: "success", outputs: { publish: "true" } }, "test-package": { result: "success" } };
    assert.equal(jobRuns("publish", needs, { NPM_PUBLISH_ENABLED: enabled }), enabled === "true");
  });
}

for (const scenario of [
  { name: "tested candidate with npm disabled", candidate: "true", requested: "false", npm: "skipped", want: true },
  { name: "verified npm publication", candidate: "true", requested: "true", npm: "success", want: true },
  { name: "branch dry run", candidate: "false", requested: "false", npm: "skipped", want: false },
  { name: "failed artifact tests", candidate: "true", requested: "false", npm: "skipped", tests: "failure", want: false },
  { name: "failed prepare", candidate: "true", requested: "false", npm: "skipped", prepare: "failure", want: false },
  { name: "failed npm verification", candidate: "true", requested: "true", npm: "failure", want: false },
  { name: "unexpected skipped publication", candidate: "true", requested: "true", npm: "skipped", want: false },
  { name: "cancelled workflow", candidate: "true", requested: "false", npm: "skipped", cancelled: true, want: false },
]) {
  test(`GitHub release job requires a tested candidate: ${scenario.name}`, () => {
    assert.equal(jobRuns("github-release", {
      prepare: {
        result: scenario.prepare ?? "success",
        outputs: { candidate: scenario.candidate, publish: scenario.requested },
      },
      "test-package": { result: scenario.tests ?? "success" },
      publish: { result: scenario.npm },
    }, {}, scenario.cancelled), scenario.want);
  });
}

const candidateNotice = "<!-- npm-release-candidate -->\n"
  + "npm publication has not occurred for this release candidate.\n<!-- /npm-release-candidate -->";

for (const scenario of [
  { name: "create disabled candidate", existing: null, npm: "skipped", action: "create", draft: true },
  { name: "refresh disabled candidate on a later API page", existing: "draft", npm: "skipped", action: "edit", draft: true },
  { name: "preserve public release with npm disabled", existing: "public", npm: "skipped", action: null, draft: false },
  { name: "finalize verified preview on a later API page", existing: "draft", npm: "success", action: "edit", draft: false },
  { name: "create verified stable", existing: null, npm: "success", action: "create", draft: false, tag: "latest" },
  { name: "preserve verified public release", existing: "public", npm: "success", action: null, draft: false },
  { name: "stop on API denial", existing: null, npm: "skipped", action: null, draft: true, status: 403 },
  { name: "stop on inaccessible repository", existing: null, npm: "skipped", action: null, draft: true, status: 404 },
  { name: "stop on failed verification", existing: "draft", npm: "failure", action: null, draft: true },
]) {
  test(`GitHub release reconciliation: ${scenario.name}`, (t) => {
    const releaseScript = scriptFor("Reconcile the tested GitHub Release");
    const { directory, command, run } = fixture(t);
    const existingBody = `${candidateNotice}\n\nHuman release notes.`;
    command("gh", `
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync("github-calls", JSON.stringify(args) + "\\n");
if (args[0] === "api") {
  const release = {
    id: 42, tag_name: "v0.9.0", draft: process.env.EXISTING === "draft", body: process.env.EXISTING_BODY,
    name: "v0.9.0", prerelease: true, target_commitish: "release-commit"
  };
  let status = Number(process.env.API_STATUS);
  if (args.at(-1) === "repos/owner/repository/releases/tags/v0.9.0") {
    // The published-tag endpoint cannot discover a draft's pending tag.
    if (status === 200 && process.env.EXISTING !== "public") status = 404;
    console.log("HTTP/2.0 " + status + " Status\\r\\nx-github-request-id: fixture\\r\\n\\r\\n"
      + JSON.stringify(status === 200 ? release : { message: "API error", status: String(status) }));
  } else {
    require("node:assert/strict").deepEqual(args,
      ["api", "--paginate", "--slurp", "--method", "GET", "repos/owner/repository/releases?per_page=100"]);
    const unrelated = { ...release, id: 41, tag_name: "v0.8.0", draft: false };
    const pages = [[unrelated], process.env.EXISTING ? [release] : []];
    console.log(JSON.stringify(status === 200 ? pages : { message: "API error", status: String(status) }));
  }
  process.exitCode = status === 200 ? 0 : 1;
} else if (args[0] !== "release" || !["create", "edit"].includes(args[1])) {
  throw new Error("Unexpected GitHub operation: " + args.join(" "));
}
`);
    const result = run(releaseScript, {
      GH_REPO: "owner/repository", RELEASE_TAG: "v0.9.0", RELEASE_CANDIDATE: "true",
      DIST_TAG: scenario.tag ?? "preview", PUBLISH_RESULT: scenario.npm,
      PUBLISH_REQUESTED: scenario.npm === "skipped" ? "false" : "true",
      EXISTING: scenario.existing ?? "", EXISTING_BODY: existingBody,
      API_STATUS: String(scenario.status ?? 200),
    });
    assert.ifError(result.error);
    assert.equal(result.status === 0, !scenario.status && scenario.npm !== "failure", result.stderr);
    const callsPath = join(directory, "github-calls");
    const calls: string[][] = existsSync(callsPath)
      ? readFileSync(callsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
    const mutations = calls.filter((args) => args[0] === "release");
    assert.equal(mutations.length, scenario.action ? 1 : 0);
    if (!scenario.action) return;
    const args = mutations[0];
    assert.deepEqual(args.slice(0, 3), ["release", scenario.action, "v0.9.0"]);
    if (scenario.action === "create" || !scenario.draft) {
      assert.ok(args.includes(`--draft=${scenario.draft}`), args.join(" "));
    } else {
      assert.ok(!args.includes("--draft=true"), "Draft updates must never demote a concurrently published release");
    }
    assert.ok(args.includes(`--prerelease=${scenario.tag !== "latest"}`), args.join(" "));
    assert.ok(args.includes(`--latest=${!scenario.draft && scenario.tag === "latest"}`), args.join(" "));
    assert.ok(args.includes("--notes-file"));
    const notes = readFileSync(args[args.indexOf("--notes-file") + 1], "utf8");
    if (scenario.draft) {
      assert.match(notes, /npm publication has not occurred/);
      assert.equal(notes.match(/<!-- npm-release-candidate -->/g)?.length, 1);
    } else {
      assert.doesNotMatch(notes, /npm publication has not occurred|npm-release-candidate/);
    }
    if (scenario.existing) assert.match(notes, /Human release notes\./);
    else assert.ok(args.includes("--verify-tag") && args.includes("--generate-notes"));
  });
}
