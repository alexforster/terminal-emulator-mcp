import assert from "node:assert/strict";
import test from "node:test";
import { outputDifference, parseOptions } from "./probe-pty-output.mjs";

test("probe arguments reject unbounded or ambiguous workloads before starting children", () => {
  assert.deepEqual(parseOptions(["--iterations", "12", "--concurrency", "3", "--timeout-ms", "100"]), {
    iterations: 12, concurrency: 3, timeoutMs: 100, help: false,
  });
  for (const args of [
    ["--iterations", "0"], ["--iterations", "100001"], ["--iterations", "1.5"],
    ["--iterations", "Infinity"], ["--concurrency", "0"], ["--concurrency", "33"],
    ["--timeout-ms", "0"], ["--timeout-ms", "60001"], ["--iterations"], ["--unknown"], ["12"],
  ]) assert.throws(() => parseOptions(args), undefined, args.join(" "));
});

test("output checks detect missing final bytes and same-length corruption", () => {
  assert.equal(outputDifference("first\r\nlast\r\n", "first\r\nlast\r\n"), null);
  const truncated = outputDifference("first\r\nlast\r\n", "first\r\n");
  assert.equal(truncated.expectedBytes, 13);
  assert.equal(truncated.receivedBytes, 7);
  assert.equal(truncated.firstDifference, 7);
  assert.equal(truncated.expectedAtDifference, "last\r\n");
  assert.equal(truncated.receivedAtDifference, "");

  const corrupt = outputDifference("0123456789", "012X456789");
  assert.equal(corrupt.firstDifference, 3);
  assert.equal(corrupt.receivedAtDifference, "X456789");
});

test("failure details stay bounded while preserving the full received byte count", () => {
  const difference = outputDifference("a".repeat(65536), "b".repeat(65537), 1_000_000);
  assert.equal(difference.receivedBytes, 1_000_000);
  assert.equal(difference.firstDifference, 0);
  assert.ok(difference.expectedAtDifference.length <= 96);
  assert.ok(difference.receivedAtDifference.length <= 96);
  assert.ok(JSON.stringify(difference).length < 1000);
  assert.equal(outputDifference("abc", "abcd").firstDifference, 3);
});
