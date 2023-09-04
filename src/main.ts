import { MarkdownView, Notice, Plugin, TFile, TFolder } from 'obsidian';
import { StateField } from '@codemirror/state';

import * as MathLinks from 'obsidian-mathlinks'
import * as Dataview from 'obsidian-dataview';

import { MathContextSettings, DEFAULT_SETTINGS, ExtraSettings, DEFAULT_EXTRA_SETTINGS, UNION_TYPE_MATH_CONTEXT_SETTING_KEYS, UNION_TYPE_EXTRA_SETTING_KEYS } from './settings/settings';
import { MathSettingTab } from "./settings/tab";
import { TheoremCallout, insertTheoremCalloutCallback } from './theorem_callouts';
import { ContextSettingModal, TheoremCalloutModal } from './modals';
import { insertDisplayMath } from './key';
import { DisplayMathRenderChild, buildEquationNumberPlugin } from './equation_number';
import { mathPreviewInfoField, inlineMathPreview, displayMathPreviewForCallout, displayMathPreviewForQuote } from './math_live_preview_in_callouts';
import { LinkedNotesIndexer, VaultIndex, VaultIndexer } from './indexer';
import { theoremCalloutMetadataHiderPlulgin } from './theorem_callout_metadata_hider';
import { getMarkdownPreviewViewEl, getMarkdownSourceViewEl, getProfile, iterDescendantFiles } from './utils';
import { proofPositionFieldFactory, proofDecorationFactory, ProofProcessor, ProofPosition, proofFoldFactory, insertProof } from './proof';
import { Suggest } from './suggest';
import { ProjectManager } from 'project';


export const VAULT_ROOT = '/';


export default class MathBooster extends Plugin {
	settings: Record<string, Partial<MathContextSettings>>;
	extraSettings: ExtraSettings;
	excludedFiles: string[];
	oldLinkMap: Dataview.IndexMap;
	proofPositionField: StateField<ProofPosition[]>;
	index: VaultIndex;
	projectManager: ProjectManager;

	async onload() {

		/** Settings */

		await this.loadSettings();
		await this.saveSettings();
		this.addSettingTab(new MathSettingTab(this.app, this));


		/** Projects */
		this.projectManager = new ProjectManager(this);


		/** Dependencies check */

		this.app.workspace.onLayoutReady(() => {
			this.assertDataview();
			this.assertMathLinks();
		});


		/** Indexing */

		this.index = new VaultIndex(this.app, this);

		// triggered if this plugin is enabled after launching the app
		this.app.workspace.onLayoutReady(() => {
			if (Dataview.getAPI(this.app)?.index.initialized) {
				this.initializeIndex()
			}
		})

		// triggered if this plugin is already enabled when launching the app
		this.registerEvent(
			this.app.metadataCache.on(
				"dataview:index-ready",
				this.initializeIndex.bind(this)
			)
		);

		this.registerEvent(
			this.app.metadataCache.on("dataview:metadata-change", async (...args) => {
				const changedFile = args[1];
				if (changedFile instanceof TFile) {
					await (new LinkedNotesIndexer(this.app, this, changedFile)).run();
				}
				this.setOldLinkMap();
			})
		);

		this.registerEvent(
			this.app.metadataCache.on("math-booster:local-settings-updated", async (file) => {
				const promises: Promise<void>[] = [];
				iterDescendantFiles(
					file,
					(descendantFile) => {
						promises.push((new LinkedNotesIndexer(this.app, this, descendantFile)).run());
					},
					"md"
				);
				await Promise.all(promises);

				// Add profile's tags as CSS classes
				this.app.workspace.iterateRootLeaves((leaf) => {
					if (leaf.view instanceof MarkdownView) {
						this.setProfileTagAsCSSClass(leaf.view);
					}
				});
			})
		);

		this.registerEvent(
			this.app.metadataCache.on("math-booster:global-settings-updated", async () => {
				await (new VaultIndexer(this.app, this)).run();

				// Add profile's tags as CSS classes
				this.app.workspace.iterateRootLeaves((leaf) => {
					if (leaf.view instanceof MarkdownView) {
						this.setProfileTagAsCSSClass(leaf.view);
					}
				});
			})
		);


		/** Add profile's tags as CSS classes */

		this.app.workspace.onLayoutReady(() => {
			this.app.workspace.iterateRootLeaves((leaf) => {
				if (leaf.view instanceof MarkdownView) {
					this.setProfileTagAsCSSClass(leaf.view);
				}
			});
		});

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (leaf?.view instanceof MarkdownView) {
					this.setProfileTagAsCSSClass(leaf.view);
				}
			})
		);


		/** Update settings when file renamed/created */

		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.settings[file.path] = this.settings[oldPath];
				delete this.settings[oldPath];

				const index = this.excludedFiles.indexOf(oldPath);
				if (index >= 0) {
					this.excludedFiles.splice(index, 1);
					this.excludedFiles.push(file.path);
				}
			})
		)

		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (file.path in this.settings) {
					delete this.settings[file.path];
				}
				const index = this.excludedFiles.indexOf(file.path);
				if (index >= 0) {
					this.excludedFiles.splice(index, 1);
				}
			})
		)


		/** Commands */

		this.addCommand({
			id: 'insert-display-math',
			name: 'Insert display math',
			editorCallback: insertDisplayMath,
		});

		this.addCommand({
			id: 'insert-theorem-callout',
			name: 'Insert theorem callout',
			editorCallback: async (editor, context) => {
				if (context instanceof MarkdownView) {
					new TheoremCalloutModal(
						this.app, this, context.file,
						(config) => {
							if (context.file) {
								insertTheoremCalloutCallback(this, editor, config, context.file);
							}
						},
						"Insert", "Insert theorem callout",
					).open();
				}
			}
		});

		this.addCommand({
			id: 'open-local-settings-for-current-note',
			name: 'Open local settings for the current note',
			callback: () => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (view) {
					new ContextSettingModal(this.app, this, view.file).open();
				}
			}
		});

		this.addCommand({
			id: 'insert-proof',
			name: 'Insert proof',
			editorCallback: (editor, context) => insertProof(this, editor, context)
		});

		/** Editor Extensions */

		// hide > [!math|{"type":"theorem", ...}]
		this.registerEditorExtension(theoremCalloutMetadataHiderPlulgin);
		// equation number
		this.registerEditorExtension(buildEquationNumberPlugin(this));
		// math preview in callouts and quotes
		this.registerEditorExtension(mathPreviewInfoField);
		this.registerEditorExtension(inlineMathPreview);
		this.registerEditorExtension(displayMathPreviewForCallout);
		this.registerEditorExtension(displayMathPreviewForQuote);
		// proofs
		this.proofPositionField = proofPositionFieldFactory(this);
		this.registerEditorExtension(this.proofPositionField);
		this.registerEditorExtension(proofDecorationFactory(this));
		this.registerEditorExtension(proofFoldFactory(this));


		/** Markdown post processors */

		// for theorem callouts
		this.registerMarkdownPostProcessor(async (element, context) => {
			const callouts = element.querySelectorAll<HTMLElement>(".callout");

			for (let index = 0; index < callouts.length; index++) {
				const callout = callouts[index];

				const type = callout.getAttribute('data-callout');
				const metadata = callout.getAttribute('data-callout-metadata');

				if (metadata) {
					const isTheoremCallout = (type?.toLowerCase() == 'math');

					if (isTheoremCallout) {
						const settings = JSON.parse(metadata);
						const currentFile = this.app.vault.getAbstractFileByPath(context.sourcePath);

						if (currentFile instanceof TFile) {
							const theoremCallout = new TheoremCallout(callout, this.app, this, settings, currentFile, context);
							await theoremCallout.setRenderedTitleElements();
							context.addChild(theoremCallout);
						}
					}
				}
			}
		});

		// for equation numbers
		this.registerMarkdownPostProcessor((element, context) => {
			const mjxContainerElements = element.querySelectorAll<HTMLElement>('mjx-container.MathJax[display="true"]');
			for (const mjxContainerEl of mjxContainerElements) {
				context.addChild(
					new DisplayMathRenderChild(mjxContainerEl, this.app, this, context)
				);
			}
		});

		// for proof environments
		this.registerMarkdownPostProcessor(
			(element, context) => ProofProcessor(this.app, this, element, context),
		);


		/** Editor suggest */

		this.registerEditorSuggest(new Suggest(this.app, this, ["theorem", "equation"]));
		this.registerEditorSuggest(new Suggest(this.app, this, ["theorem"]));
		this.registerEditorSuggest(new Suggest(this.app, this, ["equation"]));


		/** File menu */

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				menu.addSeparator()
					.addItem((item) => {
						item.setTitle(`${this.manifest.name}: Open local settings`)
							.onClick(() => {
								new ContextSettingModal(this.app, this, file).open();
							});
					});
			})
		);
	}

	onunload() {
		MathLinks.deleteAPIAccount(this);
	}

	async loadSettings() {
		this.settings = { [VAULT_ROOT]: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) };
		this.extraSettings = JSON.parse(JSON.stringify(DEFAULT_EXTRA_SETTINGS));
		this.excludedFiles = [];

		const loadedData = await this.loadData();
		if (loadedData) {
			const { settings, extraSettings, excludedFiles } = loadedData;
			for (const path in settings) {
				if (path != VAULT_ROOT) {
					this.settings[path] = {};
				}
				for (const _key in DEFAULT_SETTINGS) {
					const key = _key as keyof MathContextSettings;
					let val = settings[path][key];
					if (val !== undefined) {
						if (key in UNION_TYPE_MATH_CONTEXT_SETTING_KEYS) {
							const allowableValues = UNION_TYPE_MATH_CONTEXT_SETTING_KEYS[key];
							if (!(allowableValues?.includes(val))) {
								// invalid value encountered, substitute the default value instead
								val = DEFAULT_SETTINGS[key];
							}
						}
						if (typeof val == typeof DEFAULT_SETTINGS[key]) {
							this.settings[path][key] = val;
						}
					}
				}
			}

			for (const _key in DEFAULT_EXTRA_SETTINGS) {
				const key = _key as keyof ExtraSettings;
				let val = extraSettings[key];
				if (val !== undefined) {
					if (key in UNION_TYPE_EXTRA_SETTING_KEYS) {
						const allowableValues = UNION_TYPE_EXTRA_SETTING_KEYS[key];
						if (!(allowableValues?.includes(val))) {
							val = DEFAULT_EXTRA_SETTINGS[key];
						}
					}
					if (typeof val == typeof DEFAULT_EXTRA_SETTINGS[key]) {
						(this.extraSettings[key] as ExtraSettings[keyof ExtraSettings]) = val;
					}
				}
			}

			this.excludedFiles = excludedFiles;
		}
	}

	async saveSettings() {
		await this.saveData({
			version: this.manifest.version,
			settings: this.settings,
			extraSettings: this.extraSettings,
			excludedFiles: this.excludedFiles,
		});
	}

	assertDataview(): boolean {
		if (!Dataview.isPluginEnabled(this.app)) {
			new Notice(
				`${this.manifest.name}: Make sure Dataview is installed & enabled.`,
				10000
			);
			return false;
		}
		return true;
	}

	assertMathLinks(): boolean {
		if (!MathLinks.isPluginEnabled(this.app)) {
			new Notice(
				`${this.manifest.name}: Make sure MathLinks is installed & enabled.`,
				10000
			);
			return false;
		}
		return true;
	}

	getMathLinksAPI(): MathLinks.MathLinksAPIAccount | undefined {
		const account = MathLinks.getAPIAccount(this);
		if (account) {
			account.blockPrefix = "";
			// @ts-expect-error
			account.prefixer = (sourceFile: TFile, targetFile: TFile): string | null => {
				const sourceProject = this.projectManager.getProject(sourceFile);
				const targetProject = this.projectManager.getProject(targetFile);
				let ret: string | null;
				if (sourceProject && targetProject) {
					if (sourceProject.root == targetProject.root) {
						// return "";
						ret = "";
						console.log(sourceFile.path, targetFile.path, ret);
						return ret;
					}
					// return targetProject.name + " > ";
					ret = targetProject.name + " > ";
					console.log(sourceFile.path, targetFile.path, ret);
					return ret;
				}
				// sourceFile or targetFile doesn't belong to a project
				// return null;
				ret = null;
				console.log(sourceFile.path, targetFile.path, ret);
				return ret;
			};
			// account.enableFileNameBlockLinks = (sourceFile: TFile, targetFile: TFile) => this.extraSettings.noteTitleInLink;
			return account;
		}
	}

	initializeIndex() {
		const indexStart = Date.now();
		this.setOldLinkMap();
		(new VaultIndexer(this.app, this)).run();
		const indexEnd = Date.now();
		console.log(`${this.manifest.name}: All theorem callouts and equations in the vault have been indexed in ${(indexEnd - indexStart) / 1000}s.`);
	}

	getNewLinkMap(): Dataview.IndexMap | undefined {
		return Dataview.getAPI(this.app)?.index.links;
	}

	setOldLinkMap() {
		const oldLinkMap = this.getNewLinkMap();
		if (oldLinkMap) {
			this.oldLinkMap = structuredClone(oldLinkMap);
		}
	}

	setProfileTagAsCSSClass(view: MarkdownView) {
		const profile = getProfile(this, view.file);
		const classes = profile.meta.tags.map((tag) => `math-booster-${tag}`);
		for (const el of [getMarkdownSourceViewEl(view), getMarkdownPreviewViewEl(view)]) {
			if (el) {
				el.classList.forEach((cls) => {
					if (cls.startsWith("math-booster-")) {
						el.classList.remove(cls);
					}
				});
				el?.addClass(...classes);
			}
		}
	}

}
