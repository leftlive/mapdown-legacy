// Multiple selection. `selectNode` stays the primary node (last clicked):
// editing, keyboard navigation and Markdown sync act on it alone, while batch
// operations use the whole set. Methods run with `this` bound to the MindMap.
import type INode from './INode';
import type MindMap from './mindmap';

export interface SelectionSnapshot {
    nodes: INode[];
    primary?: INode;
}

export function isSelectableNode(this: MindMap, node: INode) {
    return this.isNodeInTree(node) && node.isShow() &&
        (!this.focusedNode || this.isNodeWithinFocus(node));
}

// Visits nodes in document order (parents before children); traverseDF
// visits children first.
function forEachInOrder(node: INode, visit: (n: INode) => void) {
    visit(node);
    node.children.forEach((c) => forEachInOrder(c, visit));
}

// Selected nodes in document order.
export function selectedList(this: MindMap): INode[] {
    const list: INode[] = [];
    if (!this.root) {
        return list;
    }
    forEachInOrder(this.root, (n) => {
        if (this.selectedNodes.has(n)) {
            list.push(n);
        }
    });
    return list;
}

// Selected nodes without a selected ancestor, in document order. The root
// is left out (it cannot be deleted or moved) and does not cover its children.
export function topmostSelected(this: MindMap): INode[] {
    return this.selectedList().filter((node) => {
        if (node === this.root) {
            return false;
        }
        for (let p = node.parent; p && p !== this.root; p = p.parent) {
            if (this.selectedNodes.has(p)) {
                return false;
            }
        }
        return true;
    });
}

export function toggleSelection(this: MindMap, node: INode) {
    if (!this.selectedNodes.has(node)) {
        node.addToSelection(true);
        return;
    }
    node.unSelect();
    if (this.selectNode === node) {
        this.selectNode = null;
        const rest = this.selectedList();
        rest[rest.length - 1]?.addToSelection(true);
    }
}

// Shift+click: the sibling range from the primary node when both share a
// parent, otherwise a toggle.
export function selectRange(this: MindMap, node: INode) {
    const anchor = this.selectNode;
    const siblings = node.parent?.children;
    if (!anchor || anchor === node || !siblings || anchor.parent !== node.parent) {
        this.toggleSelection(node);
        return;
    }
    const from = siblings.indexOf(anchor), to = siblings.indexOf(node);
    const range = siblings.slice(Math.min(from, to), Math.max(from, to) + 1);
    range.forEach((n) => {
        if (n !== node && this.isSelectableNode(n)) {
            n.addToSelection(false);
        }
    });
    node.addToSelection(true);
}

// Drops every selected node except `node`, without touching the edit state.
export function collapseSelectionTo(this: MindMap, node?: INode) {
    Array.from(this.selectedNodes).forEach((n) => {
        if (n !== node) {
            n.unSelect();
        }
    });
}

export function selectAllVisible(this: MindMap) {
    const primary = this.selectNode && this.isSelectableNode(this.selectNode)
        ? this.selectNode
        : (this.focusedNode || this.root);
    primary?.addToSelection(true);
    forEachInOrder(this.root, (n) => {
        if (n !== primary && this.isSelectableNode(n)) {
            n.addToSelection(false);
        }
    });
}

// Removes nodes that were deleted or became hidden (collapse, focus mode).
export function pruneSelection(this: MindMap) {
    let primaryLost = !this.selectNode;
    this.selectedNodes.forEach((n) => {
        if (!this.isSelectableNode(n)) {
            n.unSelect();
            if (this.selectNode === n) {
                primaryLost = true;
            }
        }
    });
    if (primaryLost && this.selectedNodes.size) {
        this.selectNode = null;
        const rest = this.selectedList();
        rest[rest.length - 1]?.addToSelection(true);
    }
}

export function captureSelection(this: MindMap): SelectionSnapshot {
    return { nodes: this.selectedList(), primary: this.selectNode || undefined };
}

export function restoreSelection(this: MindMap, snapshot: SelectionSnapshot) {
    const nodes = snapshot.nodes.filter((n) => this.isSelectableNode(n));
    const primary = snapshot.primary && nodes.includes(snapshot.primary)
        ? snapshot.primary
        : nodes[nodes.length - 1];
    if (!primary) {
        return;
    }
    primary.select();
    nodes.forEach((n) => {
        if (n !== primary) {
            n.addToSelection(false);
        }
    });
}

// Box selection: the selectable nodes the client rect touches, so a box only
// has to cross a node rather than enclose it.
export function selectInRect(this: MindMap, rect: { left: number; top: number; right: number; bottom: number }, additive: boolean) {
    const hits: INode[] = [];
    forEachInOrder(this.root, (n) => {
        if (!this.isSelectableNode(n)) {
            return;
        }
        const b = n.contentEl.getBoundingClientRect();
        if (b.right >= rect.left && b.left <= rect.right && b.bottom >= rect.top && b.top <= rect.bottom) {
            hits.push(n);
        }
    });
    if (!additive) {
        this.clearSelectNode();
        if (hits.length) {
            hits[0].select();
        }
    }
    hits.forEach((n) => n.addToSelection(false));
}
