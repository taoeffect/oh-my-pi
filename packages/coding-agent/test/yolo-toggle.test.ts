import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { createAgentSession, discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { holdYoloApprovalMode } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { cfgToolsApprovalMode } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("/yolo runtime toggle", () => {
	let tempDir: string;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = path.join(os.tmpdir(), `pi-yolo-toggle-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelRegistry = new ModelRegistry(await discoverAuthStorage(tempDir));
		modelRegistry.authStorage.keys.setRuntime("openai", "test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		vi.restoreAllMocks();
	});

	afterAll(() => {
		modelRegistry.authStorage.close();
		removeSyncWithRetries(tempDir);
	});

	async function createSession(settings: Settings, autoApprove: boolean): Promise<AgentSession> {
		const created = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			autoApprove,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			rules: [],
			workspaceTree: { rootPath: tempDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		});
		session = created.session;
		return created.session;
	}

	/** Runs `/yolo` through the TUI dispatcher and returns the status it showed. */
	async function runYolo(target: AgentSession): Promise<string> {
		const showStatus = vi.fn();
		const ctx = {
			session: target,
			sessionManager: target.sessionManager,
			settings: target.settings,
			collabGuest: false,
			showStatus,
			editor: { setText: vi.fn() },
		} as unknown as InteractiveModeContext;
		expect(await executeBuiltinSlashCommand("/yolo", { ctx })).toBe(true);
		return String(showStatus.mock.calls.at(-1)?.[0]);
	}

	/** Has the model call `bash` once and returns that call's result. */
	async function promptBash(target: AgentSession, id: string): Promise<ToolResultMessage | undefined> {
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id, name: "bash", arguments: { command: "printf yolo-ran" } }] },
				{ content: [{ type: "text", text: "done" }] },
			],
		});
		vi.spyOn(target.agent, "streamFn").mockImplementation(mock.stream);
		await target.prompt(`run ${id}`);
		return target.messages.find(
			(message): message is ToolResultMessage => message.role === "toolResult" && message.toolCallId === id,
		);
	}

	it("turns off auto-approval from --yolo for the run and turns it back on", async () => {
		const settings = Settings.isolated({ "tools.approvalMode": "always-ask" });
		// What `omp --yolo` does at startup.
		holdYoloApprovalMode(settings);
		const s = await createSession(settings, true);

		const startup = await promptBash(s, "startup");
		expect(startup?.isError).toBe(false);
		expect(JSON.stringify(startup?.content)).toContain("yolo-ran");

		expect(await runYolo(s)).toContain("approvals follow tools.approvalMode (always-ask)");
		expect(cfgToolsApprovalMode.get(settings)).toBe("always-ask");
		const off = await promptBash(s, "off");
		expect(off?.isError).toBe(true);
		expect(JSON.stringify(off?.content)).toContain("requires approval");

		expect(await runYolo(s)).toContain("Yolo mode on");
		const on = await promptBash(s, "on");
		expect(on?.isError).toBe(false);
		expect(JSON.stringify(on?.content)).toContain("yolo-ran");
	});

	it("restores an --approval-mode override when yolo turns off", async () => {
		const settings = Settings.isolated({ "tools.approvalMode": "always-ask" });
		// What `omp --approval-mode write` does at startup.
		cfgToolsApprovalMode.override(settings, "write");
		const s = await createSession(settings, false);

		await runYolo(s);
		expect(cfgToolsApprovalMode.get(settings)).toBe("yolo");
		expect(await runYolo(s)).toContain("approvals follow tools.approvalMode (write)");
		expect(cfgToolsApprovalMode.provenance(settings)).toBe("runtime");
	});
});
