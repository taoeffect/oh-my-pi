import { describe, expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import { setBuildVersion } from "./set-build-version";

// Like the real manifests: utils and coding-agent indent with tabs, natives with two spaces.
function manifest(name: string, version: string, indent = "\t"): string {
	return `{\n${indent}"name": "${name}",\n${indent}"version": "${version}",\n${indent}"author": { "name": "Stencil Labs, Inc." },\n${indent}"dependencies": {\n${indent}${indent}"dep": "1.0.0"\n${indent}}\n}\n`;
}

function nativesManifest(version: string): string {
	return manifest("@oh-my-pi/pi-natives", version, "  ");
}

async function workspace(versions: { natives: string; utils: string; codingAgent: string }): Promise<TempDir> {
	const temp = TempDir.createSync("@omp-build-version-");
	await Bun.write(temp.join("packages/natives/package.json"), nativesManifest(versions.natives));
	await Bun.write(temp.join("packages/utils/package.json"), manifest("@oh-my-pi/pi-utils", versions.utils));
	await Bun.write(
		temp.join("packages/coding-agent/package.json"),
		manifest("@oh-my-pi/pi-coding-agent", versions.codingAgent),
	);
	return temp;
}

describe("setBuildVersion", () => {
	test("stamps natives, utils and coding-agent and keeps each file's indentation", async () => {
		using temp = await workspace({ natives: "18.4.9", utils: "18.4.9", codingAgent: "18.4.9" });

		await setBuildVersion("18.4.9-taoeffect.2", temp.path());

		expect(await Bun.file(temp.join("packages/natives/package.json")).text()).toBe(
			nativesManifest("18.4.9-taoeffect.2"),
		);
		expect(await Bun.file(temp.join("packages/utils/package.json")).text()).toBe(
			manifest("@oh-my-pi/pi-utils", "18.4.9-taoeffect.2"),
		);
		expect(await Bun.file(temp.join("packages/coding-agent/package.json")).text()).toBe(
			manifest("@oh-my-pi/pi-coding-agent", "18.4.9-taoeffect.2"),
		);
	});

	test("writes no manifest when coding-agent is not on the upstream base", async () => {
		using temp = await workspace({ natives: "18.4.9", utils: "18.4.9", codingAgent: "18.4.8" });

		await expect(setBuildVersion("18.4.9-taoeffect.1", temp.path())).rejects.toThrow(/packages\/coding-agent/);
		expect(await Bun.file(temp.join("packages/natives/package.json")).text()).toBe(nativesManifest("18.4.9"));
		expect(await Bun.file(temp.join("packages/utils/package.json")).text()).toBe(
			manifest("@oh-my-pi/pi-utils", "18.4.9"),
		);
	});
});
