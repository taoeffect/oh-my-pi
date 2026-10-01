#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants } from "node:os";

import { downloadBinary, findBinary, readPackageJson } from "./lib.js";

// The terminal sends these to the whole foreground process group, so omp already gets them.
// The wrapper only has to survive them until omp exits.
const GROUP_SIGNALS = ["SIGINT", "SIGQUIT"];
// These usually target the wrapper's pid alone (`kill`, process managers), so pass them on.
const FORWARDED_SIGNALS = ["SIGTERM", "SIGHUP"];

function fail(message) {
	process.stderr.write(`omp (@taoeffects/omp): ${message}\n`);
	process.exit(1);
}

async function resolveBinary() {
	const packageJson = await readPackageJson();
	const installed = await findBinary(packageJson.version);
	if (installed) return installed;
	// npm 12 skips install scripts by default, so the first run downloads the binary instead.
	return downloadBinary(packageJson, { log: message => process.stderr.write(`omp: ${message}\n`) });
}

function run(binary) {
	const child = spawn(binary, process.argv.slice(2), {
		stdio: "inherit",
		// omp runs `npm install -g` on update only when this equals its parent pid. Processes that omp
		// starts inherit the variable, but their parent is not this launcher.
		env: { ...process.env, OMP_TAOEFFECTS_NPM_WRAPPER: String(process.pid) },
	});

	const handlers = new Map();
	for (const signal of GROUP_SIGNALS) handlers.set(signal, () => {});
	for (const signal of FORWARDED_SIGNALS) handlers.set(signal, () => child.kill(signal));
	for (const [signal, handler] of handlers) process.on(signal, handler);

	child.on("error", error => fail(`failed to start ${binary}: ${error.message}`));
	child.on("exit", (code, signal) => {
		for (const [name, handler] of handlers) process.off(name, handler);
		if (signal) {
			process.kill(process.pid, signal);
			// Reached only when the signal does not end this process (Node ignores SIGPIPE, for example).
			process.exit(128 + (constants.signals[signal] ?? 0));
		}
		process.exit(code ?? 1);
	});
}

resolveBinary().then(run, error => fail(error.message));
