import {
  App,
  MarkdownView,
  Modal,
  Notice,
  normalizePath,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TextAreaComponent
} from "obsidian";

interface ConflictMergeSettings {
  scanOnStartup: boolean;
  watchCreates: boolean;
  autoOpenModal: boolean;
  moveConflictToTrashAfterResolve: boolean;
  createBackupBeforeApply: boolean;
  conflictNamePatterns: string[];
}

interface ConflictPair {
  original: TFile;
  conflict: TFile;
}

const DEFAULT_SETTINGS: ConflictMergeSettings = {
  scanOnStartup: true,
  watchCreates: true,
  autoOpenModal: true,
  moveConflictToTrashAfterResolve: true,
  createBackupBeforeApply: true,
  conflictNamePatterns: [
    "\\s+\\(conflicted copy.*\\)$",
    "\\s+\\(conflict.*\\)$",
    "\\s+conflicted copy.*$",
    "\\s+conflict.*$"
  ]
};

interface MergeContents {
  mergedContent: string;
  originalContent: string;
  conflictContent: string;
}

interface LineDiffEntry {
  left: string;
  right: string;
  merged: string;
  state: "same" | "changed" | "left-only" | "right-only";
}

interface EditedTimestampBlock {
  content: string;
  timestamp: number;
  order: number;
  key: string;
}

interface EditedTimestampDocument {
  prefix: string;
  blocks: EditedTimestampBlock[];
  tail: string;
}

const EDITED_TIMESTAMP_REGEX = /^\s*<!--\s*edited:\s*([^>]+?)\s*-->\s*$/i;

export default class ConflictMergePlugin extends Plugin {
  settings: ConflictMergeSettings = DEFAULT_SETTINGS;
  private processingPaths = new Set<string>();
  private scheduledHandles = new Map<string, number>();

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new ConflictMergeSettingTab(this.app, this));

    this.addCommand({
      id: "scan-conflict-files",
      name: "Scan vault for conflict files",
      callback: async () => {
        const pairs = await this.findConflictPairs();
        await this.presentPairs(pairs, true);
      }
    });

    this.addCommand({
      id: "merge-active-file-if-conflict",
      name: "Merge active file if it is a conflict copy",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const canRun = !!file && this.isConflictFile(file);
        if (!checking && canRun && file) {
          void this.handleConflictFile(file, true);
        }
        return canRun;
      }
    });

    if (this.settings.watchCreates) {
      this.registerEvent(this.app.vault.on("create", (file) => {
        if (file instanceof TFile) {
          this.scheduleConflictHandling(file, this.settings.autoOpenModal);
        }
      }));
    }

    this.registerEvent(this.app.vault.on("rename", (file) => {
      if (file instanceof TFile) {
        this.scheduleConflictHandling(file, this.settings.autoOpenModal);
      }
    }));

    if (this.settings.scanOnStartup) {
      const pairs = await this.findConflictPairs();
      await this.presentPairs(pairs, false);
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  onunload(): void {
    for (const timer of this.scheduledHandles.values()) {
      window.clearTimeout(timer);
    }
    this.scheduledHandles.clear();
  }

  async findConflictPairs(): Promise<ConflictPair[]> {
    const files = this.app.vault.getMarkdownFiles();
    const pairs: ConflictPair[] = [];

    for (const file of files) {
      const pair = this.buildConflictPair(file);
      if (pair) {
        pairs.push(pair);
      }
    }

    return pairs;
  }

  scheduleConflictHandling(file: TFile, openModal: boolean): void {
    if (!this.isConflictFile(file)) {
      return;
    }

    const existing = this.scheduledHandles.get(file.path);
    if (existing) {
      window.clearTimeout(existing);
    }

    const timer = window.setTimeout(() => {
      this.scheduledHandles.delete(file.path);
      void this.handleConflictFileWhenStable(file.path, openModal);
    }, 600);

    this.scheduledHandles.set(file.path, timer);
  }

  async handleConflictFileWhenStable(path: string, openModal: boolean): Promise<void> {
    const stableFile = await this.waitForStableConflictFile(path);
    if (!stableFile) {
      return;
    }

    await this.handleConflictFile(stableFile, openModal);
  }

  async waitForStableConflictFile(path: string): Promise<TFile | null> {
    let previousSnapshot: string | null = null;

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const current = this.app.vault.getAbstractFileByPath(path);
      if (!(current instanceof TFile) || !this.isConflictFile(current)) {
        return null;
      }

      const content = await this.app.vault.cachedRead(current);
      const snapshot = `${current.stat.size}:${current.stat.mtime}:${content}`;

      if (snapshot === previousSnapshot) {
        return current;
      }

      previousSnapshot = snapshot;
      await sleep(350);
    }

    const latest = this.app.vault.getAbstractFileByPath(path);
    return latest instanceof TFile && this.isConflictFile(latest) ? latest : null;
  }

  async handleConflictFile(file: TFile, openModal: boolean): Promise<void> {
    if (!this.isConflictFile(file) || this.processingPaths.has(file.path)) {
      return;
    }

    const pair = this.buildConflictPair(file);
    if (!pair) {
      return;
    }

    this.processingPaths.add(file.path);
    try {
      if (openModal) {
        await this.openMergeModal(pair);
      } else {
        new Notice(`Detected conflict file: ${pair.conflict.path}`);
      }
    } finally {
      this.processingPaths.delete(file.path);
    }
  }

  async presentPairs(pairs: ConflictPair[], openModal: boolean): Promise<void> {
    if (!pairs.length) {
      if (openModal) {
        new Notice("No conflict files detected.");
      }
      return;
    }

    new Notice(`Detected ${pairs.length} conflict file${pairs.length === 1 ? "" : "s"}.`);

    if (openModal || this.settings.autoOpenModal) {
      for (const pair of pairs) {
        await this.openMergeModal(pair);
      }
    }
  }

  buildConflictPair(file: TFile): ConflictPair | null {
    if (!this.isConflictFile(file)) {
      return null;
    }

    const baseName = this.stripConflictSuffix(file.basename);
    if (!baseName || baseName === file.basename) {
      return null;
    }

    const parentPath = file.parent?.path;
    const candidatePath = parentPath && parentPath !== "/"
      ? normalizePath(`${parentPath}/${baseName}.${file.extension}`)
      : normalizePath(`${baseName}.${file.extension}`);
    const original = this.app.vault.getAbstractFileByPath(candidatePath);

    if (!(original instanceof TFile)) {
      return null;
    }

    return { original, conflict: file };
  }

  isConflictFile(file: TFile): boolean {
    return this.settings.conflictNamePatterns.some((pattern) => {
      try {
        return new RegExp(pattern, "i").test(file.basename);
      } catch {
        return false;
      }
    });
  }

  stripConflictSuffix(baseName: string): string {
    return this.settings.conflictNamePatterns.reduce((current, pattern) => {
      try {
        return current.replace(new RegExp(pattern, "i"), "");
      } catch {
        return current;
      }
    }, baseName).trim();
  }

  async mergePair(pair: ConflictPair): Promise<{ mergedContent: string; originalContent: string; conflictContent: string }> {
    const originalContent = await this.app.vault.cachedRead(pair.original);
    const conflictContent = await this.app.vault.cachedRead(pair.conflict);
    const mergedContent = buildMergedContent(originalContent, conflictContent);
    return { mergedContent, originalContent, conflictContent };
  }

  async openMergeModal(pair: ConflictPair): Promise<void> {
    const contents = await this.mergePair(pair);
    await new Promise<void>((resolve) => {
      new ConflictMergeModal(this.app, pair, contents, this.settings, resolve).open();
    });
  }
}

class ConflictMergeModal extends Modal {
  private compareScrollEl: HTMLElement | null = null;
  private actionSettingEl: HTMLElement | null = null;
  private readonly resizeHandler = (): void => {
    this.fitModalToWindow();
  };

  constructor(
    app: App,
    private readonly pair: ConflictPair,
    private readonly contents: MergeContents,
    private readonly settings: ConflictMergeSettings,
    private readonly onCloseComplete: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    this.modalEl.addClass("conflict-merge-modal");
    this.modalEl.style.width = "min(1600px, calc(100vw - 32px))";
    this.modalEl.style.maxWidth = "calc(100vw - 32px)";
    this.modalEl.style.height = "calc(100vh - 32px)";
    this.modalEl.style.maxHeight = "calc(100vh - 32px)";
    this.modalEl.style.display = "flex";
    this.modalEl.style.flexDirection = "column";
    const modal = this.modalEl.querySelector(".modal") as HTMLElement | null;
    if (modal) {
      modal.style.width = "min(1600px, calc(100vw - 32px))";
      modal.style.maxWidth = "calc(100vw - 32px)";
      modal.style.height = "calc(100vh - 32px)";
      modal.style.maxHeight = "calc(100vh - 32px)";
    }
    titleEl.setText(`Merge conflict: ${this.pair.original.basename}`);
    contentEl.empty();
    contentEl.addClass("conflict-merge-content");

    contentEl.createEl("div", {
      cls: "conflict-merge-meta",
      text: `Original: ${this.pair.original.path} | Conflict: ${this.pair.conflict.path}`
    });

    const summary = contentEl.createEl("div", {
      cls: "conflict-merge-meta",
      text: "Workflow: compare left/right, review the merged candidate, then choose how to resolve."
    });
    summary.style.marginTop = "8px";

    const rows = buildCompareEntries(
      this.contents.originalContent,
      this.contents.conflictContent,
      this.contents.mergedContent
    );
    this.buildSynchronizedCompare(contentEl, rows);

    const actionSetting = new Setting(contentEl)
      .setName("Resolve conflict")
      .setDesc("Choose which version to keep, or keep a merged copy for later review.")
      .addButton((button) => {
        button.setButtonText("Apply merge").setCta().onClick(async () => {
          await this.applyMergedCandidate();
          this.close();
        });
      })
      .addButton((button) => {
        button.setButtonText("Use original").onClick(async () => {
          await this.resolveConflictFileOnly("Kept original");
          this.close();
        });
      })
      .addButton((button) => {
        button.setButtonText("Use conflict").onClick(async () => {
          await this.applyToOriginal(this.contents.conflictContent, "Applied conflict");
          this.close();
        });
      })
      .addButton((button) => {
        button.setButtonText("Keep both").onClick(async () => {
          await this.createMergedCopy();
          this.close();
        });
      })
      .addButton((button) => {
        button.setButtonText("Cancel").onClick(() => {
          new Notice("Conflict left unchanged.");
          this.close();
        });
      });
    actionSetting.settingEl.addClass("conflict-merge-actions");
    this.actionSettingEl = actionSetting.settingEl;
    window.addEventListener("resize", this.resizeHandler);
    this.fitModalToWindow();
    window.requestAnimationFrame(this.resizeHandler);
    window.setTimeout(this.resizeHandler, 100);
  }

  onClose(): void {
    window.removeEventListener("resize", this.resizeHandler);
    this.modalEl.removeClass("conflict-merge-modal");
    this.contentEl.removeClass("conflict-merge-content");
    this.compareScrollEl = null;
    this.actionSettingEl = null;
    this.contentEl.empty();
    this.onCloseComplete();
  }

  private buildSynchronizedCompare(container: HTMLElement, rows: LineDiffEntry[]): void {
    const wrap = container.createDiv({ cls: "conflict-compare-wrap" });
    wrap.style.marginTop = "12px";
    wrap.style.border = "1px solid var(--background-modifier-border)";
    wrap.style.borderRadius = "8px";
    wrap.style.overflow = "hidden";

    const scroll = wrap.createDiv({ cls: "conflict-compare-scroll" });
    scroll.style.overflow = "auto";
    this.compareScrollEl = scroll;

    const table = scroll.createEl("table", { cls: "conflict-compare-table" });
    table.style.width = "100%";
    table.style.tableLayout = "fixed";
    table.style.borderCollapse = "collapse";

    const colGroup = table.createEl("colgroup");
    colGroup.createEl("col");
    colGroup.createEl("col");
    colGroup.createEl("col");

    const thead = table.createEl("thead");
    const header = thead.createEl("tr");
    this.appendHeaderCell(header, "Original");
    this.appendHeaderCell(header, "Conflict");
    this.appendHeaderCell(header, "Merged Candidate");

    const body = table.createEl("tbody", { cls: "conflict-compare-body" });
    for (const entry of rows) {
      const row = body.createEl("tr", { cls: `conflict-compare-row conflict-diff-${entry.state}` });
      this.appendCompareCell(row, entry.left, entry.state, "left");
      this.appendCompareCell(row, entry.right, entry.state, "right");
      this.appendCompareCell(row, entry.merged, entry.state, "merged");
    }
  }

  private appendHeaderCell(row: HTMLElement, label: string): void {
    const cell = row.createEl("th", { cls: "conflict-compare-heading", text: label });
    cell.style.position = "sticky";
    cell.style.top = "0";
    cell.style.zIndex = "1";
    cell.style.padding = "10px 12px";
    cell.style.textAlign = "left";
    cell.style.background = "var(--background-secondary)";
    cell.style.borderBottom = "1px solid var(--background-modifier-border)";
    cell.style.borderRight = "1px solid var(--background-modifier-border)";
    cell.style.whiteSpace = "normal";
  }

  private appendCompareCell(
    row: HTMLElement,
    value: string,
    state: LineDiffEntry["state"],
    column: "left" | "right" | "merged"
  ): void {
    const cell = row.createEl("td", { cls: `conflict-compare-cell conflict-diff-${state} conflict-diff-${column}` });
    cell.style.verticalAlign = "top";
    cell.style.padding = "6px 8px";
    cell.style.borderRight = "1px solid var(--background-modifier-border)";
    cell.style.borderBottom = "1px solid var(--background-modifier-border)";
    cell.style.whiteSpace = "pre-wrap";
    cell.style.fontFamily = "var(--font-monospace)";
    cell.style.fontSize = "12px";
    cell.style.lineHeight = "1.5";
    cell.style.overflowX = "visible";
    cell.style.overflowWrap = "anywhere";
    cell.style.wordBreak = "break-word";
    cell.style.minHeight = "1.7em";

    const background = getDiffBackground(state, column);
    if (background) {
      cell.style.background = background;
    }

    cell.setText(value.length ? value : " ");
  }

  private fitModalToWindow(): void {
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const margin = viewportHeight < 720 ? 8 : 16;
    const modalHeight = Math.max(360, viewportHeight - margin * 2);
    const modalWidth = Math.min(1600, Math.max(320, viewportWidth - margin * 2));

    this.modalEl.style.width = `${modalWidth}px`;
    this.modalEl.style.maxWidth = `${modalWidth}px`;
    this.modalEl.style.height = `${modalHeight}px`;
    this.modalEl.style.maxHeight = `${modalHeight}px`;

    if (!this.compareScrollEl) {
      return;
    }

    const modalRect = this.modalEl.getBoundingClientRect();
    const scrollRect = this.compareScrollEl.getBoundingClientRect();
    const actionsHeight = this.actionSettingEl?.offsetHeight ?? 88;
    const bottomPadding = viewportHeight < 720 ? 14 : 22;
    const availableHeight = Math.floor(modalRect.bottom - scrollRect.top - actionsHeight - bottomPadding);
    const scrollHeight = Math.max(96, availableHeight);

    this.compareScrollEl.style.height = `${scrollHeight}px`;
    this.compareScrollEl.style.maxHeight = `${scrollHeight}px`;
  }

  private async applyToOriginal(nextContent: string, label: string): Promise<void> {
    await this.maybeBackupOriginal();
    await this.app.vault.modify(this.pair.original, nextContent);
    await this.resolveConflictFileOnly(label);
    await this.openResolvedFile(this.pair.original);
  }

  private async applyMergedCandidate(): Promise<void> {
    const nextContent = await this.buildCurrentMergedContent();
    await this.applyToOriginal(nextContent, "Merged");
  }

  private async resolveConflictFileOnly(label: string): Promise<void> {
    if (this.settings.moveConflictToTrashAfterResolve) {
      await this.app.fileManager.trashFile(this.pair.conflict);
      new Notice(`${label}. Conflict file moved to trash.`);
      return;
    }

    new Notice(`${label}. Conflict file kept for manual follow-up.`);
  }

  private async maybeBackupOriginal(): Promise<void> {
    if (!this.settings.createBackupBeforeApply) {
      return;
    }

    const originalContent = await this.app.vault.cachedRead(this.pair.original);
    const backupPath = buildSiblingFilePath(this.pair.original, `backup-${timestampSlug()}`);
    await this.app.vault.create(backupPath, originalContent);
  }

  private async createMergedCopy(): Promise<void> {
    const mergedPath = buildSiblingFilePath(this.pair.original, `merged-${timestampSlug()}`);
    const mergedContent = await this.buildCurrentMergedContent();
    await this.app.vault.create(mergedPath, mergedContent);
    new Notice(`Created merged copy: ${mergedPath}`);
  }

  private async buildCurrentMergedContent(): Promise<string> {
    const currentOriginalContent = await this.app.vault.cachedRead(this.pair.original);
    if (currentOriginalContent === this.contents.originalContent) {
      return this.contents.mergedContent;
    }

    new Notice("Original changed since this review opened. Rebuilt merged candidate before applying.");
    return buildMergedContent(currentOriginalContent, this.contents.conflictContent);
  }

  private async openResolvedFile(file: TFile): Promise<void> {
    const leaf = this.app.workspace.getMostRecentLeaf();
    if (leaf) {
      await leaf.openFile(file);
      const view = leaf.view;
      if (view instanceof MarkdownView) {
        view.editor?.focus();
      }
    }
  }
}

class ConflictMergeSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: ConflictMergePlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Conflict Merge Assistant" });

    new Setting(containerEl)
      .setName("Scan on startup")
      .setDesc("Look for conflict files when Obsidian starts.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.scanOnStartup).onChange(async (value) => {
          this.plugin.settings.scanOnStartup = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Watch new files")
      .setDesc("Automatically detect new conflict files as they appear.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.watchCreates).onChange(async (value) => {
          this.plugin.settings.watchCreates = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Open merge modal automatically")
      .setDesc("Open a review modal as soon as a conflict pair is detected.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.autoOpenModal).onChange(async (value) => {
          this.plugin.settings.autoOpenModal = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Move conflict file to trash after resolve")
      .setDesc("Prevents already-handled conflicts from showing up again on the next scan.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.moveConflictToTrashAfterResolve).onChange(async (value) => {
          this.plugin.settings.moveConflictToTrashAfterResolve = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Create backup before apply")
      .setDesc("Create a sibling backup note before overwriting the original file.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.createBackupBeforeApply).onChange(async (value) => {
          this.plugin.settings.createBackupBeforeApply = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Conflict filename patterns")
      .setDesc("One regular expression per line. The matched suffix is stripped to locate the original file.")
      .addTextArea((textArea) => {
        textArea
          .setPlaceholder("\\s+\\(conflicted copy.*\\)$")
          .setValue(this.plugin.settings.conflictNamePatterns.join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.conflictNamePatterns = value
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          });
        textArea.inputEl.rows = 6;
        textArea.inputEl.cols = 40;
      });

  }
}

function buildMergedContent(leftContent: string, rightContent: string): string {
  const timestampMergedContent = buildEditedTimestampMergedContent(leftContent, rightContent);
  if (timestampMergedContent !== null) {
    return timestampMergedContent;
  }

  return buildMergedContentFromRows(buildLineDiffEntries(leftContent, rightContent));
}

function buildCompareEntries(leftContent: string, rightContent: string, mergedContent: string): LineDiffEntry[] {
  const timestampRows = buildEditedTimestampCompareEntries(leftContent, rightContent, mergedContent);
  if (timestampRows) {
    return timestampRows;
  }

  return buildLineDiffEntries(leftContent, rightContent);
}

function buildEditedTimestampMergedContent(leftContent: string, rightContent: string): string | null {
  const leftDoc = parseEditedTimestampDocument(leftContent);
  const rightDoc = parseEditedTimestampDocument(rightContent);

  if (!leftDoc.blocks.length || !rightDoc.blocks.length) {
    return null;
  }

  const prefix = mergeTimestampDocumentPrefix(leftDoc.prefix, rightDoc.prefix);
  const blocksByKey = new Map<string, EditedTimestampBlock>();

  for (const block of [...leftDoc.blocks, ...rightDoc.blocks]) {
    if (!blocksByKey.has(block.key)) {
      blocksByKey.set(block.key, block);
    }
  }

  const mergedBlocks = Array.from(blocksByKey.values()).sort(compareEditedTimestampBlocks);
  const tails = dedupeTextParts([leftDoc.tail, rightDoc.tail].filter((tail) => tail.trim().length > 0));
  const mergedContent = joinEditedTimestampParts(prefix, mergedBlocks.map((block) => block.content), tails);
  return preserveTrailingNewline(mergedContent, leftContent, rightContent);
}

function buildEditedTimestampCompareEntries(
  leftContent: string,
  rightContent: string,
  mergedContent: string
): LineDiffEntry[] | null {
  const leftDoc = parseEditedTimestampDocument(leftContent);
  const rightDoc = parseEditedTimestampDocument(rightContent);
  const mergedDoc = parseEditedTimestampDocument(mergedContent);

  if (!leftDoc.blocks.length || !rightDoc.blocks.length || !mergedDoc.blocks.length) {
    return null;
  }

  const leftBlocksByKey = buildBlockKeyMap(leftDoc.blocks);
  const rightBlocksByKey = buildBlockKeyMap(rightDoc.blocks);
  const entries: LineDiffEntry[] = [];

  if (leftDoc.prefix !== rightDoc.prefix) {
    entries.push({
      left: leftDoc.prefix,
      right: rightDoc.prefix,
      merged: mergeTimestampDocumentPrefix(leftDoc.prefix, rightDoc.prefix),
      state: "changed"
    });
  }

  for (const mergedBlock of mergedDoc.blocks) {
    const leftBlock = takeBlockByKey(leftBlocksByKey, mergedBlock.key);
    const rightBlock = takeBlockByKey(rightBlocksByKey, mergedBlock.key);
    entries.push({
      left: leftBlock?.content ?? "",
      right: rightBlock?.content ?? "",
      merged: mergedBlock.content,
      state: getBlockCompareState(leftBlock, rightBlock)
    });
  }

  appendTailCompareEntry(entries, leftDoc.tail, rightDoc.tail);
  return entries;
}

function parseEditedTimestampDocument(content: string): EditedTimestampDocument {
  const lines = normalizeLines(content);
  const prefixEnd = findStructuredPrefixEnd(lines);
  const prefix = buildPrefixContent(lines, prefixEnd);
  const blocks: EditedTimestampBlock[] = [];
  let currentLines: string[] = [];

  for (let index = prefixEnd; index < lines.length; index += 1) {
    const line = lines[index];
    currentLines.push(line);
    const timestamp = parseEditedTimestampLine(line);
    if (timestamp === null) {
      continue;
    }

    const blockContent = currentLines.join("\n");
    blocks.push({
      content: blockContent,
      timestamp,
      order: blocks.length,
      key: normalizeBlockKey(blockContent)
    });
    currentLines = [];
  }

  return {
    prefix,
    blocks,
    tail: currentLines.join("\n")
  };
}

function buildPrefixContent(lines: string[], prefixEnd: number): string {
  if (prefixEnd === 0) {
    return "";
  }

  const prefix = lines.slice(0, prefixEnd).join("\n");
  return prefixEnd < lines.length ? `${prefix}\n` : prefix;
}

function findStructuredPrefixEnd(lines: string[]): number {
  if (lines[0]?.trim() !== "---") {
    return 0;
  }

  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() !== "---") {
      continue;
    }

    let prefixEnd = index + 1;
    while (prefixEnd < lines.length && lines[prefixEnd].trim() === "") {
      prefixEnd += 1;
    }
    return prefixEnd;
  }

  return 0;
}

function parseEditedTimestampLine(line: string): number | null {
  const match = line.match(EDITED_TIMESTAMP_REGEX);
  if (!match) {
    return null;
  }

  return parseTimestampValue(match[1].trim());
}

function parseTimestampValue(value: string): number | null {
  const match = value.match(
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([+-])(\d{2}):?(\d{2}))?$/
  );

  if (!match) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }

  const [, year, month, day, hour, minute, second = "0", sign, offsetHour = "0", offsetMinute = "0"] = match;
  const utcTime = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  );

  if (!sign) {
    return utcTime;
  }

  const offsetMs = (Number(offsetHour) * 60 + Number(offsetMinute)) * 60 * 1000;
  return sign === "+" ? utcTime - offsetMs : utcTime + offsetMs;
}

function mergeTimestampDocumentPrefix(leftPrefix: string, rightPrefix: string): string {
  if (leftPrefix === rightPrefix) {
    return leftPrefix;
  }

  return buildMergedContentFromRows(buildLineDiffEntries(leftPrefix, rightPrefix));
}

function buildBlockKeyMap(blocks: EditedTimestampBlock[]): Map<string, EditedTimestampBlock[]> {
  const map = new Map<string, EditedTimestampBlock[]>();

  for (const block of blocks) {
    const matchingBlocks = map.get(block.key) ?? [];
    matchingBlocks.push(block);
    map.set(block.key, matchingBlocks);
  }

  return map;
}

function takeBlockByKey(
  blocksByKey: Map<string, EditedTimestampBlock[]>,
  key: string
): EditedTimestampBlock | null {
  const blocks = blocksByKey.get(key);
  if (!blocks?.length) {
    return null;
  }

  return blocks.shift() ?? null;
}

function getBlockCompareState(
  leftBlock: EditedTimestampBlock | null,
  rightBlock: EditedTimestampBlock | null
): LineDiffEntry["state"] {
  if (leftBlock && rightBlock) {
    return "same";
  }

  return leftBlock ? "left-only" : "right-only";
}

function appendTailCompareEntry(entries: LineDiffEntry[], leftTail: string, rightTail: string): void {
  if (!leftTail.trim().length && !rightTail.trim().length) {
    return;
  }

  entries.push({
    left: leftTail,
    right: rightTail,
    merged: dedupeTextParts([leftTail, rightTail].filter((tail) => tail.trim().length > 0)).join(""),
    state: leftTail === rightTail ? "same" : "changed"
  });
}

function joinEditedTimestampParts(prefix: string, blocks: string[], tails: string[]): string {
  const blockContent = blocks.join("\n");
  const tailContent = tails.join("\n");

  if (!tailContent.length) {
    return `${prefix}${blockContent}`;
  }

  return `${prefix}${blockContent}${blockContent.length ? "\n" : ""}${tailContent}`;
}

function preserveTrailingNewline(content: string, ...sources: string[]): string {
  if (content.endsWith("\n") || !sources.some((source) => source.endsWith("\n"))) {
    return content;
  }

  return `${content}\n`;
}

function compareEditedTimestampBlocks(left: EditedTimestampBlock, right: EditedTimestampBlock): number {
  if (left.timestamp !== right.timestamp) {
    return left.timestamp - right.timestamp;
  }

  return left.order - right.order;
}

function normalizeBlockKey(content: string): string {
  return content.replace(/\r\n/g, "\n").trim();
}

function dedupeTextParts(parts: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const part of parts) {
    const key = normalizeBlockKey(part);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(part);
  }

  return deduped;
}

function mergeRunByLcs(originalRun: string[], conflictRun: string[]): string[] {
  const originalKeys = originalRun;
  const conflictKeys = conflictRun;
  const lcs = buildLcsTable(originalKeys, conflictKeys);
  const merged: string[] = [];
  let i = 0;
  let j = 0;

  while (i < originalRun.length && j < conflictRun.length) {
    if (originalKeys[i] === conflictKeys[j]) {
      merged.push(originalRun[i]);
      i += 1;
      j += 1;
      continue;
    }

    if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      merged.push(originalRun[i]);
      i += 1;
    } else {
      merged.push(conflictRun[j]);
      j += 1;
    }
  }

  while (i < originalRun.length) {
    merged.push(originalRun[i]);
    i += 1;
  }

  while (j < conflictRun.length) {
    merged.push(conflictRun[j]);
    j += 1;
  }

  return dedupeAdjacentBlocks(merged);
}

function buildLcsTable(left: string[], right: string[]): number[][] {
  const table = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));

  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      if (left[i] === right[j]) {
        table[i][j] = table[i + 1][j + 1] + 1;
      } else {
        table[i][j] = Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
  }

  return table;
}

function buildLineDiffEntries(leftContent: string, rightContent: string): LineDiffEntry[] {
  const leftLines = normalizeLines(leftContent);
  const rightLines = normalizeLines(rightContent);
  const table = buildLcsTable(leftLines, rightLines);
  const entries: LineDiffEntry[] = [];
  let leftRun: string[] = [];
  let rightRun: string[] = [];
  let i = 0;
  let j = 0;

  const flushChangedRun = () => {
    if (!leftRun.length && !rightRun.length) {
      return;
    }
    appendChangedRun(entries, leftRun, rightRun);
    leftRun = [];
    rightRun = [];
  };

  while (i < leftLines.length && j < rightLines.length) {
    if (leftLines[i] === rightLines[j]) {
      flushChangedRun();
      entries.push({ left: leftLines[i], right: rightLines[j], merged: leftLines[i], state: "same" });
      i += 1;
      j += 1;
      continue;
    }

    if (table[i + 1][j] >= table[i][j + 1]) {
      leftRun.push(leftLines[i]);
      i += 1;
    } else {
      rightRun.push(rightLines[j]);
      j += 1;
    }
  }

  while (i < leftLines.length) {
    leftRun.push(leftLines[i]);
    i += 1;
  }

  while (j < rightLines.length) {
    rightRun.push(rightLines[j]);
    j += 1;
  }

  flushChangedRun();
  return entries;
}

function appendChangedRun(entries: LineDiffEntry[], leftRun: string[], rightRun: string[]): void {
  const maxLength = Math.max(leftRun.length, rightRun.length);

  for (let index = 0; index < maxLength; index += 1) {
    const hasLeft = index < leftRun.length;
    const hasRight = index < rightRun.length;
    const left = hasLeft ? leftRun[index] : "";
    const right = hasRight ? rightRun[index] : "";
    entries.push({
      left,
      right,
      merged: buildMergedCandidateCell(left, right, hasLeft, hasRight),
      state: getChangedRunState(left, right, hasLeft, hasRight)
    });
  }
}

function getChangedRunState(left: string, right: string, hasLeft: boolean, hasRight: boolean): LineDiffEntry["state"] {
  if (hasLeft && hasRight) {
    return left === right ? "same" : "changed";
  }
  return hasLeft ? "left-only" : "right-only";
}

function buildMergedCandidateCell(left: string, right: string, hasLeft: boolean, hasRight: boolean): string {
  if (!hasLeft || !hasRight) {
    return hasLeft ? left : right;
  }
  return mergeRunByLcs([left], [right]).join("\n");
}

function buildMergedContentFromRows(rows: LineDiffEntry[]): string {
  return rows.map((row) => row.merged).join("\n");
}

function getDiffBackground(
  state: LineDiffEntry["state"],
  column: "left" | "right" | "merged"
): string | null {
  if (state === "same") {
    return null;
  }

  if (state === "changed") {
    if (column === "merged") {
      return "rgba(13, 202, 240, 0.2)";
    }
    return "rgba(255, 193, 7, 0.2)";
  }

  if (state === "left-only") {
    if (column === "left") {
      return "rgba(220, 53, 69, 0.18)";
    }
    if (column === "merged") {
      return "rgba(13, 202, 240, 0.18)";
    }
    return null;
  }

  if (state === "right-only") {
    if (column === "right") {
      return "rgba(25, 135, 84, 0.18)";
    }
    if (column === "merged") {
      return "rgba(13, 202, 240, 0.18)";
    }
    return null;
  }

  return null;
}

function normalizeLines(content: string): string[] {
  return content.replace(/\r\n/g, "\n").split("\n");
}

function dedupeAdjacentBlocks(lines: string[]): string[] {
  const deduped: string[] = [];

  for (const line of lines) {
    if (deduped.length && deduped[deduped.length - 1] === line) {
      continue;
    }
    deduped.push(line);
  }

  return deduped;
}

function timestampSlug(): string {
  const now = new Date();
  const part = (value: number) => value.toString().padStart(2, "0");
  return `${now.getFullYear()}${part(now.getMonth() + 1)}${part(now.getDate())}${part(now.getHours())}${part(now.getMinutes())}${part(now.getSeconds())}`;
}

function buildSiblingFilePath(file: TFile, label: string): string {
  const directory = file.parent?.path && file.parent.path !== "/" ? `${file.parent.path}/` : "";
  return normalizePath(`${directory}${file.basename} (${label}).${file.extension}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
