"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// main.ts
var main_exports = {};
__export(main_exports, {
  default: () => ConflictMergePlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var DEFAULT_SETTINGS = {
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
var ConflictMergePlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.settings = DEFAULT_SETTINGS;
    this.processingPaths = /* @__PURE__ */ new Set();
    this.scheduledHandles = /* @__PURE__ */ new Map();
  }
  async onload() {
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
        if (file instanceof import_obsidian.TFile) {
          this.scheduleConflictHandling(file, this.settings.autoOpenModal);
        }
      }));
    }
    this.registerEvent(this.app.vault.on("rename", (file) => {
      if (file instanceof import_obsidian.TFile) {
        this.scheduleConflictHandling(file, this.settings.autoOpenModal);
      }
    }));
    if (this.settings.scanOnStartup) {
      const pairs = await this.findConflictPairs();
      await this.presentPairs(pairs, false);
    }
  }
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  onunload() {
    for (const timer of this.scheduledHandles.values()) {
      window.clearTimeout(timer);
    }
    this.scheduledHandles.clear();
  }
  async findConflictPairs() {
    const files = this.app.vault.getMarkdownFiles();
    const pairs = [];
    for (const file of files) {
      const pair = this.buildConflictPair(file);
      if (pair) {
        pairs.push(pair);
      }
    }
    return pairs;
  }
  scheduleConflictHandling(file, openModal) {
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
  async handleConflictFileWhenStable(path, openModal) {
    const stableFile = await this.waitForStableConflictFile(path);
    if (!stableFile) {
      return;
    }
    await this.handleConflictFile(stableFile, openModal);
  }
  async waitForStableConflictFile(path) {
    let previousSnapshot = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const current = this.app.vault.getAbstractFileByPath(path);
      if (!(current instanceof import_obsidian.TFile) || !this.isConflictFile(current)) {
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
    return latest instanceof import_obsidian.TFile && this.isConflictFile(latest) ? latest : null;
  }
  async handleConflictFile(file, openModal) {
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
        new import_obsidian.Notice(`Detected conflict file: ${pair.conflict.path}`);
      }
    } finally {
      this.processingPaths.delete(file.path);
    }
  }
  async presentPairs(pairs, openModal) {
    if (!pairs.length) {
      if (openModal) {
        new import_obsidian.Notice("No conflict files detected.");
      }
      return;
    }
    new import_obsidian.Notice(`Detected ${pairs.length} conflict file${pairs.length === 1 ? "" : "s"}.`);
    if (openModal || this.settings.autoOpenModal) {
      for (const pair of pairs) {
        await this.openMergeModal(pair);
      }
    }
  }
  buildConflictPair(file) {
    if (!this.isConflictFile(file)) {
      return null;
    }
    const baseName = this.stripConflictSuffix(file.basename);
    if (!baseName || baseName === file.basename) {
      return null;
    }
    const parentPath = file.parent?.path;
    const candidatePath = parentPath && parentPath !== "/" ? (0, import_obsidian.normalizePath)(`${parentPath}/${baseName}.${file.extension}`) : (0, import_obsidian.normalizePath)(`${baseName}.${file.extension}`);
    const original = this.app.vault.getAbstractFileByPath(candidatePath);
    if (!(original instanceof import_obsidian.TFile)) {
      return null;
    }
    return { original, conflict: file };
  }
  isConflictFile(file) {
    return this.settings.conflictNamePatterns.some((pattern) => {
      try {
        return new RegExp(pattern, "i").test(file.basename);
      } catch {
        return false;
      }
    });
  }
  stripConflictSuffix(baseName) {
    return this.settings.conflictNamePatterns.reduce((current, pattern) => {
      try {
        return current.replace(new RegExp(pattern, "i"), "");
      } catch {
        return current;
      }
    }, baseName).trim();
  }
  async mergePair(pair) {
    const originalContent = await this.app.vault.cachedRead(pair.original);
    const conflictContent = await this.app.vault.cachedRead(pair.conflict);
    const rows = buildLineDiffEntries(originalContent, conflictContent);
    const mergedContent = buildMergedContentFromRows(rows);
    return { mergedContent, originalContent, conflictContent };
  }
  async openMergeModal(pair) {
    const contents = await this.mergePair(pair);
    await new Promise((resolve) => {
      new ConflictMergeModal(this.app, pair, contents, this.settings, resolve).open();
    });
  }
};
var ConflictMergeModal = class extends import_obsidian.Modal {
  constructor(app, pair, contents, settings, onCloseComplete) {
    super(app);
    this.pair = pair;
    this.contents = contents;
    this.settings = settings;
    this.onCloseComplete = onCloseComplete;
  }
  onOpen() {
    const { contentEl, titleEl } = this;
    this.modalEl.addClass("conflict-merge-modal");
    this.modalEl.style.width = "min(1600px, 96vw)";
    this.modalEl.style.maxWidth = "96vw";
    const modal = this.modalEl.querySelector(".modal");
    if (modal) {
      modal.style.width = "min(1600px, 96vw)";
      modal.style.maxWidth = "96vw";
    }
    titleEl.setText(`Merge conflict: ${this.pair.original.basename}`);
    contentEl.empty();
    contentEl.createEl("div", {
      cls: "conflict-merge-meta",
      text: `Original: ${this.pair.original.path} | Conflict: ${this.pair.conflict.path}`
    });
    const summary = contentEl.createEl("div", {
      cls: "conflict-merge-meta",
      text: "Workflow: compare left/right, review the merged candidate, then choose how to resolve."
    });
    summary.style.marginTop = "8px";
    const rows = buildLineDiffEntries(this.contents.originalContent, this.contents.conflictContent);
    this.buildSynchronizedCompare(contentEl, rows);
    new import_obsidian.Setting(contentEl).setName("Resolve conflict").setDesc("Choose which version to keep, or keep a merged copy for later review.").addButton((button) => {
      button.setButtonText("Apply merge").setCta().onClick(async () => {
        await this.applyToOriginal(this.contents.mergedContent, "Merged");
        this.close();
      });
    }).addButton((button) => {
      button.setButtonText("Use original").onClick(async () => {
        await this.resolveConflictFileOnly("Kept original");
        this.close();
      });
    }).addButton((button) => {
      button.setButtonText("Use conflict").onClick(async () => {
        await this.applyToOriginal(this.contents.conflictContent, "Applied conflict");
        this.close();
      });
    }).addButton((button) => {
      button.setButtonText("Keep both").onClick(async () => {
        await this.createMergedCopy();
        this.close();
      });
    }).addButton((button) => {
      button.setButtonText("Cancel").onClick(() => {
        new import_obsidian.Notice("Conflict left unchanged.");
        this.close();
      });
    });
  }
  onClose() {
    this.modalEl.removeClass("conflict-merge-modal");
    this.contentEl.empty();
    this.onCloseComplete();
  }
  buildSynchronizedCompare(container, rows) {
    const wrap = container.createDiv({ cls: "conflict-compare-wrap" });
    wrap.style.marginTop = "12px";
    wrap.style.border = "1px solid var(--background-modifier-border)";
    wrap.style.borderRadius = "8px";
    wrap.style.overflow = "hidden";
    const scroll = wrap.createDiv({ cls: "conflict-compare-scroll" });
    scroll.style.maxHeight = "64vh";
    scroll.style.overflow = "auto";
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
  appendHeaderCell(row, label) {
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
  appendCompareCell(row, value, state, column) {
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
  async applyToOriginal(nextContent, label) {
    await this.maybeBackupOriginal();
    await this.app.vault.modify(this.pair.original, nextContent);
    await this.resolveConflictFileOnly(label);
    await this.openResolvedFile(this.pair.original);
  }
  async resolveConflictFileOnly(label) {
    if (this.settings.moveConflictToTrashAfterResolve) {
      await this.app.fileManager.trashFile(this.pair.conflict);
      new import_obsidian.Notice(`${label}. Conflict file moved to trash.`);
      return;
    }
    new import_obsidian.Notice(`${label}. Conflict file kept for manual follow-up.`);
  }
  async maybeBackupOriginal() {
    if (!this.settings.createBackupBeforeApply) {
      return;
    }
    const originalContent = await this.app.vault.cachedRead(this.pair.original);
    const backupPath = buildSiblingFilePath(this.pair.original, `backup-${timestampSlug()}`);
    await this.app.vault.create(backupPath, originalContent);
  }
  async createMergedCopy() {
    const mergedPath = buildSiblingFilePath(this.pair.original, `merged-${timestampSlug()}`);
    await this.app.vault.create(mergedPath, this.contents.mergedContent);
    new import_obsidian.Notice(`Created merged copy: ${mergedPath}`);
  }
  async openResolvedFile(file) {
    const leaf = this.app.workspace.getMostRecentLeaf();
    if (leaf) {
      await leaf.openFile(file);
      const view = leaf.view;
      if (view instanceof import_obsidian.MarkdownView) {
        view.editor?.focus();
      }
    }
  }
};
var ConflictMergeSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Conflict Merge Assistant" });
    new import_obsidian.Setting(containerEl).setName("Scan on startup").setDesc("Look for conflict files when Obsidian starts.").addToggle((toggle) => {
      toggle.setValue(this.plugin.settings.scanOnStartup).onChange(async (value) => {
        this.plugin.settings.scanOnStartup = value;
        await this.plugin.saveSettings();
      });
    });
    new import_obsidian.Setting(containerEl).setName("Watch new files").setDesc("Automatically detect new conflict files as they appear.").addToggle((toggle) => {
      toggle.setValue(this.plugin.settings.watchCreates).onChange(async (value) => {
        this.plugin.settings.watchCreates = value;
        await this.plugin.saveSettings();
      });
    });
    new import_obsidian.Setting(containerEl).setName("Open merge modal automatically").setDesc("Open a review modal as soon as a conflict pair is detected.").addToggle((toggle) => {
      toggle.setValue(this.plugin.settings.autoOpenModal).onChange(async (value) => {
        this.plugin.settings.autoOpenModal = value;
        await this.plugin.saveSettings();
      });
    });
    new import_obsidian.Setting(containerEl).setName("Move conflict file to trash after resolve").setDesc("Prevents already-handled conflicts from showing up again on the next scan.").addToggle((toggle) => {
      toggle.setValue(this.plugin.settings.moveConflictToTrashAfterResolve).onChange(async (value) => {
        this.plugin.settings.moveConflictToTrashAfterResolve = value;
        await this.plugin.saveSettings();
      });
    });
    new import_obsidian.Setting(containerEl).setName("Create backup before apply").setDesc("Create a sibling backup note before overwriting the original file.").addToggle((toggle) => {
      toggle.setValue(this.plugin.settings.createBackupBeforeApply).onChange(async (value) => {
        this.plugin.settings.createBackupBeforeApply = value;
        await this.plugin.saveSettings();
      });
    });
    new import_obsidian.Setting(containerEl).setName("Conflict filename patterns").setDesc("One regular expression per line. The matched suffix is stripped to locate the original file.").addTextArea((textArea) => {
      textArea.setPlaceholder("\\s+\\(conflicted copy.*\\)$").setValue(this.plugin.settings.conflictNamePatterns.join("\n")).onChange(async (value) => {
        this.plugin.settings.conflictNamePatterns = value.split("\n").map((line) => line.trim()).filter(Boolean);
        await this.plugin.saveSettings();
      });
      textArea.inputEl.rows = 6;
      textArea.inputEl.cols = 40;
    });
  }
};
function mergeRunByLcs(originalRun, conflictRun) {
  const originalKeys = originalRun;
  const conflictKeys = conflictRun;
  const lcs = buildLcsTable(originalKeys, conflictKeys);
  const merged = [];
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
function buildLcsTable(left, right) {
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
function buildLineDiffEntries(leftContent, rightContent) {
  const leftLines = normalizeLines(leftContent);
  const rightLines = normalizeLines(rightContent);
  const table = buildLcsTable(leftLines, rightLines);
  const entries = [];
  let leftRun = [];
  let rightRun = [];
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
function appendChangedRun(entries, leftRun, rightRun) {
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
function getChangedRunState(left, right, hasLeft, hasRight) {
  if (hasLeft && hasRight) {
    return left === right ? "same" : "changed";
  }
  return hasLeft ? "left-only" : "right-only";
}
function buildMergedCandidateCell(left, right, hasLeft, hasRight) {
  if (!hasLeft || !hasRight) {
    return hasLeft ? left : right;
  }
  return mergeRunByLcs([left], [right]).join("\n");
}
function buildMergedContentFromRows(rows) {
  return rows.map((row) => row.merged).join("\n");
}
function getDiffBackground(state, column) {
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
function normalizeLines(content) {
  return content.replace(/\r\n/g, "\n").split("\n");
}
function dedupeAdjacentBlocks(lines) {
  const deduped = [];
  for (const line of lines) {
    if (deduped.length && deduped[deduped.length - 1] === line) {
      continue;
    }
    deduped.push(line);
  }
  return deduped;
}
function timestampSlug() {
  const now = /* @__PURE__ */ new Date();
  const part = (value) => value.toString().padStart(2, "0");
  return `${now.getFullYear()}${part(now.getMonth() + 1)}${part(now.getDate())}${part(now.getHours())}${part(now.getMinutes())}${part(now.getSeconds())}`;
}
function buildSiblingFilePath(file, label) {
  const directory = file.parent?.path && file.parent.path !== "/" ? `${file.parent.path}/` : "";
  return (0, import_obsidian.normalizePath)(`${directory}${file.basename} (${label}).${file.extension}`);
}
function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
