import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { getBundledModel, getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { modelsDevCatalogFallback, zaiModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const CODING_MODELS_URL = "https://api.z.ai/api/coding/paas/v4/models";
const SHARED_CATALOG_HOST = "https://catalog.stencil.so/";

// The coding endpoint returns bare rows: no names, limits, or prices.
// `glm-9.1` stands in for a launch no bundle carries yet.
const ENDPOINT_IDS = ["glm-5.3", "glm-5.3-flash", "glm-5.3-flashx-legal", "glm-5v-turbo", "glm-9.1"];

const LOW_HIGH_MAX = [{ type: "effort", values: ["low", "high", "max"] }];

// The models.dev GLM Coding Plan section publishes subscription rates of $0;
// the pay-as-you-go `zai` section publishes list prices.
const ZAI_CATALOG = {
	"zai-coding-plan": {
		models: {
			"glm-5.3": {
				name: "GLM-5.3",
				reasoning: true,
				reasoning_options: [{ type: "effort", values: ["high", "max"] }],
				tool_call: true,
				modalities: { input: ["text"] },
				cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
				limit: { context: 200_000, output: 32_768 },
			},
			"glm-9.1": {
				name: "GLM-9.1",
				reasoning: true,
				reasoning_options: LOW_HIGH_MAX,
				tool_call: true,
				modalities: { input: ["text", "image"] },
				cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
				limit: { context: 1_000_000, output: 131_072 },
			},
		},
	},
	zai: {
		models: {
			// Classified into the flash family, whose pre-5.3 ladder must not claim it.
			"glm-5.3-flashx-legal": {
				name: "GLM-5.3-FlashX-Legal",
				reasoning: true,
				reasoning_options: LOW_HIGH_MAX,
				tool_call: true,
				modalities: { input: ["text", "image"] },
				cost: { input: 0.37, output: 1.25, cache_read: 0.075, cache_write: 0 },
				limit: { context: 1_000_000, output: 131_072 },
			},
			// Bundled, but no reviewed rule owns its ladder: the bundle carries a guess.
			"glm-5v-turbo": {
				name: "GLM-5V-Turbo",
				reasoning: true,
				reasoning_options: LOW_HIGH_MAX,
				tool_call: true,
				modalities: { input: ["text", "image"] },
				cost: { input: 1.2, output: 4, cache_read: 0.24, cache_write: 0 },
				limit: { context: 200_000, output: 131_072 },
			},
		},
	},
};

interface Seen {
	urls: string[];
	authorization: string | null;
}

function zaiFetch(seen: Seen, catalogAvailable: boolean): FetchImpl {
	return Object.assign(
		async (input: string | Request | URL, init?: RequestInit): Promise<Response> => {
			const url = input instanceof Request ? input.url : String(input);
			seen.urls.push(url);
			if (url.startsWith(SHARED_CATALOG_HOST)) {
				if (!catalogAvailable) throw new Error("catalog unreachable");
				return Response.json(ZAI_CATALOG);
			}
			if (url === CODING_MODELS_URL) {
				seen.authorization = new Headers(init?.headers).get("authorization");
				return Response.json({
					object: "list",
					data: ENDPOINT_IDS.map(id => ({ id, object: "model", created: 0, owned_by: "z-ai" })),
				});
			}
			return new Response("not found", { status: 404 });
		},
		{ preconnect: fetch.preconnect },
	);
}

async function withTempCache<T>(run: (cacheDbPath: string) => Promise<T>): Promise<T> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-zai-discovery-"));
	try {
		return await run(path.join(tempDir, "models.db"));
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}

describe("zai coding endpoint discovery", () => {
	it("adds unbundled endpoint ids without dropping or repricing bundled ones", async () => {
		expect(getBundledModel("zai", "glm-9.1")).toBeUndefined();
		const bundled53 = getBundledModel("zai", "glm-5.3");
		const seen: Seen = { urls: [], authorization: null };

		const result = await withTempCache(cacheDbPath =>
			resolveProviderModels(
				{
					...zaiModelManagerOptions({ apiKey: "test-key", fetch: zaiFetch(seen, true) }),
					cacheDbPath,
					staticModels: getBundledModels("zai"),
				},
				"online",
			),
		);
		const byId = new Map(result.models.map(model => [model.id, model]));

		expect(seen.urls).toContain(CODING_MODELS_URL);
		expect(seen.authorization).toBe("Bearer test-key");
		// Published tiers replace the guess; the Anthropic route keeps its wire mode.
		expect(byId.get("glm-9.1")).toMatchObject({
			api: "anthropic-messages",
			baseUrl: "https://api.z.ai/api/anthropic",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1_000_000,
			maxTokens: 131_072,
			thinking: { mode: "anthropic-budget-effort", efforts: [Effort.Low, Effort.High, Effort.Max] },
		});
		expect(byId.get("glm-5.3-flashx-legal")?.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
		// A bundled ladder no reviewed rule owns is the generator's guess; published tiers replace it.
		expect(byId.get("glm-5v-turbo")?.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
		expect(byId.get("glm-5.3-flash")).toMatchObject({
			api: "openai-completions",
			baseUrl: "https://api.z.ai/api/coding/paas/v4",
		});
		// Bundled metadata outranks the coding-plan catalog's $0 rates, smaller limits, and other tiers.
		expect(byId.get("glm-5.3")).toMatchObject({
			cost: bundled53?.cost,
			contextWindow: bundled53?.contextWindow,
			maxTokens: bundled53?.maxTokens,
			thinking: bundled53?.thinking,
		});
		// The endpoint omits ids the plan still serves; discovery must not prune them.
		expect(byId.has("glm-4.5v")).toBe(true);
	});

	it("still lists endpoint ids when the shared catalog is unreachable", async () => {
		const seen: Seen = { urls: [], authorization: null };
		const models = await zaiModelManagerOptions({
			apiKey: "test-key",
			fetch: zaiFetch(seen, false),
		}).fetchDynamicModels?.();

		expect(models?.map(model => model.id).sort()).toEqual([...ENDPOINT_IDS].sort());
		expect(models?.find(model => model.id === "glm-9.1")).toMatchObject({
			api: "anthropic-messages",
			baseUrl: "https://api.z.ai/api/anthropic",
		});
	});

	it("makes no endpoint request without a key", () => {
		expect(zaiModelManagerOptions({}).fetchDynamicModels).toBeUndefined();
	});

	it("gives keyless catalog rows their published tiers", () => {
		const rows = modelsDevCatalogFallback("zai")?.map(ZAI_CATALOG, "zai") ?? [];
		const legal = rows.find(model => model.id === "glm-5.3-flashx-legal");

		expect(legal && buildModel(legal).thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
	});
});
