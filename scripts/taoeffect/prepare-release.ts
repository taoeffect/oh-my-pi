#!/usr/bin/env bun
/**
 * Writes or checks the fork release version in `npm/package.json`
 * (port of the Crush fork's `scripts/prepare-taoeffect-release.mjs`).
 *
 * Usage:
 *   bun scripts/taoeffect/prepare-release.ts <version>
 *   bun scripts/taoeffect/prepare-release.ts --check <version>
 *
 * `bump-version-and-release.ts` calls this for every release, and the release
 * workflow runs `--check` against the pushed tag.
 */
import { parseArgs } from "node:util";
import { $ } from "bun";
import { NPM_PACKAGE_JSON_PATH, parseReleaseVersion, readUpstreamBase } from "./fork-version";

export const FORK_REMOTE = "taoeffect";
export const RELEASE_BRANCH = "mine";

const USAGE = `Usage:
  bun scripts/taoeffect/prepare-release.ts [--check] <version>

Writes <version> into npm/package.json. With --check, changes nothing and fails
unless npm/package.json already has <version>.

<version> is <upstream base>-taoeffect.<n> with n >= 1 and no leading "v",
for example 18.4.9-taoeffect.1. The git tag is v<version>. The base must equal
the upstream version merged into this checkout (packages/natives/package.json).`;

/** Validates `version` against the workspace upstream base, then writes it into or checks it against `npm/package.json`. */
export async function prepareRelease(version: string, options: { check: boolean }): Promise<void> {
	const release = parseReleaseVersion(version, await readUpstreamBase());
	const packageJson = (await Bun.file(NPM_PACKAGE_JSON_PATH).json()) as Record<string, unknown>;
	if (options.check) {
		if (packageJson.version !== release.version) {
			throw new Error(`npm/package.json has version ${String(packageJson.version)}, expected ${release.version}`);
		}
		return;
	}
	packageJson.version = release.version;
	await Bun.write(NPM_PACKAGE_JSON_PATH, `${JSON.stringify(packageJson, null, "\t")}\n`);
}

/** The git commands that commit a prepared `npm/package.json`, tag it, and push branch and tag in one atomic push. */
export function releaseGitCommands(tag: string, remote: string, branch: string): string[][] {
	return [
		["git", "add", "--", "npm/package.json"],
		["git", "commit", "-m", `chore(release): prepare ${tag}`],
		["git", "tag", "-a", tag, "-m", tag],
		[
			"git",
			"push",
			"--atomic",
			remote,
			`refs/heads/${branch}:refs/heads/${branch}`,
			`refs/tags/${tag}:refs/tags/${tag}`,
		],
	];
}

export function formatCommand(command: readonly string[]): string {
	return command.map(arg => $.escape(arg)).join(" ");
}

if (import.meta.main) {
	try {
		const { values, positionals } = parseArgs({
			args: process.argv.slice(2),
			allowPositionals: true,
			options: {
				check: { type: "boolean", default: false },
				help: { type: "boolean", short: "h", default: false },
			},
		});
		if (values.help) {
			console.log(USAGE);
			process.exit(0);
		}
		if (positionals.length !== 1) throw new Error(`expected exactly one <version> argument\n\n${USAGE}`);
		const version = positionals[0];
		await prepareRelease(version, { check: values.check });
		const tag = `v${version}`;
		if (values.check) {
			console.log(`npm/package.json is prepared for ${version} (tag ${tag}).`);
		} else {
			console.log(`Updated npm/package.json to ${version} (tag ${tag}).`);
			console.log("Next steps:");
			for (const command of releaseGitCommands(tag, FORK_REMOTE, RELEASE_BRANCH)) {
				console.log(`  ${formatCommand(command)}`);
			}
		}
	} catch (error) {
		console.error(`prepare-release: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}
