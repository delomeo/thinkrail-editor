import { describe, expect, it } from "bun:test";
import { UI_SCALE_ATTRIBUTE } from "../../scripts/typography";
import { applyUiScale, readUiScaleHint } from "./uiScale";

/** `<html>.dataset` answers the `data-ui-scale` attribute the generated blocks select on, in camelCase. */
function datasetKey(attribute: string): string {
	return attribute
		.slice("data-".length)
		.replace(/-(\w)/g, (_: string, letter: string) => letter.toUpperCase());
}

const DATASET_KEY = datasetKey(UI_SCALE_ATTRIBUTE);

function withDocument(run: (dataset: Record<string, string>) => void): void {
	const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
	const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	const dataset: Record<string, string> = {};
	const stored: Record<string, string> = {};
	try {
		Object.defineProperty(globalThis, "document", {
			configurable: true,
			value: { documentElement: { dataset } },
		});
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: {
				getItem: (key: string) => stored[key] ?? null,
				setItem: (key: string, value: string) => {
					stored[key] = value;
				},
				removeItem: (key: string) => {
					delete stored[key];
				},
			},
		});
		run(dataset);
	} finally {
		if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
		else Reflect.deleteProperty(globalThis, "document");
		if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
		else Reflect.deleteProperty(globalThis, "localStorage");
	}
}

describe("ui scale application", () => {
	it("selects the generated scale block and remembers it for the next first paint", () => {
		withDocument((dataset) => {
			applyUiScale("large");
			expect(dataset[DATASET_KEY]).toBe("large");
			expect(readUiScaleHint()).toBe("large");

			applyUiScale("default");
			expect(dataset[DATASET_KEY]).toBeUndefined();
			expect(readUiScaleHint()).toBe("default");
		});
	});
});
