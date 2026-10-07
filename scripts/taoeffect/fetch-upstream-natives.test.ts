import { describe, expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import { installLeafAddons, verifyIntegrity } from "./fetch-upstream-natives";
import { parseReleaseTarget } from "./release-layout";

async function leafTarball(files: Record<string, string>): Promise<Uint8Array> {
	return new Bun.Archive(files, { compress: "gzip" }).bytes();
}

describe("verifyIntegrity", () => {
	test("rejects a tarball whose sha512 differs from the npm dist.integrity", () => {
		const tarball = new TextEncoder().encode("leaf tarball");
		const otherIntegrity = `sha512-${new Bun.CryptoHasher("sha512").update("other").digest("base64")}`;
		expect(() => verifyIntegrity(tarball, otherIntegrity, "leaf")).toThrow(/failed the integrity check/);
	});
});

describe("installLeafAddons", () => {
	test("installs a baseline-only x64 leaf and removes a stale local modern build", async () => {
		using temp = TempDir.createSync("@omp-natives-");
		await Bun.write(temp.join("pi_natives.linux-x64-modern.node"), "stale local build");
		const tarball = await leafTarball({
			"package/package.json": "{}",
			"package/pi_natives.linux-x64-baseline.node": "upstream baseline",
		});

		await installLeafAddons(tarball, parseReleaseTarget("linux-x64"), temp.path(), "leaf");

		expect(await Bun.file(temp.join("pi_natives.linux-x64-baseline.node")).text()).toBe("upstream baseline");
		expect(await Bun.file(temp.join("pi_natives.linux-x64-modern.node")).exists()).toBe(false);
	});

	test("changes no local addon when the leaf lacks the baseline build", async () => {
		using temp = TempDir.createSync("@omp-natives-");
		await Bun.write(temp.join("pi_natives.linux-x64-modern.node"), "local modern");
		const tarball = await leafTarball({ "package/pi_natives.linux-x64-modern.node": "upstream modern" });

		await expect(installLeafAddons(tarball, parseReleaseTarget("linux-x64"), temp.path(), "leaf")).rejects.toThrow(
			"leaf does not contain package/pi_natives.linux-x64-baseline.node",
		);
		expect(await Bun.file(temp.join("pi_natives.linux-x64-modern.node")).text()).toBe("local modern");
	});
});
