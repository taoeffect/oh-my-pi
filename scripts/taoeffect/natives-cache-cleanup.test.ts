import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import { cleanupStaleNativeVersions } from "../../packages/natives/native/loader-state.js";

// Each fork release extracts its addon into `~/.omp/natives/<version>`. The fork patch in
// `loader-state.js` lets the cleanup that runs after each load remove older fork folders.
async function cleanup(currentVersion: string, folders: string[]): Promise<{ removed: string[]; kept: string[] }> {
	using temp = TempDir.createSync("@omp-natives-cleanup-");
	for (const folder of folders) {
		await fs.mkdir(temp.join(folder));
		// Older than the cleanup grace period, so only the version decides.
		await fs.utimes(temp.join(folder), new Date(0), new Date(0));
	}

	const removed = cleanupStaleNativeVersions({ nativesDir: temp.path(), currentVersion });

	return {
		removed: removed.map(folder => path.basename(folder)).sort(),
		kept: (await fs.readdir(temp.path())).sort(),
	};
}

describe("natives cache cleanup", () => {
	test("a fork release removes older fork folders and older upstream folders", async () => {
		const result = await cleanup("18.9.0-taoeffect.2", [
			"18.8.2",
			"18.8.2-taoeffect.5",
			"18.9.0",
			"18.9.0-taoeffect.1",
			"18.9.0-taoeffect.2",
			"18.9.1",
			"19.0.0-taoeffect.1",
		]);

		expect(result).toEqual({
			removed: ["18.8.2", "18.8.2-taoeffect.5", "18.9.0-taoeffect.1"],
			kept: ["18.9.0", "18.9.0-taoeffect.2", "18.9.1", "19.0.0-taoeffect.1"],
		});
	});

	test("an upstream version keeps fork folders, even ones with an older base", async () => {
		const result = await cleanup("18.8.2", ["18.8.1", "18.8.1-taoeffect.5"]);

		expect(result).toEqual({ removed: ["18.8.1"], kept: ["18.8.1-taoeffect.5"] });
	});
});
