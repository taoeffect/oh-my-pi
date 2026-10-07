import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import { buildOmpBinaryMetadata, generateNpmPackage, parseChecksums } from "./generate-npm-package";

const VERSION = "18.4.9-taoeffect.1";
const SUFFIXES = ["Linux_x86_64", "Linux_arm64", "Darwin_arm64"];

/** `sha256sum dist/*.tar.gz` output; the last line uses the binary-mode `*` marker. */
function sha256sumOutput(suffixes: readonly string[]): string {
	return suffixes
		.map((suffix, index) => {
			const digest = String(index).repeat(64);
			const marker = index === suffixes.length - 1 ? " *" : "  ";
			return `${digest}${marker}dist/omp_${VERSION}_${suffix}.tar.gz\n`;
		})
		.join("");
}

describe("buildOmpBinaryMetadata", () => {
	test("maps sha256sum lines to the per-platform download entries that npm/lib.js reads", () => {
		const metadata = buildOmpBinaryMetadata(VERSION, "taoeffect/oh-my-pi", parseChecksums(sha256sumOutput(SUFFIXES)));

		expect(metadata.tag).toBe(`v${VERSION}`);
		expect(Object.keys(metadata.archives).sort()).toEqual(["darwin-arm64", "linux-arm64", "linux-x64"]);
		expect(metadata.archives["darwin-arm64"]).toEqual({
			name: `omp_${VERSION}_Darwin_arm64.tar.gz`,
			url: `https://github.com/taoeffect/oh-my-pi/releases/download/v${VERSION}/omp_${VERSION}_Darwin_arm64.tar.gz`,
			checksum: { algorithm: "sha256", digest: "2".repeat(64) },
			wrappedIn: `omp_${VERSION}_Darwin_arm64`,
			bin: "omp",
		});
	});

	test("refuses to describe a release that lacks an archive checksum", () => {
		const checksums = parseChecksums(sha256sumOutput(SUFFIXES.filter(suffix => suffix !== "Linux_x86_64")));
		expect(() => buildOmpBinaryMetadata(VERSION, "taoeffect/oh-my-pi", checksums)).toThrow(
			`no entry for omp_${VERSION}_Linux_x86_64.tar.gz`,
		);
	});
});

describe("generateNpmPackage", () => {
	async function releaseDist(temp: TempDir): Promise<string> {
		const distDir = temp.join("dist");
		await Bun.write(temp.join("dist", "checksums.txt"), sha256sumOutput(SUFFIXES));
		return distDir;
	}

	test("ships every file that the package manifest lists or runs", async () => {
		using temp = TempDir.createSync("@omp-npm-package-");
		const outDir = temp.join("npm-package");
		await generateNpmPackage({
			version: VERSION,
			repo: "taoeffect/oh-my-pi",
			distDir: await releaseDist(temp),
			outDir,
		});

		const manifest = await Bun.file(temp.join("npm-package", "package.json")).json();
		expect(manifest.version).toBe(VERSION);
		expect(manifest.ompBinary.tag).toBe(`v${VERSION}`);
		const required: string[] = [
			...manifest.files,
			...Object.values<string>(manifest.bin),
			manifest.scripts.postinstall.split(" ")[1],
		];
		const missing: string[] = [];
		for (const file of required) if (!(await Bun.file(temp.join("npm-package", file)).exists())) missing.push(file);
		expect(missing).toEqual([]);
	});

	test("refuses an output directory that would delete the release archives", async () => {
		using temp = TempDir.createSync("@omp-npm-package-");
		const distDir = await releaseDist(temp);
		await expect(
			generateNpmPackage({ version: VERSION, repo: "taoeffect/oh-my-pi", distDir, outDir: temp.path() }),
		).rejects.toThrow(/Refusing to replace/);
		expect(await fs.readdir(distDir)).toEqual(["checksums.txt"]);
	});
});
