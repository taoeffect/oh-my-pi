import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries, VERSION } from "@oh-my-pi/pi-utils";
import { currentBuildHost } from "../../src/cli/build-service";
import { fixedNpmRegistry } from "../../src/cli/npm-registry";
import { checkForkReleases, getLatestRelease, runUpdateCommand } from "../../src/cli/update-cli";
import { cfgUpdateChannel } from "../../src/modes/settings";

const npmjs = fixedNpmRegistry();

type FetchInput = string | URL | Request;
type FetchInit = RequestInit | BunFetchRequestInit;

function stubRegistry(manifests: Record<string, unknown>): string[] {
	const urls: string[] = [];
	const fetchStub = Object.assign(
		async (input: FetchInput) => {
			const url = String(input);
			urls.push(url);
			const decoded = decodeURIComponent(url);
			let manifest: unknown;
			for (const pkg in manifests) {
				if (decoded.includes(pkg)) {
					manifest = manifests[pkg];
					break;
				}
			}
			if (!manifest) return new Response(null, { status: 404, statusText: "Not Found" });
			return Response.json(manifest);
		},
		{ preconnect: globalThis.fetch.preconnect },
	);
	vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);
	return urls;
}

describe("runUpdateCommand version source", () => {
	const previousPath = process.env.PATH;
	const previousBuildUrl = process.env.PI_BUILD_URL;
	const dirs: string[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		process.env.PATH = previousPath;
		if (previousBuildUrl === undefined) delete process.env.PI_BUILD_URL;
		else process.env.PI_BUILD_URL = previousBuildUrl;
		await Promise.all(dirs.splice(0).map(dir => removeWithRetries(dir)));
	});

	/**
	 * Make PATH a fresh directory holding only what the test puts there, so no
	 * brew, mise, bun, npm, or omp of the host takes part in target resolution.
	 */
	async function isolatePath(): Promise<string> {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-update-path-")));
		dirs.push(dir);
		process.env.PATH = dir;
		return dir;
	}

	/** Route global fetch through `respond`, recording each request. */
	function stubFetch(respond: (url: string) => Response): Array<{ url: string; signal?: AbortSignal | null }> {
		const requests: Array<{ url: string; signal?: AbortSignal | null }> = [];
		const fetchStub = Object.assign(
			async (input: FetchInput, init?: FetchInit) => {
				requests.push({ url: String(input), signal: init?.signal });
				return respond(String(input));
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);
		return requests;
	}

	function quiet(): { logs: string[] } {
		const logs: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logs.push(args.join(" "));
		});
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			logs.push(args.join(" "));
		});
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new Error(`process.exit(${code}): ${logs.join("\n")}`);
		}) as typeof process.exit);
		vi.spyOn(cfgUpdateChannel, "get").mockReturnValue("stable");
		return { logs };
	}

	it("checks npm, with a timeout, when no standalone binary is on PATH", async () => {
		await isolatePath();
		process.env.PI_BUILD_URL = "https://build.test";
		quiet();
		const requests = stubFetch(() => Response.json({ version: "999.0.0" }));

		await runUpdateCommand({ force: false, check: true });

		expect(requests.length).toBeGreaterThan(0);
		expect(requests.some(request => request.url.startsWith("https://build.test/"))).toBe(false);
		for (const request of requests) expect(request.signal).toBeInstanceOf(AbortSignal);
	});

	it.skipIf(process.platform === "win32")(
		"updates a standalone binary from the build service without asking npm",
		async () => {
			const dir = await isolatePath();
			const ompPath = path.join(dir, "omp");
			await Bun.write(ompPath, "#!/bin/sh\necho omp/1.0.0\n");
			await fs.chmod(ompPath, 0o755);
			const next = "#!/bin/sh\necho omp/999.0.0\n";
			const { target, fileName } = await currentBuildHost();
			process.env.PI_BUILD_URL = "https://build.test";
			const check = `https://build.test/api/products/omp/latest/${target}?channel=stable&from_version=${VERSION}`;
			const { logs } = quiet();
			const requests = stubFetch(url => {
				if (url === check) {
					return Response.json({
						build: { version: "999.0.0" },
						file: { name: fileName, size: Buffer.byteLength(next), sha256: Bun.SHA256.hash(next, "hex") },
						download: "https://r2.test/omp",
					});
				}
				if (url === "https://r2.test/omp") return new Response(next);
				return new Response(null, { status: 404 });
			});

			await runUpdateCommand({ force: false, check: false });

			expect(requests.map(request => request.url)).toEqual([check, "https://r2.test/omp"]);
			expect(await Bun.file(ompPath).text()).toBe(next);
			expect(logs.some(line => line.includes("Updated to 999.0.0"))).toBe(true);
		},
	);
});

describe("getLatestRelease rename pointers", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("follows omp.rename to the new package and resolves version, dist, and names from its manifest", async () => {
		const urls = stubRegistry({
			"@new/omp": { version: "999.1.0", omp: { dist: "npm" } },
			"@oh-my-pi/pi-coding-agent": {
				version: "999.0.0",
				omp: { dist: "binary", rename: { package: "@new/omp", natives: "@new/natives" } },
			},
		});

		const release = await getLatestRelease({ registries: npmjs });

		expect(release.version).toBe("999.1.0");
		expect(release.dist).toBe("npm");
		expect(release.packages).toEqual({ pkg: "@new/omp", natives: "@new/natives" });
		expect(urls).toEqual([
			"https://registry.npmjs.org/@oh-my-pi%2fpi-coding-agent/latest",
			"https://registry.npmjs.org/@new%2fomp/latest",
		]);
	});
	it("fetches the canary dist-tag when checking the canary channel", async () => {
		const urls = stubRegistry({
			"@oh-my-pi/pi-coding-agent": { version: "999.0.0-canary.1" },
		});

		await getLatestRelease({ channel: "canary", registries: npmjs });

		expect(urls).toEqual(["https://registry.npmjs.org/@oh-my-pi%2fpi-coding-agent/canary"]);
	});

	it("ignores a rename pointer that cycles back to an already-visited package", async () => {
		const urls = stubRegistry({
			"@oh-my-pi/pi-coding-agent": {
				version: "999.0.0",
				omp: { rename: { package: "@oh-my-pi/pi-coding-agent" } },
			},
		});

		const release = await getLatestRelease({ registries: npmjs });

		expect(urls).toHaveLength(1);
		expect(release.version).toBe("999.0.0");
		expect(release.packages).toEqual({ pkg: "@oh-my-pi/pi-coding-agent", natives: "@oh-my-pi/pi-natives" });
	});
});

describe("getLatestRelease configured registry", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const feed = () => ({
		url: "https://npm.corp.example/api/npm/feed/",
		source: "/home/u/.npmrc",
		authorization: "Bearer s3cret",
	});

	it("queries the configured feed with its credentials and reports it for the install pin", async () => {
		const requests: { url: string; authorization: string | null }[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: FetchInput, init?: FetchInit) => {
					requests.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
					return Response.json({ version: "999.0.0" });
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);

		const release = await getLatestRelease({ registries: feed });

		expect(requests).toEqual([
			{
				url: "https://npm.corp.example/api/npm/feed/@oh-my-pi%2fpi-coding-agent/latest",
				authorization: "Bearer s3cret",
			},
		]);
		expect(release.registry).toBe("https://npm.corp.example/api/npm/feed/");
	});

	it("falls back to the full packument when the feed does not serve the dist-tag shortcut", async () => {
		const urls: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: FetchInput) => {
					const url = String(input);
					urls.push(url);
					if (url.endsWith("/latest")) return new Response(null, { status: 404, statusText: "Not Found" });
					return Response.json({
						"dist-tags": { latest: "999.2.0" },
						versions: { "999.2.0": { version: "999.2.0", omp: { dist: "binary" } } },
					});
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);

		const release = await getLatestRelease({ registries: feed });

		expect(urls).toEqual([
			"https://npm.corp.example/api/npm/feed/@oh-my-pi%2fpi-coding-agent/latest",
			"https://npm.corp.example/api/npm/feed/@oh-my-pi%2fpi-coding-agent",
		]);
		expect(release.version).toBe("999.2.0");
		expect(release.dist).toBe("binary");
	});

	it("uses the curated packument tag when a tagged manifest has empty packument fields", async () => {
		const urls: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: FetchInput) => {
					const url = String(input);
					urls.push(url);
					if (url.endsWith("/latest")) {
						return Response.json({ version: "999.9.0", "dist-tags": {}, versions: {}, time: {} });
					}
					return Response.json({
						"dist-tags": { latest: "999.2.0" },
						versions: { "999.2.0": { version: "999.2.0", omp: { dist: "binary" } } },
					});
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);

		const release = await getLatestRelease({ registries: feed });

		expect(urls).toEqual([
			"https://npm.corp.example/api/npm/feed/@oh-my-pi%2fpi-coding-agent/latest",
			"https://npm.corp.example/api/npm/feed/@oh-my-pi%2fpi-coding-agent",
		]);
		expect(release.version).toBe("999.2.0");
		expect(release.dist).toBe("binary");
	});

	it("resolves the tagged version when the feed answers the dist-tag shortcut with the full packument", async () => {
		const urls: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: FetchInput) => {
					urls.push(String(input));
					return Response.json({
						"dist-tags": { latest: "999.3.0" },
						versions: { "999.3.0": { version: "999.3.0", omp: { dist: "binary" } } },
					});
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);

		const release = await getLatestRelease({ registries: feed });

		expect(urls).toEqual(["https://npm.corp.example/api/npm/feed/@oh-my-pi%2fpi-coding-agent/latest"]);
		expect(release.version).toBe("999.3.0");
		expect(release.dist).toBe("binary");
	});

	it("falls back to the full packument when the shortcut returns 200 without a version", async () => {
		const urls: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: FetchInput) => {
					const url = String(input);
					urls.push(url);
					if (url.endsWith("/latest")) return Response.json({ success: false, error: "not found" });
					return Response.json({
						"dist-tags": { latest: "999.4.0" },
						versions: { "999.4.0": { version: "999.4.0" } },
					});
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);

		const release = await getLatestRelease({ registries: feed });

		expect(urls).toHaveLength(2);
		expect(release.version).toBe("999.4.0");
	});

	it("falls back to the full packument when the shortcut returns 200 with a non-JSON body", async () => {
		const urls: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: FetchInput) => {
					const url = String(input);
					urls.push(url);
					if (url.endsWith("/latest")) return new Response("<html>Nexus</html>", { status: 200 });
					return Response.json({
						"dist-tags": { latest: "999.5.0" },
						versions: { "999.5.0": { version: "999.5.0" } },
					});
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);

		const release = await getLatestRelease({ registries: feed });

		expect(urls).toHaveLength(2);
		expect(release.version).toBe("999.5.0");
	});

	it("surfaces a body-read failure on the shortcut instead of retrying the packument", async () => {
		const urls: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: FetchInput) => {
					urls.push(String(input));
					const body = new ReadableStream({
						start(controller) {
							controller.error(new Error("connection reset mid-body"));
						},
					});
					return new Response(body, { status: 200 });
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);

		await expect(getLatestRelease({ registries: feed })).rejects.toThrow("connection reset mid-body");
		expect(urls).toHaveLength(1);
	});

	it("reports a missing canary dist-tag on the feed as no canary release", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: FetchInput) =>
					String(input).endsWith("/canary")
						? new Response(null, { status: 404, statusText: "Not Found" })
						: Response.json({ "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": { version: "1.0.0" } } }),
				{ preconnect: globalThis.fetch.preconnect },
			),
		);

		await expect(getLatestRelease({ channel: "canary", registries: feed })).rejects.toThrow(
			"No canary release has been published",
		);
	});
});

describe("getLatestRelease proxy errors", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("translates Bun's UnsupportedProxyProtocol fetch failure into an actionable CLI message", async () => {
		const fetchStub = Object.assign(
			async () => {
				throw new Error(
					'UnsupportedProxyProtocol fetching "https://registry.npmjs.org/@oh-my-pi/pi-coding-agent/latest". ' +
						"For more information, pass `verbose: true` in the second argument to fetch()",
				);
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		const err = await getLatestRelease({ timeoutMs: 5000, registries: npmjs }).then(
			() => null,
			(e: unknown) => e as Error,
		);

		expect(err).toBeInstanceOf(Error);
		// The raw fetch() instruction the CLI user cannot act on must not leak through.
		expect(err?.message).not.toContain("verbose: true");
		expect(err?.message).not.toContain("fetch()");
		// Instead the user gets actionable guidance about supported proxy schemes.
		expect(err?.message).toMatch(/SOCKS/i);
		expect(err?.message).toMatch(/https?:\/\//i);
	});
});

describe("taoeffect fork release builds", () => {
	const FORK_VERSION = "18.4.9-taoeffect.1";
	// Never published: if the launcher check breaks, the real `npm install -g` fails instead of installing a release.
	const NEXT_FORK_VERSION = "999.0.0-taoeffect.1";
	const WRAPPER_ENV = "OMP_TAOEFFECTS_NPM_WRAPPER";
	let savedWrapperEnv: string | undefined;

	beforeEach(() => {
		savedWrapperEnv = process.env[WRAPPER_ENV];
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (savedWrapperEnv === undefined) delete process.env[WRAPPER_ENV];
		else process.env[WRAPPER_ENV] = savedWrapperEnv;
	});

	it("checks the latest @taoeffects/omp release instead of upstream, even on the canary channel", async () => {
		const urls = stubRegistry({ "@taoeffects/omp": { name: "@taoeffects/omp", version: NEXT_FORK_VERSION } });

		const release = await getLatestRelease({ channel: "canary", registries: npmjs, currentVersion: FORK_VERSION });

		expect(urls).toEqual(["https://registry.npmjs.org/@taoeffects%2fomp/latest"]);
		expect(release.version).toBe(NEXT_FORK_VERSION);
	});

	it("prints the npm command instead of installing when omp inherited the npm launcher marker", async () => {
		// The launcher sets its own pid for the omp it starts. A process started by that omp inherits
		// the marker, but its parent is not the launcher.
		process.env[WRAPPER_ENV] = String(process.pid);
		stubRegistry({ "@taoeffects/omp": { name: "@taoeffects/omp", version: NEXT_FORK_VERSION } });
		const output: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			output.push(args.join(" "));
		});
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new Error(`process.exit(${code})`);
		}) as typeof process.exit);

		await runUpdateCommand({ force: false, check: false, currentVersion: FORK_VERSION });

		expect(output.join("\n")).toMatch(/npm install -g --registry=\S+ @taoeffects\/omp@999\.0\.0-taoeffect\.1/);
	});

	it.each([
		["upstream released past the fork base", FORK_VERSION, "18.5.0", "18.5.0"],
		["the newest fork release already contains the upstream release", NEXT_FORK_VERSION, "999.0.0", undefined],
		// Semver puts 18.4.9 above 18.4.9-taoeffect.1; the fork base must be compared instead.
		["upstream is still at the fork base", FORK_VERSION, "18.4.9", undefined],
	])("reports upstream ahead only when %s", async (_name, forkLatest, upstreamLatest, expected) => {
		stubRegistry({
			"@taoeffects/omp": { name: "@taoeffects/omp", version: forkLatest },
			"@oh-my-pi/pi-coding-agent": { version: upstreamLatest },
		});

		const check = await checkForkReleases(FORK_VERSION, { registries: npmjs });

		expect(check.release.version).toBe(forkLatest);
		expect(check.upstreamAhead).toBe(expected);
	});

	it("tells the user to wait for the fork when only upstream has a newer release", async () => {
		stubRegistry({
			"@taoeffects/omp": { name: "@taoeffects/omp", version: FORK_VERSION },
			"@oh-my-pi/pi-coding-agent": { version: "999.0.0" },
		});
		const output: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			output.push(args.join(" "));
		});
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new Error(`process.exit(${code})`);
		}) as typeof process.exit);

		await runUpdateCommand({ force: false, check: false, currentVersion: FORK_VERSION });

		const text = output.join("\n");
		expect(text).toMatch(/released 999\.0\.0, which goes beyond this fork\. Wait for/);
		expect(text).not.toContain("npm install");
	});
});
