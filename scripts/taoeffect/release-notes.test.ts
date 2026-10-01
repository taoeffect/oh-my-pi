import { describe, expect, test } from "bun:test";
import { boundCommitMessages, readReleaseNotesReply } from "./release-notes";

describe("boundCommitMessages", () => {
	test("keeps the newest commits that fit and counts every other commit in the range as omitted", () => {
		const messages = ["newest", "middle", "oldest kept by git log"];
		const log = boundCommitMessages(messages, 10, { maxMessageChars: 100, maxTotalChars: 50 });

		expect(log.text).toContain("newest");
		expect(log.text).toContain("middle");
		expect(log.text).not.toContain("oldest");
		expect(log.omitted).toBe(8);
	});

	test("cuts an oversized commit message instead of dropping the rest of the log", () => {
		const log = boundCommitMessages(["x".repeat(500), "next"], 2, { maxMessageChars: 20, maxTotalChars: 100 });

		expect(log.text).toStartWith("x".repeat(20));
		expect(log.text).not.toContain("x".repeat(21));
		expect(log.text).toContain("next");
		expect(log.omitted).toBe(0);
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
