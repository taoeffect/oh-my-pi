#!/usr/bin/env bun
/**
 * Writes GitHub release notes for a fork release tag with a Z.ai model
 * (port of the inline release-notes step of the Crush fork's release workflow).
 *
 * Commits on upstream oh-my-pi's `main` and the fork's merges of `main` are
 * upstream changes, conflict fixes included. The fork part comes from the other
 * commits since the previous fork release. The upstream part summarizes the
 * changelog entries that are new since the previous fork release: the sections
 * of every upstream release since the previous release's base, and the
 * unreleased entries that merges of `main` brought in, without the entries that
 * fork commits added. It also links each of those upstream releases.
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
const UPSTREAM_URL = `https://github.com/${UPSTREAM_REPOSITORY}.git`;
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
used instead. The script fetches main from ${UPSTREAM_REPOSITORY}, and the
upstream base tag v<upstream> when the clone lacks it. Commits on that main and
the fork's merges of it are upstream changes, so the fork notes leave them out.
The upstream changes come from the packages/*/CHANGELOG.md files in <tag>: the
sections of the versions after the previous release's base, up to v<upstream>,
and the [Unreleased] sections, without the entries that the previous release
already had or that fork commits added.`;

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
	/** Undefined for the `[Unreleased]` entries: changes after the upstream base that merges of `main` brought in. */
	version?: string;
	/** One `## <package>` part per package with entries for this release; empty when no package has any. */
	notes: string;
}

/**
 * Returns the upstream changes in the fork release's `changelogs`, newest
 * first: the `[Unreleased]` entries when there are any, then every upstream
 * release after `floorExclusive` up to and including `targetInclusive` that
 * has a changelog section. Entry lines whose trimmed text is in `excluded` are
 * left out.
 */
export function collectUpstreamReleases(
	changelogs: readonly PackageChangelog[],
	floorExclusive: UpstreamVersion,
	targetInclusive: UpstreamVersion,
	excluded: ReadonlySet<string>,
): UpstreamRelease[] {
	const included = changelogs.map(({ name, content }) => ({ name, content: withoutEntries(content, excluded) }));
	const versions = new Map<string, UpstreamVersion>();
	for (const { content } of included) {
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
	const releases: UpstreamRelease[] = [...versions.values()]
		.sort((left, right) => compareUpstreamVersions(right, left))
		.map(({ version }) => ({
			version,
			notes: packageNotes(included, content => mergePackageSection(content, null, version)),
		}));
	const unreleased = packageNotes(included, readUnreleasedSection);
	return unreleased ? [{ notes: unreleased }, ...releases] : releases;
}

/** Puts each package's `section` under a `## <package>` heading; packages with an empty section are left out. */
function packageNotes(changelogs: readonly PackageChangelog[], section: (content: string) => string): string {
	return changelogs
		.map(({ name, content }) => {
			const notes = section(content);
			return notes && `## ${name}\n\n${notes}`;
		})
		.filter(Boolean)
		.join("\n\n");
}

/** Removes the entry lines whose trimmed text is in `excluded`; headings and blank lines stay. */
function withoutEntries(content: string, excluded: ReadonlySet<string>): string {
	return content
		.split("\n")
		.filter(line => {
			const entry = line.trim();
			return !entry || line.startsWith("#") || !excluded.has(entry);
		})
		.join("\n");
}

/** Returns the `## [Unreleased]` entries under their `###` headings, like mergePackageSection, or "" when there are none. */
function readUnreleasedSection(content: string): string {
	const lines = content.split("\n");
	const start = lines.findIndex(line => line.startsWith("## [Unreleased]"));
	if (start === -1) return "";
	const end = lines.findIndex((line, index) => index > start && line.startsWith("## ["));
	const groups: string[] = [];
	let heading: string | undefined;
	let entries: string[] = [];
	const flush = () => {
		if (heading && entries.length > 0) groups.push(`${heading}\n\n${entries.join("\n")}`);
		entries = [];
	};
	for (const line of lines.slice(start + 1, end === -1 ? undefined : end)) {
		if (line.startsWith("### ")) {
			flush();
			heading = line.trimEnd();
		} else if (heading && line.trim()) {
			entries.push(line);
		}
	}
	flush();
	return groups.join("\n\n");
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
	/** The newest upstream `main` commit in the release, when it is newer than the upstream base. */
	upstreamHead: string | undefined;
	model: string;
}): string {
	const { forkNotes, upstream, upstreamBase, upstreamHead, model } = options;
	const upstreamVersions = upstream?.releases.flatMap(release => release.version ?? []).reverse() ?? [];
	const upstreamSection = upstream && [
		`### Upstream changes since v${upstream.previousBase}`,
		upstream.notes,
		upstreamVersions.length > 0 &&
			`Upstream release notes: ${upstreamVersions.map(version => upstreamReleaseLink(version)).join(", ")}.`,
	];
	const baseLink = upstreamReleaseLink(upstreamBase);
	const sections = [
		forkNotes && `### Fork changes\n\n${forkNotes}`,
		...(upstreamSection ?? []),
		upstreamHead
			? `Based on upstream oh-my-pi ${baseLink} and the later upstream main commits up to [${upstreamHead.slice(0, 10)}](https://github.com/${UPSTREAM_REPOSITORY}/commit/${upstreamHead}).`
			: `Based on upstream oh-my-pi ${baseLink}.`,
		`Release notes generated by ${model}.`,
	];
	return `${sections.filter(Boolean).join("\n\n")}\n`;
}

/**
 * Returns the release notes in a Z.ai chat-completion reply, or "" when the
 * model replied `NONE` (no important changes). Z.ai sends replies that ended
 * early (`sensitive`, `network_error`, …) with HTTP 200, so only
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
	const notes = (choice.message?.content ?? "")
		.replace(/^```(?:markdown)?\s*/i, "")
		.replace(/\s*```$/i, "")
		.trim();
	// The prompts ask for NONE: asked for an empty reply, models write placeholders like "_(empty string)_".
	return notes === "NONE" ? "" : notes;
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

function git(args: readonly string[], cwd = REPO_ROOT) {
	return $`git ${args}`.cwd(cwd).quiet().nothrow();
}

async function gitText(args: readonly string[], cwd = REPO_ROOT): Promise<string> {
	const result = await git(args, cwd);
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

async function isAncestor(commit: string, descendant: string, cwd = REPO_ROOT): Promise<boolean> {
	const result = await git(["merge-base", "--is-ancestor", commit, descendant], cwd);
	if (result.exitCode > 1) {
		throw new Error(
			`git merge-base --is-ancestor ${commit} ${descendant} failed: ${result.stderr.toString().trim()}`,
		);
	}
	return result.exitCode === 0;
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
			if (await isAncestor(`refs/tags/${tagName}`, `refs/tags/${tag}`)) return tagName;
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

/** Fetches upstream oh-my-pi's `main` and returns its commit. */
async function fetchUpstreamMain(): Promise<string> {
	console.log(`Fetching main from ${UPSTREAM_REPOSITORY}`);
	await gitText(["fetch", "--no-tags", UPSTREAM_URL, "refs/heads/main"]);
	return (await gitText(["rev-parse", "--verify", "FETCH_HEAD^{commit}"])).trim();
}

/**
 * Returns the fork's own commits in the revision `range`, newest first. The
 * commits that `upstreamMain` contains are upstream changes. So are the fork's
 * merges of upstream `main`: they bring upstream changes in, and their conflict
 * fixes adapt those changes to the fork.
 */
export async function listForkCommits(
	range: readonly string[],
	upstreamMain: string,
	cwd = REPO_ROOT,
): Promise<string[]> {
	const rows = nonEmptyLines(await gitText(["rev-list", "--parents", ...range, `^${upstreamMain}`], cwd));
	const forkCommits: string[] = [];
	for (const row of rows) {
		const [commit, ...parents] = row.split(" ");
		const mergesUpstream =
			parents.length > 1 &&
			(await Promise.all(parents.map(parent => isAncestor(parent, upstreamMain, cwd)))).some(Boolean);
		if (!mergesUpstream) forkCommits.push(commit);
	}
	return forkCommits;
}

/**
 * Returns the trimmed changelog lines that the fork's own commits in the
 * revision `range` add. Merge commits are left out: what a merge of upstream
 * `main` adds is an upstream change.
 */
export async function readForkChangelogAdditions(
	range: readonly string[],
	upstreamMain: string,
	cwd = REPO_ROOT,
): Promise<string[]> {
	const patches = await gitText(
		[
			"log",
			"--no-merges",
			"--full-history",
			"--patch",
			"--unified=0",
			"--no-color",
			"--format=",
			...range,
			`^${upstreamMain}`,
			"--",
			"packages/*/CHANGELOG.md",
		],
		cwd,
	);
	return patches
		.split("\n")
		.filter(line => line.startsWith("+") && !line.startsWith("+++"))
		.map(line => line.slice(1).trim())
		.filter(Boolean);
}

async function readCommitMessages(commits: readonly string[]): Promise<BoundedEntries> {
	const newest = commits.slice(0, MAX_COMMITS);
	// `git log --no-walk` with no commits would show HEAD.
	const log = newest.length > 0 ? await gitText(["log", "-z", "--format=%B", "--no-walk=unsorted", ...newest]) : "";
	const messages = log
		.split("\0")
		.map(message => message.trim())
		.filter(Boolean);
	return keepNewestThatFit(messages, commits.length, COMMIT_BUDGET);
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
		await gitText(["fetch", "--no-tags", UPSTREAM_URL, `refs/tags/${upstreamTag}:refs/tags/${upstreamTag}`]);
	}
	const upstreamMain = await fetchUpstreamMain();
	const previous = await findPreviousRelease(tag, repo);
	const range = previous ? [`refs/tags/${tag}`, `^refs/tags/${previous}`] : [`refs/tags/${tag}`];
	console.log(`Fork notes cover ${tag} without ${previous ? `${previous}, ` : ""}upstream main, and merges of it`);
	const commits = await readCommitMessages(await listForkCommits(range, upstreamMain));
	if (commits.omitted > 0) console.log(`Left out the ${commits.omitted} oldest commits to bound the request size`);

	// Upstream changes count from the previous release; without one, from the release's own upstream base.
	const floorTag = previous ?? upstreamTag;
	const floorBase = previous ? parseReleaseVersion(previous.slice(1)).base : upstreamBase;
	const [releaseChangelogs, floorChangelogs, forkAdditions, upstreamHead, upstreamBaseCommit] = await Promise.all([
		readChangelogsAt(tag),
		readChangelogsAt(floorTag),
		readForkChangelogAdditions(range, upstreamMain),
		gitText(["merge-base", `refs/tags/${tag}`, upstreamMain]).then(text => text.trim()),
		gitText(["rev-parse", `refs/tags/${upstreamTag}^{commit}`]).then(text => text.trim()),
	]);
	const excluded = new Set([
		...floorChangelogs.flatMap(({ content }) => content.split("\n").map(line => line.trim())),
		...forkAdditions,
	]);
	const upstreamReleases = collectUpstreamReleases(releaseChangelogs, floorBase, upstreamBase, excluded);
	const upstreamChangelogs = keepNewestThatFit(
		upstreamReleases.map(release => release.notes),
		upstreamReleases.length,
		UPSTREAM_BUDGET,
	);
	if (upstreamReleases.length > 0) {
		const released = upstreamReleases.filter(release => release.version).length;
		const unreleased = released < upstreamReleases.length ? ", and unreleased upstream changes" : "";
		console.log(
			`Upstream notes cover ${released} releases after v${floorBase.version} up to ${upstreamTag}${unreleased}`,
		);
	}
	if (upstreamChangelogs.omitted > 0) {
		console.log(`Left out the ${upstreamChangelogs.omitted} oldest upstream releases to bound the request size`);
	}

	const [forkNotes, upstreamNotes] = await Promise.all([
		// With no fork commits, a request could only invent fork changes.
		commits.kept.length > 0
			? requestReleaseNotes({
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
				})
			: "",
		upstreamReleases.some(release => release.notes)
			? requestReleaseNotes({
					apiKey,
					model,
					...renderPrompt(upstreamNotesPrompt, {
						previousBase: floorBase.version,
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
			upstreamReleases.length > 0
				? { previousBase: floorBase.version, releases: upstreamReleases, notes: upstreamNotes }
				: undefined,
		upstreamBase: upstreamBase.version,
		upstreamHead: upstreamHead === upstreamBaseCommit ? undefined : upstreamHead,
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
