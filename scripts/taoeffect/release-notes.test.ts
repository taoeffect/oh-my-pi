import { describe, expect, test } from "bun:test";
import { boundCommitMessages } from "./release-notes";

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

		expect(log.text).toStartWith(`${"x".repeat(20)}…`);
		expect(log.text).toContain("next");
		expect(log.omitted).toBe(0);
	});
});
