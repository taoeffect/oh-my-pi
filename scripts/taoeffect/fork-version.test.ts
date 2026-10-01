import { describe, expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import { nextForkVersion, parseReleaseVersion, parseUpstreamVersion, readUpstreamBase } from "./fork-version";

const base = parseUpstreamVersion;

describe("nextForkVersion", () => {
	test("starts at iteration 1 when a newer upstream base is merged", () => {
		expect(nextForkVersion("18.4.9-taoeffect.3", base("18.5.0")).version).toBe("18.5.0-taoeffect.1");
	});

	test("turns the unreleased template into the first release", () => {
		expect(nextForkVersion("0.0.0-taoeffect.0", base("18.4.9")).version).toBe("18.4.9-taoeffect.1");
	});

	test("bumps the iteration numerically when the base is unchanged", () => {
		expect(nextForkVersion("18.4.9-taoeffect.9", base("18.4.9")).version).toBe("18.4.9-taoeffect.10");
	});

	test("compares bases numerically, not as strings", () => {
		expect(nextForkVersion("18.9.0-taoeffect.2", base("18.10.0")).version).toBe("18.10.0-taoeffect.1");
		expect(() => nextForkVersion("18.10.0-taoeffect.2", base("18.9.0"))).toThrow(/older/);
	});

	test("rejects current versions outside the fork scheme", () => {
		for (const version of [
			"18.4.9",
			"v18.4.9-taoeffect.1",
			"18.4.9-taoeffect.01",
			"18.04.9-taoeffect.1",
			"18.4.9-taoeffect.1.1",
			"18.4.9-canary.1",
		]) {
			expect(() => nextForkVersion(version, base("18.4.9"))).toThrow(/fork version/);
		}
	});
});

describe("parseReleaseVersion", () => {
	test("requires iteration 1 or higher", () => {
		expect(() => parseReleaseVersion("18.4.9-taoeffect.0", base("18.4.9"))).toThrow(/1 or higher/);
		expect(parseReleaseVersion("18.4.9-taoeffect.1", base("18.4.9")).iteration).toBe(1);
	});

	test("rejects a leading v", () => {
		expect(() => parseReleaseVersion("v18.4.9-taoeffect.1", base("18.4.9"))).toThrow(/leading "v"/);
	});

	test("rejects a base that differs from the merged upstream base", () => {
		expect(() => parseReleaseVersion("18.4.10-taoeffect.1", base("18.4.9"))).toThrow(/merges upstream 18\.4\.9/);
	});
});

describe("readUpstreamBase", () => {
	async function workspace(nativesVersion: string, utilsVersion: string): Promise<TempDir> {
		const temp = TempDir.createSync("@omp-fork-version-");
		await Bun.write(temp.join("packages/natives/package.json"), JSON.stringify({ version: nativesVersion }));
		await Bun.write(temp.join("packages/utils/package.json"), JSON.stringify({ version: utilsVersion }));
		return temp;
	}

	test("rejects workspace manifests that are not in lockstep", async () => {
		using temp = await workspace("18.5.0", "18.4.9");
		await expect(readUpstreamBase(temp.join())).rejects.toThrow(/lockstep/);
	});

	test("rejects a prerelease upstream base", async () => {
		using temp = await workspace("18.5.0-canary.1", "18.5.0-canary.1");
		await expect(readUpstreamBase(temp.join())).rejects.toThrow(/stable upstream version/);
	});
});
