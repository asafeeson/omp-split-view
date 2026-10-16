/** OMP fullscreen ownership. Never replaces the host's frame/history provider. */
import type { Component, OverlayHandle, TUI } from "@oh-my-pi/pi-tui";

type RenderFrame = (width: number, height: number) => readonly string[];
interface LayoutState {
	tui: TUI | null;
	handle: OverlayHandle | null;
	render: RenderFrame | null;
	restoreModalProbe?: () => void;
}
const KEY = Symbol.for("omp.split-view.layout");
const globals = globalThis as unknown as Record<symbol, LayoutState>;
const state = globals[KEY] ??= { tui: null, handle: null, render: null };

export function initLayoutManager(tui: TUI): void {
	resetLayoutManager();
	state.tui = tui;
}

/** Read live roots on every frame: /new, /tree and custom editors replace them. */
export function getNativeRegions(): { transcript: Component; dock: readonly Component[] } | null {
	const roots = state.tui?.children;
	if (!roots) return null;
	const index = roots.findIndex(root =>
		typeof (root as Component & { renderTail?: unknown }).renderTail === "function",
	);
	if (index < 0) return null;
	return { transcript: roots[index]!, dock: roots.slice(index + 1) };
}

function contains(root: Component, target: Component): boolean {
	if (root === target) return true;
	const children = (root as Component & { children?: Component[] }).children ?? root.debugChildren;
	return children?.some(child => contains(child, target)) ?? false;
}

export function setLayoutLayer(render: RenderFrame | null): void {
	state.render = render;
	if (!render) {
		state.restoreModalProbe?.();
		state.restoreModalProbe = undefined;
		state.handle?.hide();
		state.handle = null;
		return;
	}
	const tui = state.tui;
	if (!tui) return;
	if (!state.handle) {
		const focus = tui.getFocused();
		const screen: Component & { ownsOverlayFocusTarget(component: Component): boolean } = {
			debugKind: "split-view",
			render: width => state.render?.(width, tui.terminal.rows) ?? [],
			ownsOverlayFocusTarget: component => tui.children.some(root => contains(root, component)),
		};
		// OMP gates Ctrl+O/Ctrl+T/history/external-editor on hasOverlay().
		// Our screen is layout, not a modal. Exclude ONLY this root; genuine
		// dialogs retain the native gate. Restore the method on close/reload.
		const originalHasOverlay = tui.hasOverlay;
		const hasModalOverlay = () => tui.overlayStack.some(entry =>
			entry.component !== screen && !entry.hidden &&
			(entry.options?.visible?.(tui.terminal.columns, tui.terminal.rows) ?? true),
		) && originalHasOverlay.call(tui);
		tui.hasOverlay = hasModalOverlay;
		state.restoreModalProbe = () => {
			if (tui.hasOverlay === hasModalOverlay) tui.hasOverlay = originalHasOverlay;
		};
		state.handle = tui.showOverlay(screen, {
			fullscreen: true,
			mouseTracking: false,
			width: "100%",
			maxHeight: "100%",
			margin: 0,
		});
		// The overlay borrows the screen, not input. Dialogs can still stack above it.
		if (focus) tui.setFocus(focus);
	}
	tui.requestRender();
}

export function isLayoutLayerActive(): boolean {
	return state.handle !== null;
}

export function resetLayoutManager(): void {
	setLayoutLayer(null);
}
