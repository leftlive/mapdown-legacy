// In-map search panel: query, highlight, navigation and temporary expansion.
// Methods run with `this` bound to the MindMap instance.
import INode from './INode';
import { setIcon } from 'obsidian';
import { normalizeSearchText } from '../utils';
import { t } from 'src/lang/helpers';
import type MindMap from './mindmap';

export function openSearch(this: MindMap) {
    if (this.searchPanel) {
        this.searchInput?.focus();
        this.searchInput?.select();
        return;
    }
    if (this.editNode?.data.isEdit) {
        this.editNode.commitEdit();
        this.editNode = null;
    }

    const ownerDocument = this.containerEL.ownerDocument;
    const panel = ownerDocument.createElement('div');
    panel.className = 'mapdown-search-panel';
    panel.setAttribute('role', 'search');

    const input = ownerDocument.createElement('input');
    input.className = 'mapdown-search-input';
    input.type = 'search';
    input.placeholder = t('Search nodes placeholder');
    input.setAttribute('aria-label', t('Search nodes'));

    const count = ownerDocument.createElement('span');
    count.className = 'mapdown-search-count';
    count.setAttribute('aria-live', 'polite');
    count.textContent = '0 / 0';

    const previous = this.createSearchButton(ownerDocument, 'chevron-up', t('Previous match'));
    const next = this.createSearchButton(ownerDocument, 'chevron-down', t('Next match'));
    const close = this.createSearchButton(ownerDocument, 'x', t('Close search'));
    previous.disabled = true;
    next.disabled = true;

    panel.append(input, count, previous, next, close);
    this.containerEL.appendChild(panel);
    this.searchPanel = panel;
    this.searchInput = input;
    this.searchCount = count;
    this.searchPreviousButton = previous;
    this.searchNextButton = next;

    panel.addEventListener('mousedown', (event) => event.stopPropagation());
    input.addEventListener('input', () => {
        if (!this.searchComposing) {
            this.scheduleSearchRefresh();
        }
    });
    input.addEventListener('compositionstart', () => {
        this.searchComposing = true;
    });
    input.addEventListener('compositionend', () => {
        this.searchComposing = false;
        this.scheduleSearchRefresh();
    });
    input.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.isComposing || this.searchComposing || event.keyCode === 229) {
            return;
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            this.navigateSearch(event.shiftKey ? -1 : 1);
        } else if (event.key === 'Escape') {
            event.preventDefault();
            this.closeSearch();
        }
    });
    input.addEventListener('keyup', (event) => event.stopPropagation());
    previous.addEventListener('click', () => this.navigateSearch(-1));
    next.addEventListener('click', () => this.navigateSearch(1));
    close.addEventListener('click', () => this.closeSearch());
    input.focus();
}

export function createSearchButton(this: MindMap, ownerDocument: Document, icon: string, label: string) {
    const button = ownerDocument.createElement('button');
    button.type = 'button';
    button.className = 'mapdown-search-button';
    button.title = label;
    button.setAttribute('aria-label', label);
    setIcon(button, icon);
    return button;
}

export function scheduleSearchRefresh(this: MindMap) {
    if (!this.searchPanel) {
        return;
    }
    const ownerWindow = this.containerEL.ownerDocument.defaultView;
    if (!ownerWindow) {
        this.updateSearchResults(++this.searchGeneration);
        return;
    }
    if (this.searchTimer !== null) {
        ownerWindow.clearTimeout(this.searchTimer);
    }
    const generation = ++this.searchGeneration;
    this.searchTimer = ownerWindow.setTimeout(() => {
        this.searchTimer = null;
        this.updateSearchResults(generation);
    }, 120);
}

export function updateSearchResults(this: MindMap, generation: number) {
    if (!this.searchPanel || generation !== this.searchGeneration) {
        return;
    }
    const query = (this.searchInput?.value || '').trim().toLocaleLowerCase();
    const queryChanged = query !== this.searchQuery;
    const previousMatchId = this.currentSearchMatchId;
    let visibilityChanged = false;
    if (queryChanged && this.searchTemporarilyExpandedIds.size > 0) {
        this.searchTemporarilyExpandedIds.clear();
        this.updateEffectiveNodeVisibility();
        visibilityChanged = true;
    }
    this.searchQuery = query;
    this.searchMatchIds = [];
    this.traverseDF((node: INode) => {
        node.containEl.classList.remove('mm-node-search-match', 'mm-node-search-current');
        if (query && normalizeSearchText(node.data.text || '').toLocaleLowerCase().includes(query)) {
            this.searchMatchIds.push(node.getId());
        }
    }, this.root, true);
    this.currentSearchMatchId = !queryChanged && previousMatchId && this.searchMatchIds.includes(previousMatchId)
        ? previousMatchId
        : undefined;
    this.refreshSearchHighlights();
    if (visibilityChanged) {
        this.refresh();
    }
}

export function flushSearchRefresh(this: MindMap) {
    if (!this.searchPanel) {
        return;
    }
    const ownerWindow = this.containerEL.ownerDocument.defaultView;
    if (this.searchTimer !== null && ownerWindow) {
        ownerWindow.clearTimeout(this.searchTimer);
    }
    this.searchTimer = null;
    this.updateSearchResults(++this.searchGeneration);
}

export function refreshSearchHighlights(this: MindMap) {
    const matches = new Set(this.searchMatchIds);
    this.traverseDF((node: INode) => {
        const id = node.getId();
        node.containEl.classList.toggle('mm-node-search-match', matches.has(id));
        node.containEl.classList.toggle('mm-node-search-current', id === this.currentSearchMatchId);
    }, this.root, true);

    const total = this.searchMatchIds.length;
    const currentIndex = this.currentSearchMatchId
        ? this.searchMatchIds.indexOf(this.currentSearchMatchId) + 1
        : 0;
    if (this.searchCount) {
        this.searchCount.textContent = this.searchQuery && total === 0
            ? t('No matches')
            : `${currentIndex} / ${total}`;
        this.searchCount.title = total > 0 && currentIndex === 0 ? t('Press Enter to locate') : '';
    }
    if (this.searchPreviousButton) this.searchPreviousButton.disabled = total === 0;
    if (this.searchNextButton) this.searchNextButton.disabled = total === 0;
}

export function navigateSearch(this: MindMap, direction: 1 | -1) {
    this.flushSearchRefresh();
    if (this.searchMatchIds.length === 0) {
        return;
    }
    const currentIndex = this.currentSearchMatchId
        ? this.searchMatchIds.indexOf(this.currentSearchMatchId)
        : -1;
    const nextIndex = currentIndex < 0
        ? (direction > 0 ? 0 : this.searchMatchIds.length - 1)
        : (currentIndex + direction + this.searchMatchIds.length) % this.searchMatchIds.length;
    const targetId = this.searchMatchIds[nextIndex];
    const target = this.getNodeById(targetId);
    if (!target) {
        this.scheduleSearchRefresh();
        return;
    }

    let ancestor = target.parent;
    while (ancestor) {
        if (!ancestor.isExpand) {
            this.searchTemporarilyExpandedIds.add(ancestor.getId());
        }
        ancestor = ancestor.parent;
    }
    this.updateEffectiveNodeVisibility();

    if (this.focusedNode && !this.isNodeWithin(target, this.focusedNode)) {
        this.focusedNode = undefined;
    }
    this.currentSearchMatchId = targetId;
    this.refresh();
    this.refreshSearchHighlights();
    this.scrollNodeIntoView(target);
}

export function isNodeWithin(this: MindMap, node: INode, ancestor: INode) {
    let current: INode | undefined = node;
    while (current) {
        if (current === ancestor) return true;
        current = current.parent;
    }
    return false;
}

export function scrollNodeIntoView(this: MindMap, node: INode) {
    const ownerWindow = this.containerEL.ownerDocument.defaultView;
    const generation = ++this.searchScrollGeneration;
    const scroll = () => {
        if (
            generation !== this.searchScrollGeneration ||
            !this.searchPanel ||
            this.currentSearchMatchId !== node.getId()
        ) {
            return;
        }
        const nodeRect = node.containEl.getBoundingClientRect();
        const containerRect = this.containerEL.getBoundingClientRect();
        this.containerEL.scrollTo({
            left: this.containerEL.scrollLeft + nodeRect.left + nodeRect.width / 2 -
                (containerRect.left + this.containerEL.clientWidth / 2),
            top: this.containerEL.scrollTop + nodeRect.top + nodeRect.height / 2 -
                (containerRect.top + this.containerEL.clientHeight / 2),
            behavior: 'smooth',
        });
        this.searchInput?.focus();
    };
    ownerWindow ? ownerWindow.requestAnimationFrame(scroll) : scroll();
}

export function closeSearch(this: MindMap, restoreTemporaryExpansion = true) {
    const ownerWindow = this.containerEL.ownerDocument.defaultView;
    if (this.searchTimer !== null && ownerWindow) {
        ownerWindow.clearTimeout(this.searchTimer);
    }
    this.searchTimer = null;
    this.searchGeneration++;
    this.searchScrollGeneration++;
    this.traverseDF((node: INode) => {
        node.containEl.classList.remove('mm-node-search-match', 'mm-node-search-current');
    }, this.root, true);

    if (restoreTemporaryExpansion) {
        this.searchTemporarilyExpandedIds.clear();
        this.updateEffectiveNodeVisibility();
    }
    this.searchTemporarilyExpandedIds.clear();
    this.searchPanel?.remove();
    this.searchPanel = undefined;
    this.searchInput = undefined;
    this.searchCount = undefined;
    this.searchPreviousButton = undefined;
    this.searchNextButton = undefined;
    this.searchQuery = '';
    this.searchMatchIds = [];
    this.currentSearchMatchId = undefined;
    if (restoreTemporaryExpansion) {
        this.refresh();
    }
}
