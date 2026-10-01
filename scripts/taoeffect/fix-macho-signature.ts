#!/usr/bin/env bun
/**
 * Release builds only: checks the code signature of a darwin binary that Bun
 * cross-compiled on Linux, and removes it from x86_64 binaries when it is invalid.
 *
 * Bun 1.4.2 writes a valid ad-hoc signature into darwin-arm64 binaries, but it
 * does not re-sign darwin-x64 binaries: they keep the Developer ID signature of
 * Bun's own runtime, which no longer matches the pages Bun changed, and macOS
 * kills a process whose signed pages do not match. The fork does no signing,
 * like the Crush fork, whose darwin x86_64 binary is unsigned. macOS runs
 * unsigned x86_64 binaries but not unsigned arm64 binaries.
 *
 * Layouts: <mach-o/loader.h> (mach_header_64, segment_command_64,
 * linkedit_data_command) and the CodeDirectory format in Apple's
 * <kern/cs_blobs.h>. Mach-O fields are little-endian; signature blobs are
 * big-endian.
 */
import * as path from "node:path";
import { parseArgs } from "node:util";

export type DarwinCpu = "x86_64" | "arm64";

export type SignatureInspection =
	| { cpu: DarwinCpu; status: "valid" }
	| { cpu: DarwinCpu; status: "unsigned" }
	| { cpu: DarwinCpu; status: "invalid"; problem: string };

export type SignatureFix =
	| { action: "kept" | "unsigned"; cpu: DarwinCpu; binary: Uint8Array }
	| { action: "removed"; cpu: DarwinCpu; problem: string; binary: Uint8Array };

const MH_MAGIC_64 = 0xfeedfacf;
const MACH_HEADER_64_SIZE = 32;
const LC_SEGMENT_64 = 0x19;
const LC_CODE_SIGNATURE = 0x1d;
const CSMAGIC_EMBEDDED_SIGNATURE = 0xfade0cc0;
const CSMAGIC_CODEDIRECTORY = 0xfade0c02;
const CSSLOT_CODEDIRECTORY = 0;
const CODE_DIRECTORY_MIN_SIZE = 44;
const CODE_DIRECTORY_CODE_LIMIT_64_VERSION = 0x20300;
const CODE_DIRECTORY_CODE_LIMIT_64_END = 64;

const CPU_TYPES = new Map<number, DarwinCpu>([
	[0x01000007, "x86_64"],
	[0x0100000c, "arm64"],
]);
const HASH_ALGORITHMS = new Map<number, "sha1" | "sha256">([
	[1, "sha1"],
	[2, "sha256"],
]);

const USAGE = `Usage:
  bun scripts/taoeffect/fix-macho-signature.ts <binary>

Release builds only, for darwin binaries that Bun cross-compiled on Linux.
  x86_64: removes an invalid code signature in place, so the binary is unsigned
          like the Crush fork's. Keeps a valid signature.
  arm64:  fails unless the code signature is valid, because macOS does not run
          unsigned or wrongly signed arm64 binaries.
The script never adds a signature.`;

interface LoadCommand {
	cmd: number;
	offset: number;
	size: number;
}

interface MachOLayout {
	view: DataView;
	cpu: DarwinCpu;
	commands: LoadCommand[];
	commandsEnd: number;
}

interface CodeSignatureLocation {
	command: LoadCommand;
	dataOffset: number;
	dataSize: number;
}

function readLayout(binary: Uint8Array): MachOLayout {
	const view = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
	if (binary.byteLength < MACH_HEADER_64_SIZE || view.getUint32(0, true) !== MH_MAGIC_64) {
		throw new Error("not a thin 64-bit little-endian Mach-O binary");
	}
	const cpuType = view.getUint32(4, true);
	const cpu = CPU_TYPES.get(cpuType);
	if (!cpu) throw new Error(`unsupported Mach-O CPU type 0x${cpuType.toString(16)}`);
	const commandCount = view.getUint32(16, true);
	const commandsEnd = MACH_HEADER_64_SIZE + view.getUint32(20, true);
	if (commandsEnd > binary.byteLength) throw new Error("the load commands run past the end of the file");

	const commands: LoadCommand[] = [];
	let offset = MACH_HEADER_64_SIZE;
	for (let index = 0; index < commandCount; index++) {
		const size = offset + 8 <= commandsEnd ? view.getUint32(offset + 4, true) : 0;
		if (size < 8 || offset + size > commandsEnd) throw new Error(`load command ${index} is malformed`);
		commands.push({ cmd: view.getUint32(offset, true), offset, size });
		offset += size;
	}
	return { view, cpu, commands, commandsEnd };
}

function findCodeSignature({ view, commands }: MachOLayout): CodeSignatureLocation | undefined {
	const command = commands.find(candidate => candidate.cmd === LC_CODE_SIGNATURE);
	if (!command) return undefined;
	return {
		command,
		dataOffset: view.getUint32(command.offset + 8, true),
		dataSize: view.getUint32(command.offset + 12, true),
	};
}

function segmentName(view: DataView, command: LoadCommand): string {
	const bytes = new Uint8Array(view.buffer, view.byteOffset + command.offset + 8, 16);
	const end = bytes.indexOf(0);
	return new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end));
}

/** Returns why the signature does not cover and match every code page, or `undefined` when it does. */
function findSignatureProblem(binary: Uint8Array, { dataOffset, dataSize }: CodeSignatureLocation): string | undefined {
	if (dataOffset + dataSize > binary.byteLength) return "the signature runs past the end of the file";
	const blob = new DataView(binary.buffer, binary.byteOffset + dataOffset, dataSize);
	if (dataSize < 12 || blob.getUint32(0) !== CSMAGIC_EMBEDDED_SIGNATURE) return "no embedded signature blob";
	const blobCount = blob.getUint32(8);
	if (12 + blobCount * 8 > dataSize) return "the signature blob index is truncated";
	let codeDirectory: number | undefined;
	for (let index = 0; index < blobCount; index++) {
		if (blob.getUint32(12 + index * 8) === CSSLOT_CODEDIRECTORY) codeDirectory = blob.getUint32(16 + index * 8);
	}
	if (codeDirectory === undefined) return "no CodeDirectory";
	if (codeDirectory + CODE_DIRECTORY_MIN_SIZE > dataSize || blob.getUint32(codeDirectory) !== CSMAGIC_CODEDIRECTORY) {
		return "the CodeDirectory is malformed";
	}

	const version = blob.getUint32(codeDirectory + 8);
	const hashOffset = blob.getUint32(codeDirectory + 16);
	const codeSlots = blob.getUint32(codeDirectory + 28);
	let codeLimit = blob.getUint32(codeDirectory + 32);
	const hashSize = blob.getUint8(codeDirectory + 36);
	const algorithm = HASH_ALGORITHMS.get(blob.getUint8(codeDirectory + 37));
	const pageShift = blob.getUint8(codeDirectory + 39);
	if (
		codeLimit === 0 &&
		version >= CODE_DIRECTORY_CODE_LIMIT_64_VERSION &&
		codeDirectory + CODE_DIRECTORY_CODE_LIMIT_64_END <= dataSize
	) {
		codeLimit = Number(blob.getBigUint64(codeDirectory + 56));
	}
	if (!algorithm) return "the CodeDirectory uses an unsupported hash type";
	if (codeLimit !== dataOffset) return `the signature covers ${codeLimit} bytes, but the code is ${dataOffset} bytes`;
	const pageSize = pageShift === 0 ? codeLimit : 2 ** pageShift;
	if (codeSlots !== Math.ceil(codeLimit / pageSize))
		return `the signature has ${codeSlots} page hashes for ${codeLimit} bytes`;
	const hashesStart = dataOffset + codeDirectory + hashOffset;
	if (hashesStart + codeSlots * hashSize > dataOffset + dataSize) return "the page hashes run past the signature";

	for (let page = 0; page < codeSlots; page++) {
		const start = page * pageSize;
		const digest = new Bun.CryptoHasher(algorithm)
			.update(binary.subarray(start, Math.min(start + pageSize, codeLimit)))
			.digest();
		const stored = binary.subarray(hashesStart + page * hashSize, hashesStart + (page + 1) * hashSize);
		if (!digest.subarray(0, hashSize).equals(stored)) return `page ${page} does not match its hash`;
	}
	return undefined;
}

/** Reports whether the binary is unsigned, or whether its signature covers and matches every code page. */
export function inspectCodeSignature(binary: Uint8Array): SignatureInspection {
	const layout = readLayout(binary);
	const signature = findCodeSignature(layout);
	if (!signature) return { cpu: layout.cpu, status: "unsigned" };
	const problem = findSignatureProblem(binary, signature);
	return problem === undefined
		? { cpu: layout.cpu, status: "valid" }
		: { cpu: layout.cpu, status: "invalid", problem };
}

/**
 * Returns a copy of the binary without its code signature, like
 * `codesign --remove-signature`: drops the LC_CODE_SIGNATURE load command,
 * shortens __LINKEDIT, and cuts the signature data off the end of the file.
 */
export function removeCodeSignature(binary: Uint8Array): Uint8Array {
	const layout = readLayout(binary);
	const signature = findCodeSignature(layout);
	if (!signature) return binary;
	const { command, dataOffset, dataSize } = signature;
	if (dataOffset + dataSize !== binary.byteLength) throw new Error("the code signature is not at the end of the file");
	const linkedit = layout.commands.find(
		candidate => candidate.cmd === LC_SEGMENT_64 && segmentName(layout.view, candidate) === "__LINKEDIT",
	);
	if (!linkedit) throw new Error("no __LINKEDIT segment");
	const linkeditOffset = Number(layout.view.getBigUint64(linkedit.offset + 40, true));
	const linkeditSize = Number(layout.view.getBigUint64(linkedit.offset + 48, true));
	if (linkeditOffset + linkeditSize !== binary.byteLength || dataOffset < linkeditOffset) {
		throw new Error("__LINKEDIT does not end with the code signature");
	}

	const stripped = binary.slice(0, dataOffset);
	const header = new DataView(stripped.buffer);
	// vmsize stays as it is: a segment may map more memory than its file size.
	header.setBigUint64(linkedit.offset + 48, BigInt(dataOffset - linkeditOffset), true);
	stripped.copyWithin(command.offset, command.offset + command.size, layout.commandsEnd);
	stripped.fill(0, layout.commandsEnd - command.size, layout.commandsEnd);
	header.setUint32(16, layout.commands.length - 1, true);
	header.setUint32(20, layout.commandsEnd - MACH_HEADER_64_SIZE - command.size, true);
	return stripped;
}

/** Applies the fork's darwin signature rule (see the file comment). Throws for an arm64 binary without a valid signature. */
export function fixDarwinSignature(binary: Uint8Array): SignatureFix {
	const inspection = inspectCodeSignature(binary);
	const { cpu } = inspection;
	if (inspection.status === "valid") return { action: "kept", cpu, binary };
	if (cpu === "arm64") {
		throw new Error(
			inspection.status === "unsigned"
				? "the arm64 binary has no code signature; macOS does not run it"
				: `the arm64 binary has an invalid code signature (${inspection.problem}); macOS kills it at launch`,
		);
	}
	if (inspection.status === "unsigned") return { action: "unsigned", cpu, binary };
	return { action: "removed", cpu, problem: inspection.problem, binary: removeCodeSignature(binary) };
}

if (import.meta.main) {
	try {
		const { values, positionals } = parseArgs({
			args: process.argv.slice(2),
			allowPositionals: true,
			options: { help: { type: "boolean", short: "h", default: false } },
		});
		if (values.help) {
			console.log(USAGE);
			process.exit(0);
		}
		if (positionals.length !== 1) throw new Error(`expected exactly one <binary> argument\n\n${USAGE}`);
		const binaryPath = path.resolve(positionals[0]);
		const result = fixDarwinSignature(await Bun.file(binaryPath).bytes());
		if (result.action === "removed") {
			await Bun.write(binaryPath, result.binary);
			console.log(`${binaryPath}: removed the invalid ${result.cpu} code signature (${result.problem})`);
		} else if (result.action === "kept") {
			console.log(`${binaryPath}: the ${result.cpu} code signature is valid; kept it`);
		} else {
			console.log(`${binaryPath}: the ${result.cpu} binary is unsigned; nothing to do`);
		}
	} catch (error) {
		console.error(`fix-macho-signature: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}
