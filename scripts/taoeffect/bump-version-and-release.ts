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
  3. Refuse if native addon inputs (crates/, Cargo, Bazel files) differ between
     the upstream tag v<base> and HEAD: release builds download the addons that
     upstream published for <base>, so local native changes would not ship.
  4. Write npm/package.json, commit it, create the annotated tag v<version>,
     and push branch and tag in one atomic push. The tag push starts
     .github/workflows/release-taoeffect.yml.

Options:
  --dry-run             Print the next version and the commands; change nothing.
                        Skips the clean-tree and branch checks.
  --allow-native-drift  Release even if native addon inputs differ from v<base>.
  --remote <name>       Remote to push to (default: ${FORK_REMOTE}).
  --branch <name>       Branch that must be checked out and is pushed
                        (default: ${RELEASE_BRANCH}).
  -h, --help            Show this help.`;

/**
 * Files that determine the native addon. Release builds do not compile Rust; they
 * download the addons upstream published for the base version. A change here
 * between the upstream tag and HEAD would not reach the released binary.
 */
const NATIVE_INPUT_PATHS = [
	"crates",
	"Cargo.toml",
	"Cargo.lock",
	"rust-toolchain.toml",
	".cargo",
	"MODULE.bazel",
	"MODULE.bazel.lock",
	"BUILD.bazel",
	"bazel",
	".bazelrc",
	".bazelversion",
	"packages/natives/native/index.d.ts",
];

function git(args: readonly string[]) {
	return $`git ${args}`.cwd(REPO_ROOT).quiet();
}

async function listNativeDrift(baseTag: string): Promise<string[]> {
	const tagLookup = await git(["rev-parse", "--verify", "--quiet", `refs/tags/${baseTag}^{commit}`]).nothrow();
	if (tagLookup.exitCode !== 0) {
		throw new Error(
			`Missing the local upstream tag ${baseTag}, which the native drift check needs. Run: git fetch origin tag ${baseTag}`,
		);
	}
	const diff = await git(["diff", "--name-only", `refs/tags/${baseTag}`, "HEAD", "--", ...NATIVE_INPUT_PATHS]).text();
	return diff.split("\n").filter(Boolean);
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		args: process.argv.slice(2),
		options: {
			"dry-run": { type: "boolean", default: false },
			"allow-native-drift": { type: "boolean", default: false },
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

	const baseTag = `v${upstreamBase.version}`;
	const drift = await listNativeDrift(baseTag);
	if (drift.length === 0) {
		console.log(`Native addon inputs match ${baseTag}.`);
	} else {
		console.log(`Native addon inputs differ between ${baseTag} and HEAD:`);
		for (const file of drift) console.log(`  ${file}`);
		if (!values["allow-native-drift"]) {
			throw new Error(
				`Release builds use the native addons upstream published for ${upstreamBase.version}, so these changes would not ship. Review them, then rerun with --allow-native-drift to release anyway.`,
			);
		}
		console.log("Continuing because --allow-native-drift was given.");
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
