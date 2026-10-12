import { describe, expect, test } from "bun:test";
import { parseUpstreamVersion } from "./fork-version";
import { collectUpstreamReleases, keepNewestThatFit, readReleaseNotesReply } from "./release-notes";

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

	test("returns each release after the previous base up to the new base, newest first, with every package's entries", () => {
		const releases = collectUpstreamReleases(
			[ai, codingAgent],
			parseUpstreamVersion("18.8.2"),
			parseUpstreamVersion("18.10.3"),
		);

		expect(releases.map(release => release.version)).toEqual(["18.10.3", "18.9.0", "18.8.3"]);
		expect(releases[0].notes).toContain("- Added ai in 18.10.3");
		expect(releases[0].notes).toContain("- Fixed agent in 18.10.3");
		expect(releases[1].notes).toContain("## packages/coding-agent");
		expect(releases[1].notes).not.toContain("packages/ai");
		const allNotes = releases.map(release => release.notes).join("\n");
		expect(allNotes).not.toContain("previous base");
		expect(allNotes).not.toContain("after the target");
		expect(allNotes).not.toContain("Unreleased change");
	});
});

describe("readReleaseNotesReply", () => {
	test("returns the notes without a Markdown code fence when the model finished normally", () => {
		const reply = {
			choices: [{ finish_reason: "stop", message: { content: "```markdown\n#### Features\n- Thing - works\n```" } }],
		};

		expect(readReleaseNotesReply(reply)).toBe("#### Features\n- Thing - works");
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
