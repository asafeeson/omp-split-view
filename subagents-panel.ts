/**
 * subagents-panel.ts — independent per-run model of subagent tooling activity.
 *
 * One `SubagentsPanel` instance owns one tree of subagent runs per parent
 * session (keyed by `sessionManager.getSessionId()`), assembled from the native
 * task channels (`task:subagent:lifecycle`, `task:subagent:progress`,
 * `task:subagent:event`) and restored from the parent journal
 * (`getEntries()`, i.e. every branch, not the selected one) plus the read-only
 * child session loader.
 *
 * Design notes (contract `subagents-panel/r1`):
 * - A native agent id is NOT a run identity: a follow-up turn reuses the id and
 *   the child `sessionFile` while emitting a fresh `started` lifecycle, so every
 *   run carries its own `runKey` (UUID) and a new `started` always opens a new
 *   run. Only the nearest unconfirmed raw-start run is adopted by a `started`.
 * - Per-run state is bounded: the last `MAX_ACTIONS` tool calls in *start*
 *   order; an evicted call is gone (its late result is ignored).
 * - Snapshots are written through the caller's `append` callback (native
 *   `pi.appendEntry`), one snapshot per run, only on significant changes — never
 *   for progress/output/thinking churn. No sidecar file, no database, no flush
 *   subsystem.
 * - Child history is read read-only (`loadSessionFile`, `throwIfMissing`): a
 *   checkpoint (snapshot) window is the source of truth and child entries may
 *   only refine still-unknown results of retained calls; without a checkpoint
 *   the journal's last calls are adopted but marked partial, because execution
 *   start order is unconfirmed.
 * - Tool output, thinking, messages and full args are never stored here.
 *
 * The panel does not run, cancel or steer agents and does not read `recentTools`
 * as action history (it is completion-ordered and carries no call ids).
 */

import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { loadSessionFile, type SessionLoadResult } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { ScrollView, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import * as path from "node:path";
import { fieldBag, themeFingerprint } from "./panel-utils.ts";

/** Native custom-entry type holding one run's bounded snapshot. */
export const SUBAGENT_SNAPSHOT_TYPE = "split-view:subagent-run";

const SNAPSHOT_VERSION = 1;
/** Hard per-run action window (start order, oldest first). */
const MAX_ACTIONS = 7;
const PURPOSE_MAX = 600;
const AGENT_MAX = 80;
const TOOL_MAX = 60;
const REASON_MAX = 200;
const PURPOSE_UNAVAILABLE = "Purpose unavailable";
/** Rows reserved by the framed layout (header + help + bottom border). */
const FRAME_ROWS = 3;

export type RunActionStatus = "running" | "success" | "error" | "unknown";
export type RunStatus = "running" | "completed" | "failed" | "aborted" | "unknown";
export type RunHistoryState = "loading" | "ready" | "partial" | "unavailable";
export type PanelPhase = "loading" | "ready" | "partial" | "unavailable";

type ThemeColorName = Parameters<Theme["fg"]>[0];

const RUN_STATUS: Record<RunStatus, { glyph: string; label: string; color: ThemeColorName }> = {
	running: { glyph: "●", label: "running", color: "warning" },
	completed: { glyph: "✓", label: "completed", color: "success" },
	failed: { glyph: "✗", label: "failed", color: "error" },
	aborted: { glyph: "⊘", label: "aborted", color: "error" },
	unknown: { glyph: "?", label: "unknown", color: "dim" },
};

const ACTION_STATUS: Record<RunActionStatus, { glyph: string; label: string; color: ThemeColorName }> = {
	running: { glyph: "●", label: "running", color: "warning" },
	success: { glyph: "✓", label: "", color: "success" },
	error: { glyph: "✗", label: "error", color: "error" },
	unknown: { glyph: "?", label: "unknown", color: "dim" },
};

/** Terminal lifecycle frames; `started` is handled separately. */
const LIFECYCLE_TERMINAL: Record<"completed" | "failed" | "aborted", true> = {
	completed: true,
	failed: true,
	aborted: true,
};
const HISTORY_STATE: Record<RunHistoryState, true> = {
	loading: true,
	ready: true,
	partial: true,
	unavailable: true,
};
/** Progress statuses that may restate a run with no live proof. */
const PROGRESS_RUN_STATUS: Record<"running" | "completed" | "failed" | "aborted", true> = {
	running: true,
	completed: true,
	failed: true,
	aborted: true,
};

interface RunAction {
	toolCallId: string;
	toolName: string;
	purpose: string;
	startOrder: number;
	status: RunActionStatus;
}

interface Run {
	runKey: string;
	runtimeId: string;
	ordinal: number;
	agent: string;
	index?: number;
	parentToolCallId?: string;
	sessionFile?: string;
	status: RunStatus;
	nextStartOrder: number;
	actions: RunAction[];
	history: RunHistoryState;
	historyReason?: string;
	revision: number;
	/** A `started` lifecycle (or native result) confirmed this run. */
	confirmed: boolean;
	/** Created from a raw frame before its lifecycle start arrived. */
	provisional: boolean;
	/** Live evidence arrived since the last `activate()`. */
	liveProof: boolean;
	/** Restored from a snapshot (its action window is authoritative). */
	hasCheckpoint: boolean;
	/** Synthesized from a parent `task` tool result with no snapshot. */
	legacy: boolean;
	/** Its child session file is shared with another known run. */
	sharedChild: boolean;
}

interface DocRow {
	line: string;
	key: string;
	runKey?: string;
	/** Action start order, used to re-anchor when this row disappears. */
	order?: number;
}

interface Anchor {
	key: string;
	/** Row offset of the anchored key inside the viewport (0 = top row). */
	offset: number;
	runKey?: string;
	order?: number;
}

interface SessionTree {
	sessionId: string;
	runs: Run[];
	byRunKey: Map<string, Run>;
	/** runtime id → the run currently receiving that agent's activity. */
	currentRunByRuntime: Map<string, Run>;
	/** `${runtimeId}\u0000${toolCallId}` → owning run (retained actions only). */
	actionOwner: Map<string, Run>;
	/** Parent task calls provide ownership evidence across session switches. */
	parentToolCallIds: Set<string>;
	/** Latest unsaved state stays with the parent even while it is inactive. */
	dirtyRuns: Set<Run>;
	nextOrdinal: number;
	phase: PanelPhase;
	phaseReason?: string;
	/** An unparseable snapshot or a failed append: explicit incompleteness. */
	incomplete: boolean;
	/** The journal read itself failed. */
	readFailed: boolean;
	groupIssues: number;
	generation: number;
	sessionFile?: string;
	artifactsDir: string | null;
	follow: boolean;
	viewport: Anchor | undefined;
	/** Key of the newest action (or of a group with no actions yet). */
	lastActivityKey?: string;
	scroll: ScrollView;
	scrollTheme: string;
	scrollHeight: number;
	scrollLines: readonly string[] | undefined;
	/** Bumped on every model change; the document rebuild key includes it. */
	docVersion: number;
	docKey: string;
	docRows: DocRow[];
	docLines: readonly string[];
	bodyHeight: number;
}


function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** Finite non-negative integer, or undefined. */
function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0
		? value
		: undefined;
}

function bool(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

/** Membership check against a literal enum table (never trusts a caller string). */
function enumOf<T extends string>(table: Record<T, unknown>, value: unknown): T | undefined {
	return typeof value === "string" && Object.hasOwn(table, value) ? (value as T) : undefined;
}

/**
 * Flatten one displayed string: strip ANSI/OSC sequences and control
 * characters, collapse whitespace, then bound it. Everything shown by the panel
 * (agent name, tool name, purpose, reason) goes through this — hostile tool args
 * must not inject escapes or extra rows.
 */
function sanitizeText(value: unknown, max = 0): string {
	if (typeof value !== "string" || !value) return "";
	let text = value
		.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
		.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/\u001b[@-Z\\-_]/g, "")
		.replace(/[\r\n\t]+/g, " ")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s{2,}/g, " ")
		.trim();
	if (max > 0 && text.length > max) text = text.slice(0, max);
	return text;
}

function padTo(line: string, width: number): string {
	return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
}

const SUBAGENT_THEME_COLORS = [
	"border", "accent", "muted", "dim", "text", "success", "error", "warning",
] as const;

function makeScroll(theme: Theme, height: number): ScrollView {
	return new ScrollView([], {
		height,
		scrollbar: "auto",
		theme: {
			track: (text) => theme.fg("border", text),
			thumb: (text) => theme.fg("muted", text),
		},
	});
}

const headerKey = (run: Run): string => `run:${run.runKey}:header`;
const actionKey = (run: Run, toolCallId: string): string => `run:${run.runKey}:action:${toolCallId}`;
const ownerKey = (runtimeId: string, toolCallId: string): string => `${runtimeId}\u0000${toolCallId}`;

function isTerminal(status: RunStatus): boolean {
	return status === "completed" || status === "failed" || status === "aborted";
}

/** A child reference must stay a single path component (no separators, no ..). */
function safeChildBasename(id: string): boolean {
	if (!id || id === "." || id === "..") return false;
	return !id.includes("/") && !id.includes("\\") && !id.includes("\u0000") && !id.includes("..");
}

// ─── snapshot (de)serialization ──────────────────────────────────────────────

interface SnapshotAction {
	toolCallId: string;
	toolName: string;
	purpose: string;
	startOrder: number;
	status: RunActionStatus;
}

/**
 * Validate one persisted snapshot. Returns undefined for anything that is not a
 * well-formed snapshot of `sessionId` (unknown version, wrong parent, broken
 * enums, non-finite orders, duplicate or oversized action windows): a damaged
 * record is never reported as a successful restore.
 */
function parseSnapshot(data: unknown, sessionId: string): Run | undefined {
	const bag = fieldBag(data);
	if (bag.version !== SNAPSHOT_VERSION) return undefined;
	if (str(bag.parentSessionId) !== sessionId) return undefined;
	const runKey = str(bag.runKey);
	const runtimeId = str(bag.runtimeId);
	if (!runKey || !runtimeId) return undefined;
	const revision = count(bag.revision);
	const ordinal = count(bag.ordinal);
	const nextStartOrder = count(bag.nextStartOrder);
	const status = enumOf(RUN_STATUS, bag.status);
	const history = enumOf(HISTORY_STATE, bag.history);
	if (revision === undefined || ordinal === undefined || ordinal < 1) return undefined;
	if (nextStartOrder === undefined || !status || !history) return undefined;
	// `loading` is a live-only state and is never a final persisted state.
	if (history === "loading") return undefined;
	const rawActions = bag.actions;
	if (!Array.isArray(rawActions) || rawActions.length > MAX_ACTIONS) return undefined;
	const actions: RunAction[] = [];
	const seen = new Set<string>();
	for (const raw of rawActions) {
		const entry = fieldBag(raw);
		const toolCallId = str(entry.toolCallId);
		const toolName = sanitizeText(entry.toolName, TOOL_MAX);
		const startOrder = count(entry.startOrder);
		const actionStatus = enumOf(ACTION_STATUS, entry.status);
		if (!toolCallId || !toolName || startOrder === undefined || !actionStatus) return undefined;
		if (seen.has(toolCallId)) return undefined;
		seen.add(toolCallId);
		actions.push({
			toolCallId,
			toolName,
			purpose: sanitizeText(entry.purpose, PURPOSE_MAX) || PURPOSE_UNAVAILABLE,
			startOrder,
			status: actionStatus,
		});
	}
	const index = count(bag.index);
	return {
		runKey,
		runtimeId,
		ordinal,
		agent: sanitizeText(bag.agent, AGENT_MAX),
		index,
		parentToolCallId: str(bag.parentToolCallId) || undefined,
		sessionFile: str(bag.sessionFile) || undefined,
		status,
		nextStartOrder,
		actions,
		history,
		historyReason: sanitizeText(bag.historyReason, REASON_MAX) || undefined,
		revision,
		// Cold evidence: not a live confirmation, and not provisional (a later
		// `started` opens a new run rather than adopting this one).
		confirmed: false,
		provisional: false,
		liveProof: false,
		hasCheckpoint: true,
		legacy: false,
		sharedChild: false,
	};
}

function toSnapshot(tree: SessionTree, run: Run, revision: number): Record<string, unknown> {
	// An unresolved child read is recorded as partial so a later restore cannot
	// present it as verified.
	const history: RunHistoryState = run.history === "loading" ? "partial" : run.history;
	const data: Record<string, unknown> = {
		version: SNAPSHOT_VERSION,
		parentSessionId: tree.sessionId,
		runKey: run.runKey,
		revision,
		ordinal: run.ordinal,
		runtimeId: run.runtimeId,
		agent: run.agent,
		status: run.status,
		nextStartOrder: run.nextStartOrder,
		actions: run.actions.map<SnapshotAction>((action) => ({
			toolCallId: action.toolCallId,
			toolName: action.toolName,
			purpose: action.purpose,
			startOrder: action.startOrder,
			status: action.status,
		})),
		history,
	};
	if (run.index !== undefined) data.index = run.index;
	if (run.parentToolCallId) data.parentToolCallId = run.parentToolCallId;
	if (run.sessionFile) data.sessionFile = run.sessionFile;
	const reason =
		run.historyReason ??
		(history === "partial" && run.history === "loading" ? "history not resolved" : undefined);
	if (reason) data.historyReason = reason;
	return data;
}

// ─── journal readers ─────────────────────────────────────────────────────────

interface LegacyResult {
	parentToolCallId: string;
	runtimeId: string;
	agent: string;
	index?: number;
	aborted: boolean;
	exitCode?: number;
}

/**
 * Native parent `task` results. They carry id/index/agent/exitCode/aborted but
 * no child session file, so they can only confirm identity and terminal state —
 * never a tool history. The task tool's own error glyph is NOT agent status.
 */
function collectLegacyResults(entries: readonly unknown[]): LegacyResult[] {
	const out: LegacyResult[] = [];
	for (const entry of entries) {
		const record = fieldBag(entry);
		if (record.type !== "message") continue;
		const message = fieldBag(record.message);
		if (message.role !== "toolResult" || message.toolName !== "task") continue;
		const results = fieldBag(message.details).results;
		if (!Array.isArray(results)) continue;
		const parentToolCallId = str(message.toolCallId);
		for (const raw of results) {
			const result = fieldBag(raw);
			const runtimeId = str(result.id);
			if (!runtimeId) continue;
			out.push({
				parentToolCallId,
				runtimeId,
				agent: sanitizeText(result.agent, AGENT_MAX),
				index: count(result.index),
				aborted: result.aborted === true,
				exitCode: typeof result.exitCode === "number" && Number.isFinite(result.exitCode)
					? result.exitCode
					: undefined,
			});
		}
	}
	return out;
}

/** Terminal state a native result proves: abort > exit code > unknown. */
function statusFromResult(result: LegacyResult): RunStatus {
	if (result.aborted) return "aborted";
	if (result.exitCode === 0) return "completed";
	if (result.exitCode !== undefined) return "failed";
	return "unknown";
}

interface Journal {
	calls: { toolCallId: string; toolName: string; args: unknown }[];
	/** toolCallId → real boolean `isError` (undefined = no confirmation). */
	results: Map<string, boolean | undefined>;
}

/**
 * Child journal tool calls and their results. Calls keep journal (declaration)
 * order; a result without a real boolean `isError` stays unconfirmed.
 */
function readChildJournal(entries: readonly unknown[]): Journal {
	const calls: Journal["calls"] = [];
	const results: Journal["results"] = new Map();
	for (const entry of entries) {
		const record = fieldBag(entry);
		if (record.type !== "message") continue;
		const message = fieldBag(record.message);
		if (message.role === "assistant") {
			if (!Array.isArray(message.content)) continue;
			for (const block of message.content) {
				const item = fieldBag(block);
				const toolCallId = str(item.id);
				const toolName = sanitizeText(item.name, TOOL_MAX);
				if (item.type !== "toolCall" || !toolCallId || !toolName) continue;
				calls.push({ toolCallId, toolName, args: item.arguments });
			}
			continue;
		}
		if (message.role !== "toolResult") continue;
		const toolCallId = str(message.toolCallId);
		if (!toolCallId) continue;
		const isError = bool(message.isError);
		// A later record for the same id wins only when it confirms the result.
		if (isError !== undefined || !results.has(toolCallId)) results.set(toolCallId, isError);
	}
	return { calls, results };
}

// ─── panel ───────────────────────────────────────────────────────────────────

/**
 * Independent per-run subagent panel model.
 *
 * @param append      native persistence bridge: `pi.appendEntry` gated on the
 *                    live session id; returns true only when the entry landed.
 * @param changed     called whenever the rendered model changed.
 * @param previewArgs existing args-preview (the split-view `argsJson` bound
 *                    function) used when a tool call carries no `i` intent.
 */
export class SubagentsPanel {
	private readonly trees = new Map<string, SessionTree>();
	private readonly runtimeOwners = new Map<string, SessionTree>();
	private activeSessionId: string | undefined;
	private disposed = false;

	constructor(
		private readonly append: (parentSessionId: string, data: unknown) => boolean,
		private readonly changed: () => void,
		private readonly previewArgs: (args: unknown) => string,
	) {}

	// ── lifecycle ──

	/**
	 * Select the active tree synchronously, restore persisted runs from the
	 * whole journal, then read child journals read-only. Results apply only
	 * while the captured generation is current: a newer activate (or dispose)
	 * wins, and live events arriving during the read are never overwritten.
	 */
	async activate(ctx: ExtensionContext): Promise<void> {
		if (this.disposed || !ctx) return;
		const sessionManager = ctx.sessionManager;
		const sessionId = sessionManager ? str(sessionManager.getSessionId()) : "";
		if (!sessionId) return;
		const tree = this.ensureTree(sessionId);
		// Live routing is bound before the first await.
		this.activeSessionId = sessionId;
		const generation = ++tree.generation;
		tree.sessionFile = str(sessionManager.getSessionFile()) || undefined;
		tree.artifactsDir = sessionManager.getArtifactsDir() ?? null;
		for (const run of tree.dirtyRuns) this.touch(tree, run);

		let entries: readonly unknown[];
		try {
			tree.readFailed = false;
			entries = sessionManager.getEntries() ?? [];
		} catch {
			tree.readFailed = true;
			tree.phase = "unavailable";
			tree.phaseReason = "session journal unavailable";
			tree.docVersion++;
			this.changed();
			return;
		}

		tree.parentToolCallIds.clear();
		for (const entry of entries) {
			const record = fieldBag(entry);
			if (record.type !== "message") continue;
			const message = fieldBag(record.message);
			if (message.role === "toolResult" && message.toolName === "task") {
				const id = str(message.toolCallId);
				if (id) tree.parentToolCallIds.add(id);
			} else if (message.role === "assistant" && Array.isArray(message.content)) {
				for (const content of message.content) {
					const call = fieldBag(content);
					if (call.type === "toolCall" && call.name === "task" && str(call.id))
						tree.parentToolCallIds.add(str(call.id));
				}
			}
		}
		if (this.restoreSnapshots(tree, entries)) tree.incomplete = true;
		this.restoreLegacyResults(tree, entries);

		// A child session file shared by several runs cannot have its
		// unattributed calls assigned to any one of them.
		const fileUse = new Map<string, number>();
		for (const run of tree.runs) {
			if (run.sessionFile) fileUse.set(run.sessionFile, (fileUse.get(run.sessionFile) ?? 0) + 1);
		}

		const pending: { run: Run; file: string; candidate: boolean }[] = [];
		for (const run of tree.runs) {
			if (run.liveProof) continue;
			if (run.sessionFile) {
				pending.push({ run, file: run.sessionFile, candidate: false });
				continue;
			}
			if (!run.legacy) continue;
			const dir = tree.artifactsDir;
			if (!dir || !safeChildBasename(run.runtimeId)) {
				run.history = "unavailable";
				run.historyReason = dir ? "no child session reference" : "artifacts directory unavailable";
				continue;
			}
			// Native executor writes `<artifactsDir>/<id>.jsonl` for spawned agents.
			const file = path.join(dir, `${run.runtimeId}.jsonl`);
			fileUse.set(file, (fileUse.get(file) ?? 0) + 1);
			pending.push({ run, file, candidate: true });
		}
		for (const item of pending) item.run.sharedChild = (fileUse.get(item.file) ?? 0) > 1;

		if (pending.length > 0) {
			tree.phase = "loading";
			tree.phaseReason = undefined;
		} else {
			tree.phase = this.settledPhase(tree);
		}
		tree.docVersion++;
		this.changed();

		for (const item of pending) {
			if (this.disposed || generation !== tree.generation) return;
			if (!item.run.hasCheckpoint) item.run.history = "loading";
			await this.loadChild(tree, item.run, item.file, item.candidate, generation);
		}
		if (this.disposed || generation !== tree.generation) return;
		tree.phase = this.settledPhase(tree);
		tree.docVersion++;
		this.changed();
	}

	/** Native lifecycle: the only boundary of a new confirmed run. */
	onLifecycle(data: unknown): void {
		const bag = fieldBag(data);
		const runtimeId = str(bag.id);
		if (!runtimeId) return;
		const tree = this.eventTree(runtimeId, str(bag.parentToolCallId));
		if (!tree) return;
		const agent = sanitizeText(bag.agent, AGENT_MAX);
		const index = count(bag.index);
		const parentToolCallId = str(bag.parentToolCallId) || undefined;
		const sessionFile = str(bag.sessionFile) || undefined;

		if (bag.status === "started") {
			const pending = tree.currentRunByRuntime.get(runtimeId);
			const run = pending?.provisional && !pending.confirmed
				? pending
				: this.createRun(tree, runtimeId);
			run.provisional = false;
			run.confirmed = true;
			run.liveProof = true;
			if (agent) run.agent = agent;
			if (index !== undefined) run.index = index;
			if (parentToolCallId) run.parentToolCallId = parentToolCallId;
			if (sessionFile) run.sessionFile = sessionFile;
			run.status = "running";
			tree.currentRunByRuntime.set(runtimeId, run);
			this.runtimeOwners.set(runtimeId, tree);
			this.noteActivity(tree, run);
			this.touch(tree, run);
			return;
		}

		const terminal = enumOf(LIFECYCLE_TERMINAL, bag.status);
		if (!terminal) return;
		const pending = parentToolCallId
			? tree.runs.findLast((run) =>
				run.runtimeId === runtimeId && run.parentToolCallId === parentToolCallId)
			: tree.currentRunByRuntime.get(runtimeId) ?? this.latestRun(tree, runtimeId);
		const run = pending ?? this.createRun(tree, runtimeId);
		run.provisional = false;
		run.confirmed = true;
		run.liveProof = true;
		if (agent) run.agent ||= agent;
		if (index !== undefined && run.index === undefined) run.index = index;
		if (parentToolCallId && !run.parentToolCallId) run.parentToolCallId = parentToolCallId;
		if (sessionFile && !run.sessionFile) run.sessionFile = sessionFile;
		run.status = terminal;
		// A closed run releases its runtime slot: a later raw frame opens a fresh
		// provisional run instead of reopening this one.
		if (tree.currentRunByRuntime.get(runtimeId) === run)
			tree.currentRunByRuntime.delete(runtimeId);
		// Unclosed calls are UNKNOWN, never success — no end event confirmed them.
		for (const action of run.actions) if (action.status === "running") action.status = "unknown";
		this.noteActivity(tree, run);
		this.touch(tree, run);
	}

	/**
	 * Aggregated progress: identity, child reference and a confirming status for
	 * a run that has no live proof yet. It never opens a run and never turns
	 * `recentTools` into actions.
	 */
	onProgress(data: unknown): void {
		const bag = fieldBag(data);
		const progress = fieldBag(bag.progress);
		const runtimeId = str(progress.id) || str(bag.id);
		if (!runtimeId) return;
		const tree = this.eventTree(runtimeId, str(bag.parentToolCallId));
		if (!tree) return;
		const parentToolCallId = str(bag.parentToolCallId);
		const run = parentToolCallId
			? tree.runs.findLast((candidate) =>
				candidate.runtimeId === runtimeId && candidate.parentToolCallId === parentToolCallId)
			: this.activeRun(tree, runtimeId) ?? this.latestRun(tree, runtimeId);
		if (!run) return;
		let significant = false;
		const sessionFile = str(bag.sessionFile);
		if (sessionFile && run.sessionFile !== sessionFile) {
			run.sessionFile = sessionFile;
			significant = true;
		}
		const index = count(bag.index);
		if (index !== undefined && run.index === undefined) {
			run.index = index;
			significant = true;
		}
		const agent = sanitizeText(bag.agent, AGENT_MAX);
		if (!run.agent && agent) {
			run.agent = agent;
			significant = true;
		}
		// Only a run restored without live proof may be restated from progress,
		// and a terminal run is never reopened by a late frame.
		if (!run.liveProof && !isTerminal(run.status)) {
			const confirmed = enumOf(PROGRESS_RUN_STATUS, progress.status);
			if (confirmed && confirmed !== run.status) {
				run.status = confirmed;
				significant = true;
			}
		}
		if (significant) this.touch(tree, run);
	}

	/** Raw child frame: `{ id, event }` — the source of per-run tool actions. */
	onEvent(data: unknown): void {
		if (this.disposed) return;
		const bag = fieldBag(data);
		const runtimeId = str(bag.id);
		const frame = fieldBag(bag.event);
		const type = str(frame.type);
		const toolCallId = str(frame.toolCallId);
		if (!runtimeId || !toolCallId) return;
		const tree = this.eventTree(runtimeId, str(bag.parentToolCallId), toolCallId);
		if (!tree) return;

		if (type === "tool_execution_start") {
			const toolName = sanitizeText(frame.toolName, TOOL_MAX);
			if (!toolName) return;
			let run = tree.actionOwner.get(ownerKey(runtimeId, toolCallId)) ?? this.activeRun(tree, runtimeId);
			if (!run) {
				run = this.createRun(tree, runtimeId);
				run.provisional = true;
				run.status = "running";
				tree.currentRunByRuntime.set(runtimeId, run);
				this.runtimeOwners.set(runtimeId, tree);
				this.noteActivity(tree, run);
			}
			run.liveProof = true;
			this.addAction(tree, run, toolCallId, toolName, frame.args);
			this.touch(tree, run);
			return;
		}
		if (type === "tool_execution_end") {
			const run = tree.actionOwner.get(ownerKey(runtimeId, toolCallId));
			if (!run) return;
			const action = run.actions.find((candidate) => candidate.toolCallId === toolCallId);
			if (!action) return;
			// A real boolean decides; a missing flag leaves the call unconfirmed.
			const isError = bool(frame.isError);
			action.status = isError === undefined ? "unknown" : isError ? "error" : "success";
			run.liveProof = true;
			this.touch(tree, run);
			return;
		}
		// `tool_execution_update` (and any other frame) carries no panel state.
	}

	// ── viewport ──

	/** `up`/`down` page and pause follow; `live` resumes following activity. */
	navigate(direction: "up" | "down" | "live"): void {
		const tree = this.activeTree();
		if (!tree) return;
		if (direction === "live") {
			tree.follow = true;
			this.changed();
			return;
		}
		if (tree.follow) tree.viewport = this.captureAnchor(tree);
		tree.follow = false;
		tree.scroll.page(direction === "up" ? -1 : 1);
		tree.viewport = this.captureAnchor(tree);
		this.changed();
	}

	// ── render ──

	/** Render exactly `height` rows (clipped to `width`) for the active tree. */
	render(theme: Theme, width: number, height: number): string[] {
		const w = Number.isFinite(width) ? Math.max(1, Math.trunc(width)) : 1;
		const h = Number.isFinite(height) ? Math.max(0, Math.trunc(height)) : 0;
		if (h === 0) return [];
		const tree = this.activeTree();
		if (!tree) return Array.from({ length: h }, () => "");
		const framed = h >= 4;
		const bodyHeight = framed ? h - FRAME_ROWS : h;
		tree.bodyHeight = bodyHeight;
		const fingerprint = themeFingerprint(theme, SUBAGENT_THEME_COLORS);
		if (tree.scrollTheme !== fingerprint) {
			tree.scroll.dispose();
			tree.scroll = makeScroll(theme, bodyHeight);
			tree.scrollTheme = fingerprint;
			tree.scrollLines = undefined;
		} else if (tree.scrollHeight !== bodyHeight) {
			tree.scroll.setHeight(bodyHeight);
		}
		tree.scrollHeight = bodyHeight;
		this.document(tree, theme, fingerprint);
		if (tree.scrollLines !== tree.docLines) {
			tree.scroll.setLines(tree.docLines);
			tree.scrollLines = tree.docLines;
		}
		this.syncViewport(tree, tree.docRows);
		const body = tree.scroll.render(w);
		const out: string[] = [];
		if (framed) out.push(padTo(truncateToWidth(this.headerLine(tree, theme, w), w), w));
		for (let row = 0; row < bodyHeight; row++) out.push(padTo(truncateToWidth(body[row] ?? "", w), w));
		if (framed) {
			out.push(padTo(truncateToWidth(this.hintLine(tree, theme, w), w), w));
			out.push(padTo(truncateToWidth(this.bottomLine(theme, w), w), w));
		}
		return out.slice(0, h);
	}

	/** Invalidate async work and release viewports. */
	dispose(): void {
		this.disposed = true;
		this.activeSessionId = undefined;
		for (const tree of this.trees.values()) {
			tree.generation++;
			tree.scroll.dispose();
		}
		this.trees.clear();
		this.runtimeOwners.clear();
	}

	// ── tree internals ──

	private activeTree(): SessionTree | undefined {
		if (this.disposed || !this.activeSessionId) return undefined;
		return this.trees.get(this.activeSessionId);
	}

	/** Route evidence to its owner; conflicting identities never select the UI session. */
	private eventTree(runtimeId: string, parentToolCallId?: string, toolCallId?: string): SessionTree | undefined {
		if (this.disposed) return undefined;
		let parentOwner: SessionTree | undefined;
		let actionOwner: SessionTree | undefined;
		let runtimeOwner: SessionTree | undefined;
		let ambiguousRuntime = false;
		for (const tree of this.trees.values()) {
			if (parentToolCallId && (tree.parentToolCallIds.has(parentToolCallId) ||
				tree.runs.some((run) => run.runtimeId === runtimeId && run.parentToolCallId === parentToolCallId))) {
				if (parentOwner && parentOwner !== tree) return undefined;
				parentOwner = tree;
			}
			if (toolCallId && tree.actionOwner.has(ownerKey(runtimeId, toolCallId))) {
				if (actionOwner && actionOwner !== tree) return undefined;
				actionOwner = tree;
			}
			if (tree.runs.some((run) => run.runtimeId === runtimeId)) {
				if (runtimeOwner && runtimeOwner !== tree) ambiguousRuntime = true;
				runtimeOwner = tree;
			}
		}
		if (parentOwner && actionOwner && parentOwner !== actionOwner) return undefined;
		if (parentOwner || actionOwner) return parentOwner ?? actionOwner;
		const liveOwner = this.runtimeOwners.get(runtimeId);
		if (liveOwner) return liveOwner;
		if (ambiguousRuntime) return undefined;
		return runtimeOwner ?? this.activeTree();
	}

	private ensureTree(sessionId: string): SessionTree {
		const existing = this.trees.get(sessionId);
		if (existing) return existing;
		const tree: SessionTree = {
			sessionId,
			runs: [],
			byRunKey: new Map(),
			currentRunByRuntime: new Map(),
			actionOwner: new Map(),
			parentToolCallIds: new Set(),
			dirtyRuns: new Set(),
			nextOrdinal: 1,
			phase: "ready",
			incomplete: false,
			readFailed: false,
			groupIssues: 0,
			generation: 0,
			artifactsDir: null,
			follow: true,
			viewport: undefined,
			scroll: new ScrollView([], { height: 1, scrollbar: "auto" }),
			scrollTheme: "",
			scrollHeight: 1,
			scrollLines: undefined,
			docVersion: 0,
			docKey: "",
			docRows: [],
			docLines: [],
			bodyHeight: 1,
		};
		this.trees.set(sessionId, tree);
		return tree;
	}

	/** The run currently receiving this runtime id's activity (terminal = none). */
	private activeRun(tree: SessionTree, runtimeId: string): Run | undefined {
		const run = tree.currentRunByRuntime.get(runtimeId);
		return run && !isTerminal(run.status) ? run : undefined;
	}

	private latestRun(tree: SessionTree, runtimeId: string): Run | undefined {
		for (let i = tree.runs.length - 1; i >= 0; i--) {
			if (tree.runs[i].runtimeId === runtimeId) return tree.runs[i];
		}
		return undefined;
	}

	private createRun(tree: SessionTree, runtimeId: string): Run {
		const run: Run = {
			runKey: crypto.randomUUID(),
			runtimeId,
			ordinal: tree.nextOrdinal++,
			agent: "",
			status: "unknown",
			nextStartOrder: 1,
			actions: [],
			history: "ready",
			revision: 0,
			confirmed: false,
			provisional: false,
			liveProof: true,
			hasCheckpoint: false,
			legacy: false,
			sharedChild: false,
		};
		tree.runs.push(run);
		tree.byRunKey.set(run.runKey, run);
		return run;
	}

	private insertRestoredRun(tree: SessionTree, run: Run): void {
		tree.runs.push(run);
		tree.byRunKey.set(run.runKey, run);
		if (run.ordinal >= tree.nextOrdinal) tree.nextOrdinal = run.ordinal + 1;
		for (const action of run.actions) {
			const key = ownerKey(run.runtimeId, action.toolCallId);
			// Live routing wins over restored routing.
			if (!tree.actionOwner.has(key)) tree.actionOwner.set(key, run);
		}
		// A restored run never claims the runtime slot: the previous process's
		// "running" is not current activity, and a fresh `started` is the only
		// boundary of a new confirmed run.
		this.noteActivity(tree, run);
	}

	private noteActivity(tree: SessionTree, run: Run): void {
		const last = run.actions[run.actions.length - 1];
		tree.lastActivityKey = last ? actionKey(run, last.toolCallId) : headerKey(run);
	}

	/** Purpose of one tool call: `args.i`, else the args preview, else a marker. */
	private purposeOf(args: unknown): string {
		const intent = sanitizeText(fieldBag(args).i, PURPOSE_MAX);
		if (intent) return intent;
		let preview = "";
		try {
			preview = this.previewArgs(args);
		} catch {
			preview = "";
		}
		const text = sanitizeText(preview, PURPOSE_MAX);
		if (!text || text === "{}" || text === "[]" || text === "null") return PURPOSE_UNAVAILABLE;
		return text;
	}

	private addAction(tree: SessionTree, run: Run, toolCallId: string, toolName: string, args: unknown): void {
		const existing = run.actions.find((action) => action.toolCallId === toolCallId);
		if (existing) {
			// A repeated event for a known call updates its row in place.
			existing.toolName = toolName;
			if (existing.purpose === PURPOSE_UNAVAILABLE) existing.purpose = this.purposeOf(args);
			return;
		}
		run.actions.push({
			toolCallId,
			toolName,
			purpose: this.purposeOf(args),
			startOrder: run.nextStartOrder++,
			status: "running",
		});
		if (run.actions.length > MAX_ACTIONS) {
			const evicted = run.actions.shift()!;
			const key = ownerKey(run.runtimeId, evicted.toolCallId);
			if (tree.actionOwner.get(key) === run) tree.actionOwner.delete(key);
		}
		tree.actionOwner.set(ownerKey(run.runtimeId, toolCallId), run);
		this.noteActivity(tree, run);
	}

	/** Persist one run and notify. A failed append is explicit incompleteness. */
	private touch(tree: SessionTree, run: Run): void {
		tree.docVersion++;
		tree.dirtyRuns.add(run);
		const revision = run.revision + 1;
		let stored = false;
		try {
			stored = this.append(tree.sessionId, toSnapshot(tree, run, revision)) === true;
		} catch {
			stored = false;
		}
		if (stored) {
			run.revision = revision;
			tree.dirtyRuns.delete(run);
		} else {
			tree.incomplete = true;
			if (tree.phase === "ready") tree.phase = "partial";
			tree.phaseReason = "History incomplete";
		}
		this.changed();
	}

	// ── restore ──

	/** Returns true when at least one snapshot record was unparseable. */
	private restoreSnapshots(tree: SessionTree, entries: readonly unknown[]): boolean {
		let incomplete = false;
		const best = new Map<string, { run: Run; revision: number; order: number }>();
		entries.forEach((entry, order) => {
			const record = fieldBag(entry);
			if (record.type !== "custom" || record.customType !== SUBAGENT_SNAPSHOT_TYPE) return;
			// Another session's well-formed record (copied journal) is not damage.
			const snapshotData = fieldBag(record.data);
			const owner = str(snapshotData.parentSessionId);
			if (!owner) {
				incomplete = true;
				return;
			}
			if (owner !== tree.sessionId) return;
			const parsed = parseSnapshot(record.data, tree.sessionId);
			if (!parsed) {
				incomplete = true;
				return;
			}
			const previous = best.get(parsed.runKey);
			// Highest revision wins; an equal revision keeps the later record.
			if (
				!previous ||
				parsed.revision > previous.revision ||
				(parsed.revision === previous.revision && order >= previous.order)
			) {
				best.set(parsed.runKey, { run: parsed, revision: parsed.revision, order });
			}
		});
		const ordered = [...best.values()].sort((a, b) => a.order - b.order);
		for (const { run } of ordered) {
			const existing = tree.byRunKey.get(run.runKey);
			if (existing) {
				this.mergeRestoredMetadata(existing, run);
				continue;
			}
			// Cold restore: state that only live evidence can confirm is shown as
			// unknown until a fresh event arrives.
			for (const action of run.actions) if (action.status === "running") action.status = "unknown";
			if (run.status === "running") run.status = "unknown";
			this.insertRestoredRun(tree, run);
		}
		return incomplete;
	}

	private mergeRestoredMetadata(target: Run, restored: Run): void {
		if (!target.agent && restored.agent) target.agent = restored.agent;
		if (target.index === undefined && restored.index !== undefined) target.index = restored.index;
		if (!target.parentToolCallId && restored.parentToolCallId) target.parentToolCallId = restored.parentToolCallId;
		if (!target.sessionFile && restored.sessionFile) target.sessionFile = restored.sessionFile;
		if (!target.hasCheckpoint && restored.hasCheckpoint) target.hasCheckpoint = true;
	}

	/**
	 * Native parent results: identity and terminal state only. A result never
	 * creates a second node for an already known run.
	 */
	private restoreLegacyResults(tree: SessionTree, entries: readonly unknown[]): void {
		for (const result of collectLegacyResults(entries)) {
			// Missing metadata may be filled, but conflicting parent calls or
			// item indexes are evidence of distinct runs, never a fallback match.
			const sameRuntime = tree.runs.filter((run) =>
				run.runtimeId === result.runtimeId &&
				(!result.parentToolCallId || !run.parentToolCallId ||
					run.parentToolCallId === result.parentToolCallId) &&
				(result.index === undefined || run.index === undefined || run.index === result.index));
			const known =
				(result.parentToolCallId
					? sameRuntime.find((run) => run.parentToolCallId === result.parentToolCallId)
					: undefined) ??
				(result.index !== undefined
					? sameRuntime.find((run) => run.index === result.index)
					: undefined) ??
				(sameRuntime.length === 1 &&
				sameRuntime[0].parentToolCallId === undefined &&
				sameRuntime[0].index === undefined
					? sameRuntime[0]
					: undefined);
			if (known) {
				if (known.index === undefined && result.index !== undefined) known.index = result.index;
				if (!known.parentToolCallId && result.parentToolCallId) known.parentToolCallId = result.parentToolCallId;
				if (!known.agent && result.agent) known.agent = result.agent;
				// A live-confirmed run keeps its live status.
				if (!known.liveProof || known.status === "unknown") known.status = statusFromResult(result);
				known.confirmed = true;
				continue;
			}
			this.insertRestoredRun(tree, {
				// Stable identity for a result with no checkpoint: a later restore
				// of the same journal maps onto this same node.
				runKey: `legacy:${result.parentToolCallId}:${result.index === undefined ? "" : result.index}:${result.runtimeId}`,
				runtimeId: result.runtimeId,
				ordinal: tree.nextOrdinal++,
				agent: result.agent,
				index: result.index,
				parentToolCallId: result.parentToolCallId || undefined,
				status: statusFromResult(result),
				nextStartOrder: 1,
				actions: [],
				history: "unavailable",
				historyReason: "no persisted run checkpoint",
				revision: 0,
				confirmed: true,
				provisional: false,
				liveProof: false,
				hasCheckpoint: false,
				legacy: true,
				sharedChild: false,
			});
		}
	}

	private settledPhase(tree: SessionTree): PanelPhase {
		if (tree.readFailed) return "unavailable";
		if (tree.incomplete) return "partial";
		if (tree.runs.length === 0 && tree.groupIssues > 0) return "partial";
		return "ready";
	}

	/**
	 * Read one child journal read-only. Never opens a session, mutates a
	 * registry, revives an agent or runs one; the child header must name this
	 * parent's session file, and only the corresponding group is affected.
	 */
	private async loadChild(
		tree: SessionTree,
		run: Run,
		file: string,
		candidate: boolean,
		generation: number,
	): Promise<void> {
		let loaded: SessionLoadResult;
		try {
			loaded = await loadSessionFile(file, undefined, { throwIfMissing: true });
		} catch {
			if (generation === tree.generation) {
				this.failGroup(tree, run, candidate ? "child session file not found" : "child session file unreadable");
			}
			return;
		}
		if (this.disposed || generation !== tree.generation) return;
		const header = fieldBag(loaded.entries.find((entry) => fieldBag(entry).type === "session"));
		if (loaded.invalidHeader || !str(header.id)) {
			this.failGroup(tree, run, "child session has no valid header");
			return;
		}
		const parent = str(header.parentSession);
		const expectedParent = tree.sessionFile;
		// The child must belong to THIS parent session file; an absolute-form
		// difference (symlink/relative) is not a different parent.
		if (
			!expectedParent ||
			(parent !== expectedParent && (!parent || path.resolve(parent) !== path.resolve(expectedParent)))
		) {
			this.failGroup(tree, run, parent ? "child session belongs to another parent" : "child session parent unconfirmed");
			return;
		}
		const malformed = typeof loaded.malformedRecords === "number" && loaded.malformedRecords > 0;
		const journal = readChildJournal(loaded.entries);
		if (run.hasCheckpoint) {
			// The checkpoint window is the source of truth: refine unknown results
			// of retained calls only — never revive an evicted call, never add one.
			for (const action of run.actions) {
				if (action.status !== "unknown" || !journal.results.has(action.toolCallId)) continue;
				const isError = journal.results.get(action.toolCallId);
				if (isError !== undefined) action.status = isError ? "error" : "success";
			}
			run.history = malformed ? "partial" : "ready";
			run.historyReason = malformed ? "child journal has malformed records" : undefined;
		} else if (run.sharedChild) {
			run.history = "partial";
			run.historyReason = "child session shared with another run";
		} else if (run.actions.length === 0) {
			let order = 1;
			for (const call of journal.calls.slice(-MAX_ACTIONS)) {
				const isError = journal.results.get(call.toolCallId);
				run.actions.push({
					toolCallId: call.toolCallId,
					toolName: call.toolName,
					purpose: this.purposeOf(call.args),
					startOrder: order++,
					status: isError === undefined ? "unknown" : isError ? "error" : "success",
				});
			}
			run.nextStartOrder = order;
			for (const action of run.actions) {
				const key = ownerKey(run.runtimeId, action.toolCallId);
				if (!tree.actionOwner.has(key)) tree.actionOwner.set(key, run);
			}
			run.history = "partial";
			run.historyReason = malformed
				? "child journal has malformed records; execution start order unconfirmed"
				: "execution start order unconfirmed";
			this.noteActivity(tree, run);
		} else {
			run.history = "partial";
			run.historyReason = "execution start order unconfirmed";
		}
		tree.docVersion++;
	}

	private failGroup(tree: SessionTree, run: Run, reason: string): void {
		if (run.hasCheckpoint) {
			// Known actions/state stay; only the group's confidence drops.
			run.history = "partial";
			run.historyReason = reason;
		} else {
			run.history = "unavailable";
			run.historyReason = reason;
		}
		tree.groupIssues++;
		tree.docVersion++;
	}

	// ── document ──

	private document(tree: SessionTree, theme: Theme, fingerprint: string): DocRow[] {
		const key = `${tree.docVersion}|${fingerprint}`;
		if (tree.docKey === key) return tree.docRows;
		const rows: DocRow[] = [];
		const runs = [...tree.runs].sort((a, b) => a.ordinal - b.ordinal);
		if (runs.length === 0) {
			rows.push({ key: "state:empty", line: ` ${this.emptyText(tree, theme)}` });
		} else {
			if (tree.phase !== "ready") {
				const unavailable = tree.phase === "unavailable";
				const reason = sanitizeText(tree.phaseReason, REASON_MAX);
				const text =
					tree.phase === "loading"
						? "Loading history…"
						: `${unavailable ? "History unavailable" : "History incomplete"}${reason ? ` — ${reason}` : ""}`;
				rows.push({ key: "note:tree", line: ` ${theme.fg(unavailable ? "error" : "warning", text)}` });
			}
			for (const run of runs) {
				const status = RUN_STATUS[run.status];
				const name = run.agent ? theme.fg(status.color, run.agent) : theme.fg("dim", "unknown agent");
				rows.push({
					key: headerKey(run),
					runKey: run.runKey,
					line: ` ${theme.fg("accent", `#${run.ordinal}`)} ${name}${theme.fg("muted", " · ")}${theme.fg(status.color, `${status.glyph} ${status.label}`)}`,
				});
				if (run.history !== "ready") {
					const reason = sanitizeText(run.historyReason, REASON_MAX);
					const label =
						reason ||
						(run.history === "loading"
							? "reading child session"
							: run.history === "unavailable"
								? "child session unavailable"
								: "child history incomplete");
					rows.push({
						key: `run:${run.runKey}:history`,
						runKey: run.runKey,
						line: `   ${theme.fg("dim", `history: ${label} (${run.history})`)}`,
					});
				}
				for (const action of run.actions) {
					const state = ACTION_STATUS[action.status];
					const suffix = state.label ? theme.fg(state.color, ` · ${state.label}`) : "";
					rows.push({
						key: actionKey(run, action.toolCallId),
						runKey: run.runKey,
						order: action.startOrder,
						line: `    ${theme.fg(state.color, state.glyph)} ${theme.fg("text", action.toolName)}  ${theme.fg("muted", action.purpose)}${suffix}`,
					});
				}
			}
		}
		tree.docKey = key;
		tree.docRows = rows;
		tree.docLines = rows.map((row) => row.line);
		return rows;
	}

	/** The single empty-state row: never `No subagents` before a clean read. */
	private emptyText(tree: SessionTree, theme: Theme): string {
		if (tree.phase === "loading") return theme.fg("warning", "Loading history…");
		const reason = sanitizeText(tree.phaseReason, REASON_MAX);
		if (tree.phase === "unavailable") {
			return theme.fg("error", `History unavailable${reason ? ` — ${reason}` : ""}`);
		}
		if (tree.phase === "partial") {
			return theme.fg("warning", `History incomplete${reason ? ` — ${reason}` : ""}`);
		}
		return theme.fg("dim", "No subagents");
	}

	// ── viewport internals ──

	private syncViewport(tree: SessionTree, rows: DocRow[]): void {
		if (tree.follow) {
			const reveal = tree.lastActivityKey;
			const index = reveal ? rows.findIndex((row) => row.key === reveal) : -1;
			// Live reveals the newest activity, even when it belongs to an older
			// group; groups themselves are never reordered.
			if (index >= 0) tree.scroll.setScrollOffset(index - Math.max(0, tree.bodyHeight - 1));
			else tree.scroll.scrollToBottom();
			return;
		}
		const anchor = tree.viewport;
		if (!anchor) return;
		let index = rows.findIndex((row) => row.key === anchor.key);
		if (index < 0 && anchor.runKey !== undefined) {
			// The anchored row disappeared (evicted action): fall back to the next
			// surviving row of the same run, then to its header — never to another
			// run's newer activity.
			const order = anchor.order ?? 0;
			const sameRun = rows.filter((row) => row.runKey === anchor.runKey);
			const fallback = sameRun.find((row) => (row.order ?? -1) >= order) ?? sameRun[0];
			index = fallback ? rows.indexOf(fallback) : -1;
		}
		if (index >= 0) tree.scroll.setScrollOffset(index - anchor.offset);
	}

	private captureAnchor(tree: SessionTree): Anchor | undefined {
		const offset = tree.scroll.getScrollOffset();
		const row = tree.docRows[offset];
		if (!row) return undefined;
		return { key: row.key, offset: 0, runKey: row.runKey, order: row.order };
	}

	// ── frame ──

	private headerLine(tree: SessionTree, theme: Theme, width: number): string {
		const inner = Math.max(1, width - 2);
		const state = tree.follow ? theme.fg("success", " Live ") : theme.fg("warning", " Paused ");
		const total = tree.runs.length;
		const meta = theme.fg("muted", ` ${total} ${total === 1 ? "run" : "runs"} `);
		const label = truncateToWidth(`${theme.fg("accent", " Subagents ")}${state}${meta}`, inner);
		const fill = theme.fg("border", "─".repeat(Math.max(0, inner - visibleWidth(label))));
		return theme.fg("border", "╭") + label + fill + theme.fg("border", "╮");
	}

	private hintLine(tree: SessionTree, theme: Theme, width: number): string {
		const state = tree.follow ? "Live" : "Paused";
		return truncateToWidth(
			theme.fg("dim", ` ${state} · /split-subagents up | down | live `),
			Math.max(1, width),
		);
	}

	private bottomLine(theme: Theme, width: number): string {
		return theme.fg("border", `╰${"─".repeat(Math.max(0, width - 2))}╯`);
	}
}
