/**
 * Run-status mirror of the wrapper's approval gate
 * (`EventController.#blockingPrompt`).
 *
 * The wrapper blocks on `uiContext.select` after `tool_execution_start`; the
 * controller mirrors that to report the run `blocked` on permission. Session
 * approvals ("… Commands for Session") downgrade `prompt` → allow in the
 * wrapper, so the run must not report `blocked` for them — while the three
 * prompts a session grant may never answer (pending provider safety checks,
 * carried by the computer tool's synthetic event args, a tool-demanded
 * `override`, and a `task` call, which no session grant may cover) still block
 * per call and must keep reporting `blocked`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { approveToolForSession, clearSessionApprovals } from "@oh-my-pi/pi-coding-agent/tools/session-approvals";
import { cfgToolsApprovalMode } from "@oh-my-pi/pi-coding-agent/tools/settings";
import type { RunStatus } from "@oh-my-pi/pi-coding-agent/utils/run-status";
import * as runStatus from "@oh-my-pi/pi-coding-agent/utils/run-status";

const SESSION_ID = "approval-title-test-session";

/** Exec-tier tool: resolves `prompt` under `always-ask` without user policies. */
const execTool = { name: "bash", approval: { tier: "exec" } } as unknown as AgentTool;

/**
 * Tool-demanded prompt, as `bash` returns for critical patterns: the wrapper
 * refuses to let a session grant answer it, so the run must stay `blocked`.
 */
const overrideTool = {
	name: "bash",
	approval: { tier: "exec", override: true, reason: "Critical pattern detected" },
} as unknown as AgentTool;

/** `task` is excluded from every session grant, so its prompt always blocks. */
const taskTool = { name: "task", approval: { tier: "exec" } } as unknown as AgentTool;

function createFixture(tool: AgentTool = execTool): InteractiveModeContext {
	const pendingTools = new Map<string, ToolExecutionComponent>();
	const ctx = {
		isInitialized: true,
		ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
		statusLine: { invalidate: vi.fn() },
		pendingTools,
		chatContainer: new TranscriptContainer(),
		toolOutputExpanded: false,
		session: { isAborting: false },
		viewSession: { getToolByName: () => tool, hasBuiltInTool: () => false },
		sessionManager: { getSessionId: () => SESSION_ID, getCwd: () => process.cwd() },
	} as unknown as InteractiveModeContext;
	return ctx;
}

async function startToolCall(ctx: InteractiveModeContext, toolCallId: string, args: unknown, toolName = "bash") {
	await new EventController(ctx).handleEvent({
		type: "tool_execution_start",
		toolCallId,
		toolName,
		args,
	} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
}

type RunStatusSpy = Mock<(status: RunStatus) => void>;

function permissionBlocks(spy: RunStatusSpy): number {
	return spy.mock.calls.filter(([status]) => status.state === "blocked" && status.kind === "permission").length;
}

describe("EventController approval run-status mirror", () => {
	let statusSpy: RunStatusSpy;
	let ctx: InteractiveModeContext;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		statusSpy = vi.spyOn(runStatus, "setRunStatus").mockImplementation(() => {});
		cfgToolsApprovalMode.override(settings, "always-ask");
		ctx = createFixture();
	});

	afterEach(() => {
		for (const component of ctx.pendingTools.values()) component.seal();
		clearSessionApprovals(SESSION_ID);
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("reports blocked on permission for a prompt-policy tool call", async () => {
		await startToolCall(ctx, "tc-1", { command: "ls" });
		expect(permissionBlocks(statusSpy)).toBe(1);
	});

	it("does not report blocked once the tool is approved for the session", async () => {
		approveToolForSession(SESSION_ID, "bash");
		await startToolCall(ctx, "tc-2", { command: "ls" });
		expect(permissionBlocks(statusSpy)).toBe(0);
	});

	it("reports blocked again after session approvals are cleared", async () => {
		approveToolForSession(SESSION_ID, "bash");
		await startToolCall(ctx, "tc-3", { command: "ls" });
		clearSessionApprovals(SESSION_ID);
		await startToolCall(ctx, "tc-4", { command: "ls" });
		expect(permissionBlocks(statusSpy)).toBe(1);
	});

	it("stays blocked for pending provider safety checks despite session approval", async () => {
		approveToolForSession(SESSION_ID, "bash");
		await startToolCall(ctx, "tc-5", {
			actions: [{ type: "key", key: "Return" }],
			pendingSafetyChecks: [{ checkId: "c1", prompt: "Confirm" }],
		});
		expect(permissionBlocks(statusSpy)).toBe(1);
	});

	it("stays blocked for a tool-demanded override despite session approval", async () => {
		approveToolForSession(SESSION_ID, "bash");
		ctx = createFixture(overrideTool);
		await startToolCall(ctx, "tc-6", { command: "rm -rf /" });
		expect(permissionBlocks(statusSpy)).toBe(1);
	});

	it("stays blocked for a task call, which no session grant may cover", async () => {
		// The wrapper offers `task` no session option and honors none, so a grant
		// recorded for the tool cannot clear the blocked status either.
		approveToolForSession(SESSION_ID, "task");
		ctx = createFixture(taskTool);
		await startToolCall(ctx, "tc-7", { prompt: "explore the repo" }, "task");
		expect(permissionBlocks(statusSpy)).toBe(1);
	});
});
