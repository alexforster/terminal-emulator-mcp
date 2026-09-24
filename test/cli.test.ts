import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";

const executable = fileURLToPath(new URL("../src/index.js", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

function distributable(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "terminal-emulator-mcp-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  cpSync(new URL("../src", import.meta.url), join(directory, "dist/src"), { recursive: true });
  return directory;
}

function nodeVersionArgs(version: string): string[] {
  const script = `Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(version)} });`;
  return ["--import", `data:text/javascript,${encodeURIComponent(script)}`];
}

test("help and version work on unsupported Node versions without installed dependencies", (t) => {
  const directory = distributable(t);
  writeFileSync(join(directory, "package.json"), JSON.stringify({
    ...manifest, name: "terminal-cli-fixture", version: "9.8.7",
  }));
  const installed = join(directory, "dist/src/index.js");
  for (const flag of ["--help", "-h", "--version", "-v"]) {
    const result = spawnSync(process.execPath, [...nodeVersionArgs("22.23.2"), installed, flag], {
      encoding: "utf8", timeout: 5000,
    });
    assert.equal(result.status, 0, `${flag}: ${result.stderr}`);
    assert.equal(result.stderr, "");
    if (flag === "--version" || flag === "-v") {
      assert.equal(result.stdout, "9.8.7\n");
    } else {
      assert.match(result.stdout, /terminal-cli-fixture/);
      assert.match(result.stdout, /9\.8\.7/);
      assert.match(result.stdout, /stdio/);
      assert.match(result.stdout, /--help/);
      assert.match(result.stdout, /--version/);
    }
  }
});

test("unsupported Node versions fail before loading the server or native dependencies", (t) => {
  const directory = distributable(t);
  cpSync(new URL("../../node_modules/semver", import.meta.url), join(directory, "node_modules/semver"), {
    recursive: true,
  });
  writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
  const installed = join(directory, "dist/src/index.js");
  for (const version of ["22.23.2", "24.15.0", "25.0.0", "25.9.0", "26.0.0-rc.1"]) {
    const result = spawnSync(process.execPath, [...nodeVersionArgs(version), installed], {
      encoding: "utf8", timeout: 5000,
    });
    assert.equal(result.status, 1, `${version}: ${result.stderr}`);
    assert.equal(result.stdout, "");
    assert.ok(result.stderr.includes(version), result.stderr);
    assert.ok(result.stderr.includes("^24.16.0 || >=26.0.0"), result.stderr);
    assert.match(result.stderr, /upgrade/i);
  }
});

test("runtime requirements come from the installed package manifest", (t) => {
  const directory = distributable(t);
  cpSync(new URL("../../node_modules/semver", import.meta.url), join(directory, "node_modules/semver"), {
    recursive: true,
  });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ ...manifest, engines: { node: ">=99.0.0" } }));
  const result = spawnSync(process.execPath, [...nodeVersionArgs("26.0.0"), join(directory, "dist/src/index.js")], {
    encoding: "utf8", timeout: 5000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, "");
  assert.ok(result.stderr.includes(">=99.0.0"), result.stderr);
  assert.ok(result.stderr.includes("26.0.0"), result.stderr);
});

test("supported Node versions start and shut down the stdio server", () => {
  for (const version of ["24.16.0", "24.21.0", "26.0.0", "27.0.0"]) {
    const result = spawnSync(process.execPath, [...nodeVersionArgs(version), executable], {
      encoding: "utf8", input: "", timeout: 5000,
    });
    assert.equal(result.status, 0, `${version}: ${result.stderr}`);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  }
});

test("unknown options and positional arguments fail with diagnostics on stderr", () => {
  for (const argument of ["--unknown", "unexpected", "--version=unexpected"]) {
    const result = spawnSync(process.execPath, [executable, argument], { encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 1, `${argument}: ${result.stderr}`);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /--help/);
    assert.ok(result.stderr.includes(argument.split("=")[0]), result.stderr);
  }
});

test("the published CLI version matches the package manifest", () => {
  const result = spawnSync(process.execPath, [executable, "--version"], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${manifest.version}\n`);
  assert.equal(result.stderr, "");
});
