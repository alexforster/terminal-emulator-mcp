import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const executable = fileURLToPath(new URL("../src/index.js", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

test("help and version run from the distributable without installed dependencies", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "terminal-emulator-mcp-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  cpSync(new URL("../src", import.meta.url), join(directory, "dist/src"), { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({
    ...manifest, name: "terminal-cli-fixture", version: "9.8.7",
  }));
  const installed = join(directory, "dist/src/index.js");
  for (const flag of ["--help", "-h", "--version", "-v"]) {
    const result = spawnSync(process.execPath, [installed, flag], { encoding: "utf8", timeout: 5000 });
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
