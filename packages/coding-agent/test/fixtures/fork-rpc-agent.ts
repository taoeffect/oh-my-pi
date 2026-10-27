import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

// Real RPC dispatch over a session persisted under the test's temp root; only model replies are scripted.
// The root arrives as argv so storage can never land in an inherited cwd such as the repo checkout.
const root = process.argv[2];
if (!root || root.startsWith("-")) throw new Error("fork-rpc-agent: expected the temp root as the first argument");
process.chdir(root);
const cwd = process.cwd();
const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
authStorage.keys.setRuntime("anthropic", "test-key");
const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
const askQuestions = [{ id: "target", question: "Where?", options: [{ label: "staging" }, { label: "prod" }] }];
const mock = createMockModel({
	// A prompt mentioning "slow" stays in flight long enough for the test to act mid-stream.
	// "seed-ask" calls `ask` (not registered here, so it records an error result) with questions
	// a picker could reopen; "seed-bad-ask" calls it with arguments no picker could use.
	handler: context => {
		const last = JSON.stringify(context.messages.at(-1)?.content);
		if (last.includes("seed-ask") || last.includes("seed-bad-ask")) {
			const args = last.includes("seed-ask") ? { questions: askQuestions } : {};
			return { content: [{ type: "toolCall", id: "ask-1", name: "ask", arguments: args }] };
		}
		return { content: ["Done"], delayMs: last.includes("slow") ? 1500 : 0 };
	},
});
// The first goal continuation waits here until a branch summary starts, so it is decided but not yet started.
const summaryStarted = Promise.withResolvers<void>();
// Branch summaries: one whose instructions say "hang-summary" announces itself with a notice and runs
// until aborted; "slow-summary" announces itself and answers after 1.5 s; any other releases the held
// continuation and answers shortly after.
const side = createMockModel({
	handler: context => {
		summaryStarted.resolve();
		const prompt = JSON.stringify(context.messages);
		if (prompt.includes("hang-summary") || prompt.includes("slow-summary")) {
			session.emitNotice("info", "summary started", "fork-rpc-agent");
		}
		if (prompt.includes("hang-summary")) return { content: ["unreachable"], delayMs: 600_000 };
		return { content: ["Branch summary"], delayMs: prompt.includes("slow-summary") ? 1500 : 200 };
	},
});
const agent = new Agent({
	getApiKey: () => "test-key",
	initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
	streamFn: mock.stream,
});
const session = new AgentSession({
	agent,
	sessionManager: SessionManager.create(cwd, path.join(cwd, "sessions")),
	settings: Settings.isolated({ "compaction.enabled": false, "goal.continuationModes": ["rpc"] }),
	modelRegistry,
	sideStreamFn: side.stream,
});
const waitForIdle = session.waitForIdle.bind(session);
let heldGoalIdle = false;
session.waitForIdle = async () => {
	await waitForIdle();
	if (heldGoalIdle || !session.getGoalModeState()?.enabled) return;
	heldGoalIdle = true;
	await summaryStarted.promise;
};
await runRpcMode(session);
