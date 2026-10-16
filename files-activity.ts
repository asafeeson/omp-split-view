import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { parseSel } from "@oh-my-pi/pi-coding-agent/tools/read-selector";
import { resolveToCwd } from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import { editDiffString } from "@oh-my-pi/pi-natives";
import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { renderDiff } from "@oh-my-pi/pi-tui/chrome";
import { getEditInputPaths } from "@oh-my-pi/pi-tui/tools/edit";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import { fieldBag, themeFingerprint } from "./panel-utils.ts";

const MAX_FILES = 500;
const MAX_WIDGET_NAMES = 3;
const LEGEND = "r read · w write · s seen(bash) · a subagent";
const SCHEME_URL = /^[a-z][a-z0-9+.-]*:\/\//i;
const THEME_COLORS = [
	"border", "accent", "muted", "thinkingText", "toolOutput",
	"success", "error", "warning", "dim", "text",
] as const;

type FileOp = "r" | "w" | "s" | "a";
interface FileEntry { path: string; ops: string; count: number }
interface ToolCall { toolCallId: string; toolName: string; input: unknown }
interface ToolResult { toolCallId: string; toolName: string; details?: unknown }

/** Native selector parsing distinguishes a selector from a colon in a filename. */
function filePathFromRead(raw: unknown): string {
	if (typeof raw !== "string" || !raw) return "";
	const i = raw.lastIndexOf(":");
	if (i <= 0 || i === raw.length - 1) return raw;
	try {
		return parseSel(raw.slice(i + 1)).kind === "none" ? raw : raw.slice(0, i);
	} catch {
		return raw;
	}
}

/** Preview describes declared edits only; never read a file to synthesize one. */
function editCallPreview(input: unknown): { path: string; diff: string } | null {
	const bag = fieldBag(input);
	const path = typeof bag.path === "string" ? bag.path : "";
	let diff = "";
	if (typeof bag.input === "string" && bag.input.trim()) {
		diff = bag.input;
	} else if (typeof bag.old_string === "string" || typeof bag.new_string === "string") {
		const oldText = typeof bag.old_string === "string" ? bag.old_string : "";
		const newText = typeof bag.new_string === "string" ? bag.new_string : "";
		if (oldText !== newText) diff = editDiffString(oldText, newText, path || null).diff;
	} else {
		const edits: unknown[] = Array.isArray(bag.edits) ? bag.edits : [];
		const parts: string[] = [];
		for (const entry of edits) {
			if (!entry || typeof entry !== "object") continue;
			if ("diff" in entry && typeof entry.diff === "string" && entry.diff) parts.push(entry.diff);
		}
		diff = parts.join("\n");
	}
	if (!diff) return null;
	const targets = typeof bag.input === "string" ? getEditInputPaths(bag.input) : [];
	return { path: path || targets[0] || "", diff };
}

function editResultDiff(details: unknown): { path: string; diff: string } | null {
	if (!details || typeof details !== "object") return null;
	if (!("diff" in details) || typeof details.diff !== "string" || !details.diff) return null;
	const path = "path" in details && typeof details.path === "string" ? details.path : "";
	return { path, diff: details.diff };
}

/** Files policy and both views share state; callers never manage revisions or edit ownership. */
export class FilesActivity {
	private readonly files = new Map<string, FileEntry>();
	private editPath = "";
	private editDiff = "";
	private editPreviewCallId: string | undefined;
	private version = 0;
	private cacheKey = "";
	private cacheLines: string[] = [];

	/** Replay deliberately restores result diffs, not live previews or child frames. */
	rebuild(branch: readonly SessionEntry[], cwd: string): void {
		this.files.clear();
		this.editPath = "";
		this.editDiff = "";
		this.editPreviewCallId = undefined;
		this.version++;
		for (const entry of branch) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role === "assistant") {
				for (const call of msg.content) {
					if (call.type !== "toolCall" || !call.name) continue;
					try {
						this.record(call.name, call.arguments, cwd);
					} catch {
						/* skip */
					}
				}
			} else if (msg.role === "toolResult" && msg.toolName === "edit") {
				const result = editResultDiff(msg.details);
				if (result) this.setEditDiff(result.path || this.editPath, result.diff, cwd);
			}
		}
	}

	onToolCall(event: ToolCall, cwd: string): void {
		if (event.toolName === "edit") {
			this.editPreviewCallId = event.toolCallId;
			const preview = editCallPreview(event.input);
			if (preview) this.setEditDiff(preview.path, preview.diff, cwd);
		}
		try {
			this.record(event.toolName, event.input, cwd);
		} catch {
			/* skip */
		}
		this.version++;
	}

	/** An older edit result cannot overwrite the latest call's preview. */
	onToolResult(event: ToolResult, cwd: string): boolean {
		if (event.toolName !== "edit") return false;
		const result = editResultDiff(event.details);
		if (!result || event.toolCallId !== this.editPreviewCallId) return false;
		this.setEditDiff(result.path || this.editPath, result.diff, cwd);
		return true;
	}

	onSubagentToolCall(toolName: string, args: unknown, cwd: string): void {
		// Child references retain their own provenance and existing occurrence counting.
		for (const { abs } of this.pathsFrom(toolName, args, cwd)) this.recordPath(abs, "a");
		this.version++;
	}

	summary(theme: Theme, width: number): string[] {
		const entries = [...this.files.values()].reverse();
		if (entries.length === 0) return [];
		const names = entries.slice(0, MAX_WIDGET_NAMES).map(e => path.basename(e.path));
		const rest = entries.length - names.length;
		let text = `📂 ${entries.length}`;
		if (names.length) text += `  ${names.join(" · ")}`;
		if (rest > 0) text += `  +${rest}`;
		return [truncateToWidth(theme.fg("dim", text), width)];
	}

	render(theme: Theme, width: number, height: number, cwd: string): string[] {
		const key = `${this.version}|${width}|${height}|${cwd}|${themeFingerprint(theme, THEME_COLORS)}`;
		if (key === this.cacheKey) return this.cacheLines;
		const inner = Math.max(1, width - 2);
		const pad = (s: string) => s + " ".repeat(Math.max(0, inner - visibleWidth(s)));
		const row = (c: string) => theme.fg("border", "│") + pad(truncateToWidth(c, inner)) + theme.fg("border", "│");
		const entries = [...this.files.values()].reverse();
		const half = Math.max(6, Math.floor(height / 2));
		const listRows = Math.max(2, half - 4);
		// Six chrome rows plus the padded list leave exactly diffRows for the diff.
		const diffRows = Math.max(0, height - listRows - 6);
		const meta = (e: FileEntry) => theme.fg("muted", `${e.ops}${e.count > 1 ? `×${e.count}` : ""}`);
		const rows: { line: string; files: number }[] = [];
		let i = 0;
		while (i < entries.length) {
			const dir = path.dirname(entries[i].path);
			let j = i;
			while (j < entries.length && path.dirname(entries[j].path) === dir) j++;
			const run = entries.slice(i, j);
			if (run.length > 3) {
				const label = this.displayPath(dir, cwd);
				rows.push({ line: row(` ${theme.fg("accent", label === "." ? "./" : `${label}/`)}`), files: 0 });
				for (const e of run) rows.push({ line: row(`   ${meta(e)} ${theme.fg("text", path.basename(e.path))}`), files: 1 });
			} else {
				for (const e of run) rows.push({ line: row(` ${meta(e)} ${theme.fg("text", path.basename(e.path))}`), files: 1 });
			}
			i = j;
		}
		const body: string[] = [];
		let filesShown = 0;
		for (const r of rows) {
			if (body.length >= listRows - 2) break;
			body.push(r.line);
			filesShown += r.files;
		}
		if (body.length === 0 && entries.length === 0) body.push(row(` ${theme.fg("dim", "No files touched yet")}`));
		if (entries.length > filesShown) body.push(row(` ${theme.fg("dim", `… +${entries.length - filesShown} more`)}`));
		body.push(row(` ${theme.fg("dim", LEGEND)}`));
		while (body.length < listRows) body.push(row(""));

		const diffBody = [theme.fg("border", `├${"─".repeat(inner)}┤`)];
		const title = this.editPath
			? theme.fg("accent", ` ✎ ${truncateToWidth(this.displayPath(this.editPath, cwd), inner - 4)} `)
			: theme.fg("dim", " Last Edit ");
		const titleFill = "─".repeat(Math.max(0, inner - visibleWidth(title)));
		diffBody.push(theme.fg("border", "│") + title + theme.fg("border", titleFill) + theme.fg("border", "│"));
		if (this.editDiff) {
			const rendered = renderDiff(this.editDiff, { filePath: this.editPath || undefined }).split(/\r?\n/);
			const shown = rendered.slice(0, Math.max(0, diffRows - 1));
			for (const line of shown) diffBody.push(row(` ${line}`));
			if (rendered.length > shown.length && diffRows > 0)
				diffBody.push(row(` ${theme.fg("dim", `… +${rendered.length - shown.length} more`)}`));
			while (diffBody.length < diffRows + 2) diffBody.push(row(""));
		} else {
			if (diffRows > 0) diffBody.push(row(` ${theme.fg("dim", "No edit yet")}`));
			while (diffBody.length < diffRows + 2) diffBody.push(row(""));
		}
		const out = [
			theme.fg("border", `╭${"─".repeat(inner)}╮`),
			row(` ${theme.fg("accent", `📂 Files (${entries.length})`)}`),
			theme.fg("border", `├${"─".repeat(inner)}┤`),
			...body, ...diffBody,
			theme.fg("border", `╰${"─".repeat(inner)}╯`),
		];
		this.cacheKey = key;
		this.cacheLines = out.slice(0, height);
		return this.cacheLines;
	}

	private pathsFrom(toolName: string, input: unknown, cwd: string): { abs: string; op: FileOp }[] {
		const bag = fieldBag(input);
		const out: { abs: string; op: FileOp }[] = [];
		const add = (v: unknown, op: FileOp, unconditional: boolean) => {
			if (typeof v !== "string" || !v || SCHEME_URL.test(v)) return;
			try {
				const abs = resolveToCwd(v, cwd);
				if (!unconditional && (!existsSync(abs) || !statSync(abs).isFile())) return;
				out.push({ abs, op });
			} catch {
				/* skip */
			}
		};
		if (toolName === "bash") {
			const cmd = typeof bag.command === "string" ? bag.command : "";
			for (const raw of cmd.split(/\s+/)) {
				const tok = raw.replace(/^[("'`]+/, "").replace(/[)"'`;:,]+$/, "");
				if (!tok || tok.startsWith("-") || /[|&><`$*?]/.test(tok)) continue;
				try {
					const abs = resolveToCwd(tok, cwd);
					if (existsSync(abs) && statSync(abs).isFile()) out.push({ abs, op: "s" });
				} catch {
					/* skip */
				}
			}
			return out;
		}
		if (toolName === "read") {
			add(filePathFromRead(bag.path), "r", true);
			return out;
		}
		if (toolName === "write") {
			add(bag.path, "w", true);
			return out;
		}
		if (toolName === "edit") {
			add(bag.path, "w", true);
			if (typeof bag.input === "string" && bag.input)
				for (const target of getEditInputPaths(bag.input)) add(target, "w", true);
			const edits: unknown[] = Array.isArray(bag.edits) ? bag.edits : [];
			for (const entry of edits) {
				if (!entry || typeof entry !== "object") continue;
				if ("rename" in entry && typeof entry.rename === "string") add(entry.rename, "w", true);
			}
			return out;
		}
		for (const key of ["path", "filePath", "file_path", "imagePath"]) add(bag[key], "r", false);
		for (const key of ["paths", "files", "filePaths"]) {
			const list = bag[key];
			if (Array.isArray(list)) for (const v of list) add(v, "r", false);
		}
		return out;
	}

	private recordPath(abs: string, op: FileOp): void {
		const prev = this.files.get(abs);
		if (prev) {
			this.files.delete(abs);
			prev.count++;
			if (!prev.ops.includes(op)) prev.ops += op;
			this.files.set(abs, prev);
			return;
		}
		if (this.files.size >= MAX_FILES) {
			const oldest = this.files.keys().next();
			if (!oldest.done) this.files.delete(oldest.value);
		}
		this.files.set(abs, { path: abs, ops: op, count: 1 });
	}

	private record(toolName: string, input: unknown, cwd: string): void {
		const seen = new Set<string>();
		for (const { abs, op } of this.pathsFrom(toolName, input, cwd)) {
			if (seen.has(abs)) continue;
			seen.add(abs);
			this.recordPath(abs, op);
		}
		this.version++;
	}

	private setEditDiff(p: string, diff: string, cwd: string): void {
		this.editPath = p && !SCHEME_URL.test(p) ? resolveToCwd(p, cwd) : p;
		this.editDiff = diff;
		this.version++;
	}

	private displayPath(abs: string, cwd: string): string {
		if (SCHEME_URL.test(abs)) return abs;
		const rel = path.relative(cwd, abs);
		if (rel && !rel.startsWith("..")) return rel;
		const home = homedir();
		if (abs.startsWith(home + path.sep)) return `~${abs.slice(home.length)}`;
		return abs;
	}
}
