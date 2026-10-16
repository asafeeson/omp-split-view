/**
 * Behavior tests for `files-activity.ts`. They drive the model only through its
 * public surface (`onToolCall` / `onToolResult` / `onSubagentToolCall` /
 * `rebuild` / `render` / `summary`) and read outcomes back out of `render` and
 * `summary`; no private helper, source text or wiring is asserted.
 *
 * Temporary directories supply the real files the path collector probes, so
 * existence-based tools (bash, generic payload keys) are exercised against the
 * filesystem rather than a second abstraction.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureThemeSync } from "@oh-my-pi/pi-tui/theme";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { FilesActivity } from "./files-activity.ts";

// The native diff renderer (`renderDiff`) needs a synced global theme; the
// theme-fingerprint test below uses its own proxy instead of touching the theme.
ensureThemeSync();

/** Identity theme: assertions read plain text, no escapes. */
const TEXT_THEME = { fg: (_color: string, text: string) => text } as unknown as Theme;

/** Title row of the edit-diff subpanel (`✎ <path>`); "" when absent. */
const titleLine = (lines: readonly string[]): string =>
	lines.find(line => line.includes("✎")) ?? "";

const withTempDir = (run: (dir: string) => void): void => {
	const dir = mkdtempSync(join(tmpdir(), "omp-files-"));
	try {
		run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

function assistantCall(name: string, args: unknown, id: string): SessionEntry {
	// In-process fixture: unrelated native model/usage metadata is not consumed.
	const entry = {
		type: "message", id, parentId: null, timestamp: "",
		message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
	} as unknown as SessionEntry;
	return entry;
}

function editResultEntry(toolCallId: string, details: unknown): SessionEntry {
	// In-process fixture: unrelated native timestamps/status fields are omitted.
	const entry = {
		type: "message", id: `result-${toolCallId}`, parentId: null, timestamp: "",
		message: { role: "toolResult", toolCallId, toolName: "edit", content: [], details },
	} as unknown as SessionEntry;
	return entry;
}

test("canonicalizes relative and absolute read paths and peels native selectors", () => {
	withTempDir(dir => {
		writeFileSync(join(dir, "notes.txt"), "one\ntwo\nthree\n");
		const activity = new FilesActivity();
		activity.onToolCall({ toolCallId: "c1", toolName: "read", input: { path: "notes.txt" } }, dir);
		activity.onToolCall({ toolCallId: "c2", toolName: "read", input: { path: "notes.txt:2-3" } }, dir);
		activity.onToolCall({ toolCallId: "c3", toolName: "read", input: { path: "notes.txt:raw" } }, dir);
		activity.onToolCall({ toolCallId: "c4", toolName: "read", input: { path: join(dir, "notes.txt") } }, dir);

		const out = activity.render(TEXT_THEME, 80, 24, dir).join("\n");
		expect(out).toContain("📂 Files (1)");
		expect(out).toContain("r×4 notes.txt");
		expect(activity.summary(TEXT_THEME, 200).join("\n")).toContain("notes.txt");
	});
});

test("drops non-file targets so URLs, artifact and skill references never enter the list", () => {
	withTempDir(dir => {
		const activity = new FilesActivity();
		activity.onToolCall({ toolCallId: "u1", toolName: "read", input: { path: "https://example.com/x.ts" } }, dir);
		activity.onToolCall({ toolCallId: "u2", toolName: "read", input: { path: "artifact://local/report.md" } }, dir);
		activity.onToolCall({ toolCallId: "u3", toolName: "read", input: { path: "skill://tdd" } }, dir);
		activity.onToolCall({ toolCallId: "u4", toolName: "write", input: { path: "mcp://server/resource" } }, dir);

		const out = activity.render(TEXT_THEME, 80, 24, dir).join("\n");
		expect(out).toContain("📂 Files (0)");
		expect(out).not.toContain("example.com");
		expect(out).not.toContain("://");
		expect(activity.summary(TEXT_THEME, 200)).toEqual([]);
	});
});

test("tracks only existing files for probing tools while write/read record attempts", () => {
	withTempDir(dir => {
		writeFileSync(join(dir, "real.txt"), "x");
		writeFileSync(join(dir, "script.sh"), "echo hi\n");
		const activity = new FilesActivity();
		activity.onToolCall({ toolCallId: "g1", toolName: "grep", input: { path: "real.txt" } }, dir);
		activity.onToolCall({ toolCallId: "g2", toolName: "grep", input: { path: "missing.txt" } }, dir);
		activity.onToolCall({ toolCallId: "b1", toolName: "bash", input: { command: "cat script.sh" } }, dir);
		activity.onToolCall({ toolCallId: "w1", toolName: "write", input: { path: "created.txt" } }, dir);
		activity.onToolCall({ toolCallId: "r1", toolName: "read", input: { path: "real.txt" } }, dir);

		const out = activity.render(TEXT_THEME, 80, 24, dir).join("\n");
		expect(out).toContain("📂 Files (3)");
		expect(out).toContain("r×2 real.txt");
		expect(out).toContain("s script.sh");
		expect(out).toContain("w created.txt");
		expect(out).not.toContain("missing.txt");
	});
});

test("counts each parent call path once but every child reference", () => {
	withTempDir(dir => {
		writeFileSync(join(dir, "dup.txt"), "x");

		const parent = new FilesActivity();
		parent.onToolCall({ toolCallId: "p1", toolName: "grep", input: { path: "dup.txt", paths: ["dup.txt"] } }, dir);
		const parentOut = parent.render(TEXT_THEME, 80, 24, dir).join("\n");
		expect(parentOut).toContain("📂 Files (1)");
		expect(parentOut).toContain("r dup.txt");

		const child = new FilesActivity();
		child.onSubagentToolCall("grep", { path: "dup.txt", paths: ["dup.txt"] }, dir);
		const childOut = child.render(TEXT_THEME, 80, 24, dir).join("\n");
		expect(childOut).toContain("📂 Files (1)");
		expect(childOut).toContain("a×2 dup.txt");
	});
});

test("orders files newest-first and names the three most recent in the summary", () => {
	withTempDir(dir => {
		const activity = new FilesActivity();
		for (const name of ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"])
			activity.onToolCall({ toolCallId: name, toolName: "read", input: { path: name } }, dir);

		const summary = activity.summary(TEXT_THEME, 200).join("\n");
		expect(summary).toContain("📂 5");
		expect(summary).toContain("e.txt · d.txt · c.txt");
		expect(summary).toContain("+2");

		const out = activity.render(TEXT_THEME, 80, 24, dir).join("\n");
		expect(out.indexOf("e.txt")).toBeGreaterThan(-1);
		expect(out.indexOf("e.txt")).toBeLessThan(out.indexOf("a.txt"));
	});
});

test("only the newest edit call owns the preview that a late older result cannot overwrite", () => {
	withTempDir(dir => {
		const activity = new FilesActivity();
		activity.onToolCall(
			{ toolCallId: "e1", toolName: "edit", input: { path: "a.txt", old_string: "old-a", new_string: "new-a" } },
			dir,
		);
		activity.onToolCall(
			{ toolCallId: "e2", toolName: "edit", input: { path: "b.txt", old_string: "old-b", new_string: "new-b" } },
			dir,
		);
		expect(titleLine(activity.render(TEXT_THEME, 80, 24, dir))).toContain("b.txt");

		// A slower result for the earlier call is rejected outright.
		const accepted = activity.onToolResult(
			{ toolCallId: "e1", toolName: "edit", details: { path: "stale.txt", diff: "+1|STALE" } },
			dir,
		);
		expect(accepted).toBe(false);
		const afterStale = activity.render(TEXT_THEME, 80, 24, dir).join("\n");
		expect(afterStale).not.toContain("stale.txt");
		expect(afterStale).not.toContain("STALE");

		// The owning call's result replaces the declared preview authoritatively.
		const applied = activity.onToolResult(
			{ toolCallId: "e2", toolName: "edit", details: { path: "b.txt", diff: "+1|FRESH" } },
			dir,
		);
		expect(applied).toBe(true);
		const afterResult = activity.render(TEXT_THEME, 80, 24, dir).join("\n");
		expect(titleLine(activity.render(TEXT_THEME, 80, 24, dir))).toContain("b.txt");
		expect(afterResult).toContain("FRESH");
		expect(afterResult).not.toContain("new-b");
	});
});

test("rebuild replaces live and child history and keeps the last replayed edit result", () => {
	withTempDir(dir => {
		const activity = new FilesActivity();
		writeFileSync(join(dir, "child-only.txt"), "child");
		// Live and child state that the branch does not contain.
		activity.onToolCall({ toolCallId: "live", toolName: "read", input: { path: "live-only.txt" } }, dir);
		activity.onSubagentToolCall("grep", { path: "child-only.txt" }, dir);
		activity.onToolCall(
			{ toolCallId: "live-edit", toolName: "edit", input: { path: "live.txt", old_string: "x", new_string: "y" } },
			dir,
		);
		expect(activity.summary(TEXT_THEME, 200).join("\n")).toContain("child-only.txt");

		const branch: SessionEntry[] = [
			assistantCall("read", { path: "kept.txt" }, "b1"),
			editResultEntry("b1", { path: "branch.txt", diff: "+1|BRANCH-FIRST" }),
			editResultEntry("b2", { path: "branch.txt", diff: "+1|BRANCH-LAST" }),
			assistantCall("edit", { path: "preview.txt", old_string: "old", new_string: "NO-REPLAY-PREVIEW" }, "b3"),
		];
		activity.rebuild(branch, dir);

		const out = activity.render(TEXT_THEME, 80, 24, dir).join("\n");
		expect(out).toContain("kept.txt");
		expect(out).not.toContain("live-only.txt");
		expect(out).not.toContain("child-only.txt");
		expect(out).not.toContain("live.txt");
		expect(out).toContain("BRANCH-LAST");
		expect(out).not.toContain("BRANCH-FIRST");
		expect(out).not.toContain("NO-REPLAY-PREVIEW");
		expect(titleLine(activity.render(TEXT_THEME, 80, 24, dir))).toContain("branch.txt");
		expect(activity.summary(TEXT_THEME, 200).join("\n")).toContain("kept.txt");

		// Rebuild also clears preview ownership, so a pre-rebuild call id is stale.
		const accepted = activity.onToolResult(
			{ toolCallId: "live-edit", toolName: "edit", details: { path: "late.txt", diff: "+1|LATE" } },
			dir,
		);
		expect(accepted).toBe(false);
		const after = activity.render(TEXT_THEME, 80, 24, dir).join("\n");
		expect(after).not.toContain("LATE");
		expect(after).toContain("BRANCH-LAST");
	});
});

test("keeps the files buffer bounded to the 500 newest references", () => {
	withTempDir(dir => {
		const activity = new FilesActivity();
		for (let i = 0; i < 501; i++)
			activity.onToolCall({ toolCallId: `c${i}`, toolName: "read", input: { path: `file${i}.txt` } }, dir);

		expect(activity.render(TEXT_THEME, 80, 40, dir).join("\n")).toContain("📂 Files (500)");
		const summary = activity.summary(TEXT_THEME, 200).join("\n");
		expect(summary).toContain("📂 500");
		expect(summary).toContain("file500.txt · file499.txt · file498.txt");
		expect(summary).not.toContain("file0.txt");

		// The oldest reference was evicted, so re-reading it returns as newest.
		activity.onToolCall({ toolCallId: "again", toolName: "read", input: { path: "file0.txt" } }, dir);
		const summaryAfter = activity.summary(TEXT_THEME, 200).join("\n");
		expect(summaryAfter).toContain("📂 500");
		expect(summaryAfter).toContain("file0.txt · file500.txt · file499.txt");
		expect(activity.render(TEXT_THEME, 80, 40, dir).join("\n")).toContain("r file0.txt");
	});
});

test("reuses cached lines only while geometry and theme fingerprint are unchanged", () => {
	withTempDir(dir => {
		writeFileSync(join(dir, "a.txt"), "x");
		const activity = new FilesActivity();
		activity.onToolCall({ toolCallId: "c1", toolName: "read", input: { path: "a.txt" } }, dir);

		const palette: Record<string, string> = { border: "B1", accent: "A1", muted: "M1", dim: "D1", text: "T1" };
		const theme = {
			fg: (color: string, text: string) => (palette[color] ? `<${palette[color]}>${text}` : text),
		} as unknown as Theme;

		const base = activity.render(theme, 60, 24, dir);
		expect(base).toHaveLength(24);
		expect(base.join("\n")).toContain("<A1>");

		// A height-only resize changes the list/diff split with no state change.
		const taller = activity.render(theme, 60, 30, dir);
		expect(taller).toHaveLength(30);
		expect(taller).not.toEqual(base);

		// A width-only resize reflows the frame.
		expect(activity.render(theme, 50, 24, dir)).not.toEqual(base);

		// Same geometry, new palette: the theme-aware cache must re-render.
		palette.border = "B2";
		const recolored = activity.render(theme, 60, 24, dir).join("\n");
		expect(recolored).toContain("<B2>");
		expect(recolored).not.toContain("<B1>");
	});
});
