import { createHash } from "node:crypto";
import { createWriteStream, rmSync } from "node:fs";
import { access, chmod, constants, mkdir, mkdtemp, readdir, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import * as tar from "tar";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const vendorBinaryPath = join(packageRoot, "vendor", "omp", "omp");

const PLATFORM_KEYS = new Map([
	["linux:x64", "linux-x64"],
	["linux:arm64", "linux-arm64"],
	["darwin:x64", "darwin-x64"],
	["darwin:arm64", "darwin-arm64"],
]);
const PATH_SEGMENT = /^[\w.+-]+$/;
const SHA256_HEX = /^[0-9a-f]{64}$/i;
const PERMISSION_ERROR_CODES = new Set(["EACCES", "EPERM", "EROFS"]);
// The signals that a terminal or a process manager sends. Each one ends Node by default.
const INTERRUPT_SIGNALS = ["SIGINT", "SIGQUIT", "SIGTERM", "SIGHUP"];

function platformKey() {
	const key = PLATFORM_KEYS.get(`${process.platform}:${process.arch}`);
	if (!key) throw new Error(`Unsupported platform: ${process.platform}/${process.arch}`);
	return key;
}

export async function readPackageJson() {
	return JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
}

function cacheRoot() {
	const xdgCacheHome = process.env.XDG_CACHE_HOME;
	const base = xdgCacheHome && isAbsolute(xdgCacheHome) ? xdgCacheHome : join(homedir(), ".cache");
	return join(base, "taoeffects-omp");
}

function cacheBinaryPath(version) {
	assertPathSegment(version, "package version");
	return join(cacheRoot(), version, "omp");
}

/** Returns the installed binary path, or `undefined` when neither the vendor nor the cache copy exists. */
export async function findBinary(version) {
	for (const path of [vendorBinaryPath, cacheBinaryPath(version)]) {
		try {
			await access(path, constants.X_OK);
			return path;
		} catch {}
	}
	return undefined;
}

function archiveFor(packageJson, key) {
	const archive = packageJson.ompBinary?.archives?.[key];
	if (!archive) throw new Error(`${packageJson.name}@${packageJson.version} has no omp binary for ${key}`);
	validateArchive(archive);
	return archive;
}

function validateArchive(archive) {
	for (const field of ["name", "wrappedIn", "bin"]) assertPathSegment(archive[field], `archive ${field}`);
	const protocol = URL.canParse(archive.url) ? new URL(archive.url).protocol : undefined;
	if (protocol !== "https:" && protocol !== "http:") throw new Error(`Invalid archive url: ${archive.url}`);
	if (archive.checksum?.algorithm !== "sha256") throw new Error("Archive checksum algorithm must be sha256");
	if (!SHA256_HEX.test(archive.checksum.digest ?? "")) throw new Error("Archive checksum digest must be SHA-256 hex");
}

function assertPathSegment(value, label) {
	if (typeof value !== "string" || !PATH_SEGMENT.test(value) || value === "." || value === "..") {
		throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
	}
}

/**
 * Downloads the platform archive, verifies its SHA-256, and moves the binary into place.
 * Installs into `vendor/` when the package directory is writable, otherwise into the user cache.
 */
export async function downloadBinary(packageJson, { log = () => {} } = {}) {
	const key = platformKey();
	const archive = archiveFor(packageJson, key);
	let destination = vendorBinaryPath;
	let workDir;
	try {
		workDir = await createWorkDir(destination);
	} catch (error) {
		if (!PERMISSION_ERROR_CODES.has(error?.code)) throw error;
		destination = cacheBinaryPath(packageJson.version);
		workDir = await createWorkDir(destination);
	}

	const stopRemovingOnSignal = removeOnSignal(workDir);
	try {
		log(`Downloading omp ${packageJson.version} for ${key} from ${archive.url}`);
		const archivePath = join(workDir, archive.name);
		await downloadVerified(archive, archivePath);
		const extracted = await extractBinary(archive, archivePath, workDir);
		// Rename within one directory is atomic, so concurrent first runs never see a partial binary.
		await rename(extracted, destination);
	} finally {
		// Keep the signal handlers until `rm` ends, so a signal during `rm` still removes the folder.
		await rm(workDir, { recursive: true, force: true }).finally(stopRemovingOnSignal);
	}

	if (destination !== vendorBinaryPath) await pruneOtherCachedVersions(packageJson.version);
	return destination;
}

async function createWorkDir(destination) {
	const directory = dirname(destination);
	await mkdir(directory, { recursive: true });
	return mkdtemp(join(directory, ".download-"));
}

/**
 * A signal ends Node without running `finally` blocks, so an interrupted download would leave its
 * partial archive behind. Until the returned function runs, the signals in `INTERRUPT_SIGNALS`
 * remove `directory` and then end the process with the same signal.
 */
function removeOnSignal(directory) {
	const handler = signal => {
		stop();
		rmSync(directory, { recursive: true, force: true });
		process.kill(process.pid, signal);
	};
	const stop = () => {
		for (const signal of INTERRUPT_SIGNALS) process.off(signal, handler);
	};
	for (const signal of INTERRUPT_SIGNALS) process.on(signal, handler);
	return stop;
}

async function downloadVerified(archive, archivePath) {
	let response;
	try {
		response = await fetch(archive.url);
	} catch (error) {
		throw new Error(`Failed to download ${archive.url}: ${error.cause?.message ?? error.message}`);
	}
	if (!response.ok || !response.body) {
		throw new Error(`Failed to download ${archive.url}: HTTP ${response.status} ${response.statusText}`);
	}

	const hash = createHash("sha256");
	await pipeline(
		Readable.fromWeb(response.body),
		async function* (chunks) {
			for await (const chunk of chunks) {
				hash.update(chunk);
				yield chunk;
			}
		},
		createWriteStream(archivePath, { mode: 0o600 }),
	);

	const digest = hash.digest("hex");
	const expected = archive.checksum.digest.toLowerCase();
	if (digest !== expected) {
		throw new Error(`Checksum mismatch for ${archive.name}: expected ${expected}, got ${digest}`);
	}
}

async function extractBinary(archive, archivePath, workDir) {
	const entryPath = `${archive.wrappedIn}/${archive.bin}`;
	await tar.x({
		cwd: workDir,
		file: archivePath,
		// tar defaults to keeping archive uid/gid when run as root; a root install must own its binary.
		preserveOwner: false,
		filter: (path, entry) => path.replace(/^\.\//, "") === entryPath && entry.type === "File",
	});

	const extracted = join(workDir, archive.wrappedIn, archive.bin);
	try {
		await chmod(extracted, 0o755);
	} catch (error) {
		if (error?.code === "ENOENT") throw new Error(`${archive.name} does not contain ${entryPath}`);
		throw error;
	}
	return extracted;
}

// Each cached version holds a full binary, so drop the ones a previous version left behind.
// Best effort: a failed cleanup must not stop omp from starting.
async function pruneOtherCachedVersions(keepVersion) {
	const root = cacheRoot();
	try {
		for (const entry of await readdir(root)) {
			if (entry !== keepVersion) await rm(join(root, entry), { recursive: true, force: true });
		}
	} catch {}
}
