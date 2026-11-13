import { DEFAULT_CONFIG, isUiScale, type UiScale } from "@thinkrail/contracts";
import {
	asStablePreferenceAdapter,
	getStablePreferenceAdapter,
	type StablePreferenceAdapter,
} from "../clientPreferences";
import { STORAGE_PREFIX } from "../constants/branding";

const HINT_KEY = `${STORAGE_PREFIX}ui-scale`;

/**
 * The selected UI scale is one attribute on `<html>`. Everything generated reads it from there: the type
 * ladder and the code row (`generated/typography.css`), the space ladder and Tailwind's spacing unit
 * (`generated/spacing.css`), and the row heights in `tokens.css`. The surfaces that cannot use a class —
 * Monaco, xterm, Pierre — read those same scaled tokens, so a scale never splits text from its own metrics.
 *
 * Applied synchronously where the config lands, not from a render: a component that reads a scaled token
 * during render must never see the previous scale.
 */
export function applyUiScale(scale: UiScale): void {
	if (typeof document !== "undefined") {
		const root = document.documentElement;
		if (scale === DEFAULT_CONFIG.uiScale) delete root.dataset.uiScale;
		else root.dataset.uiScale = scale;
	}
	try {
		uiScaleStorage()?.setItem(HINT_KEY, scale);
	} catch {
		return;
	}
}

/** The last scale this client applied, so a restart never paints the whole interface at another size first. */
export function readUiScaleHint(): UiScale {
	try {
		const value = uiScaleStorage()?.getItem(HINT_KEY);
		return isUiScale(value) ? value : DEFAULT_CONFIG.uiScale;
	} catch {
		return DEFAULT_CONFIG.uiScale;
	}
}

function uiScaleStorage(): StablePreferenceAdapter | null {
	return (
		getStablePreferenceAdapter() ??
		asStablePreferenceAdapter(Reflect.get(globalThis, "localStorage"))
	);
}
