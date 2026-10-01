import { describe, expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import { setBuildVersion } from "./set-build-version";

function manifest(name: string, version: string): string {
	return `{\n\t"name": "${name}",\n\t"version": "${version}",\n\t"author": { "name": "Stencil Labs, Inc." },\n\t"dependencies": {\n\t\t"dep": "1.0.0"\n\t}\n}\n`;
}

async function workspace(versions: { natives: string; utils: string; codingAgent: string }): Promise<TempDir> {
	const temp = TempDir.createSync("@omp-build-version-");
	await Bun.write(temp.join("packages/natives/package.json"), manifest("@oh-my-pi/pi-natives", versions.natives));
	await Bun.write(temp.join("packages/utils/package.json"), manifest("@oh-my-pi/pi-utils", versions.utils));
	await Bun.write(
		temp.join("packages/coding-agent/package.json"),
		manifest("@oh-my-pi/pi-coding-agent", versions.codingAgent),
	);
	return temp;
}

describe("setBuildVersion", () => {
	test("stamps the runtime manifests and keeps natives on the upstream version of its addons", async () => {
		using temp = await workspace({ natives: "18.4.9", utils: "18.4.9", codingAgent: "18.4.9" });

		await setBuildVersion("18.4.9-taoeffect.2", temp.path());

		expect(await Bun.file(temp.join("packages/utils/package.json")).text()).toBe(
			manifest("@oh-my-pi/pi-utils", "18.4.9-taoeffect.2"),
		);
		expect(await Bun.file(temp.join("packages/coding-agent/package.json")).text()).toBe(
			manifest("@oh-my-pi/pi-coding-agent", "18.4.9-taoeffect.2"),
		);
		expect(await Bun.file(temp.join("packages/natives/package.json")).text()).toBe(
			manifest("@oh-my-pi/pi-natives", "18.4.9"),
		);
	});

	test("writes no manifest when coding-agent is not on the upstream base", async () => {
		using temp = await workspace({ natives: "18.4.9", utils: "18.4.9", codingAgent: "18.4.8" });

		await expect(setBuildVersion("18.4.9-taoeffect.1", temp.path())).rejects.toThrow(/packages\/coding-agent/);
		expect(await Bun.file(temp.join("packages/utils/package.json")).text()).toBe(
			manifest("@oh-my-pi/pi-utils", "18.4.9"),
		);
	});
});
