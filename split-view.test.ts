import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, TUI, visibleWidth } from "@oh-my-pi/pi-tui";
import type { Terminal } from "@oh-my-pi/pi-tui";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { ensureThemeSync, getEditorTheme, getCurrentThemeName, setTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import type { ExtensionCommandContext, ExtensionContext, ExtensionWidgetContent, TerminalInputHandler } from "@oh-my-pi/pi-coding-agent";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { loadUiPanelsConfig } from "./ui-panels-config.ts";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TASK_SUBAGENT_EVENT_CHANNEL, TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task";

async function exerciseSplitView(): Promise<void> {
	const directory = mkdtempSync(join(tmpdir(), "omp-split-test-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	const previousDirectory = getAgentDir();
	setAgentDir(directory);
	ensureThemeSync();
	const previousTheme = getCurrentThemeName();
	const terminal = {
		columns: 120, rows: 40,
		write() {}, hideCursor() {}, showCursor() {},
	};
	const tui = new TUI(terminal as unknown as Terminal, false, { renderScheduler: {
		now: () => 0,
		scheduleImmediate() {},
		scheduleRender: () => ({ cancel() {} }),
	} });
	const transcript = new TranscriptContainer();
	transcript.addChild(new UserMessageComponent("NATIVE_TRANSCRIPT"));
	const editor = new CustomEditor(getEditorTheme());
	const widgets = new Container();
	tui.addChild(transcript);
	tui.addChild(editor);
	tui.addChild(widgets);
	tui.setFocus(editor);
	const notices: string[] = [];
	let widget: { dispose?(): void } | undefined;
	let inputListener: TerminalInputHandler | undefined;
	const sessionManager = SessionManager.create(directory, join(directory, "sessions"));
	sessionManager.appendMessage({
		role: "user",
		content: "RESPONSE_USER 中🙂",
	} as Parameters<typeof sessionManager.appendMessage>[0]);
	await sessionManager.ensureOnDisk();
	const branch = sessionManager.getBranch() as unknown as Array<{
		type: string;
		message: { role: string; content: string };
	}>;
	const context = {
		mode: "tui", hasUI: true, cwd: directory,
		sessionManager,
		ui: {
			get theme() { return theme; },
			notify: (message: string) => notices.push(message),
			onTerminalInput: (listener: TerminalInputHandler) => {
				inputListener = listener;
				return () => { inputListener = undefined; };
			},
			setWidget: (_key: string, content: ExtensionWidgetContent) => {
				widget?.dispose?.();
				widget = undefined;
				widgets.clear();
				if (typeof content === "function") {
					const component = content(tui, theme);
					widget = component;
					widgets.addChild(component);
				}
			},
		},
	} as unknown as ExtensionContext;
	const eventBus = new EventBus();
	const loaded = await loadExtensions([join(import.meta.dir, "split-view.ts")], directory, eventBus);
	loaded.runtime.appendEntry = (customType, data) => {
		sessionManager.appendCustomEntry(customType, data);
	};
	expect(loaded.errors).toEqual([]);
	const extension = loaded.extensions[0]!;
	const emit = async (type: string, event = {}) => {
		for (const handler of extension.handlers.get(type) ?? []) await handler({ type, ...event }, context);
	};
	const command = async (name: string, args = "") => {
		await extension.commands.get(name)!.handler(args, context as ExtensionCommandContext);
	};
	const render = () => {
		const lines = tui.overlayStack.at(-1)!.component.render(terminal.columns);
		expect(lines).toHaveLength(terminal.rows);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(terminal.columns);
		return Bun.stripANSI(lines.join("\n"));
	};
	try {
		await emit("session_start");
		await command("split");
		expect(tui.getFocused()).toBe(editor);
		expect(tui.hasOverlay()).toBe(false); // Native main-editor shortcuts remain enabled.
		const modal = tui.showOverlay(new UserMessageComponent("MODAL"));
		expect(tui.hasOverlay()).toBe(true);
		expect(inputListener?.("\x1b[6~")).toBeUndefined();
		modal.hide();
		tui.setFocus(editor); // Same restoration performed by OMP's dialog controller.
		expect(tui.hasOverlay()).toBe(false);
		editor.handleInput("draft 中🙂");
		expect(render()).toContain("draft 中🙂");
		expect(render()).toContain("NATIVE_TRANSCRIPT");
		const message = { role: "assistant", content: [{ type: "thinking", thinking: "THOUGHT_ONLY" }] };
		await emit("message_update", { message, assistantMessageEvent: { type: "thinking_start" } });
		await emit("message_update", { message, assistantMessageEvent: { type: "thinking_delta", delta: "THOUGHT_ONLY" } });
		await emit("message_update", { message, assistantMessageEvent: { type: "thinking_end", content: "THOUGHT_ONLY" } });
		await emit("tool_execution_start", { toolCallId: "read-1", toolName: "read", args: { path: join(directory, "file.ts") } });
		await emit("tool_execution_end", { toolCallId: "read-1", toolName: "read", result: { content: [{ type: "text", text: "TOOL_OUTPUT" }] }, isError: false });
		expect(render()).toContain("THOUGHT_ONLY");
		expect(render()).toContain("read");
		const childPath = join(directory, "child.ts");
		writeFileSync(childPath, "child");
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, { id: "child", agent: "Reviewer", status: "started" });
		eventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, { id: "child", event: {
			type: "tool_execution_start", toolCallId: "sub-read", toolName: "read", args: { path: childPath },
		} });
		await command("split-subagents");
		expect(render()).toContain("Subagents");
		expect(render()).toContain("Reviewer");
		expect(sessionManager.getEntries().some((entry) =>
			entry.type === "custom" && entry.customType === "split-view:subagent-run")).toBe(true);
		expect(render()).toContain("● read[Reviewer]");
		await command("split-subagents", "up");
		expect(render()).toContain("Paused");
		await command("split-subagents", "live");
		expect(render()).toContain("Live");
		await command("split-tools-view");
		eventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, { id: "child", event: {
			type: "tool_execution_end", toolCallId: "sub-read", toolName: "read",
			result: { content: [{ type: "text", text: "SUB_ERROR" }] }, isError: true,
		} });
		expect(render()).toContain("✗ read[Reviewer]");
		expect(render()).toContain("SUB_ERROR");
		await emit("tool_call", { toolCallId: "relative-read", toolName: "read",
			input: { path: "child.ts:1-1" } });
		await command("files");
		expect(render()).toContain("Files (1)"); // Relative + absolute identify one file.
		await emit("tool_call", { toolCallId: "edit-old", toolName: "edit",
			input: { path: "child.ts", old_string: "child", new_string: "OLD_PREVIEW" } });
		await emit("tool_call", { toolCallId: "edit-new", toolName: "edit",
			input: { path: "child.ts", old_string: "child", new_string: "LATEST_PREVIEW" } });
		await emit("tool_result", { toolCallId: "edit-old", toolName: "edit",
			details: { path: childPath, diff: "-1|child\n+1|STALE_RESULT" } });
		expect(render()).toContain("LATEST_PREVIEW");
		expect(render()).not.toContain("STALE_RESULT");
		await emit("tool_result", { toolCallId: "edit-new", toolName: "edit",
			details: { path: childPath, diff: "-1|child\n+1|LATEST_RESULT" } });
		expect(render()).toContain("LATEST_RESULT");
		await command("split-trim-response", "on");
		await command("split-thinking");
		await command("split-tools");
		const answer = {
			role: "assistant", api: "openai-completions", provider: "split-test", model: "test",
			content: [
				{ type: "thinking", thinking: "HIDDEN_REASONING" },
				{ type: "text", text: "ANSWER_ONLY" },
				{ type: "toolCall", id: "hidden", name: "hidden_tool", arguments: {} },
			],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop", timestamp: 1,
		};
		await emit("message_update", { message: answer, assistantMessageEvent: { type: "text_delta", delta: "ANSWER_ONLY" } });
		await emit("message_end", { message: answer });
		const response = render();
		expect(response).toContain("RESPONSE_USER 中🙂");
		expect(response).toContain("ANSWER_ONLY");
		expect(response).not.toContain("HIDDEN_REASONING");
		expect(response).not.toContain("hidden_tool");
		expect(response).not.toContain("NATIVE_TRANSCRIPT");
		expect(response).not.toContain("THOUGHT_ONLY");
		expect(response).not.toContain("TOOL_OUTPUT");
		const beforeTheme = tui.overlayStack.at(-1)!.component.render(terminal.columns)
			.find(line => line.includes("RESPONSE_USER"));
		await setTheme("light");
		const afterTheme = tui.overlayStack.at(-1)!.component.render(terminal.columns)
			.find(line => line.includes("RESPONSE_USER"));
		expect(afterTheme).not.toEqual(beforeTheme);
		await command("split-tools-width", "invalid");
		expect(render()).toContain("Invalid percentage");
		terminal.columns = 80;
		terminal.rows = 18;
		expect(render()).not.toContain("Files (");
		expect(render()).toContain("draft 中🙂");
		terminal.columns = 160;
		terminal.rows = 50;
		expect(render()).toContain("Files (");
		expect(render()).toContain("Subagents");
		terminal.rows = 40;
		expect(render()).toContain("Subagents");
		terminal.rows = 10;
		expect(render()).toContain("Subagents");
		terminal.rows = 40;
		branch[0]!.message.content += "\n" + Array.from({ length: 80 }, (_, i) => `BRANCH_ROW_${i + 1}`).join("\n");
		await emit("session_tree");
		expect(render()).toContain("RESPONSE_USER 中🙂");
		expect(render()).not.toContain("BRANCH_ROW_80");
		expect(inputListener?.("\x1b[6~")).toEqual({ consume: true });
		expect(render()).not.toContain("RESPONSE_USER 中🙂");
		inputListener?.("\x1b[5~");
		expect(render()).toContain("RESPONSE_USER 中🙂");
		expect(loadUiPanelsConfig()).toEqual({});
		await command("split-save");
		expect(loadUiPanelsConfig()).toMatchObject({ split: false, subagents: true });
		expect(notices.at(-1)).toContain("saved");
		await command("split");
		expect(tui.overlayStack).toHaveLength(0);
		expect(tui.getFocused()).toBe(editor);
		expect(editor.getText()).toBe("draft 中🙂");
		const bareModal = tui.showOverlay(new UserMessageComponent("BARE_MODAL"));
		expect(tui.hasOverlay()).toBe(true);
		bareModal.hide();
		expect(tui.hasOverlay()).toBe(false);
		await command("split");
		expect(render()).toContain("RESPONSE_USER 中🙂");
		expect(render()).not.toContain("Thinking");
		await emit("session_shutdown");
		expect(tui.overlayStack).toHaveLength(0);
	} finally {
		widget?.dispose?.();
		eventBus.clear();
		if (previousTheme) await setTheme(previousTheme);
		setAgentDir(previousDirectory);
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await sessionManager.close();
		rmSync(directory, { recursive: true, force: true });
	}
}

test("native split view preserves editor, filters responses, resizes and releases screen", async () => {
	if (process.env.OMP_SPLIT_TEST_CHILD === "1") {
		await exerciseSplitView();
		return;
	}
	// OMP's profile/theme registries are process-global; isolate other test files.
	const home = mkdtempSync(join(tmpdir(), "omp-split-suite-"));
	try {
		const child = Bun.spawn([process.execPath, "test", import.meta.filename], {
			env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: join(home, "agent"),
				OMP_PROFILE: "", PI_PROFILE: "", OMP_SPLIT_TEST_CHILD: "1" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [code, stdout, stderr] = await Promise.all([
			child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
		]);
		if (code !== 0) throw new Error(stdout + stderr);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
