// Turns an .xmind file into new Mapdown notes. Every entry point (drop,
// command, file menu) ends here; nothing existing is ever overwritten.
import { Notice, TFile, TFolder, normalizePath } from 'obsidian';
import { t, tf } from '../../lang/helpers';
import type MindMapPlugin from '../../main';
import { readXmind, sheetNoteNames, sheetToNote, SkippedKind, XmindDocument, XmindImportError } from './xmind';

const SKIPPED_LABELS: Record<SkippedKind, Parameters<typeof t>[0]> = {
    summary: 'XMind summaries',
    boundary: 'XMind boundaries',
    relationship: 'XMind relationships',
    callout: 'XMind callouts',
    image: 'XMind images',
};

export function importSummary(doc: XmindDocument) {
    const skipped = (Object.keys(SKIPPED_LABELS) as SkippedKind[])
        .filter((k) => doc.skipped[k] > 0)
        .map((k) => `${t(SKIPPED_LABELS[k])} ${doc.skipped[k]}`);
    const imported = tf('Imported {0} topics', String(doc.topicCount));
    return skipped.length
        ? imported + tf('XMind not imported: {0}', skipped.join(t('List separator')))
        : imported;
}

export async function importXmindFile(
    plugin: MindMapPlugin,
    data: ArrayBuffer,
    baseName: string,
    folder: TFolder,
): Promise<TFile[]> {
    let doc: XmindDocument;
    try {
        doc = await readXmind(data);
    } catch (err) {
        console.error('Failed to read XMind file:', err);
        const unrecognized = err instanceof XmindImportError && err.code === 'unrecognized';
        new Notice(t(unrecognized ? 'Unrecognized XMind file' : 'Parse xmind error'));
        return [];
    }

    // Build every note before creating any, so a failure leaves nothing behind.
    const names = sheetNoteNames(baseName.replace(/\.xmind$/i, ''), doc.sheets);
    const contents = doc.sheets.map((sheet) => sheetToNote(sheet, plugin.settings.headLevel));
    const vault = plugin.app.vault;
    const created: TFile[] = [];
    try {
        for (let i = 0; i < contents.length; i++) {
            const base = folder.isRoot() ? names[i] : `${folder.path}/${names[i]}`;
            const path = await availableNotePath(plugin, normalizePath(base));
            created.push(await vault.create(path, contents[i]));
        }
    } catch (err) {
        console.error('Failed to create the imported note:', err);
        for (const file of created) {
            await vault.delete(file).catch(() => undefined);
        }
        new Notice(t('Import failed: unable to create the note'));
        return [];
    }

    for (const file of created) {
        await plugin.openMindMapFile(file);
    }
    new Notice(importSummary(doc));
    return created;
}

export async function availableNotePath(plugin: MindMapPlugin, base: string) {
    let candidate = `${base}.md`;
    for (let suffix = 1; await plugin.app.vault.adapter.exists(candidate); suffix++) {
        candidate = `${base} ${suffix}.md`;
    }
    return candidate;
}

// The command entry: a system file picker.
export function pickXmindFile(plugin: MindMapPlugin, folder: TFolder) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xmind';
    input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (file) {
            await importXmindFile(plugin, await file.arrayBuffer(), file.name, folder);
        }
    });
    input.click();
}
