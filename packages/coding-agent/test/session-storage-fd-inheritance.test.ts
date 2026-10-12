/**
 * Descriptors omp holds for its own lifetime — session/advisor transcripts and
 * the rotating log — must not reach the commands the bash tool runs.
 *
 * The bash tool executes through the natives brush shell, which `fork`/`exec`s
 * external commands and therefore hands every inheritable descriptor to them
 * (the same property pinned by `config-value-fd-inheritance.test.ts`). Bun's
 * `fs.open*` omits `O_CLOEXEC` where libuv adds it, so before #13224 a command
 * — or any daemon it started — held a writable handle to the session it was
 * launched from for its whole life.
 *
 * Oracle: list the child's descriptor table. `sh -c` is required — a bare `ls`
 * resolves to an in-process builtin, whose `$$` is omp itself. A deliberately
 * inheritable control descriptor (the pre-fix writer's `fs.openSync(path, "a")`,
 * with close-on-exec cleared because Bun ≥1.4.3 sets it like libuv) runs in the
 * same child so the assertions cannot pass vacuously. /proc makes this
 * Linux-only; the helper's flag handling is covered on every platform by
 * `packages/utils/test/fs-open.test.ts`.
 */
import { afterAll, expect, test } from "bun:test";
import { dlopen, FFIType } from "bun:ffi";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Shell } from "@oh-my-pi/pi-natives";
import { RotatingFileSink } from "@oh-my-pi/pi-utils/logger/rotating-file";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { FileSessionStorage } from "../src/session/session-storage";

const ROOTS: string[] = [];

/** `fcntl(2)` command that replaces a descriptor's flags (`FD_CLOEXEC`). */
const F_SETFD = 2;

const FCNTL_SYMBOLS = {
	fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
} as const;

function openLibc() {
	// glibc first, then the generic soname for musl-style layouts (see process-name.ts).
	for (const soname of ["libc.so.6", "libc.so"]) {
		try {
			return dlopen(soname, FCNTL_SYMBOLS);
		} catch {}
	}
	throw new Error("failed to load libc for fcntl");
}

/** Opens `filePath` for append the way pre-#13224 Bun did: inheritable across `exec`. */
function openInheritableSync(filePath: string): number {
	const fd = fs.openSync(filePath, "a");
	const libc = openLibc();
	try {
		if (libc.symbols.fcntl(fd, F_SETFD, 0) !== 0) throw new Error(`fcntl(F_SETFD) failed for fd ${fd}`);
	} finally {
		libc.close();
	}
	return fd;
}

afterAll(async () => {
	for (const root of ROOTS) await removeWithRetries(root).catch(() => {});
});

test.skipIf(process.platform !== "linux")("bash tool children never inherit session or log descriptors", async () => {
	const root = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-session-fd-"));
	ROOTS.push(root);

	const storage = new FileSessionStorage();
	const transcript = path.join(root, "session.jsonl");
	const writer = storage.openWriter(transcript);
	await writer.append('{"type":"session_start"}\n');

	const logsDir = path.join(root, "logs");
	await fsp.mkdir(logsDir, { recursive: true });
	const logSink = new RotatingFileSink({
		directory: logsDir,
		filenamePrefix: "omp",
		filenameSuffix: String(process.pid),
		maxBytes: 1 << 20,
		maxFiles: 2,
	});
	logSink.write("entry");

	const control = path.join(root, "control.jsonl");
	const controlFd = openInheritableSync(control);

	let output = "";
	try {
		await new Shell().run({ command: "sh -c 'ls -l /proc/$$/fd'", cwd: root }, (_err, chunk) => {
			output += chunk;
		});
	} finally {
		fs.closeSync(controlFd);
		logSink.close();
		await writer.close();
	}

	const inherited = output.split("\n").filter(line => line.includes(root));
	expect(inherited.join("\n"), "control: an inheritable descriptor must reach the child").toContain(control);
	expect(inherited.join("\n")).not.toContain(transcript);
	expect(inherited.join("\n")).not.toMatch(/omp\.[\d-]+\.\d+\.log/);
});
