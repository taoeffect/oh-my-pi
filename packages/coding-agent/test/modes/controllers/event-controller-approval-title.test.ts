/**
 * Run-status mirror of the wrapper's approval gate
 * (`EventController.#blockingPrompt`).
 *
 * The wrapper blocks on `uiContext.select` after `tool_execution_start`; the
 * controller mirrors that to report the run `blocked` on permission. Session
 * approvals ("… Commands for Session") downgrade `prompt` → allow in the
 * wrapper, so the run must not report `blocked` for them — while the four
 * prompts a session grant may never answer (pending provider safety checks,
 * carried by the computer tool's synthetic event args, a tool-demanded
 * `override`, a `task` call, which no session grant may cover, and an
 * `always-ask-cached` call with targets, which offers folder and file grants
 * instead) still block per call and must keep reporting `blocked`. A call a
 * similar or file grant may answer reports `blocked` only once the wrapper
 * opens the approval menu, since its classifier may run the call with none.
 * A focused subagent's call reads the subagent's own session approvals and is
 * never held that way: only the main session's runner signals the menu.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { getApprovalGrants } from "@oh-my-pi/pi-coding-agent/tools/approval-cache";
import {
	addSimilarApproval,
	approvalIdentity,
	approveToolForSession,
	clearSessionApprovals,
	isToolApprovedForSession,
} from "@oh-my-pi/pi-coding-agent/tools/session-approvals";
import { cfgToolsApprovalMode } from "@oh-my-pi/pi-coding-agent/tools/settings";
import type { RunStatus } from "@oh-my-pi/pi-coding-agent/utils/run-status";
import * as runStatus from "@oh-my-pi/pi-coding-agent/utils/run-status";
import { TempDir } from "@oh-my-pi/pi-utils";

const SESSION_ID = "approval-title-test-session";
const SUBAGENT_SESSION_ID = "approval-title-test-subagent";

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

/** The wrapper calls the controller's approval-preview waiter right before it opens the approval menu. */
let openApprovalMenu: (toolCallId: string) => Promise<void> = async () => {};

/** Session surface the controller reads, with its grants under `sessionId`. */
function viewedSession(tool: AgentTool, sessionId: string) {
	return {
		isAborting: false,
		settings,
		sessionManager: { getSessionId: () => sessionId, getCwd: () => process.cwd() },
		getToolByName: () => tool,
		hasBuiltInTool: () => false,
		isToolApprovedForSession: (toolName: string) => isToolApprovedForSession(sessionId, toolName),
		getApprovalGrants: () => getApprovalGrants(settings.getAgentDir(), sessionId),
	};
}

/** Context that shows the main session, or a focused subagent's session `viewedSessionId`. */
function createFixture(tool: AgentTool = execTool, viewedSessionId = SESSION_ID): InteractiveModeContext {
	const pendingTools = new Map<string, ToolExecutionComponent>();
	const session = {
		...viewedSession(tool, SESSION_ID),
		extensionRunner: {
			setToolApprovalPreviewWaiter(waiter: (toolCallId: string) => Promise<void>) {
				openApprovalMenu = waiter;
				return () => {};
			},
		},
	};
	const ctx = {
		isInitialized: true,
		ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
		statusLine: { invalidate: vi.fn() },
		pendingTools,
		chatContainer: new TranscriptContainer(),
		toolOutputExpanded: false,
		session,
		viewSession: viewedSessionId === SESSION_ID ? session : viewedSession(tool, viewedSessionId),
		sessionManager: session.sessionManager,
	} as unknown as InteractiveModeContext;
	return ctx;
}

function toolStart(toolCallId: string, args: unknown, toolName = "bash") {
	return {
		type: "tool_execution_start",
		toolCallId,
		toolName,
		args,
	} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>;
}

async function startToolCall(ctx: InteractiveModeContext, toolCallId: string, args: unknown, toolName = "bash") {
	await new EventController(ctx).handleEvent(toolStart(toolCallId, args, toolName));
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
		clearSessionApprovals(SUBAGENT_SESSION_ID);
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

	it("stays blocked for an always-ask-cached call with targets despite session approval", async () => {
		// The wrapper shows the grant menu for a call with a target and honors
		// no session approval for it, so a session approval of the tool must not
		// clear the blocked status.
		using agentDir = TempDir.createSync("@pi-approval-title-cached-");
		resetSettingsForTest();
		await Settings.init({ inMemory: true, agentDir: agentDir.path() });
		cfgToolsApprovalMode.override(settings, "always-ask-cached");
		approveToolForSession(SESSION_ID, "write");
		const target = path.join(agentDir.path(), "a.txt");
		const writeTool = { name: "write", approval: { tier: "write" }, approvalCacheTargets: () => [target] };
		ctx = createFixture(writeTool as unknown as AgentTool);
		await startToolCall(ctx, "tc-8", { path: "a.txt" }, "write");
		expect(permissionBlocks(statusSpy)).toBe(1);
	});

	it("reports blocked for a call a similar grant may answer only once the approval menu opens", async () => {
		// The wrapper's classifier may run such a call with no menu; a `blocked`
		// status at start rang tmux bells for commands nobody was asked about.
		addSimilarApproval(SESSION_ID, "bash", "git status", approvalIdentity({ command: "git status" }));
		const controller = new EventController(ctx);
		await controller.handleEvent(toolStart("tc-9", { command: "git diff" }));
		expect(permissionBlocks(statusSpy)).toBe(0);
		const menu = openApprovalMenu("tc-9");
		expect(permissionBlocks(statusSpy)).toBe(1);
		await menu;
	});

	it("reports blocked at start when the approval menu opened before the controller saw the call", async () => {
		addSimilarApproval(SESSION_ID, "bash", "git status", approvalIdentity({ command: "git status" }));
		const controller = new EventController(ctx);
		const menu = openApprovalMenu("tc-10");
		await controller.handleEvent(toolStart("tc-10", { command: "git diff" }));
		expect(permissionBlocks(statusSpy)).toBe(1);
		await menu;
	});

	it("judges a focused subagent's call by the subagent's session approvals, not the main session's", async () => {
		approveToolForSession(SESSION_ID, "bash");
		ctx = createFixture(execTool, SUBAGENT_SESSION_ID);
		await startToolCall(ctx, "tc-11", { command: "ls" });
		expect(permissionBlocks(statusSpy)).toBe(1);
		approveToolForSession(SUBAGENT_SESSION_ID, "bash");
		await startToolCall(ctx, "tc-12", { command: "ls" });
		expect(permissionBlocks(statusSpy)).toBe(1);
	});

	it("reports blocked at start for a focused subagent's call a similar grant may answer", async () => {
		// Only the main session's runner calls the approval preview waiter, so a
		// held status for a subagent's call would never be reported.
		addSimilarApproval(SUBAGENT_SESSION_ID, "bash", "git status", approvalIdentity({ command: "git status" }));
		ctx = createFixture(execTool, SUBAGENT_SESSION_ID);
		await startToolCall(ctx, "tc-13", { command: "git diff" });
		expect(permissionBlocks(statusSpy)).toBe(1);
	});
});
