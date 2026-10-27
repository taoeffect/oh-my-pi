import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { parseUpstreamVersion } from "./fork-version";
import {
	collectUpstreamReleases,
	keepNewestThatFit,
	listForkCommits,
	readForkChangelogAdditions,
	readReleaseNotesReply,
} from "./release-notes";

describe("keepNewestThatFit", () => {
	test("keeps the newest entries that fit and counts every other entry in the range as omitted", () => {
		const messages = ["newest", "middle", "oldest kept by git log"];
		const log = keepNewestThatFit(messages, 10, { maxEntryChars: 100, maxTotalChars: 50, entryOverheadChars: 18 });

		expect(log.kept).toEqual(["newest", "middle"]);
		expect(log.omitted).toBe(8);
	});

	test("cuts an oversized entry instead of dropping the rest", () => {
		const log = keepNewestThatFit(["x".repeat(500), "next"], 2, {
			maxEntryChars: 20,
			maxTotalChars: 100,
			entryOverheadChars: 18,
		});

		expect(log.kept).toEqual([`${"x".repeat(20)}…`, "next"]);
		expect(log.omitted).toBe(0);
	});
});

describe("collectUpstreamReleases", () => {
	const codingAgent = {
		name: "packages/coding-agent",
		content: [
			"# Changelog",
			"## [Unreleased]",
			"### Added",
			"- Unreleased change",
			"### Changed",
			"- Fork change in Unreleased",
			"## [18.10.3] - 2026-10-12",
			"### Fixed",
			"- Fixed agent in 18.10.3",
			"## [18.9.0] - 2026-10-11",
			"### Added",
			"- Added agent in 18.9.0",
			"## [18.8.2] - 2026-10-07",
			"### Fixed",
			"- Fixed agent in the previous base",
		].join("\n\n"),
	};
	const ai = {
		name: "packages/ai",
		content: [
			"## [18.10.4] - 2026-10-13",
			"### Fixed",
			"- Fixed ai after the target",
			"## [18.10.3] - 2026-10-12",
			"### Added",
			"- Added ai in 18.10.3",
			"## [18.8.3] - 2026-10-07",
			"### Fixed",
			"- Fixed ai in 18.8.3",
		].join("\n\n"),
	};

	test("returns the unreleased entries, then each release after the previous base up to the new base, newest first, with every package's entries", () => {
		const releases = collectUpstreamReleases(
			[ai, codingAgent],
			parseUpstreamVersion("18.8.2"),
			parseUpstreamVersion("18.10.3"),
			new Set(),
		);

		expect(releases.map(release => release.version)).toEqual([undefined, "18.10.3", "18.9.0", "18.8.3"]);
		expect(releases[0].notes).toBe(
			"## packages/coding-agent\n\n### Added\n\n- Unreleased change\n\n### Changed\n\n- Fork change in Unreleased",
		);
		expect(releases[1].notes).toContain("- Added ai in 18.10.3");
		expect(releases[1].notes).toContain("- Fixed agent in 18.10.3");
		expect(releases[2].notes).toContain("## packages/coding-agent");
		expect(releases[2].notes).not.toContain("packages/ai");
		const allNotes = releases.map(release => release.notes).join("\n");
		expect(allNotes).not.toContain("previous base");
		expect(allNotes).not.toContain("after the target");
	});

	test("leaves out excluded entries, with the headings and packages that have no other entries", () => {
		const releases = collectUpstreamReleases(
			[ai, codingAgent],
			parseUpstreamVersion("18.8.2"),
			parseUpstreamVersion("18.10.3"),
			new Set(["- Fork change in Unreleased", "- Added ai in 18.10.3"]),
		);

		expect(releases[0]).toEqual({ notes: "## packages/coding-agent\n\n### Added\n\n- Unreleased change" });
		expect(releases[1]).toEqual({
			version: "18.10.3",
			notes: "## packages/coding-agent\n\n### Fixed\n\n- Fixed agent in 18.10.3",
		});
	});

	test("returns no unreleased release when every unreleased entry is excluded", () => {
		const releases = collectUpstreamReleases(
			[codingAgent],
			parseUpstreamVersion("18.10.3"),
			parseUpstreamVersion("18.10.3"),
			new Set(["- Unreleased change", "- Fork change in Unreleased"]),
		);

		expect(releases).toEqual([]);
	});
});

describe("fork commits", () => {
	test("count a merge of upstream main, its conflict fixes, and what it brings in as upstream, but keep fork merges", async () => {
		const repo = await fs.mkdtemp(path.join(os.tmpdir(), "fork-release-notes-"));
		const git = async (...args: string[]) =>
			(
				await $`git ${args}`
					.cwd(repo)
					.quiet()
					.env({
						...process.env,
						GIT_CONFIG_GLOBAL: "/dev/null",
						GIT_CONFIG_SYSTEM: "/dev/null",
						GIT_AUTHOR_NAME: "t",
						GIT_AUTHOR_EMAIL: "t@t",
						GIT_COMMITTER_NAME: "t",
						GIT_COMMITTER_EMAIL: "t@t",
					})
			)
				.text()
				.trim();
		const addEntry = (pkg: string, entry: string) =>
			fs.appendFile(path.join(repo, "packages", pkg, "CHANGELOG.md"), `${entry}\n`);
		const commit = async (message: string) => {
			await git("add", "-A");
			await git("commit", "-q", "-m", message);
			return git("rev-parse", "HEAD");
		};
		try {
			await git("init", "-q", "-b", "main");
			await fs.mkdir(path.join(repo, "packages", "upstream"), { recursive: true });
			await fs.mkdir(path.join(repo, "packages", "fork"), { recursive: true });
			await addEntry("upstream", "# Changelog");
			await addEntry("fork", "# Changelog");
			await commit("upstream base");

			await git("checkout", "-q", "-b", "mine");
			await addEntry("fork", "- Fork change");
			const forkChange = await commit("feat: fork change");
			await git("checkout", "-q", "-b", "feature");
			await addEntry("fork", "- Fork feature");
			const forkFeature = await commit("feat: fork feature");
			await git("checkout", "-q", "mine");
			await git("merge", "-q", "--no-ff", "-m", "Merge branch 'feature' into mine", "feature");
			const featureMerge = await git("rev-parse", "HEAD");

			await git("checkout", "-q", "main");
			await addEntry("upstream", "- Upstream change");
			const upstreamMain = await commit("feat: upstream change");
			await git("checkout", "-q", "mine");
			await git("merge", "-q", "--no-ff", "--no-commit", "main");
			await addEntry("fork", "- Conflict fix in the merge");
			await commit("Merge branch 'main' into mine");

			expect((await listForkCommits(["mine"], upstreamMain, repo)).sort()).toEqual(
				[forkChange, forkFeature, featureMerge].sort(),
			);
			expect((await readForkChangelogAdditions(["mine"], upstreamMain, repo)).sort()).toEqual([
				"- Fork change",
				"- Fork feature",
			]);
		} finally {
			await fs.rm(repo, { recursive: true, force: true });
		}
	});
});

describe("readReleaseNotesReply", () => {
	test("returns the notes without a Markdown code fence when the model finished normally", () => {
		const reply = {
			choices: [{ finish_reason: "stop", message: { content: "```markdown\n#### Features\n- Thing - works\n```" } }],
		};

		expect(readReleaseNotesReply(reply)).toBe("#### Features\n- Thing - works");
	});

	test("returns no notes when the model replied NONE", () => {
		const reply = { choices: [{ finish_reason: "stop", message: { content: "NONE" } }] };

		expect(readReleaseNotesReply(reply)).toBe("");
	});

	test.each([
		["the token limit", { choices: [{ finish_reason: "length", message: { content: "#### Feat" } }] }, /token limit/],
		[
			"a reply that Z.ai cut short with HTTP 200",
			{ choices: [{ finish_reason: "sensitive", message: { content: "#### Features\n- Partial" } }] },
			/finish_reason: sensitive/,
		],
		["a reply with no choices", {}, /finish_reason: none/],
	])("rejects %s instead of publishing partial or empty notes", (_case, reply, error) => {
		expect(() => readReleaseNotesReply(reply)).toThrow(error);
	});
});
