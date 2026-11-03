// Writes a map as an XMind Zen / 2020+ file: the reverse of the import rules
// in ../import/xmind.ts. No Obsidian imports, so the regression tests can load it.
import JSZip from 'jszip';
import { uuid } from '../../utils';
import { NOTE_PREFIX, TASK_DONE } from '../import/xmind';

export interface MapNode {
    text: string;
    collapsed: boolean;
    children: MapNode[];
}

const STRUCTURES: { [direct: string]: string } = {
    right: 'org.xmind.ui.logic.right',
    left: 'org.xmind.ui.logic.left',
    clockwise: 'org.xmind.ui.map.clockwise',
};

const LINK = /\[((?:\\.|[^\]\\])*)\]\(([^)\s]+)\)/g;

export interface TitleParts {
    title: string;
    href: string;
    labels: string[];
    markers: string[];
}

// Splits node text into an XMind title, link, labels and markers.
export function parseTitle(text: string): TitleParts {
    let title = text.replace(/<br\s*\/?>/gi, '\n').trim();
    const markers: string[] = [];
    for (let changed = true; changed;) {
        changed = false;
        const priority = /^\(P([1-9])\)\s*/.exec(title);
        if (priority && !markers.some((m) => m.startsWith('priority-'))) {
            markers.unshift(`priority-${priority[1]}`);
            title = title.slice(priority[0].length);
            changed = true;
        }
        if (title.startsWith(TASK_DONE) && !markers.includes('task-done')) {
            markers.push('task-done');
            title = title.slice(TASK_DONE.length).trimStart();
            changed = true;
        }
    }

    const labels: string[] = [];
    for (let m = /\s+`([^`\n]+)`$/.exec(title); m && title.length > m[0].length; m = /\s+`([^`\n]+)`$/.exec(title)) {
        labels.unshift(m[1]);
        title = title.slice(0, -m[0].length);
    }

    let href = '';
    title = title.replace(LINK, (match, label: string, url: string) => {
        if (!/^(https?:|mailto:)/i.test(url)) {
            return match;
        }
        href = href || url;
        return label.replace(/\\([[\]])/g, '$1');
    });
    title = title
        .replace(/(^|[^!])\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, before: string, target: string, alias?: string) => before + (alias || target))
        .replace(/\*\*([^*\n]+)\*\*/g, '$1')
        .replace(/__([^_\n]+)__/g, '$1')
        .replace(/==([^=\n]+)==/g, '$1')
        .replace(/~~([^~\n]+)~~/g, '$1')
        .replace(/(^|[^*])\*([^*\s][^*\n]*)\*(?!\*)/g, '$1$2');
    return { title: title.trim(), href, labels, markers };
}

function toTopic(node: MapNode): any {
    let children = node.children;
    let notes = '';
    const first = children[0];
    if (first && !first.children.length && first.text.startsWith(NOTE_PREFIX)) {
        notes = first.text.slice(NOTE_PREFIX.length).replace(/<br\s*\/?>/gi, '\n').trim();
        children = children.slice(1);
    }
    const parts = parseTitle(node.text);
    const topic: any = { id: uuid(), class: 'topic', title: parts.title };
    if (parts.href) {
        topic.href = parts.href;
    }
    if (parts.labels.length) {
        topic.labels = parts.labels;
    }
    if (parts.markers.length) {
        topic.markers = parts.markers.map((markerId) => ({ markerId }));
    }
    if (notes) {
        topic.notes = { plain: { content: notes } };
    }
    if (node.collapsed && (children.length || notes)) {
        topic.branch = 'folded';
    }
    if (children.length) {
        topic.children = { attached: children.map(toTopic) };
    }
    return topic;
}

export function mapToXmindSheet(root: MapNode, title: string, layoutDirect?: string) {
    const rootTopic = toTopic(root);
    rootTopic.structureClass = STRUCTURES[layoutDirect || ''] || 'org.xmind.ui.map.unbalanced';
    return { id: uuid(), class: 'sheet', title, rootTopic };
}

export function buildXmindArchive(sheet: ReturnType<typeof mapToXmindSheet>, version = '') {
    const zip = new JSZip();
    zip.file('content.json', JSON.stringify([sheet]));
    zip.file('metadata.json', JSON.stringify({ creator: { name: 'Mapdown', version } }));
    zip.file('manifest.json', JSON.stringify({ 'file-entries': { 'content.json': {}, 'metadata.json': {} } }));
    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
