#!/usr/bin/env bun
/**
 * Writes GitHub release notes for a fork release tag with a Z.ai model
 * (port of the inline release-notes step of the Crush fork's release workflow).
 *
 * The fork part comes from the commits since the previous fork release, without
 * the commits that the upstream base release already contains. The upstream
 * part summarizes the changelogs of every upstream release since the previous
 * fork release's base and links each of those releases.
 */
import * as path from "node:path";
import { parseArgs } from "node:util";
import { type } from "@oh-my-pi/omptype";
import * as prompt from "@oh-my-pi/pi-utils/prompt";
import { $ } from "bun";
import { enumerateChangelogVersions, mergePackageSection } from "../ci-release-notes";
import {
	compareUpstreamVersions,
	parseReleaseVersion,
	parseUpstreamVersion,
	REPO_ROOT,
	type UpstreamVersion,
} from "./fork-version";
import { FORK_REPOSITORY } from "./release-layout";
import releaseNotesPrompt from "./release-notes-prompt.md" with { type: "text" };
import upstreamNotesPrompt from "./release-notes-upstream-prompt.md" with { type: "text" };

const ZAI_CHAT_COMPLETIONS_URL = "https://api.z.ai/api/coding/paas/v4/chat/completions";
const UPSTREAM_REPOSITORY = "can1357/oh-my-pi";
const USER_SEPARATOR = "<!-- USER -->";
const COMMIT_SEPARATOR = "\n---END COMMIT---\n";
const MAX_COMMITS = 500;
const MAX_COMPLETION_TOKENS = 32_768;
const REQUEST_TIMEOUT_MS = 10 * 60_000;

const GitHubReleaseList = type({ tagName: "string" }).array();
const NpmPackageManifest = type({ name: "string" });
const ChatCompletion = type({
	"choices?": type({ "finish_reason?": "string | null", "message?": { "content?": "string | null" } }).array(),
});

const USAGE = `Usage:
  bun scripts/taoeffect/release-notes.ts <tag> [--repo <owner/name>] [--out <file>]

Writes release notes for the fork release <tag> (v<upstream>-taoeffect.<n>) to
--out (default: dist/release-notes.md). Needs the environment variables
ZAI_API_KEY and RELEASE_MODEL, a clone with the full history and tags, and an
authenticated gh for the GitHub release lookup in --repo (default: ${FORK_REPOSITORY}).

The previous release is the newest GitHub release of --repo whose tag is an
ancestor of <tag>; with none, the notes cover everything since the upstream base.
Only when gh cannot list the releases, the newest merged v*-taoeffect.* tag is
used instead. Commits that the upstream base tag v<upstream> contains are left
out; the script fetches that tag from ${UPSTREAM_REPOSITORY} when the clone lacks it.
The upstream changes come from the packages/*/CHANGELOG.md files in <tag>: the
sections of the versions after the previous release's base, up to v<upstream>.`;

export interface TextBudget {
	/** Longest entry; a longer one is cut and ends with "…". */
	maxEntryChars: number;
	/** Most characters of all kept entries, each counted with `entryOverheadChars`. */
	maxTotalChars: number;
	/** Characters that the prompt adds around each entry. */
	entryOverheadChars: number;
}

export interface BoundedEntries {
	kept: string[];
	omitted: number;
}

const COMMIT_BUDGET: TextBudget = {
	maxEntryChars: 2_000,
	maxTotalChars: 60_000,
	entryOverheadChars: COMMIT_SEPARATOR.length,
};
// About 60k tokens: room for about 30 upstream releases at the pace of late 2026.
const UPSTREAM_BUDGET: TextBudget = { maxEntryChars: 60_000, maxTotalChars: 240_000, entryOverheadChars: 40 };

/**
 * Keeps the newest entries (`entries` is newest first) that fit in the size
 * budget, each cut to a maximum length. `totalEntries` counts every entry in
 * the range, including the ones that the caller already dropped.
 */
export function keepNewestThatFit(
	entries: readonly string[],
	totalEntries: number,
	budget: TextBudget,
): BoundedEntries {
	const kept: string[] = [];
	let size = 0;
	for (const entry of entries) {
		const bounded = entry.length > budget.maxEntryChars ? `${entry.slice(0, budget.maxEntryChars)}…` : entry;
		size += bounded.length + budget.entryOverheadChars;
		if (size > budget.maxTotalChars) break;
		kept.push(bounded);
	}
	return { kept, omitted: Math.max(totalEntries, entries.length) - kept.length };
}

export interface PackageChangelog {
	/** Package directory, such as `packages/coding-agent`. */
	name: string;
	content: string;
}

export interface UpstreamRelease {
	version: string;
	/** One `## <package>` part per package with entries for this version; empty when no package has any. */
	notes: string;
}

/**
 * Returns every upstream release after `floorExclusive` up to and including
 * `targetInclusive` that has a changelog section, newest first.
 */
export function collectUpstreamReleases(
	changelogs: readonly PackageChangelog[],
	floorExclusive: UpstreamVersion,
	targetInclusive: UpstreamVersion,
): UpstreamRelease[] {
	const versions = new Map<string, UpstreamVersion>();
	for (const { content } of changelogs) {
		for (const { version } of enumerateChangelogVersions(content)) {
			const parsed = parseUpstreamVersion(version);
			if (
				compareUpstreamVersions(parsed, floorExclusive) > 0 &&
				compareUpstreamVersions(parsed, targetInclusive) <= 0
			) {
				versions.set(version, parsed);
			}
		}
	}
	return [...versions.values()]
		.sort((left, right) => compareUpstreamVersions(right, left))
		.map(({ version }) => ({
			version,
			notes: changelogs
				.map(({ name, content }) => {
					const section = mergePackageSection(content, null, version);
					return section && `## ${name}\n\n${section}`;
				})
				.filter(Boolean)
				.join("\n\n"),
		}));
}

function upstreamReleaseLink(version: string): string {
	return `[v${version}](https://github.com/${UPSTREAM_REPOSITORY}/releases/tag/v${version})`;
}

function renderPrompt(template: string, context: prompt.TemplateContext): { system: string; user: string } {
	const separator = template.indexOf(USER_SEPARATOR);
	return {
		system: template.slice(0, separator).trim(),
		user: prompt.render(template.slice(separator + USER_SEPARATOR.length), context).trim(),
	};
}

interface UpstreamChanges {
	previousBase: string;
	/** Newest first. */
	releases: UpstreamRelease[];
	notes: string;
}

function formatReleaseNotes(options: {
	forkNotes: string;
	upstream: UpstreamChanges | undefined;
	upstreamBase: string;
	model: string;
}): string {
	const { forkNotes, upstream, upstreamBase, model } = options;
	const upstreamSection = upstream && [
		`### Upstream changes since v${upstream.previousBase}`,
		upstream.notes,
		`Upstream release notes: ${upstream.releases
			.map(release => upstreamReleaseLink(release.version))
			.reverse()
			.join(", ")}.`,
	];
	const sections = [
		forkNotes && `### Fork changes\n\n${forkNotes}`,
		...(upstreamSection ?? []),
		`Based on upstream oh-my-pi ${upstreamReleaseLink(upstreamBase)}.`,
		`Release notes generated by ${model}.`,
	];
	return `${sections.filter(Boolean).join("\n\n")}\n`;
}

/**
 * Returns the release notes in a Z.ai chat-completion reply. Z.ai sends replies
 * that ended early (`sensitive`, `network_error`, …) with HTTP 200, so only
 * `finish_reason: "stop"` counts as complete.
 */
export function readReleaseNotesReply(body: unknown): string {
	const completion = ChatCompletion(body);
	if (completion instanceof type.errors) throw new Error(`Unexpected Z.ai response: ${completion.summary}`);
	const choice = completion.choices?.[0];
	if (choice?.finish_reason !== "stop") {
		throw new Error(
			choice?.finish_reason === "length"
				? `Z.ai stopped at the ${MAX_COMPLETION_TOKENS}-token limit before the release notes were complete`
				: `Z.ai did not complete the release notes (finish_reason: ${choice?.finish_reason ?? "none"})`,
		);
	}
	return (choice.message?.content ?? "")
		.replace(/^```(?:markdown)?\s*/i, "")
		.replace(/\s*```$/i, "")
		.trim();
}

async function requestReleaseNotes(options: {
	apiKey: string;
	model: string;
	system: string;
	user: string;
}): Promise<string> {
	const response = await fetch(ZAI_CHAT_COMPLETIONS_URL, {
		method: "POST",
		headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			model: options.model,
			temperature: 0.2,
			// GLM models spend most tokens on reasoning (one test run: 1633 of 1936), so Crush's 2000 is too tight.
			max_tokens: MAX_COMPLETION_TOKENS,
			messages: [
				{ role: "system", content: options.system },
				{ role: "user", content: options.user },
			],
		}),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`Z.ai release notes request failed with ${response.status}: ${await response.text()}`);
	}
	return readReleaseNotesReply(await response.json());
}

function git(args: readonly string[]) {
	return $`git ${args}`.cwd(REPO_ROOT).quiet().nothrow();
}

async function gitText(args: readonly string[]): Promise<string> {
	const result = await git(args);
	if (result.exitCode !== 0) {
		throw new Error(
			`git ${args.join(" ")} failed with exit code ${result.exitCode}: ${result.stderr.toString().trim()}`,
		);
	}
	return result.text();
}

async function hasTag(tag: string): Promise<boolean> {
	return (await git(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`])).exitCode === 0;
}

function isForkReleaseTag(tag: string): boolean {
	if (!tag.startsWith("v")) return false;
	try {
		parseReleaseVersion(tag.slice(1));
		return true;
	} catch {
		return false;
	}
}

async function findPreviousRelease(tag: string, repo: string): Promise<string | undefined> {
	const releaseList = await $`gh release list --repo ${repo} --exclude-drafts --limit 100 --json tagName`
		.quiet()
		.nothrow();
	const releases = releaseList.exitCode === 0 ? GitHubReleaseList(releaseList.json()) : undefined;
	if (releases !== undefined && !(releases instanceof type.errors)) {
		for (const { tagName } of releases) {
			if (tagName === tag || !isForkReleaseTag(tagName) || !(await hasTag(tagName))) continue;
			const ancestor = await git(["merge-base", "--is-ancestor", `refs/tags/${tagName}`, `refs/tags/${tag}`]);
			if (ancestor.exitCode === 0) return tagName;
		}
		return undefined;
	}

	const reason = releases?.summary ?? releaseList.stderr.toString().trim();
	console.error(`Could not list the GitHub releases of ${repo}; using merged tags instead. ${reason}`);
	const mergedTags = await gitText([
		"tag",
		"--merged",
		`refs/tags/${tag}`,
		"--sort=-creatordate",
		"--list",
		"v*-taoeffect.*",
	]);
	return mergedTags.split("\n").find(candidate => candidate !== tag && isForkReleaseTag(candidate));
}

async function readCommitLog(tag: string, excludedTags: readonly string[]): Promise<BoundedEntries> {
	const range = [`refs/tags/${tag}`, ...excludedTags.map(excluded => `^refs/tags/${excluded}`)];
	const total = Number((await gitText(["rev-list", "--count", ...range])).trim());
	const log = await gitText(["log", "-z", "--format=%B", `--max-count=${MAX_COMMITS}`, ...range]);
	const messages = log
		.split("\0")
		.map(message => message.trim())
		.filter(Boolean);
	return keepNewestThatFit(messages, total, COMMIT_BUDGET);
}

function nonEmptyLines(text: string): string[] {
	return text.split("\n").filter(Boolean);
}

async function readChangelogsAt(tag: string): Promise<PackageChangelog[]> {
	const packageDirs = nonEmptyLines(await gitText(["ls-tree", "--name-only", `refs/tags/${tag}`, "packages/"]));
	const changelogPaths = nonEmptyLines(
		await gitText([
			"ls-tree",
			"--name-only",
			`refs/tags/${tag}`,
			"--",
			...packageDirs.map(dir => `${dir}/CHANGELOG.md`),
		]),
	);
	return Promise.all(
		changelogPaths.map(async changelogPath => ({
			name: path.dirname(changelogPath),
			content: await gitText(["show", `refs/tags/${tag}:${changelogPath}`]),
		})),
	);
}

async function readNpmPackageNameAt(tag: string): Promise<string> {
	const manifest = NpmPackageManifest(JSON.parse(await gitText(["show", `refs/tags/${tag}:npm/package.json`])));
	if (manifest instanceof type.errors) throw new Error(`npm/package.json in ${tag}: ${manifest.summary}`);
	return manifest.name;
}

export interface ReleaseNotesOptions {
	tag: string;
	repo: string;
	apiKey: string;
	model: string;
}

/** Returns the Markdown release notes for the fork release `tag`. */
export async function generateReleaseNotes({ tag, repo, apiKey, model }: ReleaseNotesOptions): Promise<string> {
	if (!isForkReleaseTag(tag)) throw new Error(`Expected a fork release tag like v18.4.9-taoeffect.1, got ${tag}`);
	if (!(await hasTag(tag))) throw new Error(`The local clone has no tag ${tag}`);

	const upstreamBase = parseReleaseVersion(tag.slice(1)).base;
	const upstreamTag = `v${upstreamBase.version}`;
	if (!(await hasTag(upstreamTag))) {
		console.log(`Fetching ${upstreamTag} from ${UPSTREAM_REPOSITORY}`);
		const upstreamUrl = `https://github.com/${UPSTREAM_REPOSITORY}.git`;
		await gitText(["fetch", "--no-tags", upstreamUrl, `refs/tags/${upstreamTag}:refs/tags/${upstreamTag}`]);
	}
	const previous = await findPreviousRelease(tag, repo);
	const excludedTags = previous ? [previous, upstreamTag] : [upstreamTag];
	console.log(`Release notes cover ${tag} without ${excludedTags.join(" and ")}`);
	const commits = await readCommitLog(tag, excludedTags);
	if (commits.omitted > 0) console.log(`Left out the ${commits.omitted} oldest commits to bound the request size`);

	// Without a previous fork release there is no older base to list upstream releases from.
	const previousBase = previous ? parseReleaseVersion(previous.slice(1)).base : undefined;
	const upstreamReleases = previousBase
		? collectUpstreamReleases(await readChangelogsAt(tag), previousBase, upstreamBase)
		: [];
	const upstreamChangelogs = keepNewestThatFit(
		upstreamReleases.map(release => release.notes),
		upstreamReleases.length,
		UPSTREAM_BUDGET,
	);
	if (previousBase && upstreamReleases.length > 0) {
		console.log(
			`Upstream notes cover ${upstreamReleases.length} releases after v${previousBase.version} up to ${upstreamTag}`,
		);
	}
	if (upstreamChangelogs.omitted > 0) {
		console.log(`Left out the ${upstreamChangelogs.omitted} oldest upstream releases to bound the request size`);
	}

	const [forkNotes, upstreamNotes] = await Promise.all([
		requestReleaseNotes({
			apiKey,
			model,
			...renderPrompt(releaseNotesPrompt, {
				tag,
				previous,
				upstreamTag,
				npmPackage: await readNpmPackageNameAt(tag),
				commits: commits.kept.join(COMMIT_SEPARATOR),
				omitted: commits.omitted,
			}),
		}),
		upstreamReleases.some(release => release.notes)
			? requestReleaseNotes({
					apiKey,
					model,
					...renderPrompt(upstreamNotesPrompt, {
						previousBase: previousBase?.version,
						upstreamBase: upstreamBase.version,
						releases: upstreamChangelogs.kept.map((notes, index) => ({
							version: upstreamReleases[index].version,
							notes,
						})),
						omitted: upstreamChangelogs.omitted,
					}),
				})
			: "",
	]);
	return formatReleaseNotes({
		forkNotes,
		upstream:
			previousBase && upstreamReleases.length > 0
				? { previousBase: previousBase.version, releases: upstreamReleases, notes: upstreamNotes }
				: undefined,
		upstreamBase: upstreamBase.version,
		model,
	});
}

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		args: process.argv.slice(2),
		allowPositionals: true,
		options: {
			repo: { type: "string", default: FORK_REPOSITORY },
			out: { type: "string", default: path.join(REPO_ROOT, "dist", "release-notes.md") },
			help: { type: "boolean", short: "h", default: false },
		},
	});
	if (values.help) {
		console.log(USAGE);
		return;
	}
	if (positionals.length !== 1) throw new Error(`expected exactly one <tag> argument\n\n${USAGE}`);
	const apiKey = Bun.env.ZAI_API_KEY;
	const model = Bun.env.RELEASE_MODEL;
	if (!apiKey) throw new Error("ZAI_API_KEY is required");
	if (!model) throw new Error("RELEASE_MODEL is required");
	const notes = await generateReleaseNotes({ tag: positionals[0], repo: values.repo, apiKey, model });
	const outPath = path.resolve(values.out);
	await Bun.write(outPath, notes);
	console.log(`Wrote ${outPath}`);
}

if (import.meta.main) {
	try {
		await main();
	} catch (error) {
		console.error(`release-notes: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}
