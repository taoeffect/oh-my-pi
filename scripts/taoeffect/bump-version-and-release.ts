#!/usr/bin/env bun
/**
 * Cuts a taoeffect fork release of `@taoeffects/omp` from the local `mine` branch
 * (port of the Crush fork's `scripts/bump-version-and-release.mjs`).
 * Run `bun scripts/taoeffect/bump-version-and-release.ts --help` for the steps.
 */
import { parseArgs } from "node:util";
import { $ } from "bun";
import {
	NPM_PACKAGE_JSON_PATH,
	nextForkVersion,
	REPO_ROOT,
	readPackageVersion,
	readUpstreamBase,
} from "./fork-version";
import { FORK_REMOTE, formatCommand, prepareRelease, RELEASE_BRANCH, releaseGitCommands } from "./prepare-release";

const USAGE = `Usage:
  bun scripts/taoeffect/bump-version-and-release.ts [options]

Cuts a fork release from the committed HEAD of the release branch:
  1. Read the fork version from npm/package.json and the upstream base merged
     into HEAD (packages/natives/package.json, must equal packages/utils).
  2. Newer base: <base>-taoeffect.1. Same base: next taoeffect iteration.
  3. Write npm/package.json, commit it, create the annotated tag v<version>,
     and push branch and tag in one atomic push. The tag push starts
     .github/workflows/release-taoeffect.yml.

Options:
  --dry-run             Print the next version and the commands; change nothing.
                        Skips the clean-tree and branch checks.
  --remote <name>       Remote to push to (default: ${FORK_REMOTE}).
  --branch <name>       Branch that must be checked out and is pushed
                        (default: ${RELEASE_BRANCH}).
  -h, --help            Show this help.`;

function git(args: readonly string[]) {
	return $`git ${args}`.cwd(REPO_ROOT).quiet();
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		args: process.argv.slice(2),
		options: {
			"dry-run": { type: "boolean", default: false },
			remote: { type: "string", default: FORK_REMOTE },
			branch: { type: "string", default: RELEASE_BRANCH },
			help: { type: "boolean", short: "h", default: false },
		},
	});
	if (values.help) {
		console.log(USAGE);
		return;
	}
	const dryRun = values["dry-run"];

	const currentVersion = await readPackageVersion(NPM_PACKAGE_JSON_PATH);
	const upstreamBase = await readUpstreamBase();
	const next = nextForkVersion(currentVersion, upstreamBase);
	const tag = `v${next.version}`;
	console.log(`Current version (npm/package.json): ${currentVersion}`);
	console.log(`Upstream base (packages/natives):   ${upstreamBase.version}`);
	console.log(`Next release version:               ${next.version} (${next.reason})`);
	console.log(`Tag:                                ${tag}`);

	if (!dryRun) {
		const status = (await git(["status", "--porcelain"]).text()).trim();
		if (status) throw new Error(`Working tree is not clean. Commit or stash first:\n${status}`);
		const branch = (await git(["branch", "--show-current"]).text()).trim();
		if (branch !== values.branch) {
			throw new Error(`Expected branch ${values.branch} to be checked out, got ${branch || "a detached HEAD"}`);
		}
	}
	if ((await git(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`]).nothrow()).exitCode === 0) {
		throw new Error(`Local tag ${tag} already exists`);
	}

	const commands = releaseGitCommands(tag, values.remote, values.branch);
	if (dryRun) {
		console.log("Dry run; nothing changed. A release would run:");
		console.log(`  bun scripts/taoeffect/prepare-release.ts ${next.version}`);
		for (const command of commands) console.log(`  ${formatCommand(command)}`);
		return;
	}

	await prepareRelease(next.version, { check: false });
	for (const [index, command] of commands.entries()) {
		console.log(`$ ${formatCommand(command)}`);
		const { exitCode } = await $`${command}`.cwd(REPO_ROOT).nothrow();
		if (exitCode !== 0) {
			const remaining = commands.slice(index).map(step => `  ${formatCommand(step)}`);
			throw new Error(
				`Command failed with exit code ${exitCode}. Fix the cause, then run the remaining steps by hand:\n${remaining.join("\n")}`,
			);
		}
	}
	console.log(`Released ${tag}. The tag push starts .github/workflows/release-taoeffect.yml.`);
}

if (import.meta.main) {
	try {
		await main();
	} catch (error) {
		console.error(`bump-version-and-release: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}
