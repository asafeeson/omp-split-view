import type { Theme } from "@oh-my-pi/pi-tui/theme";

/** Field view only: callers still validate the individual payload fields. */
export function fieldBag(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Each panel invalidates only for the palette entries its rendering uses. */
export function themeFingerprint(
	theme: Theme,
	colors: readonly Parameters<Theme["fg"]>[0][],
): string {
	return colors.map((color) => theme.fg(color, "x")).join("|");
}
