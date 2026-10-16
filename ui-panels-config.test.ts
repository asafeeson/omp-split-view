import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { loadUiPanelsConfig, normalizeConfig, saveUiPanelsConfig } from "./ui-panels-config.ts";

test("subagents startup flag is strict, independent, and saved only explicitly", () => {
	const directory = mkdtempSync(join(tmpdir(), "omp-panels-config-"));
	const previousDirectory = getAgentDir();
	try {
		setAgentDir(directory);
		expect(normalizeConfig({}).subagents).toBe(false);
		expect(normalizeConfig({ subagents: "true" as unknown as boolean }).subagents).toBe(false);
		expect(normalizeConfig({ split: false, subagents: true }).subagents).toBe(true);
		expect(normalizeConfig({ split: true, subagents: false }).subagents).toBe(false);
		expect(loadUiPanelsConfig()).toEqual({});
		expect(saveUiPanelsConfig({ split: false, subagents: true })).toBe(true);
		expect(loadUiPanelsConfig()).toEqual({ split: false, subagents: true });
	} finally {
		setAgentDir(previousDirectory);
		rmSync(directory, { recursive: true, force: true });
	}
});
