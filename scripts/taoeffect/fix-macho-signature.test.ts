import { describe, expect, test } from "bun:test";
import { fixDarwinSignature, inspectCodeSignature } from "./fix-macho-signature";

const CPU_TYPE = { x86_64: 0x01000007, arm64: 0x0100000c } as const;
const PAGE_SIZE = 4096;
const LINKEDIT_OFFSET = 2 * PAGE_SIZE;
const CODE_SIZE = LINKEDIT_OFFSET + 1000;
const SEGMENT_COMMAND_SIZE = 72;
const COMMANDS_END = 32 + 2 * SEGMENT_COMMAND_SIZE + 16 + 24;
const UUID_COMMAND_OFFSET = 32 + 2 * SEGMENT_COMMAND_SIZE + 16;
const CODE_DIRECTORY_OFFSET = 20;
const CODE_DIRECTORY_HEADER_SIZE = 88;
const IDENTIFIER = "a.out\0";
const PAGE_COUNT = Math.ceil(CODE_SIZE / PAGE_SIZE);
const SIGNATURE_SIZE = CODE_DIRECTORY_OFFSET + CODE_DIRECTORY_HEADER_SIZE + IDENTIFIER.length + PAGE_COUNT * 32;

/**
 * A minimal executable laid out like Bun's darwin output: __TEXT, __LINKEDIT,
 * LC_CODE_SIGNATURE, then one more load command (LC_UUID); the ad-hoc
 * signature is the tail of __LINKEDIT and of the file.
 */
function signedMachO(cpu: keyof typeof CPU_TYPE): Uint8Array {
	const binary = new Uint8Array(CODE_SIZE + SIGNATURE_SIZE);
	const view = new DataView(binary.buffer);
	for (let offset = COMMANDS_END; offset < CODE_SIZE; offset++) binary[offset] = (offset * 31) & 0xff;

	view.setUint32(0, 0xfeedfacf, true);
	view.setUint32(4, CPU_TYPE[cpu], true);
	view.setUint32(12, 2, true);
	view.setUint32(16, 4, true);
	view.setUint32(20, COMMANDS_END - 32, true);
	const segments = [
		{ name: "__TEXT", fileOffset: 0, fileSize: LINKEDIT_OFFSET },
		{ name: "__LINKEDIT", fileOffset: LINKEDIT_OFFSET, fileSize: binary.length - LINKEDIT_OFFSET },
	];
	segments.forEach(({ name, fileOffset, fileSize }, index) => {
		const offset = 32 + index * SEGMENT_COMMAND_SIZE;
		view.setUint32(offset, 0x19, true);
		view.setUint32(offset + 4, SEGMENT_COMMAND_SIZE, true);
		binary.set(new TextEncoder().encode(name), offset + 8);
		view.setBigUint64(offset + 32, BigInt(fileSize), true);
		view.setBigUint64(offset + 40, BigInt(fileOffset), true);
		view.setBigUint64(offset + 48, BigInt(fileSize), true);
	});
	const signatureCommand = 32 + 2 * SEGMENT_COMMAND_SIZE;
	view.setUint32(signatureCommand, 0x1d, true);
	view.setUint32(signatureCommand + 4, 16, true);
	view.setUint32(signatureCommand + 8, CODE_SIZE, true);
	view.setUint32(signatureCommand + 12, SIGNATURE_SIZE, true);
	view.setUint32(UUID_COMMAND_OFFSET, 0x1b, true);
	view.setUint32(UUID_COMMAND_OFFSET + 4, 24, true);
	binary.fill(0xab, UUID_COMMAND_OFFSET + 8, UUID_COMMAND_OFFSET + 24);

	const signature = new DataView(binary.buffer, CODE_SIZE);
	signature.setUint32(0, 0xfade0cc0);
	signature.setUint32(4, SIGNATURE_SIZE);
	signature.setUint32(8, 1);
	signature.setUint32(12, 0);
	signature.setUint32(16, CODE_DIRECTORY_OFFSET);
	const directory = CODE_DIRECTORY_OFFSET;
	const hashOffset = CODE_DIRECTORY_HEADER_SIZE + IDENTIFIER.length;
	signature.setUint32(directory, 0xfade0c02);
	signature.setUint32(directory + 4, SIGNATURE_SIZE - CODE_DIRECTORY_OFFSET);
	signature.setUint32(directory + 8, 0x20400);
	signature.setUint32(directory + 12, 0x20002);
	signature.setUint32(directory + 16, hashOffset);
	signature.setUint32(directory + 20, CODE_DIRECTORY_HEADER_SIZE);
	signature.setUint32(directory + 28, PAGE_COUNT);
	signature.setUint32(directory + 32, CODE_SIZE);
	signature.setUint8(directory + 36, 32);
	signature.setUint8(directory + 37, 2);
	signature.setUint8(directory + 39, 12);
	binary.set(new TextEncoder().encode(IDENTIFIER), CODE_SIZE + directory + CODE_DIRECTORY_HEADER_SIZE);
	for (let page = 0; page < PAGE_COUNT; page++) {
		const start = page * PAGE_SIZE;
		const digest = new Bun.CryptoHasher("sha256")
			.update(binary.subarray(start, Math.min(start + PAGE_SIZE, CODE_SIZE)))
			.digest();
		binary.set(digest, CODE_SIZE + directory + hashOffset + page * 32);
	}
	return binary;
}

/** Changes code after signing, like Bun patching its signed runtime template. */
function withPatchedCode(binary: Uint8Array): Uint8Array {
	const patched = binary.slice();
	patched[PAGE_SIZE + 10] ^= 0xff;
	return patched;
}

describe("fixDarwinSignature", () => {
	test("removes an invalid x86_64 signature and keeps the rest of the binary intact", () => {
		const stale = withPatchedCode(signedMachO("x86_64"));

		const result = fixDarwinSignature(stale);

		expect(result).toMatchObject({ action: "removed", cpu: "x86_64", problem: "page 1 does not match its hash" });
		const stripped = result.binary;
		const view = new DataView(stripped.buffer, stripped.byteOffset, stripped.byteLength);
		expect(stripped.length).toBe(CODE_SIZE);
		expect(view.getUint32(16, true)).toBe(3);
		expect(view.getUint32(20, true)).toBe(COMMANDS_END - 32 - 16);
		expect(view.getUint32(UUID_COMMAND_OFFSET - 16, true)).toBe(0x1b);
		expect(stripped.subarray(UUID_COMMAND_OFFSET - 8, UUID_COMMAND_OFFSET + 8)).toEqual(
			new Uint8Array(16).fill(0xab),
		);
		expect(stripped.subarray(COMMANDS_END - 16, COMMANDS_END)).toEqual(new Uint8Array(16));
		expect(view.getBigUint64(32 + SEGMENT_COMMAND_SIZE + 48, true)).toBe(BigInt(CODE_SIZE - LINKEDIT_OFFSET));
		expect(stripped.subarray(COMMANDS_END)).toEqual(stale.subarray(COMMANDS_END, CODE_SIZE));
		expect(inspectCodeSignature(stripped)).toEqual({ cpu: "x86_64", status: "unsigned" });
		expect(fixDarwinSignature(stripped).action).toBe("already-unsigned");
	});

	test("strips a Buffer view without writing to the caller's memory", () => {
		const stale = withPatchedCode(signedMachO("x86_64"));
		const backing = Buffer.alloc(stale.length + 8);
		const input = backing.subarray(8);
		input.set(stale);
		const before = Buffer.from(backing);

		const result = fixDarwinSignature(input);

		expect(backing).toEqual(before);
		expect(result.binary).toEqual(fixDarwinSignature(stale).binary);
	});

	test("accepts a valid arm64 ad-hoc signature", () => {
		expect(fixDarwinSignature(signedMachO("arm64")).action).toBe("kept");
	});

	test("fails for an arm64 binary that macOS would refuse to run", () => {
		const signed = signedMachO("arm64");

		expect(() => fixDarwinSignature(withPatchedCode(signed))).toThrow(/arm64 binary has an invalid code signature/);
		const unsigned = fixDarwinSignature(withPatchedCode(signedMachO("x86_64"))).binary;
		new DataView(unsigned.buffer, unsigned.byteOffset).setUint32(4, CPU_TYPE.arm64, true);
		expect(() => fixDarwinSignature(unsigned)).toThrow(/arm64 binary has no code signature/);
	});
});
