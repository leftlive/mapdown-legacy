// Markdown outline writer shared by the live map and the importers, so an
// imported note is written exactly as the map would save it.
export interface OutlineSource<T> {
    children(node: T): T[];
    text(node: T): string;
    // Block id written as ` ^id` ('' for none).
    blockId(node: T): string;
    // Body lines [start, end) the node was written to.
    written?(node: T, range: { start: number; end: number }): void;
}

const CODE_FENCE = /^(`{3,}|~{3,})/;

export function clampHeadLevel(value: unknown) {
    const level = Number(value);
    return Number.isFinite(level) ? Math.max(0, Math.min(6, Math.trunc(level))) : 1;
}

function forEachWithDepth<T>(root: T, source: OutlineSource<T>, visit: (node: T, depth: number) => void) {
    const recurse = (node: T, depth: number) => {
        visit(node, depth);
        source.children(node).forEach((c) => recurse(c, depth + 1));
    };
    recurse(root, 0);
}

export function writeOutline<T>(root: T, headLevel: unknown, source: OutlineSource<T>) {
    let md = '';
    let level = clampHeadLevel(headLevel);
    // A code block can only be written as a list item, so headings stop above it.
    forEachWithDepth(root, source, (node, depth) => {
        if (CODE_FENCE.test(source.text(node).trim())) {
            level = Math.min(level, depth);
        }
    });
    let lineCount = 0;
    const countLines = (text: string) => (text.match(/\n/g) || []).length;
    forEachWithDepth(root, source, (n, depth) => {
        const chunkStart = md.length;
        const l = depth + 1;
        let hPrefix = '', space = '';
        if (l > 1) {
            hPrefix = '\n';
        }
        const blockId = source.blockId(n);
        const ending = blockId ? ` ^${blockId}` : '';
        const text = source.text(n).trim();

        if (depth < level) {
            for (let i = 0; i < l; i++) {
                hPrefix += '#';
            }
            md += hPrefix + ' ' + text.replace(/\n/g, '<br>') + ending + '\n';
        } else {
            for (let i = 0; i < depth - level; i++) {
                space += '    ';
            }
            // `- > quote` would swallow the next items as continuation lines.
            const item = text.startsWith('>') ? `\\${text}` : text;
            if (!text) {
                md += `${space}-\n`;
            } else if (!text.includes('\n')) {
                md += `${space}- ${item}${ending}\n`;
            } else if (CODE_FENCE.test(text)) {
                md += `${space}-\n`;
                text.split('\n').forEach((line) => {
                    md += `${space}  ${line}\n`;
                });
                if (blockId) {
                    md += `${space}  ^${blockId}\n`;
                }
            } else {
                md += `${space}- ${item.replace(/\n/g, '<br>')}${ending}\n`;
            }
        }
        const chunk = md.slice(chunkStart);
        const leadingBlankLines = chunk.length - chunk.replace(/^\n+/, '').length;
        source.written?.(n, {
            start: lineCount + leadingBlankLines,
            end: lineCount + countLines(chunk),
        });
        lineCount += countLines(chunk);
    });
    return md.trim();
}

// Collapsed block ids in breadth-first order, as saved in `mindmark-state`.
export function collapsedIdsBreadthFirst<T>(root: T, source: OutlineSource<T>, isCollapsed: (node: T) => boolean) {
    const ids: string[] = [];
    const queue = [root];
    while (queue.length) {
        const node = queue.shift();
        if (isCollapsed(node)) {
            ids.push(source.blockId(node));
        }
        queue.push(...source.children(node));
    }
    return ids;
}
