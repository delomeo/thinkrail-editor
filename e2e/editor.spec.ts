import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
	createWorkspaceViaDialog,
	openFixtureProject,
	platformModifier,
	revealWorkbenchTool,
} from "./fixtures/app";
import { languageServerNodeAvailable } from "./fixtures/executables";
import { asciiPdf, lfsPointer } from "./fixtures/repo";

test("opens a file in a center Monaco tab, focuses on re-open, and closes", async ({ page }) => {
	await openFixtureProject(page);

	await createWorkspaceViaDialog(page);
	const chatTab = page.locator('[data-testid="editor-tab"][data-kind="chat"]');
	await chatTab.hover();
	await chatTab.getByTestId("editor-tab-close").click();
	await expect(chatTab).toHaveCount(0);
	await revealWorkbenchTool(page, "files");
	const readme = page.getByTestId("file-node").filter({ hasText: "README.md" });
	await expect(readme).toBeVisible();

	await readme.dblclick();
	await expect(page.getByTestId("editor-tab").filter({ hasText: "README.md" })).toBeVisible();
	await expect(page.getByTestId("markdown-preview")).toContainText("sample-project");
	await expect(page.getByTestId("view-toggle-markdown")).toHaveAttribute("data-active", "true");

	await page.getByTestId("view-toggle-code").click();
	await expect(page.getByTestId("markdown-preview")).toHaveCount(0);
	await expect(page.getByTestId("editor-pane")).toContainText("# sample-project");
	await page.getByTestId("view-toggle-markdown").click();
	await expect(page.getByTestId("markdown-preview")).toContainText("sample-project");

	await readme.dblclick();
	await expect(page.getByTestId("editor-tab")).toHaveCount(1);

	const tab = page.getByTestId("editor-tab");
	await tab.hover();
	await tab.getByTestId("editor-tab-close").click();
	await expect(page.getByTestId("editor-tab")).toHaveCount(0);
	await expect(page.getByTestId("workspace-ready")).toContainText("Workspace ready");
	await expect(page.getByTestId("workspace-ready")).toContainText(
		"Files, chats, changes, and terminals are scoped to this workspace",
	);
});

test("hides YAML frontmatter in the rendered view but shows it in source", async ({ page }) => {
	await openFixtureProject(page);
	await createWorkspaceViaDialog(page);
	await revealWorkbenchTool(page, "files");

	const spec = page.getByTestId("file-node").filter({ hasText: "SPEC.md" });
	await expect(spec).toBeVisible();
	await spec.dblclick();

	const preview = page.getByTestId("markdown-preview");
	await expect(preview).toContainText("Goal");
	await expect(preview).not.toContainText("goal-and-requirements");
	await expect(preview).not.toContainText("id: sample-root");

	await page.getByTestId("view-toggle-code").click();
	await expect(page.getByTestId("markdown-preview")).toHaveCount(0);
	await expect(page.getByTestId("editor-pane")).toContainText("id: sample-root");
});

test("opens a non-markdown file straight to Monaco with no rendered-view toggle", async ({
	page,
}) => {
	await openFixtureProject(page);
	await createWorkspaceViaDialog(page);
	await revealWorkbenchTool(page, "files");

	const notes = page.getByTestId("file-node").filter({ hasText: "notes.txt" });
	await expect(notes).toBeVisible();
	await notes.dblclick();

	await expect(page.getByTestId("editor-tab").filter({ hasText: "notes.txt" })).toBeVisible();
	await expect(page.getByTestId("editor-pane")).toContainText("plain-text-fixture");
	await expect(page.getByTestId("resource-view-toggle")).toHaveCount(0);
	await expect(page.getByTestId("markdown-preview")).toHaveCount(0);
});

test("opens JSON with Tree and Source candidates, defaulting to Tree", async ({ page }) => {
	await openFixtureProject(page);
	const workspace = await createWorkspaceViaDialog(page);
	await revealWorkbenchTool(page, "files");

	await page.getByTestId("file-node").filter({ hasText: "sample.json" }).dblclick();
	await expect(page.getByTestId("view-toggle-json")).toHaveAttribute("data-active", "true");
	await expect(page.getByTestId("view-toggle-code")).toBeVisible();
	await expect(page.getByTestId("json-view")).toContainText("sample-project");
	await expect(page.getByTestId("json-dialect")).toHaveCount(0);

	const jsonPath = join(workspace.worktreePath, "sample.json");
	writeFileSync(jsonPath, '{\n  // a note\n  "project": "sample-project",\n}\n');
	await expect(page.getByTestId("json-dialect")).toContainText("Parsed as JSONC");
	await expect(page.getByTestId("json-view")).toContainText("sample-project");

	writeFileSync(jsonPath, "{ not json");
	await expect(page.getByTestId("json-invalid")).toContainText("Not valid JSON");
	await page.getByTestId("view-toggle-code").click();
	await expect(page.locator(".monaco-editor").first()).toBeVisible();
});

test("opens CSV with Table and Source candidates, defaulting to Table", async ({ page }) => {
	await openFixtureProject(page);
	await createWorkspaceViaDialog(page);
	await revealWorkbenchTool(page, "files");

	await page.getByTestId("file-node").filter({ hasText: "sample.csv" }).dblclick();
	await expect(page.getByTestId("view-toggle-csv")).toHaveAttribute("data-active", "true");
	await expect(page.getByTestId("view-toggle-code")).toBeVisible();
	await expect(page.getByTestId("csv-view")).toContainText("Table");
});

test("opens a notebook with Notebook and Source candidates", async ({ page }) => {
	await openFixtureProject(page);
	await createWorkspaceViaDialog(page);
	await revealWorkbenchTool(page, "files");

	await page.getByTestId("file-node").filter({ hasText: "sample.ipynb" }).dblclick();
	await expect(page.getByTestId("view-toggle-notebook")).toHaveAttribute("data-active", "true");
	await expect(page.getByTestId("view-toggle-code")).toBeVisible();
	await expect(page.getByTestId("notebook-view")).toContainText("Notebook fixture");
	await expect(page.getByTestId("notebook-view")).toContainText("notebook-output");
	const cellImage = page.getByTestId("notebook-view").locator('img[alt="fixture-logo"]');
	await expect(cellImage).toHaveAttribute("src", /\/files\/[^/]+\/logo\.png$/);
	await expect
		.poll(() => cellImage.evaluate((el: HTMLImageElement) => el.naturalWidth))
		.toBeGreaterThan(0);
});

test("opens an HTML preview with active content disabled", async ({ page }) => {
	await openFixtureProject(page);
	await createWorkspaceViaDialog(page);
	await revealWorkbenchTool(page, "files");

	await page.getByTestId("file-node").filter({ hasText: "sample.html" }).dblclick();
	await expect(page.getByTestId("view-toggle-html")).toHaveAttribute("data-active", "true");
	await expect(page.getByTestId("view-toggle-code")).toBeVisible();
	await expect(page.getByTestId("html-disabled-notice")).toContainText(
		"Scripts and external resources are disabled",
	);
});

test("opens an uncompressed PDF in the PDF renderer and its change in the PDF diff", async ({
	page,
}) => {
	await openFixtureProject(page);
	const workspace = await createWorkspaceViaDialog(page);
	await revealWorkbenchTool(page, "files");

	await page.getByTestId("file-node").filter({ hasText: "RENDERERS.pdf" }).dblclick();
	await expect(page.getByTestId("view-toggle-pdf")).toHaveAttribute("data-active", "true");
	await expect(page.getByTestId("view-toggle-binary")).toBeVisible();
	const firstPage = page.getByTestId("pdf-view").locator("canvas").first();
	await expect(firstPage).toBeVisible();
	await expect
		.poll(() =>
			firstPage.evaluate((element) => {
				const canvas = element as HTMLCanvasElement;
				const pixels = canvas
					.getContext("2d")
					?.getImageData(0, 0, canvas.width, canvas.height).data;
				if (!pixels) return 0;
				let drawn = 0;
				for (let index = 0; index < pixels.length; index += 4) {
					if (pixels[index] < 240) drawn += 1;
				}
				return drawn;
			}),
		)
		.toBeGreaterThan(100);

	writeFileSync(join(workspace.worktreePath, "RENDERERS.pdf"), asciiPdf("CHANGED PDF FIXTURE"));
	await revealWorkbenchTool(page, "changes");
	await page.getByTestId("change-item").filter({ hasText: "RENDERERS.pdf" }).dblclick();
	await expect(page.getByTestId("pdf-diff")).toBeVisible();
	await expect(page.getByTestId("pdf-diff-page")).toHaveCount(1);
});

test("a Git LFS pointer shows as a card in the view and per side in the diff, with Source one toggle away", async ({
	page,
}) => {
	await openFixtureProject(page);
	const workspace = await createWorkspaceViaDialog(page);
	await revealWorkbenchTool(page, "files");

	await page.getByTestId("file-node").filter({ hasText: "LFS-ASSET.png" }).dblclick();
	await expect(page.getByTestId("view-toggle-lfs")).toHaveAttribute("data-active", "true");
	await expect(page.getByTestId("lfs-pointer")).toContainText("Stored in Git LFS");
	await expect(page.getByTestId("lfs-pointer-size")).toHaveText("12 KB");
	await page.getByTestId("view-toggle-code").click();
	await expect(page.getByTestId("editor-pane")).toContainText("oid sha256:4d7a");

	writeFileSync(join(workspace.worktreePath, "LFS-ASSET.png"), lfsPointer("beef", 4_000_000));
	await revealWorkbenchTool(page, "changes");
	await page.getByTestId("change-item").filter({ hasText: "LFS-ASSET.png" }).dblclick();
	await expect(page.getByTestId("lfs-diff")).toBeVisible();
	await expect(page.getByTestId("lfs-pointer-original-size")).toHaveText("12 KB");
	await expect(page.getByTestId("lfs-pointer-modified-size")).toHaveText("3.8 MB");
});

test("renders a PNG and opens its changed version in the 2-up image diff", async ({ page }) => {
	await openFixtureProject(page);
	const workspace = await createWorkspaceViaDialog(page);
	await revealWorkbenchTool(page, "files");

	await page.getByTestId("file-node").filter({ hasText: "RENDERERS.png" }).dblclick();
	await expect(page.getByTestId("view-toggle-image")).toHaveAttribute("data-active", "true");
	await expect(page.getByTestId("image-resource")).toBeVisible();

	const imagePath = join(workspace.worktreePath, "RENDERERS.png");
	writeFileSync(imagePath, Buffer.concat([readFileSync(imagePath), Buffer.from("changed")]));
	await revealWorkbenchTool(page, "changes");
	await page.getByTestId("change-item").filter({ hasText: "RENDERERS.png" }).dblclick();
	await expect(page.getByTestId("image-diff-mode")).toBeVisible();
	await expect(page.getByTestId("image-diff-2-up")).toHaveAttribute("data-active", "true");
});

const longSource = (label: string) =>
	`${Array.from({ length: 400 }, (_, index) => `export const ${label}${index} = ${index};`).join("\n")}\n`;

function visibleEditor(page: Page) {
	return page.locator('[data-testid="editor-pane"]:visible .monaco-editor');
}

async function firstVisibleLine(page: Page) {
	return visibleEditor(page)
		.locator(".margin-view-overlays .line-numbers")
		.evaluateAll((nodes) => {
			const rows = nodes.map((node) => ({
				line: Number(node.textContent),
				top: node.parentElement?.getBoundingClientRect().top ?? 0,
			}));
			rows.sort((a, b) => a.top - b.top);
			return rows[0]?.line ?? 0;
		});
}

test("Monaco restores scroll across a tab switch", async ({ page }) => {
	await openFixtureProject(page);
	const workspace = await createWorkspaceViaDialog(page);
	writeFileSync(join(workspace.worktreePath, "long.ts"), longSource("row"));
	await revealWorkbenchTool(page, "files");

	await page.getByTestId("file-node").filter({ hasText: "long.ts" }).dblclick();
	await expect(visibleEditor(page)).toContainText("row0");
	await visibleEditor(page).getByText("export const row2 = 2;", { exact: true }).click();
	for (let step = 0; step < 4; step += 1) await page.keyboard.press("PageDown");
	let scrolledTo = 0;
	await expect
		.poll(async () => {
			const before = scrolledTo;
			scrolledTo = await firstVisibleLine(page);
			return scrolledTo > 50 && scrolledTo === before;
		})
		.toBe(true);

	await page.getByTestId("file-node").filter({ hasText: "notes.txt" }).dblclick();
	await expect(visibleEditor(page)).toContainText("plain-text-fixture");
	await page.getByTestId("editor-tab").filter({ hasText: "long.ts" }).click();
	await expect(visibleEditor(page)).toContainText(`row${scrolledTo - 1} `);
	expect(await firstVisibleLine(page)).toBe(scrolledTo);
});

test("closing and reopening a file tab mounts exactly one Monaco editor without page errors", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await openFixtureProject(page);
	await createWorkspaceViaDialog(page);
	await revealWorkbenchTool(page, "files");
	const notes = page.getByTestId("file-node").filter({ hasText: "notes.txt" });

	await notes.dblclick();
	await expect(visibleEditor(page)).toContainText("plain-text-fixture");
	const tab = page.getByTestId("editor-tab").filter({ hasText: "notes.txt" });
	await tab.hover();
	await tab.getByTestId("editor-tab-close").click();
	await expect(tab).toHaveCount(0);
	await expect(page.locator(".monaco-editor")).toHaveCount(0);

	await notes.dblclick();
	await expect(visibleEditor(page)).toContainText("plain-text-fixture");
	await expect(page.locator(".monaco-editor")).toHaveCount(1);
	expect(pageErrors).toEqual([]);
});

test("an on-disk change updates the open Monaco editor in place", async ({ page }) => {
	await openFixtureProject(page);
	const workspace = await createWorkspaceViaDialog(page);
	const path = join(workspace.worktreePath, "live.ts");
	writeFileSync(path, "export const before = 1;\n");
	await revealWorkbenchTool(page, "files");

	await page.getByTestId("file-node").filter({ hasText: "live.ts" }).dblclick();
	await expect(visibleEditor(page)).toContainText("before");
	await visibleEditor(page).evaluate((node) => {
		node.setAttribute("data-e2e-mount", "first");
	});

	writeFileSync(path, "export const after = 2;\n");
	await expect(visibleEditor(page)).toContainText("after", { timeout: 10_000 });
	await expect(visibleEditor(page)).not.toContainText("before");
	await expect(visibleEditor(page)).toHaveAttribute("data-e2e-mount", "first");
});

test("typing in a file tab marks it dirty, and the topbar Save or the editor's own chord writes the disk copy", async ({
	page,
}) => {
	await openFixtureProject(page);
	const workspace = await createWorkspaceViaDialog(page);
	const path = join(workspace.worktreePath, "buffer.ts");
	writeFileSync(path, "export const onDisk = 1;\n");
	await revealWorkbenchTool(page, "files");

	await page.getByTestId("file-node").filter({ hasText: "buffer.ts" }).dblclick();
	const tab = page.getByTestId("editor-tab").filter({ hasText: "buffer.ts" });
	await expect(tab).toBeVisible();
	await expect(tab.getByTestId("file-tab-dirty")).toHaveCount(0);

	const typeReplacement = async (text: string) => {
		await visibleEditor(page).locator(".view-lines").click();
		await page.keyboard.press("ControlOrMeta+A");
		await page.keyboard.type(text);
		await expect(visibleEditor(page)).toContainText(text);
		await expect(tab.getByTestId("file-tab-dirty")).toBeVisible();
	};

	await typeReplacement("export const typed = 2;");
	await page.getByTestId("scope-file").click();
	await page.getByTestId("scope-file-save").click();
	await expect
		.poll(() => readFileSync(path, "utf8"), { timeout: 10_000 })
		.toBe("export const typed = 2;");
	await expect(tab.getByTestId("file-tab-dirty")).toHaveCount(0);
	await expect(visibleEditor(page)).toContainText("typed = 2");

	await typeReplacement("export const savedByKey = 3;");
	await page.keyboard.press("ControlOrMeta+S");
	await expect
		.poll(() => readFileSync(path, "utf8"), { timeout: 10_000 })
		.toContain("savedByKey = 3");
	await expect(tab.getByTestId("file-tab-dirty")).toHaveCount(0);
});

/* ------------------------------------------------------------------ typed pairs
 * A typed mark closes itself with the caret left between the pair, in a comment exactly as in code, and
 * Enter carries the indentation of the line it left. TOML is asked for on purpose: no language server serves
 * it, so nothing here can pop a completion widget in front of an Enter. */

const PAIRS: readonly (readonly [string, string, string])[] = [
	["(", "a", ")"],
	["[", "b", "]"],
	["{", "c", "}"],
	['"', "d", '"'],
	["'", "e", "'"],
];

const typedPairSource = `# (a)[b]{c}"d"'e'
(a)[b]{c}"d"'e'
  keep
  x`;

test("typing a quote or bracket closes it around the caret, in a comment and in code, and Enter keeps the indent", async ({
	page,
}) => {
	await openFixtureProject(page);
	const workspace = await createWorkspaceViaDialog(page);
	const path = join(workspace.worktreePath, "autoclose.toml");
	writeFileSync(path, "");
	await revealWorkbenchTool(page, "files");
	await page.getByTestId("file-node").filter({ hasText: "autoclose.toml" }).dblclick();
	const tab = page.getByTestId("editor-tab").filter({ hasText: "autoclose.toml" });
	await expect(tab).toBeVisible();

	// The caret is only provably between the pair when the character typed next lands there, and typing the
	// closing mark steps over the one already written instead of adding a second.
	const typePairs = async () => {
		for (const [open, inner, close] of PAIRS) {
			await page.keyboard.type(open);
			await page.keyboard.type(inner);
			await page.keyboard.type(close);
		}
	};

	await visibleEditor(page).locator(".view-lines").click();
	await page.keyboard.type("# ");
	await typePairs();
	await page.keyboard.press("Enter");
	await typePairs();
	await page.keyboard.press("Enter");
	await page.keyboard.type("  keep");
	await page.keyboard.press("Enter");
	await page.keyboard.type("x");

	await page.keyboard.press("ControlOrMeta+S");
	await expect(tab.getByTestId("file-tab-dirty")).toHaveCount(0);
	// The model's own line ending is not part of what is under test here.
	const saved = () => readFileSync(path, "utf8").replaceAll("\r\n", "\n");
	await expect.poll(saved, { timeout: 10_000 }).toBe(typedPairSource);
});

/* ------------------------------------------------------------------ go to definition
 * The host's language server answers; Monaco draws the link, the jump and the Peek pop-up; the app opens the
 * file a jump named. A language-server child is a Node program the host spawns, so a machine without one
 * runs none of this. */

const noLanguageServer = "the host needs a Node executable to run a language server";

// `target` is defined once and used twice: a click on a use goes to the definition, and a click on the
// definition itself — already the only definition — finds the references instead.
const definitionSource = `export function target(value: number): number {
\treturn value;
}

export const first = target(1);
export const second = target(2);
`;

const librarySource = `export const shown = console.log("start");
`;

const moduleSource = `export function unused(): void {}

export const sharedValue = 1;
`;

const importSource = `import { sharedValue } from "./shared";

export const total = sharedValue + 1;
`;

/**
 * The middle of a token's own pixels. A go-to-definition gesture needs the mouse *on the word*, and Monaco
 * merges adjacent same-style tokens into one span, so a token is not always its own element. The rendered
 * spans are monospace: their widths over their own text is the width of one character.
 */
async function tokenPoint(
	page: Page,
	lineText: string,
	token: string,
): Promise<{ x: number; y: number }> {
	const deadline = Date.now() + 20_000;
	for (;;) {
		const point = await visibleEditor(page)
			.locator(".view-lines .view-line")
			.filter({ hasText: lineText })
			.first()
			.evaluate((node, token) => {
				const spans = Array.from(node.querySelectorAll<HTMLElement>("span")).filter(
					(span) => (span.textContent?.length ?? 0) > 0,
				);
				const characters = spans.reduce(
					(total, span) => total + (span.textContent?.length ?? 0),
					0,
				);
				const pixels = spans.reduce((total, span) => total + span.getBoundingClientRect().width, 0);
				const text = node.textContent ?? "";
				const box = node.getBoundingClientRect();
				const index = text.indexOf(token);
				// An editor that has not measured itself yet lays out at zero width, and a point at zero is a
				// click on nothing.
				if (characters === 0 || pixels === 0 || box.width === 0 || index < 0) return null;
				return {
					x: box.left + (index + token.length / 2) * (pixels / characters),
					y: box.top + box.height / 2,
				};
			}, token);
		if (point !== null) return point;
		if (Date.now() > deadline) throw new Error(`no ${token} on a line matching ${lineText}`);
		await page.waitForTimeout(200);
	}
}

/** Click a point in the editor's text through Playwright's own click pipeline: a raw `mouse.down`/`mouse.up`
 * pair at a point Monaco has not been moved to does not arm its link gesture. */
async function clickPoint(page: Page, point: { x: number; y: number }): Promise<void> {
	const lines = visibleEditor(page).locator(".view-lines");
	const box = await lines.boundingBox();
	if (!box) throw new Error("no rendered text to click");
	await lines.click({ position: { x: point.x - box.x, y: point.y - box.y } });
}

/** Hold the primary modifier, move onto a token, and let Monaco underline it before clicking. */
async function modifierClickOn(
	page: Page,
	modifier: string,
	point: { x: number; y: number },
): Promise<void> {
	await page.keyboard.down(modifier);
	await page.mouse.move(point.x, point.y);
	await expect(visibleEditor(page).locator(".goto-definition-link").first()).toBeVisible({
		timeout: 20_000,
	});
	await clickPoint(page, point);
}

const activeLine = (page: Page) => visibleEditor(page).locator(".line-numbers.active-line-number");
const peekWidget = (page: Page) =>
	page.locator('[data-testid="editor-pane"] .reference-zone-widget');

async function openCodeFile(
	page: Page,
	worktreePath: string,
	name: string,
	text: string,
): Promise<void> {
	writeFileSync(join(worktreePath, name), text);
	await revealWorkbenchTool(page, "files");
	await page.getByTestId("file-node").filter({ hasText: name }).dblclick();
	await expect(visibleEditor(page)).toContainText(text.split("\n")[0] as string);
}

test("Ctrl+hover underlines a symbol, Ctrl+Click jumps to its definition in the same file, and Ctrl+Click on the definition itself peeks its references", async ({
	page,
}) => {
	test.skip(!languageServerNodeAvailable(), noLanguageServer);
	await openFixtureProject(page);
	const workspace = await createWorkspaceViaDialog(page);
	await openCodeFile(page, workspace.worktreePath, "navigate.ts", definitionSource);

	const modifier = await platformModifier(page);
	await modifierClickOn(page, modifier, await tokenPoint(page, "export const first", "target"));
	// The definition is the first line of the file.
	await expect(activeLine(page)).toHaveText(/^\s*1$/, { timeout: 20_000 });

	// Clicking where the definition already is asks for the references, and there are three.
	await clickPoint(page, await tokenPoint(page, "export function target", "target"));
	await expect(peekWidget(page)).toBeVisible({ timeout: 20_000 });
	await page.keyboard.up(modifier);
});

test("Ctrl+Click on an imported name opens the file that defines it, at the definition line", async ({
	page,
}) => {
	test.skip(!languageServerNodeAvailable(), noLanguageServer);
	await openFixtureProject(page);
	const workspace = await createWorkspaceViaDialog(page);
	writeFileSync(join(workspace.worktreePath, "shared.ts"), moduleSource);
	await openCodeFile(page, workspace.worktreePath, "consumer.ts", importSource);

	const modifier = await platformModifier(page);
	// The underline of a symbol defined in another file is the preview of a file nothing had opened yet.
	await modifierClickOn(
		page,
		modifier,
		await tokenPoint(page, "export const total", "sharedValue"),
	);

	await expect(page.getByTestId("editor-tab").filter({ hasText: "shared.ts" })).toBeVisible({
		timeout: 20_000,
	});
	await expect(visibleEditor(page)).toContainText("export const sharedValue = 1;");
	// Its definition is the third line of that file.
	await expect(activeLine(page)).toHaveText(/^\s*3$/, { timeout: 20_000 });
});

test("Ctrl+Click on a standard-library member opens the declaration file the language server resolved, read-only and at its line", async ({
	page,
}) => {
	test.skip(!languageServerNodeAvailable(), noLanguageServer);
	await openFixtureProject(page);
	const workspace = await createWorkspaceViaDialog(page);
	await openCodeFile(page, workspace.worktreePath, "library.ts", librarySource);

	const modifier = await platformModifier(page);
	await modifierClickOn(page, modifier, await tokenPoint(page, "export const shown", "log"));

	// The host's own TypeScript install, outside this worktree: the only files outside a worktree the host
	// will read are the library files a resolver named.
	const tab = page.getByTestId("editor-tab").filter({ hasText: "lib.dom.d.ts" });
	await expect(tab).toBeVisible({ timeout: 20_000 });
	// The jumped-to line is the only place that declaration is rendered, so seeing it is the reveal.
	await expect(visibleEditor(page)).toContainText("log(...data: any[]): void;", {
		timeout: 20_000,
	});
	// A file with no worktree to save back to is a read: typing changes nothing and marks nothing dirty.
	await clickPoint(page, await tokenPoint(page, "log(...data: any[]): void;", "data"));
	await page.keyboard.type("unchanged");
	await expect(visibleEditor(page)).toContainText("log(...data: any[]): void;", { timeout: 5_000 });
	await expect(tab.getByTestId("file-tab-dirty")).toHaveCount(0);
});

/* ------------------------------------------------------------------ word jumps
 * The caret is asserted through where a typed marker lands, which is the column a jump actually left it at:
 * one character at a time would put the marker inside the word, and a jump that ran on to the next token
 * would put it past the space or the bracket. */

const wordJumpSource = `import os
foo_bar(baz, qux)
select me
`;

test("Ctrl+Arrow moves the caret a whole word at a time, and Ctrl+Shift+Arrow selects those words", async ({
	page,
}) => {
	await openFixtureProject(page);
	const workspace = await createWorkspaceViaDialog(page);
	await openCodeFile(page, workspace.worktreePath, "words.txt", wordJumpSource);

	const placeAtLineStart = async (lineText: string) => {
		await visibleEditor(page).getByText(lineText, { exact: true }).click();
		await page.keyboard.press("Home");
	};

	await placeAtLineStart("import os");
	await page.keyboard.press("ControlOrMeta+ArrowRight");
	await page.keyboard.type("X");
	await expect(visibleEditor(page)).toContainText("importX os");
	await page.keyboard.press("ControlOrMeta+ArrowLeft");
	await page.keyboard.type("Z");
	await expect(visibleEditor(page)).toContainText("ZimportX os");

	// Identifier, then the bracket: a single separator followed by a name is crossed, not stopped at.
	await placeAtLineStart("foo_bar(baz, qux)");
	await page.keyboard.press("ControlOrMeta+ArrowRight");
	await page.keyboard.type("1");
	await expect(visibleEditor(page)).toContainText("foo_bar1(baz, qux)");
	await page.keyboard.press("ControlOrMeta+ArrowRight");
	await page.keyboard.type("2");
	await expect(visibleEditor(page)).toContainText("foo_bar1(baz2, qux)");
	await page.keyboard.press("ControlOrMeta+ArrowLeft");
	await page.keyboard.type("3");
	// Back to the start of the word the previous jump crossed, not one character left of the caret.
	await expect(visibleEditor(page)).toContainText("foo_bar1(3baz2, qux)");

	// The selection chord selects up to the end of the next word, so typing replaces exactly that.
	await placeAtLineStart("select me");
	await page.keyboard.press("ControlOrMeta+Shift+ArrowRight");
	await page.keyboard.type("Q");
	await expect(visibleEditor(page)).toContainText("Q me");
	await page.keyboard.press("ControlOrMeta+Shift+ArrowLeft");
	await page.keyboard.type("W");
	await expect(visibleEditor(page)).toContainText("W me");
});

/* ------------------------------------------------------------------ unsaved closes
 * A tab that holds text the disk does not is asked before it goes: the answer decides whether the buffer is
 * written first, dropped, or left alone. */

const dirtyFileName = "unsaved.ts";
const dirtyFileSource = "export const keep = 1;\n";

async function openDirtyFile(
	page: Page,
	worktreePath: string,
): Promise<{ path: string; tab: Locator }> {
	const path = join(worktreePath, dirtyFileName);
	writeFileSync(path, dirtyFileSource);
	await revealWorkbenchTool(page, "files");
	await page.getByTestId("file-node").filter({ hasText: dirtyFileName }).dblclick();
	const tab = page.getByTestId("editor-tab").filter({ hasText: dirtyFileName });
	await expect(tab).toBeVisible();
	await visibleEditor(page).getByText("export const keep = 1;", { exact: true }).click();
	await page.keyboard.press("End");
	await page.keyboard.type(" edited");
	await expect(tab.getByTestId("file-tab-dirty")).toBeVisible();
	return { path, tab };
}

const closeDialog = (page: Page) => page.getByTestId("unsaved-changes-dialog");

test("closing a dirty file tab asks first, and Cancel leaves the pane, the text, and the dirty mark", async ({
	page,
}) => {
	await openFixtureProject(page);
	const workspace = await createWorkspaceViaDialog(page);
	const { path, tab } = await openDirtyFile(page, workspace.worktreePath);

	await tab.hover();
	await tab.getByTestId("editor-tab-close").click();

	// Nothing was closed: the pane, its text, and the disk copy are all still where they were.
	await expect(closeDialog(page)).toBeVisible();
	await expect(closeDialog(page)).toContainText(dirtyFileName);
	await expect(tab).toBeVisible();
	await expect(visibleEditor(page)).toContainText("edited");
	expect(readFileSync(path, "utf8")).toBe(dirtyFileSource);

	await closeDialog(page).getByTestId("file-close-cancel").click();
	await expect(closeDialog(page)).toHaveCount(0);
	await expect(tab).toBeVisible();
	await expect(visibleEditor(page)).toContainText("edited");
	await expect(tab.getByTestId("file-tab-dirty")).toBeVisible();

	// Escape is the same answer, and it goes back to whatever asked for the close.
	await tab.hover();
	await tab.getByTestId("editor-tab-close").click();
	await expect(closeDialog(page)).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(closeDialog(page)).toHaveCount(0);
	await expect(tab.getByTestId("file-tab-dirty")).toBeVisible();

	// A tab with no unsaved text is not asked at all.
	await page.keyboard.press("ControlOrMeta+S");
	await expect(tab.getByTestId("file-tab-dirty")).toHaveCount(0);
	await tab.hover();
	await tab.getByTestId("editor-tab-close").click();
	await expect(closeDialog(page)).toHaveCount(0);
	await expect(tab).toHaveCount(0);
});

test("Save and close writes the disk copy first, and Don't save drops the buffer for the next read", async ({
	page,
}) => {
	await openFixtureProject(page);
	const workspace = await createWorkspaceViaDialog(page);
	const { path, tab } = await openDirtyFile(page, workspace.worktreePath);

	await tab.hover();
	await tab.getByTestId("editor-tab-close").click();
	await closeDialog(page).getByTestId("file-close-discard").click();
	await expect(closeDialog(page)).toHaveCount(0);
	await expect(tab).toHaveCount(0);
	expect(readFileSync(path, "utf8")).toBe(dirtyFileSource);

	// Re-opening the discarded file reads the disk copy: the buffer it held is gone with its tab.
	const reopened = page.getByTestId("editor-tab").filter({ hasText: dirtyFileName });
	await page.getByTestId("file-node").filter({ hasText: dirtyFileName }).dblclick();
	await expect(reopened).toBeVisible();
	await expect(visibleEditor(page)).toContainText("export const keep = 1;");
	await expect(visibleEditor(page)).not.toContainText("edited");
	await expect(reopened.getByTestId("file-tab-dirty")).toHaveCount(0);

	await visibleEditor(page).getByText("export const keep = 1;", { exact: true }).click();
	await page.keyboard.press("End");
	await page.keyboard.type(" saved");
	await expect(reopened.getByTestId("file-tab-dirty")).toBeVisible();

	await reopened.hover();
	await reopened.getByTestId("editor-tab-close").click();
	await closeDialog(page).getByTestId("file-close-save").click();
	await expect(reopened).toHaveCount(0);
	await expect(closeDialog(page)).toHaveCount(0);
	await expect
		.poll(() => readFileSync(path, "utf8"), { timeout: 10_000 })
		.toBe("export const keep = 1; saved\n");
});

const NESTED_INDENT_SOURCE = [
	"def outer(values):",
	"    if values:",
	"        for value in values:",
	"            if value:",
	"                while value:",
	"                    return value",
	"",
].join("\n");

// Two-space indentation, so the step width must follow the file rather than a fixed four.
const NESTED_TWO_SPACE_SOURCE = [
	"export function outer(values: number[]): number | undefined {",
	"  for (const value of values) {",
	"    if (value) {",
	"      try {",
	"        return value;",
	"      } catch {",
	"        return undefined;",
	"      }",
	"    }",
	"  }",
	"}",
	"",
].join("\n");

test("colours each indentation step of a nested file with four alternating vertical guides", async ({
	page,
}) => {
	await openFixtureProject(page);
	const workspace = await createWorkspaceViaDialog(page);
	writeFileSync(join(workspace.worktreePath, "nested.py"), NESTED_INDENT_SOURCE);
	await revealWorkbenchTool(page, "files");

	await page.getByTestId("file-node").filter({ hasText: "nested.py" }).dblclick();
	const editor = page.locator('[data-testid="editor-pane"]:visible .monaco-editor').first();
	await expect(editor).toBeVisible();
	await expect(editor).toContainText("return value");

	for (const step of [0, 1, 2, 3]) {
		await expect(editor.locator(`.tr-indent-step-${step}`).first()).toBeVisible();
	}
	// The colourized guides replace Monaco's monochrome set rather than drawing beside it.
	await expect(editor.locator(".core-guide-indent")).toHaveCount(0);

	const guides = await editor.evaluate((root) =>
		[0, 1, 2, 3].map((step) => {
			const node = root.querySelector(`.tr-indent-step-${step}`);
			if (node === null) return null;
			const style = getComputedStyle(node);
			return {
				borderLeftWidth: style.borderLeftWidth,
				borderLeftColor: style.borderLeftColor,
				backgroundColor: style.backgroundColor,
			};
		}),
	);

	for (const guide of guides) {
		expect(guide).not.toBeNull();
		// The default style draws the vertical line only: no filled indentation block.
		expect(guide?.borderLeftWidth).toBe("1px");
		expect(guide?.borderLeftColor).not.toBe("rgba(0, 0, 0, 0)");
		expect(guide?.backgroundColor).toBe("rgba(0, 0, 0, 0)");
	}
	expect(new Set(guides.map((guide) => guide?.borderLeftColor)).size).toBe(4);

	// The step width is the model's own: a two-space file cycles the same palette at half the columns.
	writeFileSync(join(workspace.worktreePath, "nested.ts"), NESTED_TWO_SPACE_SOURCE);
	await page.getByTestId("file-node").filter({ hasText: "nested.ts" }).dblclick();
	const wrapped = page.locator('[data-testid="editor-pane"]:visible .monaco-editor').first();
	await expect(wrapped).toContainText("return value");
	await expect(wrapped.locator(".tr-indent-step-3").first()).toBeVisible();
});
