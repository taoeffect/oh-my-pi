/**
 * Version rules for taoeffect fork releases (`@taoeffects/omp`).
 *
 * A fork release version is `<upstream X.Y.Z>-taoeffect.<n>` with n ≥ 1; its git
 * tag is `v<version>`. The committed fork version lives only in
 * `npm/package.json`, where `0.0.0-taoeffect.0` means "never released".
 *
 * The upstream base is the upstream release merged into this checkout, read from
 * `packages/natives/package.json`. Release builds download the native addons that
 * upstream published under that version, so a release must use exactly that base.
 */
import * as path from "node:path";

export const REPO_ROOT = path.resolve(import.meta.dir, "../..");
export const NPM_PACKAGE_JSON_PATH = path.join(REPO_ROOT, "npm", "package.json");

const UPSTREAM_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const FORK_VERSION_PATTERN = /^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-taoeffect\.(0|[1-9]\d*)$/;

export interface UpstreamVersion {
	major: number;
	minor: number;
	patch: number;
	version: string;
}

export interface ForkVersion {
	base: UpstreamVersion;
	iteration: number;
	version: string;
}

export interface NextForkVersion {
	version: string;
	reason: string;
}

function toSafeInteger(digits: string, version: string): number {
	const value = Number(digits);
	if (!Number.isSafeInteger(value)) throw new Error(`Version number is too large in ${version}`);
	return value;
}

/** Parses a stable upstream version such as `18.4.9`. */
export function parseUpstreamVersion(version: string): UpstreamVersion {
	const match = UPSTREAM_VERSION_PATTERN.exec(version);
	if (!match) throw new Error(`Expected a stable upstream version like 18.4.9, got ${JSON.stringify(version)}`);
	return {
		major: toSafeInteger(match[1], version),
		minor: toSafeInteger(match[2], version),
		patch: toSafeInteger(match[3], version),
		version,
	};
}

/** Parses a fork version such as `18.4.9-taoeffect.2`. Iteration 0 is allowed: it marks the unreleased template. */
export function parseForkVersion(version: string): ForkVersion {
	const match = FORK_VERSION_PATTERN.exec(version);
	if (!match) {
		throw new Error(`Expected a fork version like 18.4.9-taoeffect.1, got ${JSON.stringify(version)}`);
	}
	return {
		base: parseUpstreamVersion(match[1]),
		iteration: toSafeInteger(match[2], version),
		version,
	};
}

export function compareUpstreamVersions(left: UpstreamVersion, right: UpstreamVersion): number {
	return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

/**
 * Computes the next release from the current `npm/package.json` version and the
 * upstream base merged into HEAD: a newer base restarts at iteration 1, the same
 * base bumps the iteration, and an older base is an error.
 */
export function nextForkVersion(currentVersion: string, upstreamBase: UpstreamVersion): NextForkVersion {
	const current = parseForkVersion(currentVersion);
	const order = compareUpstreamVersions(upstreamBase, current.base);
	if (order > 0) {
		return {
			version: `${upstreamBase.version}-taoeffect.1`,
			reason: `new upstream base ${upstreamBase.version}, previous base ${current.base.version}`,
		};
	}
	if (order < 0) {
		throw new Error(
			`Upstream base ${upstreamBase.version} is older than ${current.base.version}, the base of the current fork version ${currentVersion}`,
		);
	}
	return {
		version: `${current.base.version}-taoeffect.${current.iteration + 1}`,
		reason: `next fork iteration for upstream base ${current.base.version}`,
	};
}

/** Validates a version to release: a fork version with iteration ≥ 1 on the given upstream base. */
export function parseReleaseVersion(version: string, upstreamBase: UpstreamVersion): ForkVersion {
	if (version.startsWith("v")) {
		throw new Error(
			`Invalid release version ${version}: omit the leading "v" (use ${version.slice(1)}); only the git tag has it.`,
		);
	}
	const release = parseForkVersion(version);
	if (release.iteration < 1) {
		throw new Error(`Invalid release version ${version}: the taoeffect iteration must be 1 or higher`);
	}
	if (compareUpstreamVersions(release.base, upstreamBase) !== 0) {
		throw new Error(
			`Release ${version} is based on ${release.base.version}, but this checkout merges upstream ${upstreamBase.version} (packages/natives/package.json)`,
		);
	}
	return release;
}

export async function readPackageVersion(manifestPath: string): Promise<string> {
	const manifest = (await Bun.file(manifestPath).json()) as { version?: unknown };
	if (typeof manifest.version !== "string") throw new Error(`${manifestPath} has no version string`);
	return manifest.version;
}

/** Reads the upstream base from the lockstep workspace manifests (natives must equal utils). */
export async function readUpstreamBase(repoRoot: string = REPO_ROOT): Promise<UpstreamVersion> {
	const [nativesVersion, utilsVersion] = await Promise.all([
		readPackageVersion(path.join(repoRoot, "packages", "natives", "package.json")),
		readPackageVersion(path.join(repoRoot, "packages", "utils", "package.json")),
	]);
	if (nativesVersion !== utilsVersion) {
		throw new Error(
			`Workspace versions are not in lockstep: packages/natives is ${nativesVersion}, packages/utils is ${utilsVersion}. Finish the upstream merge first.`,
		);
	}
	return parseUpstreamVersion(nativesVersion);
}
