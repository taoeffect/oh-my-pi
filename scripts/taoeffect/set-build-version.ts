#!/usr/bin/env bun
/**
 * CI only: writes the fork release version into the manifests that the compiled
 * binary takes its version from, so `omp --version` prints `omp/<fork version>`.
 * The Crush fork injects its version with `-ldflags` instead.
 *
 * `packages/utils/package.json` provides the runtime `VERSION`, and
 * `packages/coding-agent/package.json` must match it. `packages/natives/package.json`
 * keeps the upstream version because the downloaded addons carry that version stamp.
 * Never commit the result.
 */
import * as path from "node:path";
import { parseArgs } from "node:util";
import { type } from "@oh-my-pi/omptype";
import { parseReleaseVersion, REPO_ROOT, readUpstreamBase } from "./fork-version";

export const BUILD_VERSION_MANIFESTS = ["packages/utils/package.json", "packages/coding-agent/package.json"] as const;

// Top-level keys of the workspace manifests are indented with one tab.
const TOP_LEVEL_VERSION_LINE = /^(\t"version": )"([^"]*)",$/m;
const VersionedManifest = type({ version: "string" });

const USAGE = `Usage:
  bun scripts/taoeffect/set-build-version.ts <version>

Release builds only. Replaces the upstream version in
${BUILD_VERSION_MANIFESTS.join(" and ")} with <version>
(<upstream base>-taoeffect.<n>, n >= 1). Run it once on a clean checkout and do
not commit the result; restore the files with:
  git checkout -- ${BUILD_VERSION_MANIFESTS.join(" ")}`;

/** Rewrites the `version` line of each build manifest. Changes no file unless every manifest is on the upstream base. */
export async function setBuildVersion(version: string, repoRoot: string = REPO_ROOT): Promise<string[]> {
	const upstreamBase = await readUpstreamBase(repoRoot);
	const release = parseReleaseVersion(version, upstreamBase);
	const updates = await Promise.all(
		BUILD_VERSION_MANIFESTS.map(async relativePath => {
			const manifestPath = path.join(repoRoot, relativePath);
			const text = await Bun.file(manifestPath).text();
			const current = TOP_LEVEL_VERSION_LINE.exec(text)?.[2];
			if (current !== upstreamBase.version) {
				throw new Error(
					`${relativePath} must have the top-level line "version": "${upstreamBase.version}", found ${JSON.stringify(current ?? null)}`,
				);
			}
			const updated = text.replace(TOP_LEVEL_VERSION_LINE, `$1"${release.version}",`);
			if (VersionedManifest.assert(JSON.parse(updated)).version !== release.version) {
				throw new Error(`${relativePath}: the first "version" line is not the top-level version`);
			}
			return { manifestPath, updated };
		}),
	);
	for (const { manifestPath, updated } of updates) await Bun.write(manifestPath, updated);
	return updates.map(update => update.manifestPath);
}

if (import.meta.main) {
	try {
		const { values, positionals } = parseArgs({
			args: process.argv.slice(2),
			allowPositionals: true,
			options: { help: { type: "boolean", short: "h", default: false } },
		});
		if (values.help) {
			console.log(USAGE);
			process.exit(0);
		}
		if (positionals.length !== 1) throw new Error(`expected exactly one <version> argument\n\n${USAGE}`);
		for (const manifestPath of await setBuildVersion(positionals[0])) {
			console.log(`Set ${path.relative(REPO_ROOT, manifestPath)} version to ${positionals[0]}`);
		}
	} catch (error) {
		console.error(`set-build-version: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}
