/**
 * Where taoeffect fork releases live and how their assets are named.
 * Shared by the release scripts, the npm wrapper metadata, and the release workflow.
 */

/** GitHub repository that hosts the fork releases and their archives. */
export const FORK_REPOSITORY = "taoeffect/oh-my-pi";

/**
 * Release targets. `key` is the `<process.platform>-<process.arch>` pair that
 * `npm/lib.js` looks up and the `scripts/ci-release-build-binaries.ts` target id.
 */
export const RELEASE_TARGETS = [
	{ key: "linux-x64", archiveSuffix: "Linux_x86_64" },
	{ key: "linux-arm64", archiveSuffix: "Linux_arm64" },
	{ key: "darwin-arm64", archiveSuffix: "Darwin_arm64" },
] as const;

export type ReleaseTarget = (typeof RELEASE_TARGETS)[number];

/** The directory inside the release archive; the archive itself is `<name>.tar.gz` and holds `<name>/omp`. */
export function archiveDirName(version: string, target: ReleaseTarget): string {
	return `omp_${version}_${target.archiveSuffix}`;
}
