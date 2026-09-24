# PTY output validation

`npm run test:pty-output` is an opt-in diagnostic for final-output delivery through `node-pty`. Run it from a repository checkout with dependencies installed. It uses the public `spawn`, `onData`, `onExit`, and `kill` APIs, and compares all received bytes when the exit event arrives. It does not load the MCP server or terminal renderer.

```sh
npm run test:pty-output
npm run test:pty-output -- --iterations 1000 --concurrency 8
npm --silent run test:pty-output -- --iterations 15000 --concurrency 8 > pty-output.jsonl
```

Each iteration runs both cases:

* `split-writes`: a non-login `/bin/sh` process makes two separate `printf` calls, then exits. The expected output includes both lines and the PTY's carriage-return/newline conversion.
* `64k-exit`: a Node child makes synchronous writes of 256-byte blocks totaling 65,536 bytes, then exits immediately. Partial writes are completed before exit. This exercises the large-output-and-close pattern discussed in libuv's [`tty_pty_partial` regression](https://github.com/libuv/libuv/pull/5165#issuecomment-4702391620), using the application's public PTY dependency.

The defaults are 100 iterations per case, at most four simultaneous children, and a five-second timeout for each child. Iterations accept 1–100,000; concurrency accepts 1–32; `--timeout-ms` accepts 1–60,000. Larger runs are deliberate stress work and can take minutes. The probe is separate from `npm test` and ordinary CI; its argument and output-comparison tests are fast and run with the normal suite.

Output is newline-delimited JSON. The start record includes Node, libuv, and `node-pty` versions, platform, architecture, kernel release, configuration, and expected byte counts. The summary includes completed runs, failures, and data-event counts for each case. At most ten detailed failures are printed; all failures remain counted. Output mismatch records include byte counts, the first differing byte offset, bounded expected/received excerpts, process exit information, and output timing.

Exit status 0 means every scheduled case delivered the expected bytes and exited successfully. Status 1 means invalid arguments, output loss or corruption, a child error, timeout, or interruption. Timeouts and SIGINT/SIGTERM kill active children; a one-second cleanup deadline bounds waiting for their exit events. The cases create no descendant processes or temporary files.

## Interpreting results

A passing run is evidence for the recorded runtime, operating system, and workload. It does not prove that PTY output loss is fixed or assign a failure rate to other environments. Repeat runs on the operating systems and runtimes relevant to a release, and keep the JSON records with the validation evidence.

The runtime requirement, Node `^24.16.0 || >=26.0.0`, includes the libuv correction for the reproduced premature-EOF defect: [issue 4992](https://github.com/libuv/libuv/issues/4992) and [fix 4997](https://github.com/libuv/libuv/pull/4997). Node [24.16.0](https://github.com/nodejs/node/blob/v24.16.0/doc/changelogs/CHANGELOG_V24.md) and 26.0.0 bundle libuv 1.52.1, which contains that correction.

A separate [hangup-without-readable fix, 5165](https://github.com/libuv/libuv/pull/5165), is included in libuv 1.53.0. Node 24.21.0 and 26.10.0 bundle libuv 1.52.1 and contain only the first correction. A runtime carrying libuv 1.53.0 or a backport of fix 5165 includes both upstream corrections. The runtime requirement and a passing probe do not establish that the second correction is present; inspect the runtime's bundled libuv version and release/source history.
