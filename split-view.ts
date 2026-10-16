/**
 * Split-view for OMP. A native fullscreen overlay owns panel geometry while
 * retaining the live host transcript, editor, status and dialog components.
 * Closing the view returns to OMP's untouched normal-screen history provider.
 * Recent thinking/tool buffers are bounded; response-only history is text-only.
 */

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { textContent } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import {
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task";
import {
	Container,
	ScrollView,
	Spacer,
	wrapTextWithAnsi,
	truncateToWidth,
	visibleWidth,
	matchesKey,
} from "@oh-my-pi/pi-tui";
import type { TUI } from "@oh-my-pi/pi-tui";
import {
	loadUiPanelsConfig,
	saveUiPanelsConfig,
	normalizeConfig,
	type ToolMode as ToolModeCfg,
} from "./ui-panels-config.ts";
import { SUBAGENT_SNAPSHOT_TYPE, SubagentsPanel } from "./subagents-panel.ts";
import { FilesActivity } from "./files-activity.ts";
import { fieldBag, themeFingerprint } from "./panel-utils.ts";
import {
	getNativeRegions,
	initLayoutManager,
	setLayoutLayer,
	isLayoutLayerActive,
	resetLayoutManager,
} from "./layout-manager.ts";

const WIDGET_KEY = "split-view";
const MAX_TOOLS = 60;
// Display window (logical lines) for the thinking panel. The full transcript
// keeps everything; the band is a recent-history view. Must stay small: the
// per-flush render cost is dominated by wrapping the visible window.
const MAX_LINES = 400;
// A newline-free streaming tail grows char by char; every flush re-wraps it
// (its key changes each time). Render only its recent suffix so per-flush
// work is bounded even for one giant paragraph.
const MAX_TAIL_CHARS = 2000;
const MIN_TERM_WIDTH = 90;
const MAX_TOOL_OUTPUT_LINES = 20;
// OracleSpec body window: hard cap on FINAL VISUAL rows rendered by band
// panels (logical lines can wrap into many). ~2 viewports of scrollback.
const MAX_BODY_ROWS = 96;
// Hard cap on raw chars processed per logical line (giant-line guard).
const MAX_LINE_CHARS = 600;


// ─── module-lifetime state ───────────────────────────────────────────────────

let tuiRef: TUI | undefined;
let widgetSet = false;
let termHeight = 0;
let panelNotice: { text: string; type: "info" | "warning" | "error" } | undefined;

/** Keep command feedback visible when the native notification transcript is hidden. */
function notify(ctx: ExtensionContext, text: string, type: "info" | "warning" | "error"): void {
	currentContext = ctx;
	ctx.ui.notify(text, type);
	panelNotice = trimResponse && ctx.mode === "tui" ? { text, type } : undefined;
	requestRender();
}

// Panel enable flags (kept in sync with config; thinking/tools default true).
let thinkingOn = true;
let toolsOn = true;
let filesOn = false;
let subagentsOn = false;
let toolMode: ToolModeCfg = "compact";
/** Panel C: response-only view instead of pi's transcript (persisted). */
let trimResponse = false;
/** Top band height in rows (6–40, persisted; /split-height). */
let bandHeight = 14;
/** F: tools panel's share of the band width in percent (20–60, default 35,
 * persisted as toolsWidthPct; session-local, only /split-save writes it). */
let toolsWidthPct = 35;

const SPLIT_THEME_COLORS = [
	"border", "accent", "muted", "thinkingText", "toolOutput",
	"success", "error", "warning", "dim", "text",
] as const;

// ─── thinking buffer ─────────────────────────────────────────────────────────

interface ThinkingBlock {
	lines: string[];
	tail: string;
	complete: boolean;
}

/**
 * Coalesce streaming appends: each token bumps `version`, which invalidates the
 * panel's (version, width) render cache → full re-wrap of all lines per frame.
 * During a stream we bump at most every THINK_RAF_MS instead, so keystroke
 * frames don't queue behind 5000-line re-wraps. Complete blocks + end() are
 * unaffected (they bump synchronously).
 */
const THINK_RAF_MS = 100;
let thinkFlushTimer: ReturnType<typeof setTimeout> | null = null;
let thinkDirty = false;

function flushThinking(): void {
	thinkFlushTimer = null;
	if (!thinkDirty) return;
	thinkDirty = false;
	thinking.version++;
	requestRender();
}

function cancelPendingThinkFlush(): void {
	thinkDirty = false;
	if (thinkFlushTimer) {
		clearTimeout(thinkFlushTimer);
		thinkFlushTimer = null;
	}
}

/**
 * Tools-side twin of the thinking flush: tool_execution_update can fire many
 * times per second while a command streams output; each bump would re-wrap
 * the tools window + repaint. Coalesce to ≤1 version bump per TOOLS_FLUSH_MS.
 * start/end stay synchronous (entry appears / finalizes immediately).
 */
const TOOLS_FLUSH_MS = 100;
let toolsFlushTimer: ReturnType<typeof setTimeout> | null = null;
let toolsDirty = false;

function flushTools(): void {
	toolsFlushTimer = null;
	if (!toolsDirty) return;
	toolsDirty = false;
	toolsVersionCounter++;
	requestRender();
}

function cancelPendingToolsFlush(): void {
	toolsDirty = false;
	if (toolsFlushTimer) {
		clearTimeout(toolsFlushTimer);
		toolsFlushTimer = null;
	}
}

function markToolsDirty(): void {
	toolsDirty = true;
	if (!toolsFlushTimer) toolsFlushTimer = setTimeout(flushTools, TOOLS_FLUSH_MS);
}

const thinking = {
	blocks: [] as ThinkingBlock[],
	current: null as ThinkingBlock | null,
	streaming: false,
	version: 0,
	start() {
		if (this.current && (this.current.lines.length || this.current.tail)) {
			this.current.complete = true;
			this.blocks.push(this.current);
		}
		this.current = { lines: [], tail: "", complete: false };
		this.streaming = true;
		this.version++;
	},
	append(delta: string) {
		if (!this.current) this.current = { lines: [], tail: "", complete: false };
		this.current.tail += delta;
		if (this.current.tail.length > MAX_TAIL_CHARS)
			this.current.tail = this.current.tail.slice(-MAX_TAIL_CHARS);
		let nl = this.current.tail.indexOf("\n");
		while (nl !== -1) {
			this.current.lines.push(this.current.tail.slice(0, nl));
			this.current.tail = this.current.tail.slice(nl + 1);
			nl = this.current.tail.indexOf("\n");
		}
		this.trim();
		thinkDirty = true;
		if (!thinkFlushTimer)
			thinkFlushTimer = setTimeout(flushThinking, THINK_RAF_MS);
	},
	end(text: string) {
		cancelPendingThinkFlush();
		if (this.current) {
			if (text) {
				// Authoritative final content: replace the accumulated buffer.
				this.current.lines = text.split(/\r?\n/);
				this.current.tail = "";
			} else if (this.current.tail) {
				// SV-21: an empty/omitted end payload must not wipe streamed
				// text — finalize the accumulated tail into the current block.
				this.current.lines.push(this.current.tail);
				this.current.tail = "";
			}
			this.current.complete = true;
			this.blocks.push(this.current);
			this.current = null;
			this.trim();
		}
		this.streaming = false;
		this.version++;
	},
	trim() {
		// Hard-bound the whole display buffer (oldest lines first, splicing
		// partially into the front/current block so a giant block trims instead
		// of vanishing). The old version only evicted whole completed blocks, so
		// an oversized current block or reconstruct() output could blow past
		// MAX_LINES.
		let excess = this.countLines() - MAX_LINES;
		while (excess > 0) {
			const b = this.blocks[0];
			if (!b) {
				if (this.current) {
					const cut = Math.min(excess, this.current.lines.length);
					this.current.lines.splice(0, cut);
					excess -= cut;
				}
				break;
			}
			if (b.lines.length <= excess) {
				this.blocks.shift();
				excess -= b.lines.length;
			} else {
				b.lines.splice(0, excess);
				excess = 0;
			}
		}
	},
	countLines() {
		let total = 0;
		for (const b of this.blocks) total += b.lines.length;
		if (this.current) total += this.current.lines.length;
		return total;
	},
	reset() {
		cancelPendingThinkFlush();
		this.blocks = [];
		this.current = null;
		this.streaming = false;
		this.version++;
	},
};

function thinkingLines(theme: Theme, width: number): string[] {
	const out: string[] = [];
	const sep = theme.fg("dim", "─".repeat(Math.max(8, Math.min(60, width - 3))));
	for (const b of thinking.blocks) {
		if (out.length) out.push("");
		out.push(sep);
		for (const l of b.lines) out.push(l);
	}
	if (thinking.current) {
		if (out.length) out.push("");
		for (const l of thinking.current.lines) out.push(l);
		if (thinking.current.tail) out.push(thinking.current.tail);
	}
	return out;
}

// ─── response doc (panel C trim mode) ───────────────────────────────

/**
 * Panel C's document: user + assistant messages only, rendered with the
 * transcript's own components (native contracts, native themes). Built from
 * the branch (session start / tree) and streamed live (message_start/update/end).
 *
 * Assistant messages are handed over verbatim: the native
 * AssistantMessageComponent renders text blocks in order, renders NOTHING for
 * `toolCall` blocks (tool components own those — panel B), and hides thinking
 * blocks through its own `hideThinkingBlock` flag (panel A owns those). So no
 * content filtering is needed; only an assistant turn with no text at all is
 * skipped, so tool-only / thinking-only rounds add no stray spacer.
 */
const responseDoc = new Container();
let streamingResponseComponent: AssistantMessageComponent | null = null;

/** Native assistant-message shape, derived from the component's own signature. */
type ResponseAssistantMessage = NonNullable<ConstructorParameters<typeof AssistantMessageComponent>[0]>;
/** Native user-message fields the response doc consumes. */
interface ResponseUserMessage {
	content: Parameters<typeof textContent>[0];
	liveSteered?: boolean;
	timestamp?: number;
}

/**
 * The response doc's assistant component: native, thinking hidden (panel A owns
 * it) and images off (panel C is text-only, so nothing but text rows render).
 */
function createResponseAssistantComponent(
	msg?: ResponseAssistantMessage,
): AssistantMessageComponent {
	// Disable images before the first content pass to avoid conversion work.
	const component = new AssistantMessageComponent(undefined, true, requestRender);
	component.setImagesVisible(false);
	component.setToolResultImagesVisible(false);
	if (msg) component.updateContent(msg);
	return component;
}

/** Append a user message (text only — an image-only turn renders nothing). */
function addResponseUser(msg: ResponseUserMessage): void {
	const text = textContent(msg.content);
	if (!text.trim()) return;
	if (responseDoc.children.length > 0) responseDoc.addChild(new Spacer(1));
	responseDoc.addChild(
		new UserMessageComponent(text, {
			liveSteered: msg.liveSteered === true,
			timestamp: msg.timestamp,
		}),
	);
}

/** Append an assistant message (text only: thinking, tools and images excluded). */
function addResponseAssistant(msg: ResponseAssistantMessage): void {
	const hasText = msg.content.some(c => c.type === "text" && c.text.trim().length > 0);
	// Keep error/abort turns: the component renders their stopReason marker.
	if (!hasText && msg.stopReason !== "error" && msg.stopReason !== "aborted") return;
	if (responseDoc.children.length > 0) responseDoc.addChild(new Spacer(1));
	responseDoc.addChild(createResponseAssistantComponent(msg));
}

/** Rebuild the whole response doc from the current branch. */
function rebuildResponseDoc(ctx: ExtensionContext): void {
	// A branch change preserves numeric position, even when the old doc was at tail.
	if (responseDocInitialized && responseScrollView) {
		responseScrollView.setFollowTail(false);
		preserveResponsePosition = true;
	}
	responseDoc.clear();
	streamingResponseComponent = null;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg.role === "user") addResponseUser(msg);
		else if (msg.role === "assistant") addResponseAssistant(msg);
	}
	responseDocInitialized = true;
}

/** Live-stream an assistant message into the doc (lazy: created on first visible text). */
function responseMessageUpdate(msg: ResponseAssistantMessage): void {
	if (!streamingResponseComponent) {
		// Pure tool-call / thinking rounds never create a component — no stray
		// spacers accumulate in the doc.
		if (!msg.content.some(c => c.type === "text" && c.text.trim().length > 0)) return;
		if (responseDoc.children.length > 0) responseDoc.addChild(new Spacer(1));
		const component = createResponseAssistantComponent();
		streamingResponseComponent = component;
		responseDoc.addChild(component);
	}
	streamingResponseComponent.updateContent(msg, { transient: true });
}

function responseMessageEnd(msg: ResponseAssistantMessage): void {
	if (streamingResponseComponent) {
		streamingResponseComponent.updateContent(msg);
		streamingResponseComponent = null;
	} else {
		// No component was streamed (no update fired, or thinking/tool-only
		// round): finalize from the full message — addResponseAssistant skips
		// text-less rounds and keeps error/abort markers.
		addResponseAssistant(msg);
	}
}

// ─── tool buffer ─────────────────────────────────────────────────────────────

let toolsVersionCounter = 0;

interface ToolEntry {
	id: string;
	name: string;
	args: string;
	output: string;
	active: boolean;
	isError: boolean;
	subagent?: boolean;
	agent?: string;
}
const toolsBy = new Map<string, ToolEntry>();
const toolOrder: string[] = [];

/** True if c is a UTF-16 high (lead) surrogate — the first half of an astral
 * code point. Used to keep truncation cuts off surrogate-pair boundaries. */
function isHighSurrogate(c: number): boolean {
	return c >= 0xd800 && c <= 0xdbff;
}

function truncateInline(s: string, max = 40): string {
	const flat = s.replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	let end = max - 1;
	// Never end mid surrogate pair (a lone trailing half renders as U+FFFD).
	if (end >= 1 && isHighSurrogate(flat.charCodeAt(end - 1))) end--;
	return flat.slice(0, end) + "…";
}

/** SV-16: storage cap for one tool's text (args JSON or result output), in
 * UTF-16 code units (≈ in-memory size of the stored string). Below pi's own
 * bash-output cap (50KB) so even maximal tool output is bounded here, and
 * ~2.7× the maximum displayed content (20 lines × 600 chars). */
const MAX_TOOL_TEXT_CHARS = 32 * 1024;

/** SV-16: bound one tool text to MAX_TOOL_TEXT_CHARS, keeping the NEWEST
 * suffix and prepending an explicit truncation marker. The cut is aligned to
 * a code point so a UTF-16 surrogate pair is never split. Text within the
 * cap passes through unchanged (byte-identical). */
function capToolText(s: string): string {
	if (s.length <= MAX_TOOL_TEXT_CHARS) return s;
	const total = s.length;
	const marker = `[truncated: newest ${MAX_TOOL_TEXT_CHARS} of ${total} chars]\n`;
	const budget = MAX_TOOL_TEXT_CHARS - marker.length;
	let end = s.length;
	let units = 0;
	while (end > 0 && units < budget) {
		// Width of the code point ENDING at `end`: an astral char occupies
		// end-2..end-1 (lead surrogate at end-2), so a pair is never split.
		const w = end >= 2 && isHighSurrogate(s.charCodeAt(end - 2)) ? 2 : 1;
		if (units + w > budget) break;
		units += w;
		end -= w;
	}
	return marker + s.slice(end);
}

/** SV-16: text of a tool result payload — a plain string, or the text blocks of
 * a native `AgentToolResult` / `ToolResultMessage` content array. */
function resultText(result: unknown): string {
	const payload =
		typeof result === "object" && result !== null && "content" in result
			? result.content
			: result;
	if (typeof payload === "string") return capToolText(payload);
	if (!Array.isArray(payload)) return "";
	const blocks: unknown[] = payload;
	let text = "";
	for (const block of blocks) {
		if (!block || typeof block !== "object") continue;
		if (!("type" in block) || block.type !== "text") continue;
		if ("text" in block && typeof block.text === "string") text += block.text;
	}
	// SV-16: bound the stored text before the caller splits/keeps lines.
	return capToolText(text);
}

function argsJson(args: unknown): string {
	try {
		// SV-16: bound the stored args JSON (newest suffix + marker).
		return capToolText(JSON.stringify(args ?? {}));
	} catch {
		return "";
	}
}

function setToolOutput(e: ToolEntry, text: string): void {
	// SV-16: cap BEFORE splitting so the split never sees unbounded text.
	const lines = capToolText(text).split(/\r?\n/);
	e.output = lines.slice(-MAX_TOOL_OUTPUT_LINES).join("\n");
}

/** SV-17: ingest one tool call through the SAME path for live events and
 * branch reconstruction (resume / session_tree), so the bounded buffer,
 * the newest-first display and the MAX_TOOLS eviction (oldest shifted out)
 * behave identically for resumed and live entries. */
function ingestToolCall(id: string, name: string, args: unknown): void {
	toolOrder.push(id);
	toolsBy.set(id, {
		id,
		name,
		args: argsJson(args),
		output: "",
		active: true,
		isError: false,
	});
	toolsVersionCounter++;
	if (toolOrder.length > MAX_TOOLS) {
		const evict = toolOrder.shift()!;
		toolsBy.delete(evict);
	}
}

/** SV-17: ingest one tool result, correlated to its call by id (live event
 * or resumed branch entry). A result whose call is not in the bounded buffer
 * (evicted or unknown) is ignored. */
function ingestToolResult(id: string, result: unknown, isError: boolean): void {
	const e = toolsBy.get(id);
	if (!e) return;
	const text = resultText(result);
	if (text) setToolOutput(e, text);
	e.active = false;
	e.isError = isError;
	cancelPendingToolsFlush();
	toolsVersionCounter++;
}

function toolLines(theme: Theme, width: number): string[] {
	const th = theme;
	const out: string[] = [];
	const full = toolMode === "full";
	// Text budget inside the frame: 1 col inset + ≥2 trailing pad cols
	// (the transient scrollbar paints over the pad, never the frame).
	const textWidth = Math.max(8, width - 3);
	for (const id of toolOrder) {
		const e = toolsBy.get(id);
		if (!e) continue;
		const mark = e.active
			? th.fg("warning", "●")
			: e.isError
				? th.fg("error", "✗")
				: th.fg("success", "✓");
		const name = e.active
			? th.fg("accent", e.name)
			: e.isError
				? th.fg("error", e.name)
				: th.fg("success", e.name);
		const badge = e.subagent ? th.fg("muted", `[${e.agent ?? "sub"}]`) : "";
		const prefix = `${mark} ${name}${badge}`;
		const room = textWidth - visibleWidth(prefix) - 1;
		const args =
			e.args && room >= 8
				? th.fg("muted", ` ${truncateInline(e.args, room)}`)
				: "";
		out.push(prefix + args);
		if (!full) {
			if (out.length > 1) out.splice(out.length - 1, 0, "");
			continue;
		}
		const content = (e.output || "")
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter(Boolean);
		if (content.length === 0) {
			if (e.active) out.push(th.fg("dim", "  · …"));
		} else {
			for (const l of content.slice(0, 2))
				out.push(th.fg("toolOutput", `  · ${truncateInline(l, textWidth - 4)}`));
			if (content.length > 2)
				out.push(th.fg("dim", `  · +${content.length - 2} more`));
		}
	}
	return out;
}

const toolsVersion = () => toolsVersionCounter;

let filesActivity: FilesActivity;

// ─── shared helpers ──────────────────────────────────────────────────────────

function requestRender(): void {
	try {
		tuiRef?.requestRender?.();
	} catch {
		/* ignore */
	}
}

const anyPanelActive = () => isLayoutLayerActive();
const panelsActive = () => thinkingOn || toolsOn || filesOn || subagentsOn || trimResponse;

// ─── framed panel components ─────────────────────────────────────────────────

class BorderTop {
	constructor(
		private theme: Theme,
		private title: string,
		private color: "accent" | "muted",
		private streaming: () => boolean,
	) {}
	render(width: number): string[] {
		const th = this.theme;
		const contentWidth = Math.max(1, width - 2);
		const title = th.fg(this.color, ` ${this.title} `);
		const dot = this.streaming() ? th.fg("warning", "●") : "";
		const label = truncateToWidth(title + dot, contentWidth);
		const fill = th.fg(
			"border",
			"─".repeat(Math.max(0, contentWidth - visibleWidth(label))),
		);
		return [th.fg("border", "╭") + label + fill + th.fg("border", "╮")];
	}
	invalidate(): void {}
	dispose(): void {}
}

class BorderBottom {
	constructor(private theme: Theme) {}
	render(width: number): string[] {
		return [
			this.theme.fg("border", "╰") +
				this.theme.fg("border", "─".repeat(Math.max(0, width - 2))) +
				this.theme.fg("border", "╯"),
		];
	}
	invalidate(): void {}
	dispose(): void {}
}


/**
 * OracleSpec body: renders the recent window with a left │ edge only — the
 * ScrollView's always-on scrollbar column is the right frame edge (track
 * styled as border, so the frame reads as complete; thumb slides when
 * overflowing). Pads every row to EXACT width and always emits at least
 * `minRows` rows so the left edge is continuous when content is short. No
 * per-line memo: the window is small, a (version, width) cache suffices.
 */
class RecentBody {
	private cacheVersion = -1;
	private cacheMinRows = -1;
	/** SV-19: bounded width cache — keep the current width plus a small LRU of
	 * recent widths so resize cycling cannot grow it unbounded. */
	private cacheByWidth = new Map<number, string[]>();
	private static readonly MAX_CACHED_WIDTHS = 4;
	constructor(
		private theme: Theme,
		private style: (line: string) => string,
		private lines: (width: number) => string[],
		private version: () => number,
		private empty: string,
		/** Rows to guarantee so the left edge has no gaps (viewport height). */
		private minRows: () => number,
	) {}
	render(width: number): string[] {
		const th = this.theme;
		const v = this.version();
		const min = Math.max(1, this.minRows());
		if (v !== this.cacheVersion || min !== this.cacheMinRows) {
			this.cacheVersion = v;
			this.cacheMinRows = min;
			this.cacheByWidth.clear();
		}
		const cached = this.cacheByWidth.get(width);
		if (cached) {
			// SV-19: refresh recency so eviction is genuinely LRU, not FIFO —
			// delete+set moves this width to the Map's newest position.
			this.cacheByWidth.delete(width);
			this.cacheByWidth.set(width, cached);
			return cached;
		}
		const edge = th.fg("border", "│");
		const pad = (s: string) =>
			" ".repeat(Math.max(0, width - 1 - visibleWidth(s)));
		// Wrap newest-first, keep only the newest MAX_BODY_ROWS visual rows;
		// giant logical lines are suffix-capped before wrapping.
		// SV-03/SV-04: fragments of ONE source line are wrapped as a group and
		// the group is inserted in order (an individual unshift reversed the
		// fragments of one line); the MAX_BODY_ROWS cap counts VISUAL rows, not
		// source lines, so one long line cannot blow past the cap at narrow
		// widths. A group that would straddle the cap is skipped whole (no
		// fragment is ever split); the newest groups always fit. A single group
		// larger than the whole cap keeps only its newest fragments.
		const src = this.lines(width);
		const groups: string[][] = [];
		let used = 0;
		for (let i = src.length - 1; i >= 0; i--) {
			const line =
				src[i].length > MAX_LINE_CHARS
					? "… " + src[i].slice(-MAX_LINE_CHARS + 1)
					: src[i];
			const frags = wrapTextWithAnsi(
				this.style(line),
				Math.max(1, width - 3),
			).map((w: string) => " " + w);
			if (used + frags.length > MAX_BODY_ROWS) {
				if (groups.length === 0 && frags.length > MAX_BODY_ROWS)
					groups.push(frags.slice(frags.length - MAX_BODY_ROWS));
				break;
			}
			groups.push(frags);
			used += frags.length;
		}
		const rows: string[] = [];
		for (let g = groups.length - 1; g >= 0; g--)
			for (const f of groups[g]) rows.push(f);
		let out: string[];
		if (rows.length === 0) {
			const empty = " " + th.fg("dim", this.empty);
			out = [edge + empty + pad(empty)];
		} else {
			out = rows.map((r) => edge + r + pad(r));
		}
		// Guarantee a continuous left edge: fill short content up to minRows.
		const filler = edge + " ".repeat(Math.max(0, width - 1));
		while (out.length < min) out.push(filler);
		this.cacheByWidth.set(width, out);
		// SV-19: bound the number of cached widths (Map preserves insertion
		// order; hits refresh recency above, so the first key is least-recent
		// and eviction is true LRU).
		while (this.cacheByWidth.size > RecentBody.MAX_CACHED_WIDTHS) {
			const oldest = this.cacheByWidth.keys().next().value as number;
			this.cacheByWidth.delete(oldest);
		}
		return out;
	}
	invalidate(): void {
		this.cacheVersion = -1;
		this.cacheByWidth.clear();
	}
	dispose(): void {}
}

// ─── native OMP frame composition ─────────────────────────────────────────────

let responseScrollView: ScrollView | null = null;
let responseDocInitialized = false;
let preserveResponsePosition = false;
let responseTheme: Theme | undefined;
const transcriptScrollView = new ScrollView({
	render: width => getNativeRegions()?.transcript.render(width) ?? [],
}, { height: 1, followTail: true });
let currentContext: ExtensionContext | undefined;
let subagentsPanel: SubagentsPanel | undefined;

/** Allocate geometry once per frame; never replace OMP's history provider. */
function reconcileLayout(theme: Theme): void {
	if (!tuiRef || !panelsActive()) {
		setLayoutLayer(null);
		return;
	}
	let panelFingerprint = "";
	let thinkingPanel: ScrollView;
	let toolPanel: ScrollView;
	let bodyRows = 1;
	responseScrollView ??= new ScrollView(responseDoc, { height: 1, followTail: true });
	setLayoutLayer((width, height) => {
		const liveTheme = currentContext?.ui.theme ?? theme;
		if (liveTheme !== responseTheme) {
			responseTheme = liveTheme;
			responseDoc.invalidate();
		}
		const fingerprint = themeFingerprint(liveTheme, SPLIT_THEME_COLORS);
		if (fingerprint !== panelFingerprint) {
			panelFingerprint = fingerprint;
			const options = {
				height: 1,
				followTail: true,
				scrollbar: "always" as const,
				theme: {
					track: (text: string) => liveTheme.fg("border", text),
					thumb: (text: string) => liveTheme.fg("accent", text),
				},
			};
			thinkingPanel = new ScrollView(new RecentBody(
				liveTheme, line => liveTheme.fg("thinkingText", line),
				w => thinkingLines(liveTheme, w), () => thinking.version,
				"Thinking idle", () => bodyRows,
			), options);
			toolPanel = new ScrollView(new RecentBody(
				liveTheme, line => line, w => toolLines(liveTheme, w),
				toolsVersion, "No tools called yet", () => bodyRows,
			), options);
		}
		termHeight = height;
		const dockWidth = (filesOn || subagentsOn) && width >= MIN_TERM_WIDTH
			? Math.max(34, Math.min(48, Math.floor(width * 0.25))) : 0;
		const mainWidth = Math.max(1, width - dockWidth);
		const dock: string[] = [];
		for (const root of getNativeRegions()?.dock ?? []) dock.push(...root.render(mainWidth));
		const bandRows = thinkingOn || toolsOn
			? Math.min(bandHeight, Math.max(0, height - dock.length - 3)) : 0;
		bodyRows = Math.max(0, bandRows - 2);
		const frame: string[] = [];
		const fit = (line: string, cols: number) => {
			const clipped = truncateToWidth(line, cols, "");
			return clipped + "\x1b[0m" + " ".repeat(Math.max(0, cols - visibleWidth(clipped)));
		};
		const panel = (scroll: ScrollView, cols: number, title: string, active: () => boolean) => {
			scroll.setHeight(bodyRows);
			return [
				...new BorderTop(liveTheme, title, "accent", active).render(cols),
				...scroll.render(cols),
				...new BorderBottom(liveTheme).render(cols),
			];
		};
		if (bandRows >= 3) {
			if (thinkingOn && toolsOn && mainWidth >= 4) {
				let toolsWidth = Math.round(mainWidth * toolsWidthPct / 100);
				if (mainWidth >= 44) toolsWidth = Math.max(20, Math.min(mainWidth - 24, toolsWidth));
				toolsWidth = Math.max(2, Math.min(mainWidth - 2, toolsWidth));
				const thinkingWidth = mainWidth - toolsWidth;
				const left = panel(thinkingPanel!, thinkingWidth, "Thinking", () => thinking.streaming);
				const right = panel(toolPanel!, toolsWidth, "Tool Usage",
					() => toolOrder.some(id => toolsBy.get(id)?.active));
				for (let row = 0; row < bandRows; row++)
					frame.push(fit(left[row] ?? "", thinkingWidth) + fit(right[row] ?? "", toolsWidth));
			} else {
				frame.push(...panel(
					thinkingOn ? thinkingPanel! : toolPanel!, mainWidth,
					thinkingOn ? "Thinking" : "Tool Usage",
					() => thinkingOn ? thinking.streaming : toolOrder.some(id => toolsBy.get(id)?.active),
				));
			}
		}
		const chatHeight = Math.max(0, height - frame.length - dock.length);
		const scroll = trimResponse ? responseScrollView! : transcriptScrollView;
		scroll.setHeight(chatHeight);
		frame.push(...scroll.render(mainWidth), ...dock);
		if (trimResponse && preserveResponsePosition) {
			responseScrollView!.setFollowTail(true);
			preserveResponsePosition = false;
		}
		const visible = frame.slice(-height);
		while (visible.length < height) visible.push("");
		if (dockWidth) {
			let subagentRows = 0;
			let fileRows = 0;
			if (subagentsOn && filesOn) {
				subagentRows = height >= 12
					? Math.max(4, Math.min(Math.floor(height / 2), height - 8))
					: Math.min(4, height);
				fileRows = height - subagentRows;
			} else if (subagentsOn) subagentRows = height;
			else if (filesOn) fileRows = height;
			const right: string[] = [];
			if (subagentRows > 0) right.push(...subagentsPanel!.render(liveTheme, dockWidth, subagentRows));
			if (fileRows > 0) right.push(...filesActivity.render(liveTheme, dockWidth, fileRows, currentContext?.cwd ?? process.cwd()));
			return visible.map((line, row) => fit(line, mainWidth) + fit(right[row] ?? "", dockWidth));
		}
		return visible;
	});
}
// ─── wiring ──────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	filesActivity = new FilesActivity();
	subagentsPanel = new SubagentsPanel(
		(parentSessionId, data) => {
			if (currentContext?.sessionManager.getSessionId() !== parentSessionId)
				return false;
			pi.appendEntry(SUBAGENT_SNAPSHOT_TYPE, data);
			return true;
		},
		requestRender,
		argsJson,
	);
	pi.registerFlag("no-split", {
		description: "Start bare: skip the split-view panels (thinking/tools/files)",
		type: "boolean",
		default: false,
	});

	const ensureWidget = (ctx: ExtensionContext) => {
		currentContext = ctx;
		if (ctx.mode !== "tui" || widgetSet) return;
		widgetSet = true;
		const unsubscribe = ctx.ui.onTerminalInput(data => {
			if (!isLayoutLayerActive() ||
				tuiRef?.overlayStack.at(-1)?.component.debugKind !== "split-view") return;
			if (!matchesKey(data, "pageUp") && !matchesKey(data, "pageDown")) return;
			const scroll = trimResponse ? responseScrollView : transcriptScrollView;
			if (!scroll?.handleScrollKey(data)) return;
			requestRender();
			return { consume: true };
		});
		ctx.ui.setWidget(WIDGET_KEY, tui => {
			tuiRef = tui;
			initLayoutManager(tui);
			reconcileLayout(ctx.ui.theme);
			return {
				render: width => {
					if (!panelsActive()) return [];
					const lines = filesActivity.summary(ctx.ui.theme, width);
					if (trimResponse && panelNotice) lines.push(truncateToWidth(
						ctx.ui.theme.fg(panelNotice.type === "info" ? "muted" : panelNotice.type, panelNotice.text),
						width,
					));
					return lines;
				},
				dispose: () => {
					unsubscribe();
					panelNotice = undefined;
					resetLayoutManager();
					widgetSet = false;
				},
			};
		}, { placement: "belowEditor" });
	};

	/** Rebuild all buffers from the current branch (start / reload / switch /
	 * branch / tree). */
	const reconstruct = (ctx: ExtensionContext) => {
		// Newest context first: the widget factory and the layout layer read
		// `currentContext` for the live theme the moment either first renders.
		currentContext = ctx;
		void subagentsPanel!.activate(ctx);
		ensureWidget(ctx);
		thinking.reset();
		toolsBy.clear();
		toolOrder.length = 0;
		toolsVersionCounter++;
		const branch = ctx.sessionManager.getBranch();
		filesActivity.rebuild(branch, ctx.cwd);
		rebuildResponseDoc(ctx);

		const thoughts: string[] = [];
		for (const entry of branch) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role === "assistant") {
				for (const c of msg.content) {
					if (c.type === "thinking") thoughts.push(c.thinking);
					if (c.type !== "toolCall" || !c.name) continue;
					try {
						// SV-17: rebuild the bounded tools buffer from the
						// branch through the same ingest path live events use.
						ingestToolCall(c.id, c.name, c.arguments);
					} catch {
						/* skip */
					}
				}
				continue;
			}
			if (msg.role !== "toolResult") continue;
			// SV-17: rebuild tool outputs from persisted results, correlated
			// to their calls by toolCallId.
			try {
				ingestToolResult(msg.toolCallId, msg.content, msg.isError);
			} catch {
				/* skip */
			}
		}
		if (thoughts.length) {
			for (const t of thoughts) {
				thinking.current = { lines: t.split(/\r?\n/), tail: "", complete: true };
				thinking.blocks.push(thinking.current);
				thinking.current = null;
			}
			thinking.trim();
			thinking.version++;
		}
		if (anyPanelActive()) requestRender();
	};

	pi.on("session_start", (_e, ctx) => {
		let cfg = normalizeConfig(loadUiPanelsConfig());
		if (pi.getFlag("no-split")) {
			// --no-split: start bare, ignoring the saved ui-panels.json defaults.
			cfg = {
				...cfg,
				split: false,
				thinking: false,
				tools: false,
				files: false,
				subagents: false,
				trimResponse: false,
			};
		}
		thinkingOn = cfg.thinking;
		toolsOn = cfg.tools;
		toolMode = cfg.toolMode;
		bandHeight = cfg.bandHeight;
		toolsWidthPct = cfg.toolsWidthPct;
		filesOn = cfg.files;
		subagentsOn = cfg.subagents;
		trimResponse = cfg.trimResponse;
		reconstruct(ctx);
		if (ctx.mode === "tui") reconcileLayout(ctx.ui.theme);
	});
	// Subagent history spans every branch; ordinary panels keep their existing
	// branch reconstruction behavior.
	pi.on("session_switch", (_e, ctx) => reconstruct(ctx));
	pi.on("session_branch", (_e, ctx) => reconstruct(ctx));
	pi.on("session_tree", (_e, ctx) => reconstruct(ctx));

	// Thinking stream.
	pi.on("message_update", (event) => {
		const delta = event.assistantMessageEvent;
		if (delta.type === "thinking_start") thinking.start();
		else if (delta.type === "thinking_delta") thinking.append(delta.delta);
		else if (delta.type === "thinking_end") thinking.end(delta.content);
		if (event.message.role === "assistant") responseMessageUpdate(event.message);
		if (anyPanelActive()) requestRender();
	});

	// Response stream (panel C trim mode): mirror user/assistant messages into
	// the response doc. Always maintained so toggling trim mid-turn is seamless.
	// Assistant components are created lazily on first visible text (update),
	// so tool-only / thinking-only rounds add nothing to the doc.
	pi.on("message_start", (event) => {
		const msg = event.message;
		if (msg.role === "user") addResponseUser(msg);
		if (anyPanelActive()) requestRender();
	});
	pi.on("message_end", (event) => {
		const msg = event.message;
		if (msg.role === "assistant") responseMessageEnd(msg);
		if (anyPanelActive()) requestRender();
	});

	// Tool stream.
	pi.on("tool_execution_start", (event) => {
		// SV-17: same ingest path the branch rebuild uses.
		ingestToolCall(event.toolCallId, event.toolName, event.args);
		if (anyPanelActive()) requestRender();
	});
	pi.on("tool_execution_update", (event) => {
		const e = toolsBy.get(event.toolCallId);
		if (e) {
			setToolOutput(e, resultText(event.partialResult));
			markToolsDirty();
		}
		if (anyPanelActive()) requestRender();
	});
	pi.on("tool_execution_end", (event) => {
		// SV-17: same ingest path the branch rebuild uses.
		ingestToolResult(event.toolCallId, event.result, event.isError);
		if (anyPanelActive()) requestRender();
	});

	pi.on("tool_call", (event, ctx) => {
		currentContext = ctx;
		filesActivity.onToolCall(event, ctx.cwd);
		if (anyPanelActive()) requestRender();
	});
	pi.on("tool_result", (event) => {
		if (filesActivity.onToolResult(event, currentContext?.cwd ?? process.cwd()) && anyPanelActive())
			requestRender();
	});

	// Subagent activity: the native task framework publishes its frames on the
	// session event bus (`pi.events`) — one channel per child's AgentSessionEvent
	// and one for its lifecycle, whose `id` carries the agent name. (The legacy
	// `subagents:tool_call` channel does not exist in OMP.)
	const subagentAgentBy = new Map<string, string>();
	pi.events.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, (data) => {
		subagentsPanel!.onLifecycle(data);
		const bag = fieldBag(data);
		if (typeof bag.id !== "string" || typeof bag.agent !== "string") return;
		if (bag.status === "started") subagentAgentBy.set(bag.id, bag.agent);
		else subagentAgentBy.delete(bag.id);
	});
	pi.events.on(TASK_SUBAGENT_PROGRESS_CHANNEL, (data) => {
		subagentsPanel!.onProgress(data);
	});
	pi.events.on(TASK_SUBAGENT_EVENT_CHANNEL, (data) => {
		subagentsPanel!.onEvent(data);
		const bag = fieldBag(data);
		const frame = fieldBag(bag.event);
		if (typeof bag.id !== "string" || typeof frame.toolCallId !== "string") return;
		const id = `sub:${bag.id}:${frame.toolCallId}`;
		if (frame.type === "tool_execution_start" && typeof frame.toolName === "string") {
			ingestToolCall(id, frame.toolName, frame.args);
			const entry = toolsBy.get(id);
			if (entry) {
				entry.subagent = true;
				entry.agent = subagentAgentBy.get(bag.id) ?? bag.id;
			}
			filesActivity.onSubagentToolCall(frame.toolName, frame.args, currentContext?.cwd ?? process.cwd());
		} else if (frame.type === "tool_execution_update") {
			const entry = toolsBy.get(id);
			if (entry) {
				setToolOutput(entry, resultText(frame.partialResult));
				markToolsDirty();
			}
		} else if (frame.type === "tool_execution_end") {
			ingestToolResult(id, frame.result, frame.isError === true);
		} else {
			return;
		}
		if (anyPanelActive()) requestRender();
	});

	pi.on("session_shutdown", (_e, ctx) => {
		cancelPendingThinkFlush();
		cancelPendingToolsFlush();
		resetLayoutManager();
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		subagentsPanel!.dispose();
		widgetSet = false;
	});

	// ── panel toggles ──

	/** Files uses the same fullscreen owner, including a files-only layout. */
	const toggleFilesPanel = (ctx: ExtensionContext): boolean => {
		if (ctx.mode !== "tui") {
			notify(ctx, "/files requires interactive mode", "error");
			return filesOn;
		}
		filesOn = !filesOn;
		reconcileLayout(ctx.ui.theme);
		const cols = tuiRef?.terminal.columns ?? 0;
		notify(ctx,
			!filesOn ? "Files panel closed" : cols < MIN_TERM_WIDTH
				? `Files panel on — hidden below ${MIN_TERM_WIDTH} cols (now ${cols})`
				: "Files panel docked right",
			filesOn && cols < MIN_TERM_WIDTH ? "warning" : "info",
		);
		return filesOn;
	};

	pi.registerCommand("split", {
		description:
			"Toggle all panels: off = native OMP layout, on = saved startup defaults",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				notify(ctx, "/split requires interactive mode", "error");
				return;
			}
			// Full toggle pair (revised SV-01): OFF clears every panel flag so
			// pi's native layout is fully restored (no band, no files dock, no
			// trim/response-only swap). ON restores the panel flags saved as
			// startup defaults (ui-panels.json, written by /split-save); if the
			// saved layout has no panels on (or was never saved), fall back to
			// the classic default of thinking + tools. Geometry (bandHeight,
			// toolMode, toolsWidthPct) is session-local and not reset here.
			const wasOn = panelsActive();
			if (wasOn) {
				thinkingOn = false;
				toolsOn = false;
				filesOn = false;
				subagentsOn = false;
				trimResponse = false;
				reconcileLayout(ctx.ui.theme);
				notify(ctx, "Split view off (all panels)", "info");
			} else {
				const cfg = normalizeConfig(loadUiPanelsConfig());
				if (!cfg.thinking && !cfg.tools && !cfg.files && !cfg.subagents && !cfg.trimResponse) {
					thinkingOn = true;
					toolsOn = true;
				} else {
					thinkingOn = cfg.thinking;
					toolsOn = cfg.tools;
					filesOn = cfg.files;
					subagentsOn = cfg.subagents;
					trimResponse = cfg.trimResponse;
				}
				reconcileLayout(ctx.ui.theme);
				notify(ctx, "Split view on (saved layout)", "info");
			}
		},
	});

	pi.registerCommand("split-thinking", {
		description: "Toggle the thinking panel within the band",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return;
			thinkingOn = !thinkingOn;
			if (thinkingOn || toolsOn) {
				reconcileLayout(ctx.ui.theme);
				notify(ctx, `Thinking ${thinkingOn ? "on" : "off"}`, "info");
			} else {
				reconcileLayout(ctx.ui.theme);
				notify(ctx, "Band off (no panels)", "info");
			}
		},
	});

	pi.registerCommand("split-tools", {
		description: "Toggle the tools panel within the band",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return;
			toolsOn = !toolsOn;
			reconcileLayout(ctx.ui.theme);
			notify(ctx, `Tools ${toolsOn ? "on" : "off"}`, "info");
		},
	});

	pi.registerCommand("split-subagents", {
		description: "Toggle and navigate the subagents panel",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				notify(ctx, "/split-subagents requires interactive mode", "error");
				return;
			}
			const arg = String(args ?? "").trim().toLowerCase();
			if (!arg) {
				subagentsOn = !subagentsOn;
				reconcileLayout(ctx.ui.theme);
				const cols = tuiRef?.terminal.columns ?? 0;
				notify(ctx, !subagentsOn ? "Subagents panel closed" : cols < MIN_TERM_WIDTH
					? `Subagents panel on — hidden below ${MIN_TERM_WIDTH} cols (now ${cols})`
					: "Subagents panel docked right",
				subagentsOn && cols < MIN_TERM_WIDTH ? "warning" : "info");
				return;
			}
			if (arg !== "up" && arg !== "down" && arg !== "live") {
				notify(ctx, "Usage: /split-subagents [up|down|live]", "error");
				return;
			}
			subagentsPanel!.navigate(arg);
			requestRender();
		},
	});
	pi.registerCommand("files", {
		description: "Toggle the files panel (dock or overlay)",
		handler: async (_args, ctx) => {
			toggleFilesPanel(ctx);
		},
	});

	pi.registerCommand("split-tools-view", {
		description: "Toggle tool panel compact ↔ full detail",
		handler: async (_args, ctx) => {
			toolMode = toolMode === "compact" ? "full" : "compact";
			toolsVersionCounter++;
			notify(ctx, `Tool panel: ${toolMode}`, "info");
			requestRender();
		},
	});

	pi.registerCommand("split-height", {
		description: "Set the top band height in rows (6-40)",
		handler: async (args, ctx) => {
			const n = Number.parseInt(String(args ?? "").trim(), 10);
			if (Number.isNaN(n)) {
				notify(ctx,
					`Band height: ${bandHeight} rows (usage: /split-height 6-40)`,
					"info",
				);
				return;
			}
			bandHeight = Math.max(6, Math.min(40, n));
			reconcileLayout(ctx.ui.theme);
			notify(ctx, `Band height: ${bandHeight} rows`, "info");
		},
	});

	pi.registerCommand("split-tools-width", {
		description: "Set tools panel width as % of the band (20-60, default 35)",
		handler: async (args, ctx) => {
			const arg = String(args ?? "").trim();
			if (!arg) {
				notify(ctx,
					`Tools panel width: ${toolsWidthPct}% of the band (usage: /split-tools-width 20-60)`,
					"info",
				);
				return;
			}
			const n = Number.parseInt(arg, 10);
			if (Number.isNaN(n)) {
				notify(ctx,
					"Invalid percentage (usage: /split-tools-width 20-60)",
					"error",
				);
				return;
			}
			toolsWidthPct = Math.max(20, Math.min(60, n));
			reconcileLayout(ctx.ui.theme);
			notify(ctx, `Tools panel width: ${toolsWidthPct}%`, "info");
		},
	});

	pi.registerCommand("split-trim-response", {
		description:
			"Panel C: full transcript ↔ response-only (on|off) — response-only: text-only (native parity), full scrollback, scroll offset preserved on branch switch",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				notify(ctx, "/split-trim-response requires interactive mode", "error");
				return;
			}
			const arg = String(args ?? "")
				.trim()
				.toLowerCase();
			const next = arg === "on" ? true : arg === "off" ? false : !trimResponse;
			if (next && !getNativeRegions()) {
				notify(ctx, "Panel C unavailable: native transcript not ready", "error");
				return;
			}
			trimResponse = next;
			reconcileLayout(ctx.ui.theme);
			notify(ctx,
				`Panel C: ${trimResponse ? "response only" : "full transcript"}`,
				"info",
			);
		},
	});

	pi.registerCommand("split-save", {
		description: "Save current panel layout as the startup defaults",
		handler: async (_args, ctx) => {
			const saved = saveUiPanelsConfig({
				split: thinkingOn || toolsOn,
				thinking: thinkingOn,
				tools: toolsOn,
				files: filesOn,
				subagents: subagentsOn,
				toolMode,
				trimResponse,
				bandHeight,
				toolsWidthPct,
			});
			notify(ctx,
				saved
					? "Panel layout saved as startup defaults for new windows"
					: "Could not save panel layout (config write failed)",
				saved ? "info" : "error",
			);
		},
	});
}
