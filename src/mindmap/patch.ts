// In-place update of the map from re-parsed Markdown (typing in a linked
// editor): unchanged nodes keep their INode, DOM and render; only changed,
// added and removed nodes are touched. Methods run with `this` bound to the
// MindMap instance.
import INode, { INodeData } from './INode';
import { t } from '../lang/helpers';
import type MindMap from './mindmap';

export interface PatchAdapter<T> {
    text(node: T): string;
    blockId(node: T): string | undefined;
    children(node: T): T[];
}

export interface PatchPlan<T> {
    node: T | null;
    data: INodeData;
    children: PatchPlan<T>[];
    removed: T[];
    textChanged: boolean;
}

export interface PatchSummary {
    created: number;
    changed: number;
    removed: number;
}

// Pairs new siblings with old ones: equal text and block id first (longest
// common subsequence), then the unmatched nodes between two matches by
// position, so a node whose text was edited keeps its identity.
export function matchSiblings<T>(adapter: PatchAdapter<T>, oldList: T[], newList: INodeData[]): number[] {
    const key = (text: string, blockId?: string) => `${blockId || ''}\u0000${text}`;
    const oldKeys = oldList.map((n) => key(adapter.text(n), adapter.blockId(n)));
    const newKeys = newList.map((d) => key(d.text, d.blockId));
    const n = oldKeys.length, m = newKeys.length;
    const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            lcs[i][j] = oldKeys[i] === newKeys[j]
                ? lcs[i + 1][j + 1] + 1
                : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
        }
    }
    const result = new Array(m).fill(-1);
    const anchors: Array<[number, number]> = [];
    for (let i = 0, j = 0; i < n && j < m;) {
        if (oldKeys[i] === newKeys[j]) {
            anchors.push([i, j]);
            result[j] = i;
            i++;
            j++;
        } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
            i++;
        } else {
            j++;
        }
    }
    anchors.push([n, m]);
    let previousOld = 0, previousNew = 0;
    for (const [anchorOld, anchorNew] of anchors) {
        const gap = Math.min(anchorOld - previousOld, anchorNew - previousNew);
        for (let k = 0; k < gap; k++) {
            const i = previousOld + k, j = previousNew + k;
            if ((adapter.blockId(oldList[i]) || '') === (newList[j].blockId || '')) {
                result[j] = i;
            }
        }
        previousOld = anchorOld + 1;
        previousNew = anchorNew + 1;
    }
    return result;
}

export function planPatch<T>(adapter: PatchAdapter<T>, oldRoot: T, newRoot: INodeData) {
    const summary: PatchSummary = { created: 0, changed: 0, removed: 0 };
    const countSubtree = (node: T): number =>
        1 + adapter.children(node).reduce((sum, c) => sum + countSubtree(c), 0);
    const createPlan = (data: INodeData): PatchPlan<T> => {
        summary.created++;
        return {
            node: null,
            data,
            children: (data.children || []).map(createPlan),
            removed: [],
            textChanged: false,
        };
    };
    const pairPlan = (node: T, data: INodeData): PatchPlan<T> => {
        const oldChildren = adapter.children(node);
        const newChildren = data.children || [];
        const match = matchSiblings(adapter, oldChildren, newChildren);
        const used = new Set(match.filter((i) => i >= 0));
        const removed = oldChildren.filter((_, i) => !used.has(i));
        removed.forEach((r) => summary.removed += countSubtree(r));
        const textChanged = adapter.text(node) !== data.text;
        if (textChanged) {
            summary.changed++;
        }
        return {
            node,
            data,
            children: newChildren.map((c, j) => match[j] >= 0 ? pairPlan(oldChildren[match[j]], c) : createPlan(c)),
            removed,
            textChanged,
        };
    };
    // The root always keeps its node, even when its title changes.
    return { plan: pairPlan(oldRoot, newRoot), summary };
}

const inodeAdapter: PatchAdapter<INode> = {
    text: (node) => node.data.text,
    blockId: (node) => node.data.blockId,
    children: (node) => node.children,
};

// Returns false when the change is too large to be worth patching; the caller
// then rebuilds the map.
export function patchFromData(this: MindMap, newRoot: INodeData): boolean {
    if (!this.root || this.editNode?.data.isEdit || this._dragNode) {
        return false;
    }
    const placeholder = t('Sub title');
    const normalize = (d: INodeData) => {
        if (!d.text) {
            d.text = placeholder;
        }
        (d.children || []).forEach(normalize);
    };
    normalize(newRoot);

    const { plan, summary } = planPatch(inodeAdapter, this.root, newRoot);
    let total = 0;
    this.traverseBF(() => total++);
    if (summary.created + summary.changed > Math.max(30, total * 0.3)) {
        return false;
    }

    const removedNodes = new Set<INode>();
    const release = (node: INode) => {
        this.traverseBF((n: INode) => {
            removedNodes.add(n);
            n.releaseRenderComponent();
        }, node);
        this._removeChildDom(node);
    };

    const apply = (p: PatchPlan<INode>, parent?: INode): INode => {
        let node = p.node;
        if (!node) {
            node = new INode(p.data, this);
            if (parent?.direct) {
                node.direct = parent.direct;
            }
        } else {
            node.data.blockId = p.data.blockId;
            if (p.textChanged) {
                node.setText(p.data.text);
                node.refreshBox();
                node.clearCacheData();
            }
        }
        node.data.sourceRange = p.data.sourceRange;
        const expanded = p.data.expanded !== false;
        if (node.isExpand !== expanded) {
            node.isExpand = expanded;
            node.containEl.classList.toggle('mm-node-collapse', !expanded);
        }
        p.removed.forEach(release);
        const children = p.children.map((c) => apply(c, node));
        const changed = children.length !== node.children.length ||
            children.some((c, i) => c !== node.children[i]);
        if (changed) {
            node.children = children;
            children.forEach((c) => {
                if (!c.parent || c.parent !== node || !this.contentEL.contains(c.containEl)) {
                    c.parent = node;
                    this._addNodeDom(c);
                }
            });
            node.clearCacheData();
        }
        return node;
    };
    apply(plan);

    const isRemoved = (node?: INode) => !!node && removedNodes.has(node);
    if (isRemoved(this.selectNode)) {
        this.selectNode.unSelect();
        this.selectNode = null;
    }
    if (isRemoved(this.editNode)) {
        this.editNode = null;
    }
    if (isRemoved(this.lastSelectedNode)) {
        this.lastSelectedNode = null;
    }
    if (isRemoved(this.focusedNode)) {
        this.focusedNode = undefined;
    }
    this.selectedNodes.forEach((n) => {
        if (isRemoved(n)) {
            n.unSelect();
        }
    });
    if (!this.selectNode && this.selectedNodes.size) {
        this.selectedList().pop()?.addToSelection(true);
    }
    // Commands recorded before the text changed would replay onto a different tree.
    this.resetHistory();
    this.updateEffectiveNodeVisibility();
    // One layout in the next frame; nodes whose Markdown renders later
    // request their own (see MindMap.initNode).
    if (summary.created || summary.changed || summary.removed) {
        this.requestRenderRefresh();
    }
    if (this.searchPanel) {
        this.scheduleSearchRefresh();
    }
    return true;
}
