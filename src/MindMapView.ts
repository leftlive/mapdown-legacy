import {
  HoverParent,
  HoverPopover,
  MarkdownView,
  Menu,
  TextFileView,
  WorkspaceLeaf,
  TFile,
  Notice,
  Platform,
  parseYaml
} from "obsidian";

import MindMapPlugin from './main'
import { FRONT_MATTER_REGEX, basicFrontmatter } from './constants'
import MindMap from "./mindmap/mindmap";
import INode, { INodeData } from './mindmap/INode'
import { Transformer } from './markmapLib/markmap-lib';
import { t, tf } from './lang/helpers'
import { uuid } from './utils'
import { revealLineInMarkdown } from './editorSync'
import { buildXmindArchive, mapToXmindSheet, MapNode } from './mindmap/export/xmind'
import { writeOutline } from './mindmap/outline'

// import domtoimage from './domtoimage.js'
import domtoimage from './dom-to-image-more.js'

const transformer = new Transformer();
const MAX_EXPORT_PIXELS = 64_000_000;
const MAX_EXPORT_SIDE = 32_767;
const EXPORT_RESOURCE_TIMEOUT_MS = 5_000;
const EXPORT_RENDER_TIMEOUT_MS = 20_000;
const MAX_QUEUED_EXPORTS = 3;
const exportQueues = new WeakMap<object, { tail: Promise<void>; count: number }>();

// The view closed (or reloaded) while an export was waiting or rendering.
class ExportCancelledError extends Error {}

interface ExportSnapshot {
  element: HTMLElement;
  width: number;
  height: number;
  sourcePath?: string;
  sourceTitle: string;
  generation: number;
}

interface SaveSnapshot {
  file: TFile;
  path: string;
  session: number;
  revision: number;
  data: string;
  baseData: string;
  // Unsaved editor text the map was refreshed from; the editor may write it first.
  previewData: string | null;
  rootTitleIntent: string | null;
  needsStateMigration: boolean;
}

interface RecoveryDraft {
  version: 1;
  sourcePath: string;
  revision: number;
  data: string;
  updatedAt: string;
}

interface MindMarkState {
  version: number;
  collapsed: Set<string>;
  writable: boolean;
  needsMigration: boolean;
  raw: Record<string, unknown>;
}

class DiskConflictError extends Error {
  externalData: string;

  constructor(externalData: string) {
    super('The mindmap changed on disk while it was being saved');
    this.externalData = externalData;
  }
}


export const mindmapViewType = "mindmapViewUpgraded";
export const mindmapIcon = "mapdown";
// brand/mapdown-glyph.svg (24×24) scaled to Obsidian's 100×100 icon box.
export const mindmapIconSvg = `<g transform="scale(4.1667)" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
<path d="M4.5 7.5H6M2 12H6M3 16.5H6"/>
<rect x="8.5" y="9.5" width="6" height="5" rx="1.5"/>
<path d="M14.5 12C17.5 12 16.5 7 19.5 7"/>
<path d="M14.5 12H19.5"/>
<path d="M14.5 12C17.5 12 16.5 17 19.5 17"/>
<circle cx="21" cy="7" r="1" fill="currentColor"/>
<circle cx="21" cy="12" r="1" fill="currentColor"/>
<circle cx="21" cy="17" r="1" fill="currentColor"/>
</g>`;

export class MindMapView extends TextFileView implements HoverParent {
  plugin: MindMapPlugin;
  hoverPopover: HoverPopover | null = null;
  id: string = (this.leaf as any).id;
  mindmap: MindMap | null;
  colors: string[] = [];
  timeOut: any = null;
  fileCache: any;
  firstInit: boolean = true;
  isInitializingMindmap: boolean = false;
  pendingSave: Promise<void> | null = null;
  saveRequestedWhilePending: boolean = false;
  localRevision: number = 0;
  savedRevision: number = 0;
  recoveredRevision: number = 0;
  // Not named lastSavedData: Obsidian's TextFileView overwrites that field on external modify.
  savedBaseData: string = '';
  private recentOwnWrites: string[] = [];
  private editorPreviewData: string | null = null;
  bodyLineOffset = 0;
  // Set while applying a selection that came from a Markdown editor (text -> map).
  syncingFromEditor = false;
  private selectionSyncTimer: number | null = null;
  private reselectFromEditorOnReady = false;
  externalConflictData: string | null = null;
  externalConflictGeneration: number = 0;
  fileSessionGeneration: number = 0;
  boundFilePath: string | null = null;
  lastSaveError: Error | null = null;
  draftWriteChain: Promise<void> = Promise.resolve();
  queuedDraftSession: number = -1;
  queuedDraftRevision: number = -1;
  pendingRootTitle: string | null = null;
  stateNeedsMigration: boolean = false;
  hasUnwritableState: boolean = false;
  migrationBackupSession: number = -1;
  metadataReadGeneration: number = 0;
  isApplyingExternalData: boolean = false;
  savingSnapshot: string | null = null;
  lastViewportWidth: number = 0;
  lastViewportHeight: number = 0;
  exportGeneration: number = 0;
  exportSnapshots = new Set<HTMLElement>();
  isClosed: boolean = false;
  yamlString:string=''

  getViewType() {
    return mindmapViewType;
  }
  getIcon() {
    return mindmapIcon;
  }

  getDisplayText() {
    return this.file?.basename || "mindmap";
  }

  setColors() {
    var colors:any[] = []
    try{
      if( this.plugin.settings.strokeArray){
         //colors = this.plugin.settings.strokeArray.split(',')
         colors = this.plugin.settings.strokeArray;
      }
    }catch(err){
       console.error('stroke array is error', err);
    }

    this.colors = this.colors.concat(colors);

    // We no longer add 50 random colors. Layout.ts now uses CSS variable defined theme palettes.
  }

  async exportToHtml() {
    if (!this.mindmap) {
      return;
    }

    let exportEl: HTMLElement | null = null;

    try {
      await this.commitEditBeforeExport();
      const snapshot = this.createExportSnapshot();
      exportEl = snapshot.element;
      await this.enqueueExport(async () => {
        this.assertExportActive(snapshot);
        this.activateExportSnapshot(snapshot);
        this.assertExportSize(snapshot, 1);
        await this.waitForExportResources(snapshot);
        this.assertExportActive(snapshot);
        const dataUrl = await this.withExportRenderTimeout(
          snapshot,
          this.exportSnapshotToDataUrl(snapshot, 'png', 1),
        );
        this.assertExportActive(snapshot);
        const title = snapshot.sourceTitle;
        const escapedTitle = this.escapeHtml(title);
        const html = [
          '<!DOCTYPE html>',
          '<html lang="en">',
          '<head>',
          '  <meta charset="UTF-8">',
          `  <title>${escapedTitle}</title>`,
          '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
          '  <style>',
          '    body { margin: 0; padding: 24px; background: #f5f5f5; font-family: sans-serif; }',
          '    main { display: flex; justify-content: center; }',
          '    img { max-width: 100%; height: auto; display: block; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12); }',
          '  </style>',
          '</head>',
          '<body>',
          '  <main>',
          `    <img src="${dataUrl}" alt="${escapedTitle}">`,
          '  </main>',
          '</body>',
          '</html>',
        ].join('\n');

        const fileName = await this.createUniqueExportFile(
          snapshot.sourcePath,
          '.html',
          snapshot.sourceTitle,
          html,
        );
        new Notice(tf('Mindmap exported as {0}: {1}', 'HTML', fileName));
      });
    } catch (err) {
      if (err instanceof ExportCancelledError) {
        return;
      }
      console.error('Failed to export mindmap as HTML:', err);
      new Notice(tf('Failed to export mindmap as {0}: {1}', 'HTML', String(err)));
    } finally {
      this.removeExportSnapshot(exportEl);
    }
  }

  exportToPng(i_scale: number) {
    if (!this.mindmap) {
      return;
    }

    return this.exportImage('png', i_scale);
  }

  exportToJpeg(i_scale: number) {
    if (!this.mindmap) {
      return;
    }

    return this.exportImage('jpeg', i_scale);
  }

  // Structured export: the whole map with its saved collapse state, ignoring
  // focus mode and search's temporary expansion.
  async exportToXmind() {
    const mindmap = this.mindmap;
    if (!mindmap) {
      return;
    }
    try {
      await this.commitEditBeforeExport();
      const toMapNode = (n: INode): MapNode => ({
        text: n.data.text || '',
        collapsed: !n.isExpand || !!mindmap.searchTemporarilyExpandedIds?.has(n.getId()),
        children: n.children.map(toMapNode),
      });
      const title = this.file?.basename || 'Mapdown Export';
      const sheet = mapToXmindSheet(toMapNode(mindmap.root), title, this.plugin.settings.layoutDirect);
      const archive = await buildXmindArchive(sheet, this.plugin.manifest.version);
      const buffer = archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer;
      const fileName = await this.createUniqueExportFile(this.file?.path, '.xmind', title, buffer);
      new Notice(tf('Mindmap exported as {0}: {1}', 'XMIND', fileName));
    } catch (err) {
      console.error('Failed to export mindmap as XMIND:', err);
      new Notice(tf('Failed to export mindmap as {0}: {1}', 'XMIND', String(err)));
    }
  }

  private async exportImage(format: 'png' | 'jpeg', scale: number) {
    if (!this.mindmap) {
      return;
    }

    let exportEl: HTMLElement | null = null;
    const extension = format === 'png' ? '.png' : '.jpeg';

    try {
      const exportScale = Math.max(1, scale);
      await this.commitEditBeforeExport();
      const snapshot = this.createExportSnapshot();
      exportEl = snapshot.element;
      await this.enqueueExport(async () => {
        this.assertExportActive(snapshot);
        this.activateExportSnapshot(snapshot);
        this.assertExportSize(snapshot, exportScale);
        await this.waitForExportResources(snapshot);
        this.assertExportActive(snapshot);
        const binary = await this.withExportRenderTimeout(
          snapshot,
          this.exportSnapshotToBinary(snapshot, format, exportScale),
        );
        this.assertExportActive(snapshot);
        const fileName = await this.createUniqueExportFile(
          snapshot.sourcePath,
          extension,
          snapshot.sourceTitle,
          binary,
        );
        new Notice(tf('Mindmap exported as {0}: {1}', format.toUpperCase(), fileName));
      });
    } catch (err) {
      if (err instanceof ExportCancelledError) {
        return;
      }
      console.error(`Failed to export mindmap as ${format.toUpperCase()}:`, err);
      new Notice(tf('Failed to export mindmap as {0}: {1}', format.toUpperCase(), String(err)));
    } finally {
      this.removeExportSnapshot(exportEl);
    }
  }

  // Export what the user sees after the edit: commit it, then wait for the
  // node to re-render and the layout frame to run.
  private async commitEditBeforeExport() {
    const mindmap = this.mindmap;
    if (!mindmap?.editNode?.data.isEdit) {
      return;
    }
    const rendered = new Promise<void>((resolve) => {
      const done = () => {
        mindmap.off('initNode', done);
        resolve();
      };
      mindmap.on('initNode', done);
      window.setTimeout(done, 500);
    });
    mindmap.commitActiveEdit();
    await rendered;
    await new Promise<void>((resolve) => {
      const ownerWindow = this.contentEl.ownerDocument.defaultView || window;
      ownerWindow.requestAnimationFrame(() => ownerWindow.requestAnimationFrame(() => resolve()));
    });
  }

  private createExportSnapshot(): ExportSnapshot {
    if (this.isClosed) {
      throw new ExportCancelledError('Export cancelled because the mindmap view was closed');
    }
    if (!this.mindmap) {
      throw new Error('Mindmap is not available');
    }

    const nodes: any[] = [];
    this.mindmap.traverseDF((node: any) => {
      if (node.isShow() && !node.containEl.classList.contains('mm-node-dimmed')) {
        nodes.push(node);
      }
    });

    if (nodes.length === 0) {
      throw new Error('No visible nodes to export');
    }

    const padding = 60;
    const box = this.mindmap.getBoundingRect(nodes);
    const width = Math.max(1, Math.ceil(box.width + padding * 2));
    const height = Math.max(1, Math.ceil(box.height + padding * 2));
    const ownerDocument = this.mindmap.containerEL.ownerDocument;
    const wrapper = ownerDocument.createElement('div');
    wrapper.className = 'mapdown-export-snapshot';
    wrapper.style.position = 'fixed';
    wrapper.style.left = '-100000px';
    wrapper.style.top = '0';
    wrapper.style.width = `${width}px`;
    wrapper.style.height = `${height}px`;
    wrapper.style.overflow = 'hidden';
    wrapper.style.pointerEvents = 'none';
    wrapper.style.background = this.getExportBackgroundColor();
    wrapper.style.zIndex = '2147483647';

    const contentClone = this.mindmap.contentEL.cloneNode(true) as HTMLElement;
    contentClone.style.position = 'absolute';
    contentClone.style.left = '0';
    contentClone.style.top = '0';
    contentClone.style.width = `${width}px`;
    contentClone.style.height = `${height}px`;
    contentClone.style.transform = 'none';
    contentClone.style.transformOrigin = '0 0';
    const sourceNodes = new Map<string, HTMLElement>();
    nodes.forEach((node) => {
      const id = node.containEl?.getAttribute('data-id');
      if (id) {
        sourceNodes.set(id, node.containEl);
      }
    });
    contentClone.querySelectorAll('.mm-node').forEach((element) => {
      const node = element as HTMLElement;
      const left = Number.parseFloat(node.style.left);
      const top = Number.parseFloat(node.style.top);
      if (Number.isFinite(left)) {
        node.style.left = `${left - box.x + padding}px`;
      }
      if (Number.isFinite(top)) {
        node.style.top = `${top - box.y + padding}px`;
      }

      const sourceNode = sourceNodes.get(node.getAttribute('data-id') || '');
      const sourceContent = sourceNode?.querySelector<HTMLElement>('.mm-node-content');
      const clonedContent = node.querySelector<HTMLElement>('.mm-node-content');
      if (sourceContent && clonedContent && this.isSingleLineNodeContent(sourceContent)) {
        // SVG rasterization cannot always reuse a locally installed UI font. Preserve
        // the live one-line layout when its fallback font is slightly wider.
        clonedContent.style.setProperty('white-space', 'nowrap', 'important');
        clonedContent.style.setProperty('overflow-wrap', 'normal', 'important');
        clonedContent.style.setProperty('word-break', 'normal', 'important');
      }
    });
    const svg = contentClone.querySelector('svg');
    if (svg) {
      svg.setAttribute('width', String(width));
      svg.setAttribute('height', String(height));
      svg.setAttribute('viewBox', `${box.x - padding} ${box.y - padding} ${width} ${height}`);
    }
    contentClone.querySelectorAll('.mm-node-dimmed').forEach((element) => {
      (element as HTMLElement).style.display = 'none';
    });
    contentClone.querySelectorAll([
      '.mm-node-menu',
      '.mm-node-layout-indicate',
      '.mm-control-panel',
      '.mapdown-search-panel',
    ].join(',')).forEach((element) => element.remove());
    contentClone.querySelectorAll([
      '.mm-node-select',
      '.mm-edit-node',
      '.mm-node-search-match',
      '.mm-node-search-current',
    ].join(',')).forEach((element) => {
      element.classList.remove(
        'mm-node-select',
        'mm-edit-node',
        'mm-node-search-match',
        'mm-node-search-current',
      );
    });

    wrapper.appendChild(contentClone);
    this.exportSnapshots.add(wrapper);

    return {
      element: wrapper,
      width,
      height,
      sourcePath: this.mindmap.path || this.file?.path,
      sourceTitle: this.file?.basename || 'Mapdown Export',
      generation: this.exportGeneration,
    };
  }

  private isSingleLineNodeContent(content: HTMLElement) {
    const ownerWindow = content.ownerDocument.defaultView;
    if (!ownerWindow) {
      return false;
    }

    const style = ownerWindow.getComputedStyle(content);
    const lineHeight = Number.parseFloat(style.lineHeight);
    if (!Number.isFinite(lineHeight)) {
      return false;
    }
    const verticalChrome = [
      style.paddingTop,
      style.paddingBottom,
      style.borderTopWidth,
      style.borderBottomWidth,
    ].reduce((total, value) => total + (Number.parseFloat(value) || 0), 0);
    return content.offsetHeight <= lineHeight + verticalChrome + 1;
  }

  private async exportSnapshotToDataUrl(
    snapshot: ExportSnapshot,
    format: 'png' | 'jpeg',
    scale: number,
  ): Promise<string> {
    const options = {
      width: snapshot.width,
      height: snapshot.height,
      scale,
      disableEmbedFonts: true,
      styleCaching: 'relaxed',
      bgcolor: format === 'jpeg'
        ? this.getExportBackgroundColor()
        : undefined,
    };
    return format === 'png'
      ? domtoimage.toPng(snapshot.element, options)
      : domtoimage.toJpeg(snapshot.element, { ...options, quality: 1.0 });
  }

  private async exportSnapshotToBinary(
    snapshot: ExportSnapshot,
    format: 'png' | 'jpeg',
    scale: number,
  ): Promise<ArrayBuffer> {
    const dataUrl = await this.exportSnapshotToDataUrl(snapshot, format, scale);
    return this.dataURLtoBlob(dataUrl).arrayBuffer();
  }

  private assertExportSize(snapshot: ExportSnapshot, scale: number) {
    const width = Math.ceil(snapshot.width * scale);
    const height = Math.ceil(snapshot.height * scale);
    const pixels = width * height;
    if (width > MAX_EXPORT_SIDE || height > MAX_EXPORT_SIDE || pixels > MAX_EXPORT_PIXELS) {
      const megapixels = (pixels / 1_000_000).toFixed(1);
      throw new Error(
        `Export size ${width} x ${height} (${megapixels} MP) is too large. ` +
        'Collapse branches or choose a lower resolution.',
      );
    }
  }

  private async waitForExportResources(snapshot: ExportSnapshot) {
    const ownerDocument = snapshot.element.ownerDocument;
    const fontSet = (ownerDocument as Document & { fonts?: FontFaceSet }).fonts;
    const fontsReady = fontSet?.ready?.then(() => undefined) || Promise.resolve();
    const imageReady = Array.from(snapshot.element.querySelectorAll('img')).map((image) => {
      const imageName = image.currentSrc || image.src || image.alt || 'unnamed image';
      if (image.complete) {
        return image.naturalWidth > 0
          ? Promise.resolve()
          : Promise.reject(new Error(`Unable to load image for export: ${imageName}`));
      }
      return new Promise<void>((resolve, reject) => {
        image.addEventListener('load', () => resolve(), { once: true });
        image.addEventListener('error', () => {
          reject(new Error(`Unable to load image for export: ${imageName}`));
        }, { once: true });
      });
    });

    const resourcesReady = Promise.all([fontsReady, ...imageReady]).then(() => undefined);
    const ownerWindow = ownerDocument.defaultView;
    if (ownerWindow) {
      let timeoutId: number | undefined;
      const timeout = new Promise<void>((_, reject) => {
        timeoutId = ownerWindow.setTimeout(() => {
          reject(new Error('Export resources did not finish loading within 5 seconds'));
        }, EXPORT_RESOURCE_TIMEOUT_MS);
      });
      try {
        await Promise.race([resourcesReady, timeout]);
      } finally {
        if (timeoutId !== undefined) {
          ownerWindow.clearTimeout(timeoutId);
        }
      }
    } else {
      await resourcesReady;
    }
    await this.waitForAnimationFrames(ownerDocument, 2);
  }

  private async waitForAnimationFrames(ownerDocument: Document, count: number) {
    const requestFrame = ownerDocument.defaultView?.requestAnimationFrame.bind(ownerDocument.defaultView);
    for (let i = 0; i < count; i++) {
      await new Promise<void>((resolve) => {
        if (requestFrame) {
          requestFrame(() => resolve());
        } else {
          resolve();
        }
      });
    }
  }

  private async withExportRenderTimeout<T>(snapshot: ExportSnapshot, render: Promise<T>) {
    const ownerWindow = snapshot.element.ownerDocument.defaultView;
    if (!ownerWindow) {
      return render;
    }

    let timeoutId: number | undefined;
    const timeout = new Promise<T>((_, reject) => {
      timeoutId = ownerWindow.setTimeout(() => {
        reject(new Error('Export rendering did not finish within 20 seconds'));
      }, EXPORT_RENDER_TIMEOUT_MS);
    });
    try {
      return await Promise.race([render, timeout]);
    } finally {
      if (timeoutId !== undefined) {
        ownerWindow.clearTimeout(timeoutId);
      }
    }
  }

  private assertExportActive(snapshot: ExportSnapshot) {
    if (this.isClosed || snapshot.generation !== this.exportGeneration) {
      throw new ExportCancelledError('Export cancelled because the mindmap view was closed');
    }
  }

  private activateExportSnapshot(snapshot: ExportSnapshot) {
    if (!snapshot.element.isConnected) {
      snapshot.element.ownerDocument.body.appendChild(snapshot.element);
    }
  }

  private enqueueExport(task: () => Promise<void>) {
    const key = this.app.vault as unknown as object;
    let queue = exportQueues.get(key);
    if (!queue) {
      queue = { tail: Promise.resolve(), count: 0 };
      exportQueues.set(key, queue);
    }
    if (queue.count >= MAX_QUEUED_EXPORTS) {
      throw new Error('Too many Mapdown exports are already queued');
    }

    queue.count++;
    const result = queue.tail.then(task);
    const completed = result.finally(() => {
      queue!.count--;
      if (queue!.count === 0) {
        exportQueues.delete(key);
      }
    });
    queue.tail = completed.then(() => undefined, () => undefined);
    return completed;
  }

  private removeExportSnapshot(element: HTMLElement | null) {
    if (!element) {
      return;
    }
    this.exportSnapshots.delete(element);
    element.remove();
  }

  private getExportBackgroundColor() {
    if (!this.mindmap) {
      return '#ffffff';
    }

    const configuredBackground = this.plugin.settings.background;
    if (configuredBackground && configuredBackground !== 'transparent') {
      return configuredBackground;
    }

    return getComputedStyle(this.mindmap.containerEL)
      .getPropertyValue('--background-primary')
      .trim() || '#ffffff';
  }

  private async getAvailableExportFilePath(
    sourcePath: string | undefined,
    extension: string,
    sourceTitle: string,
  ) {
    const fallbackName = this.sanitizeFilename(sourceTitle) || 'Mapdown Export';
    const basePath = sourcePath
      ? sourcePath.replace(/\.md$/i, '')
      : fallbackName;
    let candidate = `${basePath}${extension}`;
    let suffix = 1;
    while (await this.app.vault.adapter.exists(candidate)) {
      candidate = `${basePath} ${suffix}${extension}`;
      suffix++;
    }
    return candidate;
  }

  private async createUniqueExportFile(
    sourcePath: string | undefined,
    extension: string,
    sourceTitle: string,
    data: string | ArrayBuffer,
  ) {
    for (let attempt = 0; attempt < 1000; attempt++) {
      const path = await this.getAvailableExportFilePath(sourcePath, extension, sourceTitle);
      try {
        if (typeof data === 'string') {
          await this.app.vault.create(path, data);
        } else {
          await this.app.vault.createBinary(path, data);
        }
        return path;
      } catch (err) {
        if (!(await this.app.vault.adapter.exists(path))) {
          throw err;
        }
      }
    }
    throw new Error('Unable to allocate a unique export filename');
  }

  private escapeHtml(value: string) {
    return value.replace(/[&<>"']/g, (char) => {
      switch (char) {
        case '&':
          return '&amp;';
        case '<':
          return '&lt;';
        case '>':
          return '&gt;';
        case '"':
          return '&quot;';
        case "'":
          return '&#39;';
        default:
          return char;
      }
    });
  }

  dataURLtoBlob(dataUrl: string) {
    var arr = dataUrl.split(','), mime = arr[0].match(/:(.*?);/)[1],
      bstr = atob(arr[1]), n = bstr.length, u8arr = new Uint8Array(n);
    while (n--) {
      u8arr[n] = bstr.charCodeAt(n);
    }
    return new Blob([u8arr], { type: mime });
  }

  mindMapChange() {
    this.localRevision++;
    try {
      this.serializeMindMap();
    } catch (err) {
      this.lastSaveError = this.toError(err);
      console.error('Mapdown refused to overwrite unsafe state metadata:', err);
      new Notice(t('Save fail: unsupported mindmark-state metadata'));
      return;
    }
    const snapshot = this.captureSaveSnapshot();
    if (snapshot) {
      void this.scheduleRecoveryDraft(snapshot).catch((err) => {
        console.error('Failed to persist Mapdown recovery draft:', err);
      });
    }
    if (this.pendingSave) {
      this.saveRequestedWhilePending = true;
      return;
    }

    this.startQueuedSave();
  }

  private startQueuedSave() {
    const saveTask = this.persistQueuedMindMapChange();
    this.pendingSave = saveTask;
    void saveTask.catch((err) => {
      console.error('Failed to save Mapdown changes:', err);
    });
  }

  private async persistQueuedMindMapChange() {
    let saved = false;
    try {
      do {
        this.saveRequestedWhilePending = false;
        await this.persistMindMapChange();
      } while (this.saveRequestedWhilePending);
      this.lastSaveError = null;
      saved = true;
    } catch (err) {
      this.lastSaveError = this.toError(err);
      new Notice(`${t("Save fail")}`);
      throw this.lastSaveError;
    } finally {
      this.pendingSave = null;
      if (saved && this.externalConflictData !== null) {
        void this.applyExternalChangeAfterSave().catch((err) => {
          console.error('Failed to apply an external Mapdown change after saving:', err);
        });
      }
    }
  }

  // An external edit recorded while a save was running is applied once the save
  // settles, using the disk as the source of truth.
  private async applyExternalChangeAfterSave() {
    const file = this.file;
    const session = this.fileSessionGeneration;
    if (!file || this.externalConflictData === null) {
      return;
    }
    const diskData = await this.app.vault.read(file);
    if (
      this.file !== file ||
      this.fileSessionGeneration !== session ||
      this.externalConflictData === null ||
      this.pendingSave
    ) {
      return;
    }
    if (diskData === this.savedBaseData) {
      this.externalConflictData = null;
      return;
    }
    this.externalConflictData = diskData;
    this.applyPendingExternalChange();
  }

  private async persistMindMapChange() {
    const snapshot = this.captureSaveSnapshot();
    if (!snapshot || snapshot.revision <= Math.max(this.savedRevision, this.recoveredRevision)) {
      return;
    }

    let draftError: Error | null = null;
    try {
      await this.scheduleRecoveryDraft(snapshot);
    } catch (err) {
      draftError = this.toError(err);
      console.error('Failed to persist Mapdown recovery draft:', draftError);
    }

    try {
      await this.ensureStateMigrationBackup(snapshot);
      if (this.externalConflictData !== null) {
        await this.preserveConflictVersions(
          snapshot,
          this.externalConflictData,
          this.externalConflictGeneration,
        );
        return;
      }

      this.savingSnapshot = snapshot.data;
      await this.app.vault.process(snapshot.file, (diskData: string) => {
        if (diskData !== snapshot.baseData && diskData !== snapshot.data && diskData !== snapshot.previewData) {
          throw new DiskConflictError(diskData);
        }
        return snapshot.data;
      });

      if (!this.isSaveSnapshotCurrent(snapshot)) {
        return;
      }

      this.savedBaseData = snapshot.data;
      this.editorPreviewData = null;
      this.rememberOwnWrite(snapshot.data);
      this.savedRevision = Math.max(this.savedRevision, snapshot.revision);
      if (snapshot.needsStateMigration) {
        this.stateNeedsMigration = false;
      }
      try {
        await this.clearRecoveryDraftIfCurrent(snapshot);
      } catch (err) {
        console.error('Failed to clear a saved Mapdown recovery draft:', err);
      }

      try {
        await this.syncFilenameWithRootTitle(snapshot);
      } catch (err) {
        console.error('Failed to rename mindmap:', err);
        new Notice(t('Save fail: unable to rename the file'));
      }
    } catch (err) {
      if (err instanceof DiskConflictError) {
        const generation = this.recordExternalConflict(err.externalData);
        await this.preserveConflictVersions(snapshot, err.externalData, generation);
        return;
      }

      if (draftError) {
        throw new Error(
          `Mapdown could not save the note or its recovery draft: ${this.toError(err).message}; ` +
          `recovery draft: ${draftError.message}`,
        );
      }
      throw err;
    } finally {
      if (this.savingSnapshot === snapshot.data) {
        this.savingSnapshot = null;
      }
    }
  }

  private captureSaveSnapshot(): SaveSnapshot | null {
    if (!this.file || !this.serializeMindMap()) {
      return null;
    }

    return {
      file: this.file,
      path: this.file.path,
      session: this.fileSessionGeneration,
      revision: this.localRevision,
      data: this.data,
      baseData: this.savedBaseData,
      previewData: this.editorPreviewData,
      rootTitleIntent: this.pendingRootTitle,
      needsStateMigration: this.stateNeedsMigration,
    };
  }

  private async ensureStateMigrationBackup(snapshot: SaveSnapshot) {
    if (!snapshot.needsStateMigration || this.migrationBackupSession === snapshot.session) {
      return;
    }

    const backupPath = this.getAvailableRecoveryPath('backup');
    await this.app.vault.create(backupPath, snapshot.baseData);
    if (this.isSaveSnapshotCurrent(snapshot)) {
      this.migrationBackupSession = snapshot.session;
      new Notice(tf('Mapdown preserved the pre-migration note in {0}', backupPath));
    }
  }

  private async preserveConflictVersions(
    snapshot: SaveSnapshot,
    externalData: string,
    externalGeneration: number,
  ) {
    const recoveryPath = this.getAvailableRecoveryPath();
    await this.app.vault.create(recoveryPath, snapshot.data);

    if (!this.isSaveSnapshotCurrent(snapshot)) {
      return;
    }

    this.recoveredRevision = Math.max(this.recoveredRevision, snapshot.revision);
    new Notice(tf('Mapdown detected an external edit. Local changes were preserved in {0}', recoveryPath));

    const hasNewerLocalRevision = this.localRevision > snapshot.revision;
    const hasNewerExternalRevision = this.externalConflictGeneration !== externalGeneration;
    if (hasNewerLocalRevision || hasNewerExternalRevision) {
      this.saveRequestedWhilePending = true;
      return;
    }

    this.externalConflictData = null;
    this.savedBaseData = externalData;
    try {
      await this.clearRecoveryDraftIfCurrent(snapshot);
    } catch (err) {
      console.error('Failed to clear a recovered Mapdown draft:', err);
    }
    this.applyExternalData(externalData);
  }

  applyPendingExternalChange() {
    if (
      this.externalConflictData === null ||
      this.pendingSave ||
      this.hasUnprotectedChanges() ||
      this.mindmap?.editNode?.data.isEdit
    ) {
      return;
    }

    const externalData = this.externalConflictData;
    this.externalConflictData = null;
    this.applyExternalData(externalData);
  }

  // Change events for our own writes can arrive after a newer save has started.
  // Without this they look like external edits and trigger a false conflict.
  private rememberOwnWrite(data: string) {
    this.recentOwnWrites.push(data);
    if (this.recentOwnWrites.length > 8) {
      this.recentOwnWrites.shift();
    }
  }

  private isOwnWrite(data: string) {
    return this.recentOwnWrites.includes(data);
  }

  private recordExternalConflict(data: string) {
    this.externalConflictData = data;
    this.externalConflictGeneration++;
    return this.externalConflictGeneration;
  }

  private isSaveSnapshotCurrent(snapshot: SaveSnapshot) {
    return (
      this.fileSessionGeneration === snapshot.session &&
      this.file === snapshot.file &&
      this.file?.path === snapshot.path
    );
  }

  private hasUnprotectedChanges() {
    return this.localRevision > Math.max(this.savedRevision, this.recoveredRevision);
  }

  private scheduleRecoveryDraft(snapshot: SaveSnapshot) {
    if (
      this.queuedDraftSession === snapshot.session &&
      this.queuedDraftRevision === snapshot.revision
    ) {
      return this.draftWriteChain;
    }

    const draft: RecoveryDraft = {
      version: 1,
      sourcePath: snapshot.path,
      revision: snapshot.revision,
      data: snapshot.data,
      updatedAt: new Date().toISOString(),
    };
    const adapter = this.app.vault.adapter;
    const directory = this.getRecoveryDraftDirectory();
    const path = this.getRecoveryDraftPath(snapshot.path);

    this.queuedDraftSession = snapshot.session;
    this.queuedDraftRevision = snapshot.revision;
    this.draftWriteChain = this.draftWriteChain
      .catch(() => undefined)
      .then(async () => {
        if (!(await adapter.exists(directory))) {
          await adapter.mkdir(directory);
        }
        await adapter.write(path, JSON.stringify(draft));
      });
    return this.draftWriteChain;
  }

  private async clearRecoveryDraftIfCurrent(snapshot: SaveSnapshot) {
    if (!this.isSaveSnapshotCurrent(snapshot) || this.localRevision > snapshot.revision) {
      return;
    }

    await this.draftWriteChain.catch(() => undefined);
    const adapter = this.app.vault.adapter;
    const path = this.getRecoveryDraftPath(snapshot.path);
    if (await adapter.exists(path)) {
      await adapter.remove(path);
    }
  }

  private getRecoveryDraftDirectory() {
    return this.plugin.getRecoveryDraftDirectory();
  }

  private getRecoveryDraftPath(sourcePath: string) {
    let hash = 2166136261;
    for (let i = 0; i < sourcePath.length; i++) {
      hash ^= sourcePath.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `${this.getRecoveryDraftDirectory()}/${(hash >>> 0).toString(16)}.json`;
  }

  private toError(error: unknown) {
    if (error instanceof Error) {
      return error;
    }
    if (error && typeof error === 'object' && 'message' in error) {
      return new Error(String((error as { message: unknown }).message));
    }
    return new Error(String(error));
  }

  private applyExternalData(data: string) {
    this.isApplyingExternalData = true;
    try {
      this.setViewData(data);
    } finally {
      this.isApplyingExternalData = false;
    }
  }

  private getAvailableRecoveryPath(label: 'backup' | 'conflict' | 'recovered' = 'conflict') {
    const parentPath = this.file?.parent?.path;
    const folderPrefix = parentPath && parentPath !== '/' ? `${parentPath}/` : '';
    const basename = this.sanitizeFilename(this.file?.basename || 'Mapdown') || 'Mapdown';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return this.getAvailableRenamePath(folderPrefix, `${basename} Mapdown ${label} ${timestamp}`);
  }

  markRootTitleChange(title: string) {
    this.pendingRootTitle = title;
  }

  private async syncFilenameWithRootTitle(snapshot: SaveSnapshot) {
    if (
      !this.file ||
      !snapshot.rootTitleIntent ||
      this.localRevision !== snapshot.revision ||
      this.pendingRootTitle !== snapshot.rootTitleIntent
    ) {
      return;
    }

    const rootTitle = this.sanitizeFilename(snapshot.rootTitleIntent);
    if (!rootTitle || rootTitle === this.file.basename) {
      this.pendingRootTitle = null;
      return;
    }

    const parentPath = this.file.parent?.path;
    const folderPrefix = parentPath && parentPath !== '/' ? `${parentPath}/` : '';
    const newPath = this.getAvailableRenamePath(folderPrefix, rootTitle);
    await this.app.fileManager.renameFile(this.file, newPath);
    // onRename has already synced the paths; the view may have closed meanwhile.
    this.pendingRootTitle = null;
  }

  private getAvailableRenamePath(folderPrefix: string, basename: string) {
    let index = 0;
    let path = `${folderPrefix}${basename}.md`;

    while (this.app.vault.getAbstractFileByPath(path) && path !== this.file.path) {
      index++;
      path = `${folderPrefix}${basename} ${index}.md`;
    }

    return path;
  }

  private sanitizeFilename(text: string) {
    return (text || '')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/[*"\\/<>:|?#\[\]]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
  }

  private serializeMindMap(): boolean {
    if (!this.mindmap) {
      return false;
    }

    const configuredHeadLevel = Number(this.plugin.settings.headLevel);
    this.mindmap.setting.headLevel = Number.isFinite(configuredHeadLevel)
      ? Math.max(0, Math.min(6, Math.trunc(configuredHeadLevel)))
      : 1;

    const currentState = this.getMindMarkState(this.yamlString);
    if (!currentState.writable) {
      throw new Error('Mapdown cannot safely update the existing mindmark-state metadata');
    }
    this.yamlString = this.updateMindMarkState(
      this.yamlString,
      this.mindmap.getCollapsedBlockIds(),
    );
    this.data = this.yamlString + this.mindmap.getMarkdown();
    this.bodyLineOffset = this.getBodyLineOffset(this.data);
    return true;
  }

  async formatAndSaveMarkdown(): Promise<void> {
    this.mindmap?.commitActiveEdit();
    if (!this.pendingSave && this.hasUnprotectedChanges()) {
      this.startQueuedSave();
    }

    if (this.pendingSave) {
      await this.pendingSave;
    }

    if (this.hasUnprotectedChanges() || this.lastSaveError) {
      throw this.lastSaveError || new Error('Mapdown still has unsaved changes');
    }
  }

  // Edits to a map whose state metadata cannot be written would never be saved,
  // so keep such files in Markdown mode instead of accepting edits.
  returnUnwritableStateToMarkdown() {
    const leaf = this.leaf;
    const generation = this.fileSessionGeneration;
    setTimeout(() => {
      if (leaf.view !== this || this.fileSessionGeneration !== generation) {
        return;
      }
      void this.plugin.setMarkdownView(leaf);
    }, 0);
  }

  private getMindMarkState(frontMatter: string): MindMarkState {
    try {
      const yaml = frontMatter
        .replace(/^\uFEFF?---[ \t]*(?:\r?\n)?/, '')
        .replace(/\r?\n---[ \t]*(?:\r?\n)*$/, '');
      const document = parseYaml(yaml) || {};
      const state = document['mindmark-state'];
      if (state === undefined) {
        return {
          version: 1,
          collapsed: new Set<string>(),
          writable: true,
          needsMigration: true,
          raw: {},
        };
      }
      if (!state || typeof state !== 'object' || Array.isArray(state)) {
        throw new Error('mindmark-state must be a mapping');
      }

      const version = Number(state.version);
      const collapsed = state.collapsed === undefined ? [] : state.collapsed;
      if (!Number.isInteger(version) || !Array.isArray(collapsed) || collapsed.some((id) => typeof id !== 'string')) {
        throw new Error('mindmark-state has invalid fields');
      }
      if (version !== 1 && version !== 2) {
        return {
          version,
          collapsed: new Set<string>(),
          writable: false,
          needsMigration: false,
          raw: { ...state },
        };
      }

      return {
        version,
        collapsed: new Set<string>(collapsed),
        writable: true,
        needsMigration: version < 2,
        raw: { ...state },
      };
    } catch (err) {
      console.error('Failed to parse mindmark-state:', err);
      return {
        version: 0,
        collapsed: new Set<string>(),
        writable: false,
        needsMigration: false,
        raw: {},
      };
    }
  }

  private updateMindMarkState(frontMatter: string, collapsed: string[]) {
    const currentState = this.getMindMarkState(frontMatter);
    if (!currentState.writable) {
      throw new Error('Unsupported or invalid mindmark-state metadata');
    }

    const stateLine = `mindmark-state: ${JSON.stringify({
      ...currentState.raw,
      version: 2,
      collapsed,
    })}`;
    const newline = frontMatter.includes('\r\n') ? '\r\n' : '\n';
    const lines = frontMatter.split(/\r?\n/);
    const start = lines.findIndex((line) => /^mindmark-state\s*:/.test(line));
    if (start >= 0) {
      let end = start + 1;
      while (end < lines.length) {
        const line = lines[end];
        if (/^---[ \t]*$/.test(line) || (/^\S/.test(line) && /^[^#][^:]*:/.test(line))) {
          break;
        }
        end++;
      }
      lines.splice(start, end - start, stateLine);
      return lines.join(newline);
    }

    const closingDelimiter = /\r?\n---[ \t]*(?:\r?\n){2}$/;
    if (closingDelimiter.test(frontMatter)) {
      return frontMatter.replace(closingDelimiter, `${newline}${stateLine}${newline}---${newline}${newline}`);
    }

    return basicFrontmatter.replace(/\n---[ \t]*\n\n$/, `\n${stateLine}\n---\n\n`);
  }

  getFrontMatter(data: string = this.data) {
    const source = data || '';
    const match = FRONT_MATTER_REGEX.exec(source);
    if (match) {
      return this.normalizeFrontMatter(match[0]);
    }

    const recoveredFrontMatter = this.recoverFrontMatter(source);
    if (recoveredFrontMatter) {
      return recoveredFrontMatter;
    }

    return basicFrontmatter;
  }

  private normalizeFrontMatter(frontMatter: string) {
    return frontMatter.replace(/\s*$/, '\n\n');
  }

  // File line where the trimmed Markdown body starts; node source ranges are
  // relative to it, both after parsing and after serializing.
  private getBodyLineOffset(data: string) {
    const source = data || '';
    const body = this.stripFrontMatter(source);
    const firstContent = body.search(/\S/);
    const bodyStart = source.length - body.length + (firstContent < 0 ? body.length : firstContent);
    return (source.slice(0, bodyStart).match(/\n/g) || []).length;
  }

  // Whether node line numbers describe this text (what an editor shows).
  isSourceMapCurrent(text: string) {
    return text.replace(/\r\n/g, '\n') === this.data.replace(/\r\n/g, '\n');
  }

  // Map -> text sync: move the most recently used Markdown view of this file to
  // the selected node's line. Only user selections in the active map count.
  onMapSelectionChanged() {
    if (
      !this.plugin.settings.syncSelection ||
      this.isInitializingMindmap ||
      this.syncingFromEditor ||
      this.mindmap?.suppressFocus ||
      this.app.workspace.getActiveViewOfType(MindMapView) !== this
    ) {
      return;
    }
    // Coalesce clear-then-select sequences into one sync of the final node.
    this.scheduleSelectionSync(60, Date.now() + 3000);
  }

  private scheduleSelectionSync(delay: number, deadline: number) {
    const ownerWindow = this.containerEl.ownerDocument.defaultView || window;
    if (this.selectionSyncTimer != null) {
      ownerWindow.clearTimeout(this.selectionSyncTimer);
    }
    this.selectionSyncTimer = ownerWindow.setTimeout(() => {
      this.selectionSyncTimer = null;
      this.syncSelectionToMarkdown(deadline);
    }, delay);
  }

  private syncSelectionToMarkdown(deadline: number) {
    const node = this.mindmap?.selectNode;
    const target = this.findLinkedMarkdownView();
    if (!node || !target || this.isClosed) {
      return;
    }
    // The user moved on to the editor before this delayed sync ran; never
    // pull their cursor away.
    if (
      !this.plugin.settings.syncSelection ||
      this.app.workspace.getActiveViewOfType(MindMapView) !== this ||
      (target.getMode() !== 'preview' && target.editor.hasFocus())
    ) {
      return;
    }
    const text = target.getMode() === 'preview' ? target.data : target.editor.getValue();
    if (!this.isSourceMapCurrent(text)) {
      // The editor has not caught up with a map edit yet; try again shortly.
      if (Date.now() < deadline) {
        this.scheduleSelectionSync(150, deadline);
      }
      return;
    }
    revealLineInMarkdown(target, this.getFileLineOfNode(node));
  }

  // Text -> map sync: select the node at a Markdown cursor line without taking
  // focus from the editor. Hidden nodes resolve to their nearest visible
  // ancestor; nodes outside the focus-mode subtree are left alone.
  selectNodeFromEditor(line: number, text: string) {
    const mindmap = this.mindmap;
    if (
      !this.plugin.settings.syncSelection ||
      !mindmap ||
      this.isInitializingMindmap ||
      mindmap.editNode?.data.isEdit ||
      !this.isSourceMapCurrent(text)
    ) {
      return;
    }
    let node = this.getNodeAtFileLine(line);
    if (!node) {
      return;
    }
    while (!node.isShow() && node.parent) {
      node = node.parent;
    }
    if (mindmap.focusedNode && !mindmap.isNodeWithinFocus(node)) {
      return;
    }
    if (mindmap.selectNode !== node) {
      const suppressFocus = mindmap.suppressFocus;
      this.syncingFromEditor = true;
      mindmap.suppressFocus = true;
      try {
        mindmap.clearSelectNode();
        node.select();
      } finally {
        mindmap.suppressFocus = suppressFocus;
        this.syncingFromEditor = false;
      }
    }
    mindmap.revealNode(node);
  }

  // A rebuild caused by typing in a linked editor loses the selection; restore
  // it from that editor's cursor once the new map has been laid out.
  private onMindMapReady() {
    if (!this.reselectFromEditorOnReady) {
      return;
    }
    this.reselectFromEditorOnReady = false;
    const view = this.findLinkedMarkdownView();
    if (view && view.getMode() !== 'preview' && view.editor.hasFocus()) {
      this.selectNodeFromEditor(view.editor.getCursor().line, view.editor.getValue());
    }
  }

  private findLinkedMarkdownView(): MarkdownView | null {
    let best: MarkdownView | null = null;
    let bestTime = -1;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof MarkdownView && leaf.view.file === this.file) {
        const activeTime = (leaf as any).activeTime || 0;
        if (activeTime > bestTime) {
          best = leaf.view;
          bestTime = activeTime;
        }
      }
    });
    return best;
  }

  getNodeAtFileLine(line: number) {
    if (!this.mindmap || line < this.bodyLineOffset) {
      return null;
    }
    return this.mindmap.getNodeAtBodyLine(line - this.bodyLineOffset);
  }

  getFileLineOfNode(node: { data: { sourceRange?: { start: number } } }) {
    return this.bodyLineOffset + (node.data.sourceRange?.start ?? 0);
  }

  private stripFrontMatter(data: string) {
    const source = data || '';
    const match = FRONT_MATTER_REGEX.exec(source);
    if (match) {
      return source.slice(match[0].length);
    }

    if (source.replace(/^\uFEFF/, '').startsWith('---')) {
      const bodyStart = this.findMindMapBodyStart(source);
      if (bodyStart >= 0) {
        return source.slice(bodyStart);
      }
    }

    return source;
  }

  private recoverFrontMatter(data: string) {
    if (!data.replace(/^\uFEFF/, '').startsWith('---')) {
      return null;
    }

    const bodyStart = this.findMindMapBodyStart(data);
    if (bodyStart < 0) {
      return null;
    }

    const rawFrontMatter = data
      .slice(0, bodyStart)
      .replace(/^\uFEFF?---[ \t]*(?:\r?\n)?/, '')
      .replace(/\s*$/, '');
    const normalizedLines = rawFrontMatter
      .split(/\r?\n/)
      .map((line) => this.normalizeYamlLine(line))
      .filter((line) => line !== null) as string[];
    const content = normalizedLines.join('\n').trim();

    if (!content) {
      return basicFrontmatter;
    }

    return `---\n${content}\n---\n\n`;
  }

  private normalizeYamlLine(line: string): string | null {
    const trimmed = line.trim();
    if (!trimmed || /^---[ \t]*$/.test(trimmed)) {
      return null;
    }

    if (
      !line.match(/^\s/) &&
      !trimmed.includes(':') &&
      !trimmed.startsWith('#') &&
      !trimmed.startsWith('-')
    ) {
      return `${trimmed}:`;
    }

    return line.replace(/\s+$/, '');
  }

  private findMindMapBodyStart(data: string) {
    const headingMatch = /(^|\r?\n)#{1,6}\s+/.exec(data);
    if (headingMatch) {
      return headingMatch.index + headingMatch[1].length;
    }

    const listAfterBlankMatch = /(?:\r?\n){2}(\s*[-*+]\s+|\s*\d+\.\s+)/.exec(data);
    if (listAfterBlankMatch) {
      return listAfterBlankMatch.index + listAfterBlankMatch[0].length - listAfterBlankMatch[1].length;
    }

    const listMatch = /(^|\r?\n)(\s*[-*+]\s+|\s*\d+\.\s+)/.exec(data);
    if (listMatch) {
      return listMatch.index + listMatch[1].length;
    }

    return -1;
  }

  constructor(leaf: WorkspaceLeaf, plugin: MindMapPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.setColors();

    this.fileCache = {
      'frontmatter': {
        'mindmap-plugin': 'basic'
      }
    }

  }

  async onLoadFile(file: TFile) {
    await super.onLoadFile(file);
    await this.recoverPersistedDraft(file);
  }

  // Renames and moves from anywhere (file explorer, sync, other plugins) must
  // update the paths used for export and link resolution.
  async onRename(file: TFile) {
    await super.onRename(file);
    if (file !== this.file) {
      return;
    }
    this.boundFilePath = file.path;
    if (this.mindmap) {
      this.mindmap.path = file.path;
    }
  }

  async onUnloadFile(file: TFile) {
    if (
      this.file === file &&
      (this.pendingSave || this.hasUnprotectedChanges() || this.mindmap?.editNode?.data.isEdit)
    ) {
      await this.formatAndSaveMarkdown();
    }
    await super.onUnloadFile(file);
  }

  private async recoverPersistedDraft(file: TFile) {
    const adapter = this.app.vault.adapter;
    const draftPath = this.getRecoveryDraftPath(file.path);
    if (!(await adapter.exists(draftPath))) {
      return;
    }

    try {
      const draft = JSON.parse(await adapter.read(draftPath)) as Partial<RecoveryDraft>;
      if (
        draft.version !== 1 ||
        draft.sourcePath !== file.path ||
        typeof draft.data !== 'string'
      ) {
        throw new Error('invalid recovery draft data');
      }

      const diskData = await this.app.vault.read(file);
      if (draft.data === diskData) {
        await adapter.remove(draftPath);
        return;
      }
      if (this.file !== file || this.hasUnprotectedChanges()) {
        return;
      }

      const recoveryPath = this.getAvailableRecoveryPath('recovered');
      await this.app.vault.create(recoveryPath, draft.data);
      await adapter.remove(draftPath);
      new Notice(tf('Mapdown restored unsaved changes to {0}', recoveryPath));
    } catch (err) {
      console.error('Failed to recover a persisted Mapdown draft:', err);
      new Notice(t('Mapdown found an unsaved recovery draft but could not restore it'));
    }
  }


  async onClose() {
    this.isClosed = true;
    if (this.selectionSyncTimer != null) {
      (this.containerEl.ownerDocument.defaultView || window).clearTimeout(this.selectionSyncTimer);
      this.selectionSyncTimer = null;
    }
    this.exportGeneration++;
    this.exportSnapshots.forEach((element) => element.remove());
    this.exportSnapshots.clear();
    // Remove draggables from render, as the DOM has already detached
    //this.plugin.removeView(this);
    if (this.mindmap) {
      if (
        this.pendingSave ||
        this.hasUnprotectedChanges() ||
        this.mindmap.editNode?.data.isEdit
      ) {
        try {
          await this.formatAndSaveMarkdown();
        } catch (err) {
          console.error('Mapdown view closed with recoverable unsaved changes:', err);
          return;
        }
      }
      this.mindmap?.clear();
      this.contentEl.innerHTML = '';
      this.mindmap = null;
    }


  }

  clear() {

  }

  getViewData() {
    return this.data;
  }

  setViewData(data: string, clear: boolean = false) {

    if (this.savingSnapshot !== null && data === this.savingSnapshot) {
      return;
    }
    if (!clear && this.isOwnWrite(data)) {
      return;
    }
    if (!clear && this.mindmap && data === this.data && data === this.editorPreviewData) {
      // The editor saved the text the map already shows.
      this.savedBaseData = data;
      this.editorPreviewData = null;
      return;
    }

    if (
      !clear &&
      !this.isApplyingExternalData &&
      this.mindmap &&
      (this.pendingSave || this.hasUnprotectedChanges() || this.mindmap.editNode?.data.isEdit)
    ) {
      this.recordExternalConflict(data);
      return;
    }

    const filePath = this.file?.path || null;
    if (clear || (this.boundFilePath !== null && this.boundFilePath !== filePath)) {
      this.fileSessionGeneration++;
      this.recentOwnWrites = [];
    }
    this.boundFilePath = filePath;

    // A rebuild triggered from elsewhere (another editor, sync) keeps focus where it is.
    const focusIsElsewhere = !clear && !!this.mindmap &&
      !this.containerEl.contains(this.containerEl.ownerDocument.activeElement);
    if (this.mindmap) {
      this.mindmap.clear();
      this.contentEl.innerHTML = '';
    }

    this.data = data;
    this.savedBaseData = data;
    this.editorPreviewData = null;
    this.bodyLineOffset = this.getBodyLineOffset(data);
    this.localRevision = 0;
    this.savedRevision = 0;
    this.recoveredRevision = 0;
    this.lastSaveError = null;
    this.externalConflictData = null;
    this.pendingRootTitle = null;
    this.yamlString = this.getFrontMatter(this.data);

    var mdText = this.getMdText(this.data);
    const mindMarkState = this.getMindMarkState(this.yamlString);
    this.stateNeedsMigration = mindMarkState.needsMigration && mdText.length > 0;
    this.hasUnwritableState = !mindMarkState.writable;
    if (this.hasUnwritableState) {
      new Notice(t('Unsupported mindmark-state metadata, opened as Markdown'));
      // A file load is still inside leaf.setViewState; the plugin redirects after it settles.
      if (!clear) {
        this.returnUnwritableStateToMarkdown();
      }
    }
    var mindData = this.mdToData(mdText, mindMarkState);
    mindData.isRoot = true;

    // const frontmatterContentRegExResult = /^---$(.+?)^---$.+?/mis.exec(data)

    // if (frontmatterContentRegExResult != null && frontmatterContentRegExResult[1]) {
    //   frontmatterContentRegExResult[1].split('\n').forEach((frontmatterLine) => {
    //     const keyValue = frontmatterLine.split(': ')
    //     if (keyValue.length === 2) {
    //       const value = /^[{\[].+[}\]]$/.test(keyValue[1]) ? JSON.parse(keyValue[1]) : keyValue[1]
    //       this.fileCache.frontmatter[keyValue[0]] = value
    //     }
    //   });
    // }

    this.isInitializingMindmap = true;
    this.mindmap = new MindMap(mindData, this.contentEl, this.plugin.settings, this);
    this.mindmap.suppressFocus = focusIsElsewhere;
    this.reselectFromEditorOnReady = focusIsElsewhere;
    this.mindmap.colors = this.colors;
    if (this.firstInit) {
      const mindmap = this.mindmap;

      setTimeout(() => {
        if (this.mindmap !== mindmap || !this.file) {
          return;
        }

        mindmap.path = this.file.path;
        this.fileCache = this.app.metadataCache.getFileCache(this.file);
        this.yamlString = this.getFrontMatter();
        const markReady = () => {
          if (this.mindmap === mindmap && mindmap.appEl) {
            mindmap.appEl.classList.add('mm-ready');
            this.isInitializingMindmap = false;
            mindmap.off('initialLayoutComplete', markReady);
            this.onMindMapReady();
          }
        };

        mindmap.on('initialLayoutComplete', markReady);
        mindmap.init();
        mindmap.view = this;
        
        // Auto-edit root node if the mindmap is completely new
        if (mdText.trim() === "") {
           setTimeout(() => {
               if (this.mindmap && this.mindmap.root) {
                   if (this.leaf) {
                       this.app.workspace.setActiveLeaf(this.leaf, false, true);
                   }
                   this.mindmap.root.edit();
               }
           }, 600);
        }
        
        this.firstInit = false;
      }, 100);
    } else {
      var view = this.leaf.view as MindMapView;
      this.fileCache = this.app.metadataCache.getFileCache(view.file);
      this.yamlString = this.getFrontMatter();

      this.mindmap.path = view?.file.path;
      this.mindmap.view = this;
      const mindmap = this.mindmap;
      const markReady = () => {
        if (this.mindmap === mindmap && mindmap.appEl) {
          mindmap.appEl.classList.add('mm-ready');
          this.isInitializingMindmap = false;
          mindmap.off('initialLayoutComplete', markReady);
          this.onMindMapReady();
        }
      };

      mindmap.on('initialLayoutComplete', markReady);
      mindmap.init();
    }
  }

  onload() {
    super.onload();
    this.registerEvent(
      this.app.workspace.on("quick-preview", this.onEditorPreview, this)
    );
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => {
        if (leaf === this.leaf) {
            setTimeout(() => this.updateMindMap(), 100);
        }
      })
    );

    // 增加切换回 Markdown 的快捷按钮
    this.addAction("document", t("Open as markdown"), async () => {
      await this.plugin.setMarkdownView(this.leaf);
    });

    // 增加向右分屏并以 Markdown 展示的快捷按钮 (Toggle 模式)
    this.addAction("sidebar-right", t("Toggle split right (Markdown)"), async () => {
      // 查找当前工作区中是否已经有显示该文件的 markdown 视图
      const leaves = this.app.workspace.getLeavesOfType("markdown");
      const existingLeaf = leaves.find(l => {
         const view = l.view as any;
         return view.file && view.file.path === this.file.path;
      });

      if (existingLeaf) {
        // 如果已经存在，则将其关闭（取消分屏）
        existingLeaf.detach();
      } else {
        await this.formatAndSaveMarkdown();
        // 否则，创建一个新的右侧分屏叶子
        const newLeaf = (this.app.workspace as any).getLeaf("split", "vertical") as WorkspaceLeaf;
        // 标记这个新叶子需要以 Markdown 模式打开，避免被插件再次拦截为导图
        this.plugin.setFileMode(newLeaf, this.file.path, "markdown");
        // 在新叶子中打开当前文件
        newLeaf.openFile(this.file, { active: true });
      }
    });
  }

  // Unsaved text from a Markdown editor of the same file. Obsidian merges our
  // writes into that editor and saves the result, so it is never a conflict:
  // refresh the map only when idle, and keep the disk content as the baseline.
  onEditorPreview(file: TFile, data: string) {
    if (file !== this.file || data === this.data || this.isOwnWrite(data)) {
      return;
    }
    if (this.pendingSave || this.hasUnprotectedChanges() || this.mindmap?.editNode?.data.isEdit) {
      return;
    }
    if (!this.patchFromEditor(data)) {
      const baseData = this.savedBaseData;
      this.setViewData(data);
      this.savedBaseData = baseData;
    }
    this.editorPreviewData = data;
    this.fileCache = this.app.metadataCache.getFileCache(file);
  }

  // Apply editor text to the live map in place instead of rebuilding it.
  // Returns false when a rebuild is needed (state metadata changed, map not
  // ready, or too much of the map changed).
  private patchFromEditor(data: string): boolean {
    const mindmap = this.mindmap;
    if (
      !mindmap?.root ||
      this.firstInit ||
      this.isInitializingMindmap ||
      this.hasUnwritableState ||
      this.boundFilePath !== (this.file?.path || null) ||
      this.getFrontMatter(data) !== this.getFrontMatter(this.data)
    ) {
      return false;
    }
    const mdText = this.getMdText(data);
    const mindMarkState = this.getMindMarkState(this.getFrontMatter(data));
    if (!mdText || !mindMarkState.writable) {
      return false;
    }
    const mindData = this.mdToData(mdText, mindMarkState);
    mindData.isRoot = true;
    const focusIsElsewhere = !this.containerEl.contains(this.containerEl.ownerDocument.activeElement);
    try {
      if (!mindmap.patchFromData(mindData)) {
        return false;
      }
    } catch (e) {
      console.error('Mapdown: in-place update failed, rebuilding', e);
      return false;
    }
    // Same view state a rebuild would leave (unsaved map changes were ruled out).
    this.data = data;
    this.bodyLineOffset = this.getBodyLineOffset(data);
    this.localRevision = 0;
    this.savedRevision = 0;
    this.recoveredRevision = 0;
    this.lastSaveError = null;
    this.externalConflictData = null;
    this.pendingRootTitle = null;
    this.reselectFromEditorOnReady = focusIsElsewhere;
    // After the layout frame the patch requested, so revealing uses new positions.
    const ownerWindow = this.containerEl.ownerDocument.defaultView || window;
    ownerWindow.requestAnimationFrame(() => {
      if (this.mindmap === mindmap) {
        this.onMindMapReady();
      }
    });
    return true;
  }

  onQuickPreview(file: TFile, data: string) {
    if (file !== this.file || data === this.data || data === this.savedBaseData || this.isOwnWrite(data)) {
      return;
    }

    if (this.pendingSave || this.hasUnprotectedChanges() || this.mindmap?.editNode?.data.isEdit) {
      this.recordExternalConflict(data);
      return;
    }

    this.setViewData(data);
    this.fileCache = this.app.metadataCache.getFileCache(file);
  }

  updateMindMap(options: { force?: boolean; center?: boolean } = {}) {
    if (this.isInitializingMindmap) {
      return;
    }

    if (this.mindmap?.root && this.contentEl && this.contentEl.clientWidth > 0) {
      const width = this.contentEl.clientWidth;
      const height = this.contentEl.clientHeight;
      const sizeChanged = width !== this.lastViewportWidth || height !== this.lastViewportHeight;

      if (options.force || sizeChanged) {
        this.mindmap.refresh();
        this.lastViewportWidth = width;
        this.lastViewportHeight = height;
      }

      if(options.center && Platform.isDesktopApp){
        this.mindmap.center();
      }
    }
  }

  onResize() {
    super.onResize();
    this.updateMindMap();
  }

  async onFileMetadataChange(file: TFile) {
    if (file !== this.file) {
      return;
    }

    const generation = ++this.metadataReadGeneration;
    var path = file.path;
    let md = await this.app.vault.adapter.read(path);
    if (generation !== this.metadataReadGeneration || file !== this.file || path !== file.path) {
      return;
    }
    this.onQuickPreview(file, md);
  }

  getMdText(str: string) {
    return this.stripFrontMatter(str).trim();
  }

  mdToData(
    str: string,
    mindMarkState: { version: number; collapsed: Set<string> } = { version: 1, collapsed: new Set<string>() },
  ) {
    const sourceLines = str.split(/\r?\n/);

    function getCodeBlockSource(mapData: any): { id: string | null; text: string } | null {
      if (!/^(?:`{3,}|~{3,})/.test(String(mapData.v || '').trimStart())) {
        return null;
      }
      const range = mapData.p?.lines;
      if (!Array.isArray(range) || range.length < 2) {
        return null;
      }

      const lines = sourceLines.slice(range[0], range[1]);
      for (let i = 0; i < lines.length; i++) {
        const opening = lines[i].match(/^\s*(?:-\s+)?(`{3,}|~{3,})/);
        if (!opening) {
          continue;
        }
        const fenceCharacter = opening[1][0];
        const fenceLength = opening[1].length;
        const fenceColumn = lines[i].indexOf(opening[1]);
        for (let j = i + 1; j < lines.length; j++) {
          const closing = lines[j].trim().match(/^(`+|~+)$/);
          if (
            closing &&
            closing[1][0] === fenceCharacter &&
            closing[1].length >= fenceLength
          ) {
            const marker = (lines[j + 1] || '').trim().match(/^\^([a-z0-9-]+)$/i);
            const codeLines = lines.slice(i, j + 1).map((line, index) => {
              if (index === 0) {
                return line.slice(fenceColumn);
              }
              return line.length >= fenceColumn ? line.slice(fenceColumn) : line;
            });
            return {
              id: marker ? marker[1] : null,
              text: codeLines.join('\n'),
            };
          }
        }
      }
      return null;
    }

    function transformData(mapData: any) {
      var flag = true;
      if (mapData.t == 'blockquote') {
        mapData = mapData.c[0];
        flag = false;
        mapData.v = '> ' + mapData.v;
      }
      // A table (also one indented under a list item) becomes one node
      // holding its Markdown source.
      const tableHead = mapData.t === 'table' ? mapData : (mapData.c || []).find((c: any) => c.t === 'thead');
      if (tableHead && Array.isArray(tableHead.p?.lines)) {
        return tableNode(mapData, tableHead.p.lines[0]);
      }
      if (mapData.t === 'list_item') {
        mapData.v = String(mapData.v || '').replace(/^\\>/, '>');
        if (mapData.p?.index !== undefined) {
          mapData.v = mapData.v.replace(/^\d+[.)]\s+/, '');
        }
      }
      const regexResult = /^.+ \^([a-z0-9\-]+)$/im.exec(mapData.v);
      const codeBlock = getCodeBlockSource(mapData);
      const id = regexResult != null ? regexResult[1] : codeBlock?.id || null;

     // console.log(id);

      var rawText = regexResult
        ? mapData.v.replace(` ^${id}`, '')
        : codeBlock?.text || mapData.v;
      var map: INodeData = {
        id: id || uuid(),
        text: rawText.replace(/<br>/g, '\n'),
        children: [],
        expanded: mindMarkState.version >= 2 ? !mindMarkState.collapsed.has(id) : !id,
      };
      if (mapData.t === 'heading') {
        headingNodes.add(map);
      }
      if (id) {
        (map as any).blockId = id;
      }
      const lines = mapData.p?.lines;
      if (Array.isArray(lines) && lines.length === 2) {
        map.sourceRange = { start: lines[0], end: lines[1] };
      }

      if (flag && mapData.c && mapData.c.length) {
        listChildren(mapData).forEach((data: any) => {
          map.children.push(transformData(data));
        });
      }

      return map;
    }

    // Task lists come wrapped in an empty list node; their items belong to
    // the parent directly.
    function listChildren(mapData: any): any[] {
      return (mapData.c || []).reduce((all: any[], c: any) => (
        (c.t === 'bullet_list' || c.t === 'ordered_list') && !c.v
          ? all.concat(listChildren(c))
          : all.concat([c])
      ), []);
    }

    function tableNode(mapData: any, headLine: number): INodeData {
      let end = headLine;
      while (end < sourceLines.length && /^\s*\|/.test(sourceLines[end])) {
        end++;
      }
      const rows = sourceLines.slice(headLine, end);
      const indent = Math.min(...rows.map((row) => row.match(/^\s*/)[0].length));
      const marker = String(mapData.v || '').trim().match(/^\^([a-z0-9-]+)$/i);
      const id = marker ? marker[1] : null;
      const start = sourceLines[headLine - 1]?.trim() === '-' ? headLine - 1 : headLine;
      const lines = mapData.p?.lines;
      const node: INodeData = {
        id: id || uuid(),
        text: rows.map((row) => row.slice(indent).trimEnd()).join('\n'),
        children: [],
        expanded: mindMarkState.version >= 2 ? !mindMarkState.collapsed.has(id) : !id,
        sourceRange: { start, end: Math.max(end, Array.isArray(lines) ? lines[1] : end) },
      };
      if (id) {
        (node as any).blockId = id;
      }
      return node;
    }

    // Paragraphs, embeds and other text outside headings and lists are not
    // in the parsed tree; each block becomes a child of the heading above it.
    function addLooseText(root: INodeData) {
      const covered = new Set<number>();
      const headings: { node: INodeData; line: number }[] = [];
      const walk = (node: INodeData, isHeading: boolean) => {
        const range = node.sourceRange;
        if (range) {
          for (let i = range.start; i < Math.max(range.end, range.start + 1); i++) {
            covered.add(i);
          }
          if (isHeading) {
            headings.push({ node, line: range.start });
          }
        }
        node.children.forEach((c) => walk(c, headingNodes.has(c)));
      };
      walk(root, true);
      headings.sort((a, b) => a.line - b.line);

      const isSkipped = (line: string) => !line.trim() || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line);
      for (let i = 0; i < sourceLines.length; i++) {
        if (covered.has(i) || isSkipped(sourceLines[i])) {
          continue;
        }
        let end = i;
        while (end < sourceLines.length && !covered.has(end) && !isSkipped(sourceLines[end])) {
          end++;
        }
        const owner = headings.filter((h) => h.line < i).pop()?.node || root;
        const node: INodeData = {
          id: uuid(),
          text: sourceLines.slice(i, end).map((line) => line.trim()).join('\n').replace(/<br>/g, '\n'),
          children: [],
          expanded: true,
          sourceRange: { start: i, end },
        };
        const at = owner.children.findIndex((c) => (c.sourceRange?.start ?? -1) > i);
        owner.children.splice(at < 0 ? owner.children.length : at, 0, node);
        i = end - 1;
      }
    }
    const headingNodes = new Set<INodeData>();

    if (str) {
      const { root } = transformer.transform(str);
      const data = transformData(root);
      addLooseText(data);
      return data;

    } else {
      return {
        id: uuid(),
        text: this.file?.basename || `${t('Untitled mindmap')}`,
        expanded: true,
      }
    }
  }


  onMoreOptionsMenu(menu: Menu) {
    // Add a menu item to force the board to markdown view
    menu
      .addItem((item) => {
        item
          .setTitle(`${t("Open as markdown")}`)
          .setIcon("document")
          .onClick(async () => {
            await this.plugin.setMarkdownView(this.leaf);
          });
      });

    // .addItem((item)=>{
    //    item
    //    .setTitle(`${t("Export to opml")}`)
    //    .setIcon('image-file')
    //    .onClick(()=>{
    //       const targetFolder = this.plugin.app.fileManager.getNewFileParent(
    //        this.plugin.app.workspace.getActiveFile()?.path || ""
    //       );
    //       if(targetFolder){
    //         console.log(targetFolder,this.plugin.app.fileManager);

    //       }
    //    })

    // })

    const parentView = Object.getPrototypeOf(MindMapView.prototype);
    parentView.onPaneMenu?.call(this, menu, 'more-options');
  }

}

// A plain note written as a mind map note: its properties are kept and its
// body is converted the way opening it in the map view would.
export function plainNoteAsMindMap(source: string, basename: string, headLevel: unknown) {
  const view = Object.create(MindMapView.prototype) as MindMapView;
  (view as any).file = { basename };
  const data = view.mdToData(view.getMdText(source), { version: 2, collapsed: new Set<string>() });
  const match = FRONT_MATTER_REGEX.exec(source);
  const properties = match
    ? match[0].split(/\r?\n/).slice(1).filter((line) => (
      line.trim() && !/^---[ \t]*$/.test(line) && !/^(mindmap-plugin|mindmark-state)\s*:/.test(line)
    ))
    : [];
  const frontMatter = ['---', ...properties, 'mindmap-plugin: basic', 'mindmark-state: {"version":2,"collapsed":[]}', '---', '', ''].join('\n');
  return frontMatter + writeOutline<INodeData>(data, headLevel, {
    children: (n) => n.children || [],
    text: (n) => n.text || '',
    blockId: () => '',
  });
}
