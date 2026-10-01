/**
 * Where taoeffect fork releases live and how their assets are named.
 * Shared by the release scripts, the npm wrapper metadata, and the release workflow.
 */

/** GitHub repository that hosts the fork releases and their archives. */
export const FORK_REPOSITORY = "taoeffect/oh-my-pi";

/**
 * Release targets. `key` is the `<process.platform>-<process.arch>` pair that
 * `npm/lib.js` looks up, the `scripts/ci-release-build-binaries.ts` target id, and
 * the upstream native leaf tag (`@oh-my-pi/pi-natives-<key>`).
 */
export const RELEASE_TARGETS = [
	{ key: "linux-x64", arch: "x64", archiveSuffix: "Linux_x86_64" },
	{ key: "linux-arm64", arch: "arm64", archiveSuffix: "Linux_arm64" },
	{ key: "darwin-x64", arch: "x64", archiveSuffix: "Darwin_x86_64" },
	{ key: "darwin-arm64", arch: "arm64", archiveSuffix: "Darwin_arm64" },
] as const;

export type ReleaseTarget = (typeof RELEASE_TARGETS)[number];

export function parseReleaseTarget(key: string): ReleaseTarget {
	const target = RELEASE_TARGETS.find(candidate => candidate.key === key);
	if (!target) {
		const keys = RELEASE_TARGETS.map(candidate => candidate.key).join(", ");
		throw new Error(`Unknown release target ${JSON.stringify(key)}; expected one of: ${keys}`);
	}
	return target;
}

/** The directory inside the release archive; the archive itself is `<name>.tar.gz` and holds `<name>/omp`. */
export function archiveDirName(version: string, target: ReleaseTarget): string {
	return `omp_${version}_${target.archiveSuffix}`;
}
