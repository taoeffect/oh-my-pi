/**
 * Idle recap in a real `InteractiveMode`: a real session runs real turns against scripted providers, and the recap is
 * judged by the provider requests it made, the journal it wrote and the transcript the user reads.
 *
 * Fake timers freeze the clock; real async work (promises, files, `setImmediate`) keeps running under them, so the
 * shared `helpers/fake-clock` waits yield the event loop instead of guessing durations.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { submitInteractiveInput } from "@oh-my-pi/pi-coding-agent/main";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import * as loopCondition from "@oh-my-pi/pi-coding-agent/modes/loop-condition";
import { cfgCompletionNotify, cfgStartupQuiet } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { closeSessionIndex, listSessionRecaps } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { driveTurn, elapse, flush, until, wait } from "../helpers/fake-clock";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

const RECAP = "Reworked the login flow; next: wire the focused token-refresh test.";
const WORKER_RECAP = "The worker is mid-way through the migration; next: run the backfill.";
/** `recap.idleSeconds` is set explicitly, to the smallest delay the scheduler allows, never inherited from a default. */
const RECAP_DELAY_MS = 1_000;
const RECAP_SETTINGS = { "compaction.enabled": false, "todo.reminders": false, "recap.idleSeconds": 1 };

/** The providers of one session: `main` answers its turns, `side` its idle recaps. Both record every request. */
interface Models {
	main: MockModel;
	side: MockModel;
}

function scriptedModels(recap: string): Models {
	return {
		main: createMockModel({ handler: { content: ["Work finished."] } }),
		side: createMockModel({ handler: { content: [recap] } }),
	};
}

/** Park the next request `model` gets until `release`; `started` settles once the provider has been asked. */
function holdNext(model: MockModel): { started: Promise<void>; release(response: MockResponse): void } {
	const started = Promise.withResolvers<void>();
	const reply = Promise.withResolvers<MockResponse>();
	model.push(() => {
		started.resolve();
		return reply.promise;
	});
	return { started: started.promise, release: response => reply.resolve(response) };
}

/** One real turn of `session`. The clock stands still once the terminal `agent_end` is out, so the idle stretch starts there. */
async function runTurn(session: AgentSession, text = "please work"): Promise<void> {
	await driveTurn(session, session.prompt(text));
	await wait(session.waitForIdle());
	await flush();
}

describe("InteractiveMode idle recap", () => {
	let settingsState: SettingsTestState;
	let dir: TempDir;
	const cleanups: (() => Promise<void> | void)[] = [];

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		settingsState = beginSettingsTest();
		dir = TempDir.createSync("@pi-idle-mode-");
		// Recaps are journaled in the process-wide history.db under the agent dir.
		setAgentDir(path.join(dir.path(), "agent"));
		closeSessionIndex();
		await Settings.init({ inMemory: true });
	});

	afterEach(async () => {
		vi.useRealTimers();
		// Last opened, first closed.
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		closeSessionIndex();
		restoreSettingsTestState(settingsState);
		dir.removeSync();
	});

	/**
	 * A TUI over a session whose turns and recaps come from scripted providers. Its startup is done on return, unless
	 * `holdStartup` keeps `init()` parked at the draft restore; `startup` then finishes once `releaseStartup()` is called.
	 */
	async function openMode(options: { holdStartup?: boolean } = {}) {
		cfgStartupQuiet.set(Settings.instance, true);
		cfgCompletionNotify.set(Settings.instance, "off");
		const models = scriptedModels(RECAP);
		const authStorage = await AuthStorage.create(path.join(dir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		const registry = new ModelRegistry(authStorage, path.join(dir.path(), "models.yml"));
		const model = registry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist");
		const newSession = (sessionModels: Models): AgentSession =>
			new AgentSession({
				agent: new Agent({
					getApiKey: () => "test-key",
					initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
					streamFn: sessionModels.main.stream,
				}),
				sessionManager: SessionManager.create(dir.path(), dir.path()),
				settings: Settings.isolated(RECAP_SETTINGS),
				modelRegistry: registry,
				sideStreamFn: sessionModels.side.stream,
			});
		const session = newSession(models);
		const mode = new InteractiveMode(session, "test");
		cleanups.push(async () => {
			mode.stop();
			await session.dispose();
			authStorage.close();
		});
		// With `holdStartup`, startup parks at the draft restore until `releaseStartup()` answers there is no saved draft.
		const draftRestore = Promise.withResolvers<string | null>();
		const draftRestoreEntered = Promise.withResolvers<void>();
		if (options.holdStartup) {
			vi.spyOn(session.sessionManager, "consumeDraft").mockImplementation(() => {
				draftRestoreEntered.resolve();
				return draftRestore.promise;
			});
		}
		const startup = mode.init({ suppressWelcomeIntro: true });
		if (options.holdStartup) await draftRestoreEntered.promise;
		else await startup;

		/** A second real agent, registered like a task subagent and with a recap text of its own. */
		const spawnAgent = (id: string) => {
			const workerModels = scriptedModels(WORKER_RECAP);
			const worker = newSession(workerModels);
			cleanups.push(() => worker.dispose());
			const agents = AgentRegistry.global();
			const ref = agents.register({
				id,
				displayName: id,
				kind: "sub",
				parentId: MAIN_AGENT_ID,
				session: worker,
				status: "running",
			});
			cleanups.push(async () => {
				if (mode.focusedAgentId) await mode.unfocusSession();
				agents.unregister(id, ref);
			});
			return { id, session: worker, models: workerModels };
		};
		return { mode, session, models, spawnAgent, startup, releaseStartup: () => draftRestore.resolve(null) };
	}

	const screen = (mode: InteractiveMode): string => Bun.stripANSI(mode.chatContainer.render(120).join("\n"));
	const shown = (mode: InteractiveMode, text: string): number => screen(mode).split(text).length - 1;
	const journal = (session: AgentSession): string[] =>
		listSessionRecaps({ sessionIds: [session.sessionManager.getSessionId()] }).map(row => row.recap);

	it("recaps an idle session once, on screen and in the journal", async () => {
		const { mode, session, models } = await openMode();
		vi.useFakeTimers();
		await runTurn(session);
		await elapse(RECAP_DELAY_MS);
		await until(() => shown(mode, RECAP) > 0, "the recap on screen");
		await elapse(3 * RECAP_DELAY_MS);

		expect(models.side.calls).toHaveLength(1);
		expect(journal(session)).toEqual([RECAP]);
		expect(shown(mode, RECAP)).toBe(1);
	}, 30_000);

	it("holds the recap back while a draft is being composed and delivers it once the draft is gone", async () => {
		const { mode, session, models } = await openMode();
		vi.useFakeTimers();
		await runTurn(session);

		// The recap is due in a second; the draft arrives before that.
		mode.editor.setText("half-written draft");
		await flush();
		await elapse(3 * RECAP_DELAY_MS);
		expect(models.side.calls).toHaveLength(0);
		expect(journal(session)).toEqual([]);

		// Whitespace is not a draft.
		mode.editor.setText("  ");
		await flush();
		await elapse(RECAP_DELAY_MS);
		await until(() => shown(mode, RECAP) > 0, "the recap on screen");
		await elapse(3 * RECAP_DELAY_MS);

		expect(models.side.calls).toHaveLength(1);
		expect(journal(session)).toEqual([RECAP]);
		expect(shown(mode, RECAP)).toBe(1);
	}, 30_000);

	it("does idle work only for the agent on screen: a viewed subagent recaps, the root waits until it is back", async () => {
		const { mode, session: root, models: rootModels, spawnAgent } = await openMode();
		const worker = spawnAgent("RecapWorker");
		vi.useFakeTimers();

		// Nobody has opened the worker: its turn ends unattended and nothing is started on its behalf.
		await runTurn(worker.session);
		await elapse(3 * RECAP_DELAY_MS);
		expect(worker.models.side.calls).toHaveLength(0);

		// The root owes a recap, but the view moves to the worker before it is due.
		await runTurn(root);
		await wait(mode.focusAgentSession(worker.id));
		await elapse(3 * RECAP_DELAY_MS);
		expect(rootModels.side.calls).toHaveLength(0);
		expect(worker.models.side.calls).toHaveLength(0);

		// Viewed now, the worker's own turn is the one that gets recapped.
		await runTurn(worker.session);
		await elapse(RECAP_DELAY_MS);
		await until(() => shown(mode, WORKER_RECAP) > 0, "the worker's recap on screen");
		await elapse(3 * RECAP_DELAY_MS);
		expect(worker.models.side.calls).toHaveLength(1);
		expect(journal(worker.session)).toEqual([WORKER_RECAP]);
		expect(shown(mode, WORKER_RECAP)).toBe(1);
		expect(rootModels.side.calls).toHaveLength(0);
		expect(journal(root)).toEqual([]);

		// Back on main, the recap it still owes arrives, once.
		await wait(mode.unfocusSession());
		await flush();
		await elapse(RECAP_DELAY_MS);
		await until(() => shown(mode, RECAP) > 0, "the root's recap on screen");
		await elapse(3 * RECAP_DELAY_MS);
		expect(rootModels.side.calls).toHaveLength(1);
		expect(journal(root)).toEqual([RECAP]);
		expect(shown(mode, RECAP)).toBe(1);
		expect(worker.models.side.calls).toHaveLength(1);
	}, 30_000);

	it("abandons a recap being written when the view leaves its agent, and recaps the stretch that ended while away once it is viewed again", async () => {
		const { mode, spawnAgent } = await openMode();
		const worker = spawnAgent("LeavingWorker");
		const lateReply = "Late reply from a view that is gone.";
		vi.useFakeTimers();
		await wait(mode.focusAgentSession(worker.id));
		await runTurn(worker.session);
		const held = holdNext(worker.models.side);
		await elapse(RECAP_DELAY_MS);
		await wait(held.started);
		const signal = worker.models.side.calls[0]?.options?.signal;
		expect(signal?.aborted).toBe(false);

		await wait(mode.unfocusSession());
		expect(signal?.aborted).toBe(true);
		held.release({ content: [lateReply] });
		await flush();
		expect(shown(mode, lateReply)).toBe(0);
		expect(journal(worker.session)).toEqual([]);

		// The worker works on while nobody looks: that stretch is owed, not started.
		await runTurn(worker.session);
		await elapse(3 * RECAP_DELAY_MS);
		expect(worker.models.side.calls).toHaveLength(1);

		await wait(mode.focusAgentSession(worker.id));
		await elapse(RECAP_DELAY_MS);
		await until(() => shown(mode, WORKER_RECAP) > 0, "the owed recap on screen");
		await elapse(3 * RECAP_DELAY_MS);
		expect(worker.models.side.calls).toHaveLength(2);
		expect(shown(mode, lateReply)).toBe(0);
		expect(journal(worker.session)).toEqual([WORKER_RECAP]);
		expect(shown(mode, WORKER_RECAP)).toBe(1);
	}, 30_000);

	it("recaps the stretch once a goal continuation is cancelled before it starts, with no other turn to restart the clock", async () => {
		const { mode, session, models } = await openMode();
		await session.goalRuntime.createGoal({ objective: "Ship the login flow" });
		vi.useFakeTimers();
		// The main loop waits for input, so the end of the turn schedules the goal's next continuation.
		const input = mode.getUserInput();
		await runTurn(session);
		expect(models.main.calls).toHaveLength(1);

		// The continuation is submitted 800 ms after the turn ended; until its turn starts it holds the recap back.
		await elapse(800);
		expect((await wait(input)).customType).toBe("goal-continuation");
		await elapse(3 * RECAP_DELAY_MS);
		expect(models.side.calls).toHaveLength(0);

		// Esc before the turn begins: no `agent_end` will ever follow to end this stretch.
		expect(mode.cancelPendingSubmission()).toBe(true);
		await flush();
		await elapse(RECAP_DELAY_MS);
		await until(() => shown(mode, RECAP) > 0, "the recap on screen");
		await elapse(3 * RECAP_DELAY_MS);
		expect(models.main.calls).toHaveLength(1);
		expect(models.side.calls).toHaveLength(1);
		expect(journal(session)).toEqual([RECAP]);
		expect(shown(mode, RECAP)).toBe(1);
	}, 30_000);

	const refusals: Array<[outcome: string, dispatch: () => Promise<boolean>]> = [
		["rejects", () => Promise.reject(new Error("No API key found for anthropic."))],
		["drops", () => Promise.resolve(false)],
	];
	for (const [outcome, dispatch] of refusals) {
		it(`recaps the stretch once the session ${outcome} a goal continuation, with no other turn to restart the clock`, async () => {
			const { mode, session, models } = await openMode();
			await session.goalRuntime.createGoal({ objective: "Ship the login flow" });
			vi.useFakeTimers();
			const input = mode.getUserInput();
			await runTurn(session);
			await elapse(800);
			const continuation = await wait(input);
			expect(continuation.customType).toBe("goal-continuation");

			// The main loop submits it and the session refuses it before any turn starts: no `agent_end` follows.
			vi.spyOn(session, "promptCustomMessage").mockImplementationOnce(dispatch);
			await wait(submitInteractiveInput(mode, session, continuation));
			await flush();
			await elapse(RECAP_DELAY_MS);
			await until(() => shown(mode, RECAP) > 0, "the recap on screen");
			await elapse(3 * RECAP_DELAY_MS);
			expect(models.main.calls).toHaveLength(1);
			expect(models.side.calls).toHaveLength(1);
			expect(journal(session)).toEqual([RECAP]);
		}, 30_000);
	}

	it("holds the recap while a goal continuation the session took still owes its turn, and recaps once that turn ends", async () => {
		const { mode, session, models } = await openMode();
		await session.goalRuntime.createGoal({ objective: "Ship the login flow" });
		vi.useFakeTimers();
		const input = mode.getUserInput();
		await runTurn(session);
		await elapse(800);
		const continuation = await wait(input);
		expect(continuation.customType).toBe("goal-continuation");

		// The session takes it, queued into a turn that has not ended yet: its `agent_end` is still to come.
		vi.spyOn(session, "promptCustomMessage").mockImplementationOnce(() => Promise.resolve(true));
		await wait(submitInteractiveInput(mode, session, continuation));
		await flush();
		await elapse(3 * RECAP_DELAY_MS);
		expect(models.side.calls).toHaveLength(0);

		// That turn ends, and the stretch it closes is recapped.
		await runTurn(session);
		await elapse(RECAP_DELAY_MS);
		await until(() => shown(mode, RECAP) > 0, "the recap on screen");
		await elapse(3 * RECAP_DELAY_MS);
		expect(models.main.calls).toHaveLength(2);
		expect(models.side.calls).toHaveLength(1);
		expect(journal(session)).toEqual([RECAP]);
	}, 30_000);

	it("starts no idle work before the TUI has finished starting up, and recaps the stretch once it has", async () => {
		const { mode, session, models, startup, releaseStartup } = await openMode({ holdStartup: true });
		vi.useFakeTimers();
		// A turn ends while startup is still restoring the draft (an initial CLI message can do this).
		await runTurn(session);
		await elapse(3 * RECAP_DELAY_MS);
		expect(models.side.calls).toHaveLength(0);
		expect(journal(session)).toEqual([]);

		releaseStartup();
		await wait(startup);
		await elapse(RECAP_DELAY_MS);
		await until(() => shown(mode, RECAP) > 0, "the recap on screen");
		await elapse(3 * RECAP_DELAY_MS);
		expect(models.side.calls).toHaveLength(1);
		expect(journal(session)).toEqual([RECAP]);
		expect(shown(mode, RECAP)).toBe(1);
	}, 30_000);

	it("holds the recap while a loop iteration decides whether to resubmit, and recaps once the loop stops", async () => {
		const { mode, session, models } = await openMode();
		const verdict = Promise.withResolvers<loopCondition.LoopConditionVerdict>();
		vi.spyOn(loopCondition, "evaluateLoopCondition").mockImplementation(() => verdict.promise);
		mode.loopModeEnabled = true;
		mode.loopPrompt = "please work";
		mode.loopCondition = { command: "test -f DONE", until: true };
		vi.useFakeTimers();
		await runTurn(session);
		// The main loop waits for input again, so the loop schedules its next iteration 800 ms on.
		void mode.getUserInput();
		await elapse(800);
		expect(loopCondition.evaluateLoopCondition).toHaveBeenCalledTimes(1);

		// The condition command is still running long after the recap would have been due.
		await elapse(3 * RECAP_DELAY_MS);
		expect(models.side.calls).toHaveLength(0);

		// It says stop: no turn follows, and the stretch is recapped.
		verdict.resolve({ kind: "halt", message: "Loop condition met. Loop mode disabled." });
		await flush();
		expect(mode.loopModeEnabled).toBe(false);
		await elapse(RECAP_DELAY_MS);
		await until(() => shown(mode, RECAP) > 0, "the recap on screen");
		await elapse(3 * RECAP_DELAY_MS);
		expect(models.main.calls).toHaveLength(1);
		expect(models.side.calls).toHaveLength(1);
		expect(journal(session)).toEqual([RECAP]);
	}, 30_000);
});
