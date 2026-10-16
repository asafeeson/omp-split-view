/**
 * Model tests for `subagents-panel.ts`. They exercise the panel model directly
 * (no TUI, no host registries, no child session IO): run identity, the bounded
 * per-run window, agent/action status independence, provisional adoption,
 * pause/live viewport behaviour, snapshot persistence shape, whole-session
 * restore and damaged-record handling.
 */
import { expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import { SUBAGENT_SNAPSHOT_TYPE, SubagentsPanel } from "./subagents-panel.ts";

/** Identity theme: assertions read plain text, no escapes. */
const THEME = { fg: (_color: string, text: string) => text } as unknown as Theme;

interface Snapshot {
	sessionId: string;
	data: Record<string, unknown>;
}

interface Harness {
	panel: SubagentsPanel;
	snapshots: Snapshot[];
	ctx: ExtensionContext;
	touches: () => number;
}

function makeHarness(entries: readonly unknown[] = [], sessionId = "s1"): Harness {
	const snapshots: Snapshot[] = [];
	let touches = 0;
	const panel = new SubagentsPanel(
		(parentSessionId, data) => {
			snapshots.push({ sessionId: parentSessionId, data: data as Record<string, unknown> });
			return true;
		},
		() => {
			touches++;
		},
		(args) => JSON.stringify(args ?? {}),
	);
	const ctx = {
		sessionManager: {
			getSessionId: () => sessionId,
			getEntries: () => entries,
			getSessionFile: () => undefined,
			getArtifactsDir: () => null,
		},
	} as unknown as ExtensionContext;
	return { panel, snapshots, ctx, touches: () => touches };
}

/** Body rows of a framed render (header, body…, help, bottom). */
const bodyOf = (lines: readonly string[]): string[] => lines.slice(1, -2);
const lineWith = (lines: readonly string[], needle: string): string =>
	lines.find((line) => line.includes(needle)) ?? "";
const start = (id: string, n: number): { id: string; event: Record<string, unknown> } => ({
	id,
	event: { type: "tool_execution_start", toolCallId: `t${n}`, toolName: `tool${n}`, args: { i: `purpose ${n}` } },
});
const end = (
	id: string,
	n: number,
	isError?: boolean,
): { id: string; event: Record<string, unknown> } => ({
	id,
	event: {
		type: "tool_execution_end",
		toolCallId: `t${n}`,
		toolName: `tool${n}`,
		result: {},
		...(isError === undefined ? {} : { isError }),
	},
});

test("a run keeps its last seven calls in start order and forgets evicted ones", async () => {
	const harness = makeHarness();
	await harness.panel.activate(harness.ctx);
	harness.panel.onLifecycle({ id: "agent-a", agent: "scout", index: 0, status: "started", parentToolCallId: "call-1" });
	for (let n = 1; n <= 9; n++) harness.panel.onEvent(start("agent-a", n));

	let lines = harness.panel.render(THEME, 100, 12);
	expect(lines.join("\n")).toContain("#1");
	expect(lineWith(lines, "#1")).toContain("scout");
	expect(lineWith(lines, "#1")).toContain("running");
	for (const n of [3, 4, 5, 6, 7, 8, 9]) expect(lines.join("\n")).toContain(`tool${n}`);
	for (const n of [1, 2]) expect(lines.join("\n")).not.toContain(`tool${n}`);
	expect(lineWith(lines, "tool3")).toContain("purpose 3");

	// A late end/update for an evicted call returns nothing, and an update for a
	// known call adds no row.
	const before = lines.join("\n");
	harness.panel.onEvent(end("agent-a", 1, false));
	harness.panel.onEvent({ id: "agent-a", event: {
		type: "tool_execution_update", toolCallId: "t9", toolName: "tool9", partialResult: { content: [] },
	} });
	lines = harness.panel.render(THEME, 100, 12);
	expect(lines.join("\n")).toBe(before);

	// A real boolean decides the action status; an absent flag stays unknown.
	harness.panel.onEvent(end("agent-a", 7, true));
	harness.panel.onEvent(end("agent-a", 8));
	lines = harness.panel.render(THEME, 100, 12);
	expect(lineWith(lines, "tool7")).toContain("error");
	expect(lineWith(lines, "tool8")).toContain("unknown");
	expect(lineWith(lines, "tool9")).toContain("running");
	expect(harness.touches()).toBeGreaterThan(0);
});

test("agent status and action status stay independent, and a new start opens a new run", async () => {
	const harness = makeHarness();
	await harness.panel.activate(harness.ctx);
	harness.panel.onLifecycle({ id: "agent-a", agent: "scout", index: 0, status: "started", parentToolCallId: "call-1" });
	harness.panel.onEvent(start("agent-a", 1));
	harness.panel.onEvent(end("agent-a", 1, true));
	// The agent fails while its tool call keeps its own error state.
	harness.panel.onLifecycle({ id: "agent-a", agent: "scout", index: 0, status: "failed", parentToolCallId: "call-1" });

	let lines = harness.panel.render(THEME, 100, 12);
	expect(lineWith(lines, "#1")).toContain("failed");
	expect(lineWith(lines, "tool1")).toContain("error");

	// A follow-up turn reuses the native id: a second run appears, the first stays.
	harness.panel.onLifecycle({ id: "agent-a", agent: "scout", index: 0, status: "started", parentToolCallId: "call-2" });
	harness.panel.onEvent(start("agent-a", 2));
	harness.panel.onEvent(end("agent-a", 2, false));
	lines = harness.panel.render(THEME, 100, 12);
	expect(lines.join("\n")).toContain("#2");
	expect(lineWith(lines, "#1")).toContain("failed");
	expect(lineWith(lines, "tool1")).toContain("error");
	expect(lineWith(lines, "#2")).toContain("running");
	expect(lineWith(lines, "tool2")).not.toContain("error");
});

test("a raw frame before its lifecycle is adopted, never duplicated", async () => {
	const harness = makeHarness();
	await harness.panel.activate(harness.ctx);
	harness.panel.onEvent(start("agent-b", 1));
	let lines = harness.panel.render(THEME, 100, 12);
	expect(lines.join("\n")).toContain("#1");
	expect(lineWith(lines, "#1")).toContain("unknown agent");

	harness.panel.onLifecycle({ id: "agent-b", agent: "scout", index: 1, status: "started" });
	harness.panel.onEvent(start("agent-b", 2));
	lines = harness.panel.render(THEME, 100, 12);
	expect(lines.join("\n")).not.toContain("#2");
	expect(lineWith(lines, "#1")).toContain("scout");
	expect(lines.join("\n")).toContain("tool1");
	expect(lines.join("\n")).toContain("tool2");
});

test("paused viewport holds its anchored row while live follows the newest activity", async () => {
	const harness = makeHarness();
	await harness.panel.activate(harness.ctx);
	for (let n = 1; n <= 8; n++) {
		harness.panel.onLifecycle({ id: `agent-${n}`, agent: `scout${n}`, index: n - 1, status: "started" });
		harness.panel.onEvent(start(`agent-${n}`, n));
	}
	let lines = harness.panel.render(THEME, 100, 8);
	expect(lineWith(lines, "Subagents")).toContain("Live");
	expect(bodyOf(lines)[0]).toContain("tool6");

	harness.panel.navigate("up");
	lines = harness.panel.render(THEME, 100, 8);
	expect(lineWith(lines, "Subagents")).toContain("Paused");
	expect(bodyOf(lines)[0]).toContain("tool4");

	// New activity in an older group must not move the paused viewport.
	harness.panel.onEvent({
		id: "agent-1",
		event: { type: "tool_execution_start", toolCallId: "t1b", toolName: "tool1b", args: { i: "later" } },
	});
	const paused = harness.panel.render(THEME, 100, 8);
	expect(bodyOf(paused)[0]).toContain("tool4");
	expect(paused.join("\n")).not.toContain("tool1b");

	// Live returns to the newest activity, including an older group's.
	harness.panel.navigate("live");
	const live = harness.panel.render(THEME, 100, 8);
	expect(lineWith(live, "Subagents")).toContain("Live");
	expect(live.join("\n")).toContain("tool1b");
});

test("snapshots persist one bounded run and restore from the whole journal", async () => {
	const first = makeHarness();
	await first.panel.activate(first.ctx);
	first.panel.onLifecycle({ id: "agent-x", agent: "scout", index: 0, status: "started", parentToolCallId: "call-9" });
	first.panel.onEvent(start("agent-x", 1));
	first.panel.onEvent(end("agent-x", 1, false));
	first.panel.onEvent(start("agent-x", 2));
	expect(first.snapshots.length).toBeGreaterThan(0);
	const last = first.snapshots.at(-1)!;
	expect(last.sessionId).toBe("s1");
	expect(last.data.version).toBe(1);
	expect(last.data.parentSessionId).toBe("s1");
	expect(last.data.agent).toBe("scout");
	expect(last.data.status).toBe("running");
	const actions = last.data.actions as Record<string, unknown>[];
	expect(actions).toHaveLength(2);
	expect(Object.keys(actions[0]!).sort()).toEqual(["purpose", "startOrder", "status", "toolCallId", "toolName"]);
	expect(actions[0]!.status).toBe("success");

	// A progress frame only contributes identity/reference: repeated churn writes nothing.
	const beforeProgress = first.snapshots.length;
	const progress = {
		index: 0,
		agent: "scout",
		task: "task",
		progress: { id: "agent-x", status: "running" },
		sessionFile: "/tmp/omp-subagents-panel-missing-child.jsonl",
	};
	first.panel.onProgress(progress);
	const afterReference = first.snapshots.length;
	expect(afterReference).toBe(beforeProgress + 1);
	first.panel.onProgress(progress);
	expect(first.snapshots.length).toBe(afterReference);

	// Restore in a fresh panel: same journal, cold states marked unknown.
	const entries = first.snapshots.map((snapshot) => ({
		type: "custom",
		customType: SUBAGENT_SNAPSHOT_TYPE,
		data: snapshot.data,
	}));
	entries.push({ type: "custom", customType: SUBAGENT_SNAPSHOT_TYPE, data: { version: 99, parentSessionId: "s1", runKey: "bad" } });
	entries.push({ type: "custom", customType: SUBAGENT_SNAPSHOT_TYPE, data: { version: 1, parentSessionId: "other", runKey: "foreign" } });

	const restored = makeHarness(entries);
	await restored.panel.activate(restored.ctx);
	const lines = restored.panel.render(THEME, 100, 12);
	const text = lines.join("\n");
	expect(text).toContain("#1");
	expect(lineWith(lines, "#1")).toContain("scout");
	expect(lineWith(lines, "#1")).toContain("unknown");
	expect(lineWith(lines, "tool1")).not.toContain("unknown");
	expect(lineWith(lines, "tool2")).toContain("unknown");
	expect(text).toContain("History incomplete");
});

test("a clean empty journal reports no subagents only after the read settles", async () => {
	const harness = makeHarness();
	await harness.panel.activate(harness.ctx);
	const lines = harness.panel.render(THEME, 100, 6);
	expect(lines.join("\n")).toContain("No subagents");
	expect(lines).toHaveLength(6);
	// Short heights drop chrome but keep the body row.
	expect(harness.panel.render(THEME, 40, 1)).toHaveLength(1);
});

test("parent sessions keep independent subagent trees", async () => {
	const harness = makeHarness();
	await harness.panel.activate(harness.ctx);
	harness.panel.onLifecycle({
		id: "agent", agent: "ParentOneAgent", parentToolCallId: "call-a", status: "started",
	});

	const secondContext = {
		sessionManager: {
			getSessionId: () => "s2",
			getEntries: () => [{
				type: "message",
				message: { role: "assistant", content: [{
					type: "toolCall", id: "call-b", name: "task", arguments: {},
				}] },
			}],
			getSessionFile: () => undefined,
			getArtifactsDir: () => null,
		},
	} as unknown as ExtensionContext;
	await harness.panel.activate(secondContext);
	expect(harness.panel.render(THEME, 100, 8).join("\n")).toContain("No subagents");
	harness.panel.onLifecycle({
		id: "agent", agent: "ParentTwoAgent", parentToolCallId: "call-b", status: "started",
	});
	expect(harness.panel.render(THEME, 100, 8).join("\n")).toContain("ParentTwoAgent");

	await harness.panel.activate(harness.ctx);
	const first = harness.panel.render(THEME, 100, 8).join("\n");
	expect(first).toContain("ParentOneAgent");
	expect(first).not.toContain("ParentTwoAgent");
	harness.panel.dispose();
});

test("late child events update their parent tree after a session switch", async () => {
	const harness = makeHarness();
	await harness.panel.activate(harness.ctx);
	harness.panel.onLifecycle({ id: "child-a", agent: "AgentA", status: "started" });
	harness.panel.onEvent(start("child-a", 1));
	const second = makeHarness([], "s2").ctx;
	await harness.panel.activate(second);
	harness.panel.onEvent(end("child-a", 1, true));
	harness.panel.onProgress({ id: "child-a", sessionFile: "/missing/a.jsonl" });
	harness.panel.onLifecycle({ id: "child-a", agent: "AgentA", status: "completed" });
	expect(harness.panel.render(THEME, 100, 12).join("\n")).toContain("No subagents");
	await harness.panel.activate(harness.ctx);
	const lines = harness.panel.render(THEME, 100, 12);
	expect(lineWith(lines, "AgentA")).toContain("completed");
	expect(lineWith(lines, "tool1")).toContain("error");
	harness.panel.dispose();
});

test("parent call evidence distinguishes shared runtime IDs across sessions", async () => {
	const harness = makeHarness();
	await harness.panel.activate(harness.ctx);
	harness.panel.onLifecycle({
		id: "shared", agent: "AgentA", parentToolCallId: "parent-a", status: "started",
	});
	harness.panel.onEvent(start("shared", 1));
	const second = makeHarness([{
		type: "message",
		message: { role: "assistant", content: [{
			type: "toolCall", id: "parent-b", name: "task", arguments: {},
		}] },
	}], "s2").ctx;
	await harness.panel.activate(second);
	harness.panel.onLifecycle({
		id: "shared", agent: "AgentB", parentToolCallId: "parent-b", status: "started",
	});
	harness.panel.onEvent(start("shared", 2));
	harness.panel.onEvent(end("shared", 1, true));
	harness.panel.onLifecycle({
		id: "shared", agent: "AgentA", parentToolCallId: "parent-a", status: "completed",
	});
	const active = harness.panel.render(THEME, 100, 12);
	expect(lineWith(active, "AgentB")).toContain("running");
	expect(lineWith(active, "tool2")).toContain("running");
	expect(active.join("\n")).not.toContain("AgentA");
	await harness.panel.activate(harness.ctx);
	const previous = harness.panel.render(THEME, 100, 12);
	expect(lineWith(previous, "AgentA")).toContain("completed");
	expect(lineWith(previous, "tool1")).toContain("error");
	harness.panel.dispose();
});

test.each(["reject", "throw"] as const)(
	"dirty snapshots survive %s and persist when their parent becomes active again",
	async (failure) => {
		const entries: unknown[] = [];
		const first = makeHarness(entries).ctx;
		const second = makeHarness([], "s2").ctx;
		let activeSessionId = "s1";
		let failing = true;
		const panel = new SubagentsPanel((owner, data) => {
			if (owner !== activeSessionId) return false;
			if (failing) {
				if (failure === "throw") throw new Error("journal unavailable");
				return false;
			}
			entries.push({ type: "custom", customType: SUBAGENT_SNAPSHOT_TYPE, data });
			return true;
		}, () => {}, JSON.stringify);
		await panel.activate(first);
		panel.onLifecycle({ id: "dirty", agent: "RecoveredAgent", status: "started" });
		panel.onEvent(start("dirty", 1));
		activeSessionId = "s2";
		await panel.activate(second);
		failing = false;
		panel.onEvent(end("dirty", 1, true));
		panel.onLifecycle({ id: "dirty", status: "completed" });
		activeSessionId = "s1";
		await panel.activate(first);
		panel.dispose();

		const restored = makeHarness(entries);
		await restored.panel.activate(restored.ctx);
		const lines = restored.panel.render(THEME, 100, 12);
		expect(lineWith(lines, "RecoveredAgent")).toContain("completed");
		expect(lineWith(lines, "tool1")).toContain("error");
		restored.panel.dispose();
	},
);
