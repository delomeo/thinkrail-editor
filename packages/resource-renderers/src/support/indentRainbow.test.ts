import { expect, test } from "bun:test";
import {
	DEFAULT_EDITOR_SETTINGS,
	INDENT_RAINBOW_COLORS,
	type IndentRainbowSettings,
} from "@thinkrail/contracts";
import {
	currentEditorSettings,
	publishEditorSettings,
	resolveEditorSettings,
	subscribeEditorSettings,
} from "./editorSettings";
import {
	indentRainbowApplies,
	indentRainbowVariables,
	indentStepClass,
	indentSteps,
} from "./indentRainbow";

const NESTED_PYTHON = [
	"def outer(values):",
	"    if values:",
	"        for value in values:",
	"            if value:",
	"                while value:",
	"                    return value",
];

const stepsOf = (line: string, tabSize: number) =>
	indentSteps(line, tabSize).map(({ step }) => step);
const classesOf = (line: string, tabSize: number) =>
	indentSteps(line, tabSize).map(({ step }) => indentStepClass(step, false));

test("the shipped defaults colour indentation lines on", () => {
	const settings = currentEditorSettings().indentRainbow;
	expect(settings).toEqual(DEFAULT_EDITOR_SETTINGS.indentRainbow);
	expect(settings.enabled).toBe(true);
	expect(settings.style).toBe("lines");
	expect(settings.colors).toHaveLength(INDENT_RAINBOW_COLORS);
	expect(settings.lineOpacity).toBe(0.45);
	expect(settings.activeLineOpacity).toBe(0.85);
	expect(settings.backgroundOpacity).toBe(0);
	expect(settings.excludedLanguages).toEqual([]);
});

test("a user's settings override the defaults and every opacity is clamped", () => {
	const settings = resolveEditorSettings({
		indentRainbow: {
			style: "both",
			lineOpacity: 2,
			backgroundOpacity: -0.5,
			colors: ["#fff", "rgb(1, 2, 3)", "#00ff00", "rgba(9, 8, 7, 0.5)"],
			excludedLanguages: ["markdown", "markdown", ""],
		},
	}).indentRainbow;
	expect(settings.style).toBe("both");
	expect(settings.lineOpacity).toBe(1);
	expect(settings.backgroundOpacity).toBe(0);
	expect(settings.enabled).toBe(true);
	expect(settings.colors).toEqual(["#fff", "rgb(1, 2, 3)", "#00ff00", "rgba(9, 8, 7, 0.5)"]);
	expect(settings.excludedLanguages).toEqual(["markdown"]);
});

test("a malformed value falls back on its own field and keeps the valid siblings", () => {
	const settings = resolveEditorSettings({
		indentRainbow: { enabled: false, lineOpacity: "0.5", colors: ["#111111"], style: "diagonal" },
	}).indentRainbow;
	const defaults = DEFAULT_EDITOR_SETTINGS.indentRainbow;
	expect(settings.enabled).toBe(false);
	expect(settings.lineOpacity).toBe(defaults.lineOpacity);
	expect(settings.colors).toEqual(defaults.colors);
	expect(settings.style).toBe(defaults.style);
});

test("the cycle colours become rgba variables, and a style that draws no half leaves it transparent", () => {
	const lines = indentRainbowVariables(DEFAULT_EDITOR_SETTINGS.indentRainbow);
	expect(lines["--tr-indent-line-0"]).toBe("rgba(234, 179, 8, 0.45)");
	expect(lines["--tr-indent-line-3"]).toBe("rgba(168, 85, 247, 0.45)");
	expect(lines["--tr-indent-line-active-1"]).toBe("rgba(34, 197, 94, 0.85)");
	expect(lines["--tr-indent-bg-2"]).toBe("transparent");

	const filled = indentRainbowVariables({
		...DEFAULT_EDITOR_SETTINGS.indentRainbow,
		style: "background",
		backgroundOpacity: 0.2,
	});
	expect(filled["--tr-indent-line-0"]).toBe("transparent");
	expect(filled["--tr-indent-line-active-0"]).toBe("transparent");
	expect(filled["--tr-indent-bg-0"]).toBe("rgba(234, 179, 8, 0.2)");
});

test("an unparseable colour paints nothing rather than breaking the cycle", () => {
	const settings = {
		...DEFAULT_EDITOR_SETTINGS.indentRainbow,
		colors: ["rgb(300, 0, 0)", "#fff", "rgb(0, 255, 0)", "#000"],
	};
	expect(indentRainbowVariables(settings)["--tr-indent-line-0"]).toBe("transparent");
	expect(indentRainbowVariables(settings)["--tr-indent-line-1"]).toBe("rgba(255, 255, 255, 0.45)");
});

test("every nesting step of a Python block takes the next colour, cycling every four", () => {
	expect(classesOf(NESTED_PYTHON[0] ?? "", 4)).toEqual([]);
	expect(classesOf(NESTED_PYTHON[1] ?? "", 4)).toEqual(["tr-indent-step-0"]);
	expect(classesOf(NESTED_PYTHON[2] ?? "", 4)).toEqual(["tr-indent-step-0", "tr-indent-step-1"]);
	expect(classesOf(NESTED_PYTHON[3] ?? "", 4)).toEqual([
		"tr-indent-step-0",
		"tr-indent-step-1",
		"tr-indent-step-2",
	]);
	expect(classesOf(NESTED_PYTHON[4] ?? "", 4)).toEqual([
		"tr-indent-step-0",
		"tr-indent-step-1",
		"tr-indent-step-2",
		"tr-indent-step-3",
	]);
	expect(classesOf(NESTED_PYTHON[5] ?? "", 4)).toEqual([
		"tr-indent-step-0",
		"tr-indent-step-1",
		"tr-indent-step-2",
		"tr-indent-step-3",
		"tr-indent-step-0",
	]);
});

test("a step covers only its own indentation columns", () => {
	expect(indentSteps("    if values:", 4)).toEqual([{ step: 0, startColumn: 1, endColumn: 5 }]);
	expect(indentSteps("        return value", 4)[1]).toEqual({
		step: 1,
		startColumn: 5,
		endColumn: 9,
	});
	expect(indentSteps("  x = 1", 2)).toEqual([{ step: 0, startColumn: 1, endColumn: 3 }]);
});

test("a tab advances a whole step, and a short tail is not a step of its own", () => {
	expect(stepsOf("\t\tif x:", 4)).toEqual([0, 1]);
	expect(indentSteps("\t  x", 4)).toEqual([{ step: 0, startColumn: 1, endColumn: 5 }]);
	expect(stepsOf("\t\tif x:", 2)).toEqual([0, 1]);
});

test("the cursor's own line carries the active class beside the base one", () => {
	expect(indentStepClass(5, true)).toBe("tr-indent-step-1 tr-indent-step-active-1");
});

test("an off switch or an excluded language leaves Monaco's own guides in place", () => {
	const settings = { ...DEFAULT_EDITOR_SETTINGS.indentRainbow, excludedLanguages: ["markdown"] };
	expect(indentRainbowApplies(settings, "python")).toBe(true);
	expect(indentRainbowApplies(settings, "markdown")).toBe(false);
	expect(indentRainbowApplies({ ...settings, enabled: false }, "python")).toBe(false);
});

test("publishing a host's settings notifies every subscriber once per actual change", () => {
	const seen: IndentRainbowSettings[] = [];
	const unsubscribe = subscribeEditorSettings((settings) => seen.push(settings.indentRainbow));
	const raw = { indentRainbow: { style: "background", lineOpacity: 0.25 } };
	publishEditorSettings(raw);
	publishEditorSettings(raw);
	expect(seen).toHaveLength(1);
	expect(seen[0]?.style).toBe("background");
	expect(seen[0]?.lineOpacity).toBe(0.25);
	unsubscribe();
	publishEditorSettings(undefined);
	expect(seen).toHaveLength(1);
	expect(currentEditorSettings()).toEqual(DEFAULT_EDITOR_SETTINGS);
});
