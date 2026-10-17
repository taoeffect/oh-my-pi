import { afterEach, describe, expect, it } from "bun:test";
import type { FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import {
	resetRequestCompressionForTesting,
	wrapFetchForRequestCompression,
} from "@oh-my-pi/pi-ai/utils/request-compression";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Api } from "@oh-my-pi/pi-catalog/types";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages?beta=true";
const COPILOT_URL = "https://api.individual.githubcopilot.com/chat/completions";
const LARGE_BODY = JSON.stringify({ messages: [{ role: "user", content: "hello world ".repeat(500) }] });

function model(provider: string, api: Api, baseUrl: string): Model {
	return buildModel({
		id: "test-model",
		name: "Test Model",
		api,
		provider,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	});
}

const anthropic = model("anthropic", "anthropic-messages", "https://api.anthropic.com");
const copilot = model("github-copilot", "openai-completions", "https://api.individual.githubcopilot.com");

interface Captured {
	body: RequestInit["body"];
	headers: Record<string, string | undefined>;
}

function captureFetch(responses: Response[]): { calls: Captured[]; fetch: FetchImpl } {
	const calls: Captured[] = [];
	const fetch: FetchImpl = async (_input, init) => {
		calls.push({ body: init?.body, headers: init?.headers as Record<string, string | undefined> });
		return responses.shift() ?? new Response("{}", { status: 200 });
	};
	return { calls, fetch };
}

const post = (headers: Record<string, string> = { "Content-Type": "application/json" }) => ({
	method: "POST",
	headers,
	body: LARGE_BODY,
});

const decode = (body: RequestInit["body"], decoder: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array) =>
	new TextDecoder().decode(decoder(body as Uint8Array<ArrayBuffer>));

const anthropicRejection = () =>
	new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: "invalid_request_error",
				message: "Request body is not valid gzip.",
				details: { error_code: "request_body_encoding_invalid" },
			},
		}),
		{ status: 400 },
	);

const copilotRejection = () =>
	new Response('{"error":{"message":"Failed to read request body.","code":"invalid_request_body"}}', { status: 400 });

afterEach(() => resetRequestCompressionForTesting());

describe("wrapFetchForRequestCompression", () => {
	it("gzips large bodies to the official Anthropic API without disturbing other headers", async () => {
		const { calls, fetch } = captureFetch([]);
		await wrapFetchForRequestCompression(fetch, anthropic)(ANTHROPIC_URL, post());

		expect(calls[0].headers).toEqual({ "Content-Type": "application/json", "Content-Encoding": "gzip" });
		expect(decode(calls[0].body, Bun.gunzipSync)).toBe(LARGE_BODY);
	});

	it("zstd-compresses large bodies to the first-party Copilot API", async () => {
		const { calls, fetch } = captureFetch([]);
		await wrapFetchForRequestCompression(fetch, copilot)(COPILOT_URL, post());

		expect(calls[0].headers["Content-Encoding"]).toBe("zstd");
		expect(decode(calls[0].body, Bun.zstdDecompressSync)).toBe(LARGE_BODY);
	});

	it("leaves proxies, unverified Copilot hosts, providers without rules, and tiny bodies uncompressed", async () => {
		const { calls, fetch } = captureFetch([]);
		await wrapFetchForRequestCompression(fetch, anthropic)("https://gateway.example/anthropic/v1/messages", post());
		await wrapFetchForRequestCompression(fetch, copilot)("https://copilot-api.acme.ghe.com/chat/completions", post());
		const relay = model("deepseek", "openai-completions", "https://api.deepseek.com");
		await wrapFetchForRequestCompression(fetch, relay)("https://api.deepseek.com/chat/completions", post());
		await wrapFetchForRequestCompression(fetch, anthropic)(ANTHROPIC_URL, { method: "POST", body: '{"model":"x"}' });

		expect(calls.map(call => call.body)).toEqual([LARGE_BODY, LARGE_BODY, LARGE_BODY, '{"model":"x"}']);
		expect(calls[0].headers).toEqual({ "Content-Type": "application/json" });
	});

	it("resends uncompressed after an encoding rejection and stops compressing for that host only", async () => {
		const { calls, fetch } = captureFetch([anthropicRejection()]);
		const toAnthropic = wrapFetchForRequestCompression(fetch, anthropic);

		const response = await toAnthropic(ANTHROPIC_URL, post());
		await toAnthropic(ANTHROPIC_URL, post());
		await wrapFetchForRequestCompression(fetch, copilot)(COPILOT_URL, post());

		expect(response.status).toBe(200);
		expect(calls.map(call => call.headers["Content-Encoding"])).toEqual(["gzip", undefined, undefined, "zstd"]);
		expect(calls[1].body).toBe(LARGE_BODY);
	});

	it("falls back to the host's next accepted encoding once the preferred one is rejected", async () => {
		const { calls, fetch } = captureFetch([copilotRejection()]);
		const wrapped = wrapFetchForRequestCompression(fetch, copilot);

		await wrapped(COPILOT_URL, post());
		await wrapped(COPILOT_URL, post());

		expect(calls.map(call => call.headers["Content-Encoding"])).toEqual(["zstd", undefined, "gzip"]);
		expect(decode(calls[2].body, Bun.gunzipSync)).toBe(LARGE_BODY);
	});

	it("keeps compressing when the uncompressed resend fails the same way", async () => {
		const { calls, fetch } = captureFetch([copilotRejection(), copilotRejection()]);
		const wrapped = wrapFetchForRequestCompression(fetch, copilot);

		const response = await wrapped(COPILOT_URL, post());
		await wrapped(COPILOT_URL, post());

		expect(response.status).toBe(400);
		expect(calls.map(call => call.headers["Content-Encoding"])).toEqual(["zstd", undefined, "zstd"]);
	});

	it("surfaces unrelated 400s once, with the error body still readable", async () => {
		const error = '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long"}}';
		const { calls, fetch } = captureFetch([new Response(error, { status: 400 })]);

		const response = await wrapFetchForRequestCompression(fetch, anthropic)(ANTHROPIC_URL, post());

		expect(calls).toHaveLength(1);
		expect(await response.text()).toBe(error);
	});
});
