import { App, Editor, ExtraButtonComponent, MarkdownPostProcessorContext, MarkdownRenderChild, MarkdownView, TFile } from "obsidian";

import MathBooster from './main';
import { MathCalloutModal } from './modals';
import { MathSettings } from './settings/settings';
import { TheoremLikeEnv, getTheoremLikeEnv } from './env';
import { increaseQuoteLevel, renderTextWithMath, formatTitle, formatTitleWithoutSubtitle, resolveSettings, splitIntoLines, getSectionCacheFromPos } from './utils';
import { AutoNoteIndexer } from './indexer';


export class MathCallout extends MarkdownRenderChild {
    config: Required<MathSettings>;
    env: TheoremLikeEnv;
    renderedTitleElements: (HTMLElement | string)[];

    constructor(containerEl: HTMLElement, public app: App, public plugin: MathBooster, config: MathSettings, public currentFile: TFile, public context: MarkdownPostProcessorContext) {
        super(containerEl);
        this.env = getTheoremLikeEnv(config.type);
        this.config = resolveSettings(config, this.plugin, this.currentFile) as Required<MathSettings>;
    }

    async setRenderedTitleElements() {
        // ex) "Theorem 1.1", not "Theorem 1.1 (Cauchy-Schwarz)"
        let titleWithoutSubtitle = await renderTextWithMath(formatTitleWithoutSubtitle(this.config));
        this.renderedTitleElements = [
            ...titleWithoutSubtitle
        ];
        if (this.config.title) {
            // ex) "(Cauchy-Schwarz)"
            let subtitle = await renderTextWithMath(`(${this.config.title})`);
            let subtitleEl = createSpan({ cls: "math-callout-subtitle" });
            subtitleEl.replaceChildren(...subtitle)
            this.renderedTitleElements.push(" ", subtitleEl);
        }
        if (this.config.titleSuffix) {
            this.renderedTitleElements.push(this.config.titleSuffix);
        }
    }

    onload() {
        // make sure setRenderedTitleElements() is called beforehand
        let titleInner = this.containerEl.querySelector<HTMLElement>('.callout-title-inner');
        titleInner?.replaceChildren(...this.renderedTitleElements);

        // add classes for CSS snippets
        this.containerEl.classList.add("math-callout");
        this.containerEl.classList.add("math-callout-" + this.config.lang);
        this.containerEl.classList.add("math-callout-" + this.config.type);
        this.containerEl.toggleClass(`math-callout-${this.config.mathCalloutStyle}`, this.config.mathCalloutStyle != "custom");
        this.containerEl.toggleClass("font-family-inherit", this.config.mathCalloutStyle != "custom" && this.config.mathCalloutFontInherit);

        // click the title block (div.callout-title) to edit settings
        let button = new ExtraButtonComponent(this.containerEl)
            .setIcon("settings-2")
            .setTooltip("Edit math callout settings");
        button.extraSettingsEl.addEventListener("click", (ev) => {
            ev.stopPropagation();
            const view = this.app.workspace.getActiveViewOfType(MarkdownView);
            const editor = view?.editor;
            if (editor) {
                let modal = new MathCalloutModal(
                    this.app,
                    this.plugin,
                    view,
                    (settings) => {
                        let resolvedSettings = resolveSettings(settings, this.plugin, this.currentFile);
                        let title = formatTitle(resolvedSettings);
                        let indexer = (new AutoNoteIndexer(this.app, this.plugin, view.file)).getIndexer();
                        const info = this.context.getSectionInfo(this.containerEl);
                        let lineNumber = info?.lineStart;
                        if (lineNumber === undefined && view.getMode() == "source") { // Live preview or source mode
                            const pos = editor.cm?.posAtDOM(this.containerEl);
                            const cache = this.app.metadataCache.getFileCache(this.currentFile);
                            if (pos !== undefined && cache) {
                                lineNumber = getSectionCacheFromPos(cache, pos, "callout")?.position.start.line;
                            }
                        }
                        if (lineNumber !== undefined) {
                            indexer.calloutIndexer.overwriteSettings(lineNumber, settings, title);
                        }
                    },
                    "Confirm",
                    "Edit math callout settings",
                    this.config,
                );
                modal.resolveDefaultSettings(view.file);
                modal.open();
            }
        });
        button.extraSettingsEl.classList.add("math-callout-setting-button");

    }
}


export function insertMathCalloutCallback(plugin: MathBooster, editor: Editor, config: MathSettings, currentFile: TFile) {
    let selection = editor.getSelection();
    let cursorPos = editor.getCursor();
    let resolvedSettings = resolveSettings(config, plugin, currentFile);
    let title = formatTitle(resolvedSettings);

    if (selection) {
        let nLines = splitIntoLines(selection).length;
        editor.replaceSelection(
            `> [!math|${JSON.stringify(config)}] ${title}\n`
            + increaseQuoteLevel(selection)
        );
        cursorPos.line += nLines;
    } else {
        editor.replaceRange(
            `> [!math|${JSON.stringify(config)}] ${title}\n> `,
            cursorPos
        )
        cursorPos.line += 1;
    }
    cursorPos.ch = 2;
    editor.setCursor(cursorPos);
}
