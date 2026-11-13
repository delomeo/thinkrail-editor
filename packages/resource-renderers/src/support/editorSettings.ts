import { type EditorSettings, mergeEditorSettings } from "@thinkrail/contracts";

type SettingsListener = (settings: EditorSettings) => void;

const listeners = new Set<SettingsListener>();

/** Merge a user or host settings blob over `defaultEditorSettings.json`, clamping every opacity. */
export function resolveEditorSettings(value: unknown): EditorSettings {
	return mergeEditorSettings(undefined, value);
}

let published: EditorSettings = resolveEditorSettings(undefined);
let publishedRaw: unknown = null;

/** The settings every live editor paints with right now. */
export function currentEditorSettings(): EditorSettings {
	return published;
}

/** Store a host's editor settings and tell every active editor to repaint with them. */
export function publishEditorSettings(value: unknown): void {
	if (value === publishedRaw) return;
	publishedRaw = value;
	published = resolveEditorSettings(value);
	for (const listener of listeners) listener(published);
}

export function subscribeEditorSettings(listener: SettingsListener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
