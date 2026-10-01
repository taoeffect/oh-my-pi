#!/usr/bin/env bun
/**
 * Builds the publishable `@taoeffects/omp` package from the `npm/` template and the
 * release `checksums.txt` (port of the Crush fork's `scripts/generate-npm-package.mjs`).
 * The added `ompBinary` metadata tells `npm/lib.js` where to download each platform
 * archive and which SHA-256 digest the archive must have.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { NPM_PACKAGE_JSON_PATH, parseReleaseVersion, REPO_ROOT, readPackageVersion } from "./fork-version";
import { archiveDirName, FORK_REPOSITORY, RELEASE_TARGETS } from "./release-layout";

const NPM_TEMPLATE_DIR = path.dirname(NPM_PACKAGE_JSON_PATH);
/** Entries of the template's `files` list that come from the repository root instead of `npm/`. */
const ROOT_FILES: Record<string, true> = { "README.md": true, LICENSE: true };
const REPOSITORY_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const CHECKSUM_LINE = /^([0-9a-f]{64})\s+\*?(.+)$/i;

const USAGE = `Usage:
  bun scripts/taoeffect/generate-npm-package.ts [options]

Writes the publishable npm package to --out: every file that npm/package.json
lists in "files" (README.md and LICENSE come from the repository root), and
package.json with <version> and the ompBinary download metadata for the
release archives listed in <dist>/checksums.txt.

Options:
  --version <version>  Release version without "v" (default: npm/package.json).
  --repo <owner/name>  GitHub repository of the release (default: ${FORK_REPOSITORY}).
  --dist <dir>         Directory with checksums.txt (default: dist).
  --out <dir>          Output directory; replaced if it exists
                       (default: .release/npm-package).
  -h, --help           Show this help.`;

export interface OmpBinaryArchive {
	name: string;
	url: string;
	checksum: { algorithm: "sha256"; digest: string };
	wrappedIn: string;
	bin: "omp";
}

export interface OmpBinaryMetadata {
	repo: string;
	tag: string;
	archives: Record<string, OmpBinaryArchive>;
}

export interface GenerateNpmPackageOptions {
	version: string;
	repo: string;
	distDir: string;
	outDir: string;
}

/** Parses `sha256sum` output into a map from file basename to lowercase hex digest. */
export function parseChecksums(contents: string): Map<string, string> {
	const checksums = new Map<string, string>();
	for (const [index, rawLine] of contents.split(/\r?\n/).entries()) {
		const line = rawLine.trim();
		if (!line) continue;
		const match = CHECKSUM_LINE.exec(line);
		if (!match) throw new Error(`Malformed checksums.txt line ${index + 1}: ${rawLine}`);
		const name = path.basename(match[2]);
		if (checksums.has(name)) throw new Error(`checksums.txt lists ${name} more than once`);
		checksums.set(name, match[1].toLowerCase());
	}
	return checksums;
}

/** Builds the `ompBinary` metadata that `npm/lib.js` reads; every release target needs a checksum. */
export function buildOmpBinaryMetadata(
	version: string,
	repo: string,
	checksums: ReadonlyMap<string, string>,
): OmpBinaryMetadata {
	const tag = `v${version}`;
	const archives: Record<string, OmpBinaryArchive> = {};
	for (const target of RELEASE_TARGETS) {
		const wrappedIn = archiveDirName(version, target);
		const name = `${wrappedIn}.tar.gz`;
		const digest = checksums.get(name);
		if (!digest) throw new Error(`checksums.txt has no entry for ${name}`);
		archives[target.key] = {
			name,
			url: `https://github.com/${repo}/releases/download/${tag}/${name}`,
			checksum: { algorithm: "sha256", digest },
			wrappedIn,
			bin: "omp",
		};
	}
	return { repo, tag, archives };
}

/** Refuses an output directory that is, or contains, a directory the generator must not delete. */
function assertSafeOutputDir(outDir: string, protectedDirs: readonly string[]): void {
	for (const protectedDir of protectedDirs) {
		const relative = path.relative(outDir, protectedDir);
		const containsProtected =
			!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
		if (containsProtected) throw new Error(`Refusing to replace ${outDir}: it is or contains ${protectedDir}`);
	}
}

export async function generateNpmPackage({ version, repo, distDir, outDir }: GenerateNpmPackageOptions): Promise<void> {
	parseReleaseVersion(version);
	if (!REPOSITORY_PATTERN.test(repo)) throw new Error(`Invalid GitHub repository ${JSON.stringify(repo)}`);
	const resolvedOutDir = path.resolve(outDir);
	const resolvedDistDir = path.resolve(distDir);
	assertSafeOutputDir(resolvedOutDir, [REPO_ROOT, NPM_TEMPLATE_DIR, resolvedDistDir, os.homedir()]);

	const checksums = parseChecksums(await Bun.file(path.join(resolvedDistDir, "checksums.txt")).text());
	const ompBinary = buildOmpBinaryMetadata(version, repo, checksums);
	const packageJson = (await Bun.file(NPM_PACKAGE_JSON_PATH).json()) as Record<string, unknown> & { files: string[] };

	await fs.rm(resolvedOutDir, { recursive: true, force: true });
	await fs.mkdir(resolvedOutDir, { recursive: true });
	for (const file of packageJson.files) {
		const sourceDir = ROOT_FILES[file] ? REPO_ROOT : NPM_TEMPLATE_DIR;
		await fs.copyFile(path.join(sourceDir, file), path.join(resolvedOutDir, file));
	}

	packageJson.version = version;
	packageJson.ompBinary = ompBinary;
	await Bun.write(path.join(resolvedOutDir, "package.json"), `${JSON.stringify(packageJson, null, "\t")}\n`);
}

if (import.meta.main) {
	try {
		const { values } = parseArgs({
			args: process.argv.slice(2),
			options: {
				version: { type: "string" },
				repo: { type: "string", default: FORK_REPOSITORY },
				dist: { type: "string", default: path.join(REPO_ROOT, "dist") },
				out: { type: "string", default: path.join(REPO_ROOT, ".release", "npm-package") },
				help: { type: "boolean", short: "h", default: false },
			},
		});
		if (values.help) {
			console.log(USAGE);
			process.exit(0);
		}
		const version = values.version ?? (await readPackageVersion(NPM_PACKAGE_JSON_PATH));
		await generateNpmPackage({ version, repo: values.repo, distDir: values.dist, outDir: values.out });
		console.log(`Generated @taoeffects/omp@${version} in ${path.resolve(values.out)}`);
	} catch (error) {
		console.error(`generate-npm-package: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}
