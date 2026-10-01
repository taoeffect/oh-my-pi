#!/usr/bin/env bun
/**
 * Downloads the native addons that upstream published for one release target
 * (`@oh-my-pi/pi-natives-<target>@<version>`), checks the npm integrity hash, and
 * copies them into `packages/natives/native/`, where `gen:native` embeds them
 * into the compiled binary.
 *
 * The fork does not build Rust. The published addons carry the upstream version
 * stamp, and `packages/natives/package.json` keeps that upstream version, so the
 * embed step and the runtime loader accept them.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { type } from "@oh-my-pi/omptype";
import { REPO_ROOT, readPackageVersion } from "./fork-version";
import { parseReleaseTarget, RELEASE_TARGETS, type ReleaseTarget } from "./release-layout";

const NPM_REGISTRY = "https://registry.npmjs.org";
const NATIVES_PACKAGE_JSON_PATH = path.join(REPO_ROOT, "packages", "natives", "package.json");
const DEFAULT_NATIVE_DIR = path.join(REPO_ROOT, "packages", "natives", "native");
const LeafVersionManifest = type({ dist: { tarball: "string", integrity: "string" } });

const USAGE = `Usage:
  bun scripts/taoeffect/fetch-upstream-natives.ts <target> [--out-dir <dir>]

Downloads @oh-my-pi/pi-natives-<target>@<version> from npm, where <version> is
packages/natives/package.json#version, checks its integrity hash, and copies
the target's addon files into --out-dir (default: packages/natives/native).
This replaces any local addon build for <target>.

Targets: ${RELEASE_TARGETS.map(target => target.key).join(", ")}`;

interface AddonCandidate {
	filename: string;
	required: boolean;
}

/**
 * The addon files that `packages/natives/scripts/embed-native.ts` embeds for a target.
 * x64 leaves always ship the baseline build; some also ship a modern (newer CPU) build.
 */
export function addonCandidates(target: ReleaseTarget): AddonCandidate[] {
	return target.arch === "x64"
		? [
				{ filename: `pi_natives.${target.key}-baseline.node`, required: true },
				{ filename: `pi_natives.${target.key}-modern.node`, required: false },
			]
		: [{ filename: `pi_natives.${target.key}.node`, required: true }];
}

/** Throws unless `bytes` match an npm `dist.integrity` value of the form `sha512-<base64>`. */
export function verifyIntegrity(bytes: Uint8Array, integrity: string, label: string): void {
	if (!integrity.startsWith("sha512-")) throw new Error(`${label} has no sha512 integrity hash: ${integrity}`);
	const actual = `sha512-${new Bun.CryptoHasher("sha512").update(bytes).digest("base64")}`;
	if (actual !== integrity) {
		throw new Error(`${label} failed the integrity check: expected ${integrity}, got ${actual}`);
	}
}

/**
 * Makes `nativeDir` hold exactly the target's addons from a native leaf tarball.
 * Writes nothing when a required addon is missing. Deletes a local variant that
 * the leaf does not ship, so the embed step cannot pick up a stale build.
 */
export async function installLeafAddons(
	tarball: Uint8Array,
	target: ReleaseTarget,
	nativeDir: string,
	label: string,
): Promise<string[]> {
	const candidates = addonCandidates(target);
	const entries = await new Bun.Archive(tarball).files(candidates.map(candidate => `package/${candidate.filename}`));
	const addons = candidates.map(({ filename, required }) => {
		const entry = entries.get(`package/${filename}`);
		if (!entry && required) throw new Error(`${label} does not contain package/${filename}`);
		return { destination: path.join(nativeDir, filename), entry };
	});
	const written: string[] = [];
	for (const { destination, entry } of addons) {
		if (entry) {
			await Bun.write(destination, entry);
			written.push(destination);
		} else {
			await fs.rm(destination, { force: true });
		}
	}
	return written;
}

async function fetchOk(url: string): Promise<Response> {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`GET ${url} failed with ${response.status} ${response.statusText}`);
	return response;
}

export async function fetchUpstreamNatives(
	target: ReleaseTarget,
	version: string,
	nativeDir: string,
): Promise<string[]> {
	const packageName = `@oh-my-pi/pi-natives-${target.key}`;
	const label = `${packageName}@${version}`;
	const manifest = LeafVersionManifest(await (await fetchOk(`${NPM_REGISTRY}/${packageName}/${version}`)).json());
	if (manifest instanceof type.errors) {
		throw new Error(`Unexpected npm registry metadata for ${label}: ${manifest.summary}`);
	}
	const { tarball: tarballUrl, integrity } = manifest.dist;
	const tarball = await (await fetchOk(tarballUrl)).bytes();
	verifyIntegrity(tarball, integrity, label);
	return installLeafAddons(tarball, target, nativeDir, label);
}

if (import.meta.main) {
	try {
		const { values, positionals } = parseArgs({
			args: process.argv.slice(2),
			allowPositionals: true,
			options: {
				"out-dir": { type: "string", default: DEFAULT_NATIVE_DIR },
				help: { type: "boolean", short: "h", default: false },
			},
		});
		if (values.help) {
			console.log(USAGE);
			process.exit(0);
		}
		if (positionals.length !== 1) throw new Error(`expected exactly one <target> argument\n\n${USAGE}`);
		const target = parseReleaseTarget(positionals[0]);
		const version = await readPackageVersion(NATIVES_PACKAGE_JSON_PATH);
		console.log(`Fetching @oh-my-pi/pi-natives-${target.key}@${version}`);
		for (const file of await fetchUpstreamNatives(target, version, path.resolve(values["out-dir"]))) {
			console.log(`  wrote ${file} (${Bun.file(file).size} bytes)`);
		}
	} catch (error) {
		console.error(`fetch-upstream-natives: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}
