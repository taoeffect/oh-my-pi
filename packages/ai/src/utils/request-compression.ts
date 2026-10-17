import { promisify } from "node:util";
import * as zlib from "node:zlib";
import {
	type RequestBodyEncoding,
	type RequestCompressionPolicy,
	resolveRequestCompression,
} from "@oh-my-pi/pi-catalog/compat/request-compression";
import { $flag, logger } from "@oh-my-pi/pi-utils";
import type { FetchImpl, Model } from "../types";

const gzip = promisify(zlib.gzip);

/** Bodies below one TCP segment gain nothing from compression; skip them. */
const MIN_COMPRESSED_BODY_BYTES = 1024;

/**
 * zlib's default level: on multi-MB transcripts ~35% smaller than level 1 for
 * ~2x the CPU — a few ms per MB.
 */
const GZIP_LEVEL = 6;

/**
 * Measured on real 1–2 MB transcripts: smaller than gzip-6 at about a quarter
 * of its CPU; higher levels triple the cost for ~1pp.
 */
const ZSTD_LEVEL = 3;

/**
 * `<origin> <encoding>` pairs a host has rejected. Latched per host and
 * encoding so one host's rejection never disables compression elsewhere, and
 * the next request falls back to that host's next accepted encoding.
 */
const rejectedEncodings = new Set<string>();

type RequestHeaders = RequestInit["headers"];

function requestUrl(input: string | URL | Request): string | undefined {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return undefined;
}

function hasContentEncoding(headers: RequestHeaders): boolean {
	if (!headers) return false;
	if (headers instanceof Headers) return headers.has("content-encoding");
	if (Array.isArray(headers)) return headers.some(([name]) => name.toLowerCase() === "content-encoding");
	for (const name in headers) {
		if (name.toLowerCase() === "content-encoding") return true;
	}
	return false;
}

/** Adds `Content-Encoding`, preserving the caller's header container and casing. */
function withContentEncoding(headers: RequestHeaders, encoding: RequestBodyEncoding): RequestHeaders {
	if (headers instanceof Headers) {
		const copy = new Headers(headers);
		copy.set("Content-Encoding", encoding);
		return copy;
	}
	if (Array.isArray(headers)) return [...headers, ["Content-Encoding", encoding]];
	return { ...headers, "Content-Encoding": encoding };
}

/** Off the event loop: a synchronous codec stalls the TUI ~120ms on a 9MB body. */
function compress(body: string | ArrayBufferView, encoding: RequestBodyEncoding): Promise<Uint8Array> {
	const bytes = typeof body === "string" ? body : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
	return encoding === "zstd" ? Bun.zstdCompress(bytes, { level: ZSTD_LEVEL }) : gzip(bytes, { level: GZIP_LEVEL });
}

async function mayBeEncodingRejection(response: Response, policy: RequestCompressionPolicy): Promise<boolean> {
	if (response.status !== 400 && response.status !== 415) return false;
	if (!policy.rejection) return true;
	try {
		return policy.rejection.test(await response.clone().text());
	} catch {
		return false;
	}
}

/**
 * Compresses request bodies from {@link model} to its provider's own endpoint
 * when its catalog rules declare encodings the endpoint decodes
 * (`request-encodings` / `endpoint-hosts` KDL axes). Long sessions resend
 * multi-MB transcripts every turn, so upload time dominates time-to-first-token
 * on ordinary uplinks.
 *
 * Install it beneath any body rewriter or signer (e.g. the cch attestation
 * patch): those must see the uncompressed bytes. Other hosts, small bodies,
 * bodies that already carry `Content-Encoding`, and `PI_REQUEST_COMPRESSION=0`
 * pass through untouched. A possible rejection is resent uncompressed once;
 * only when that resend succeeds is the encoding latched off for the host, so
 * a genuine 400 never disables compression.
 */
export function wrapFetchForRequestCompression(base: FetchImpl, model: Model): FetchImpl {
	const wrapped: FetchImpl = async (input, init) => {
		const body = init?.body;
		const url = requestUrl(input);
		if (
			url === undefined ||
			!(typeof body === "string" || ArrayBuffer.isView(body)) ||
			// UTF-16 length undercounts UTF-8 bytes — fine for a size floor.
			(typeof body === "string" ? body.length : body.byteLength) < MIN_COMPRESSED_BODY_BYTES ||
			hasContentEncoding(init?.headers) ||
			!$flag("PI_REQUEST_COMPRESSION", true)
		) {
			return base(input, init);
		}
		const policy = resolveRequestCompression(model, url);
		if (!policy) return base(input, init);
		const origin = new URL(url).origin;
		const encoding = policy.encodings.find(candidate => !rejectedEncodings.has(`${origin} ${candidate}`));
		if (!encoding) return base(input, init);

		let compressed: Uint8Array;
		try {
			compressed = await compress(body, encoding);
		} catch (error) {
			logger.debug("Request body compression failed; sending uncompressed", {
				origin,
				encoding,
				error: error instanceof Error ? error.message : String(error),
			});
			return base(input, init);
		}

		const response = await base(input, {
			...init,
			body: compressed,
			headers: withContentEncoding(init?.headers, encoding),
		});
		if (!(await mayBeEncodingRejection(response, policy))) return response;

		await response.body?.cancel().catch(() => {});
		const plain = await base(input, init);
		if (plain.ok) {
			rejectedEncodings.add(`${origin} ${encoding}`);
			logger.warn("Endpoint rejected compressed request body; disabling this encoding for the host", {
				origin,
				encoding,
				status: response.status,
			});
		}
		return plain;
	};
	if (base.preconnect) wrapped.preconnect = base.preconnect;
	return wrapped;
}

/** Test hook: clears every per-host rejection latch. */
export function resetRequestCompressionForTesting(): void {
	rejectedEncodings.clear();
}
