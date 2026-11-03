import INode, { INodeData, levelClass } from './INode'
import Layout from './Layout'
import { Menu, Platform, setIcon } from 'obsidian'
import SVG from 'svg.js'
import type { MindMapView } from '../MindMapView'
import Exec from './Execute'
import { FileSuggest } from './FileSuggest'

import { t } from 'src/lang/helpers'
import * as search from './search'
import * as keyboard from './keyboard'
import * as navigation from './navigation'
import * as pointer from './pointer'
import * as serialize from './serialize'
import * as viewport from './viewport'
import * as patch from './patch'
import * as selection from './selection'
import type { SelectionSnapshot } from './selection'

let deleteIcon = '<svg class="icon" width="16px" height="16.00px" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg"><path  d="M799.2 874.4c0 34.4-28 62.4-62.368 62.4H287.2a62.496 62.496 0 0 1-62.4-62.4V212h574.4v662.4zM349.6 100c0-7.2 5.6-12.8 12.8-12.8h300c7.2 0 12.768 5.6 12.768 12.8v37.6H349.6V100z m636.8 37.6H749.6V100c0-48-39.2-87.2-87.2-87.2h-300a87.392 87.392 0 0 0-87.2 87.2v37.6H37.6C16.8 137.6 0 154.4 0 175.2s16.8 37.6 37.6 37.6h112v661.6A137.6 137.6 0 0 0 287.2 1012h449.6a137.6 137.6 0 0 0 137.6-137.6V212h112c20.8 0 37.6-16.8 37.6-37.6s-16.8-36.8-37.6-36.8zM512 824c20.8 0 37.6-16.8 37.6-37.6v-400c0-20.8-16.768-37.6-37.6-37.6-20.8 0-37.6 16.8-37.6 37.6v400c0 20.8 16.8 37.6 37.6 37.6m-175.2 0c20.8 0 37.6-16.8 37.6-37.6v-400c0-20.8-16.8-37.6-37.6-37.6s-37.6 16.8-37.6 37.6v400c0.8 20.8 17.6 37.6 37.6 37.6m350.4 0c20.8 0 37.632-16.8 37.632-37.6v-400c0-20.8-16.8-37.6-37.632-37.6-20.768 0-37.6 16.8-37.6 37.6v400c0 20.8 16.8 37.6 37.6 37.6" /></svg>';
let addIcon = '<svg class="icon" width="16px" height="16.00px" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg"><path  d="M512 1024C230.4 1024 0 793.6 0 512S230.4 0 512 0s512 230.4 512 512-230.4 512-512 512z m0-960C265.6 64 64 265.6 64 512s201.6 448 448 448 448-201.6 448-448S758.4 64 512 64z"  /><path d="M800 544H224c-19.2 0-32-12.8-32-32s12.8-32 32-32h576c19.2 0 32 12.8 32 32s-12.8 32-32 32z"  /><path  d="M512 832c-19.2 0-32-12.8-32-32V224c0-19.2 12.8-32 32-32s32 12.8 32 32v576c0 19.2-12.8 32-32 32z"  /></svg>';
let focusIcon = '<svg class="icon" width="16px" height="16px" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg"><path d="M512 1024c-282.8 0-512-229.2-512-512s229.2-512 512-512 512 229.2 512 512-229.2 512-512 512z m0-960C264.8 64 64 264.8 64 512s200.8 448 448 448 448-200.8 448-448S759.2 64 512 64z m0 768c-176.8 0-320-143.2-320-320s143.2-320 320-320 320 143.2 320 320-143.2 320-320 320z m0-576c-141.2 0-256 114.8-256 256s114.8 256 256 256 256-114.8 256-256-114.8-256-256-256z m0 384c-70.6 0-128-57.4-128-128s57.4-128 128-128 128 57.4 128 128-57.4 128-128 128z m0-192c-35.4 0-64 28.6-64 64s28.6 64 64 64 64-28.6 64-64-28.6-64-64-64z"/></svg>';
let tempDispLevel = 0;

interface Setting {
    theme?: string;
    canvasSize?: number;
    background?: string;
    fontSize?: number;
    color?: string,
    exportMdModel?: string,
    headLevel: number,
    layoutDirect: string,
    strokeArray?:any[],
    focusOnMove?: boolean,
    focusOverlayOpacity?: number,
    focusGlowSize?: number,
    nodeGlowSize?: number,
    nodeMaxWidth?: number,
    enableLinkPreview?: boolean,
    linkOpenMode?: 'current' | 'tab' | 'window'
}

export default class MindMap {
    root: INode;
    status: string;
    appEl: HTMLElement;
    contentEL: HTMLElement;
    containerEL: HTMLElement;
    path?: string;
    editNode?: INode;
    selectNode?: INode;
    focusedNode?: INode;
    lastSelectedNode?: INode;
    // Every selected node, including the primary `selectNode`.
    selectedNodes = new Set<INode>();
    // The primary node the view was last told about (Markdown selection sync).
    reportedSelectNode: INode = null;
    // Set while a batch runs; commands then defer layout and saving.
    refreshSuspended = 0;
    refreshPending = false;
    marqueeEndedAt = 0;
    panMoved = false;
    setting: Setting;
    data: INodeData;
    drag?: boolean;
    startX?: number;
    startY?: number;
    dx?: number;
    dy?: number;
    mmLayout?: Layout;
    draw: any;
    edgeGroup: any;
    _nodeNum: number = 0;
    _tempNum: number = 0;
    view?: MindMapView;
    colors: string[] = [];
    _dragNode?: INode;
    exec: Exec;
    scalePointer: number[] = [];
    mindScale = 100;
    timeOut: any = null;
    _indicateDom:HTMLElement;
    _menuDom:HTMLElement;
    _dragType:string='';
    _left:number;
    _top:number;
    dispLevel:number;
    isComposing = false;
    // Set by focusin/focusout only; a map must not handle keys typed elsewhere.
    isFocused = false;
    // A rebuild while focus is in another view (e.g. typing in the Markdown
    // split) must not pull focus into the map; cleared on the next interaction.
    suppressFocus = false;
    fileSuggest: FileSuggest;
    renderRefreshFrame: number | null = null;
    revealGeneration: number = 0;
    nodeRemeasureTimer: number | null = null;
    pendingNodeRemeasure = new Set<INode>();
    isInitializingNodes = false;
    focusTimer: number | null = null;
    controlPanel?: HTMLElement;
    undoButton?: HTMLElement;
    redoButton?: HTMLElement;
    searchPanel?: HTMLElement;
    searchInput?: HTMLInputElement;
    searchCount?: HTMLElement;
    searchPreviousButton?: HTMLButtonElement;
    searchNextButton?: HTMLButtonElement;
    searchQuery = '';
    searchMatchIds: string[] = [];
    currentSearchMatchId?: string;
    searchTimer: number | null = null;
    searchGeneration = 0;
    searchScrollGeneration = 0;
    searchComposing = false;
    searchTemporarilyExpandedIds = new Set<string>();
    isApplyingSearchExpansion = false;

    constructor(data: INodeData, containerEL: HTMLElement, setting?: Setting, view?: MindMapView) {
        this.setting = Object.assign({
            theme: 'default',
            //canvasSize: 8000,
            canvasSize: 36000,
            fontSize: 16,
            background: 'transparent',
            color: 'inherit',
            exportMdModel: 'default',
            headLevel: 1,
            layoutDirect: '',
            focusOverlayOpacity: 0.4,
            focusGlowSize: 150,
            nodeGlowSize: 10,
            nodeMaxWidth: 800
        }, setting || {});


        this.data = data;
        this.view = view;
        if (view) {
            this.fileSuggest = new FileSuggest(view.app);
        }
        this.appEl = document.createElement('div');
        this.appEl.setAttribute('tabindex', '0');

        this.appEl.classList.add('mm-mindmap');
        this.appEl.classList.add(`mm-theme-${this.setting.theme}`);
        this.appEl.style.overflow = "auto";


        this.contentEL = document.createElement('div');
        this.contentEL.style.position = "relative";
        this.contentEL.style.width = "100%";
        this.contentEL.style.height = "100%";
        this.appEl.appendChild(this.contentEL);
        this.draw = SVG(this.contentEL).size('100%', '100%');

        this.setAppSetting();
        containerEL.appendChild(this.appEl);
        this.containerEL = containerEL;


        //layout direct
        this._indicateDom = document.createElement('div');
        this._indicateDom.classList.add('mm-node-layout-indicate');
        this._indicateDom.style.display='none';

        //menu
        this._menuDom = document.createElement('div');
        this._menuDom.classList.add('mm-node-menu');
        this._menuDom.style.display='none';
        this.setMenuIcon();

        this.contentEL.appendChild(this._indicateDom);
        this.contentEL.appendChild(this._menuDom);
        this.containerEL.classList.add('mapdown-viewport');

        //history
        this.resetHistory();

        // link line
        this.edgeGroup = this.draw.group();

        this.appClickFn = this.appClickFn.bind(this);
        this.appDragstart = this.appDragstart.bind(this);
        this.appDragend = this.appDragend.bind(this);
        this.appDragover = this.appDragover.bind(this);
        this.appDblclickFn = this.appDblclickFn.bind(this);
        this.appMouseOverFn = this.appMouseOverFn.bind(this);
        this.appDrop = this.appDrop.bind(this);
        this.appKeyup = this.appKeyup.bind(this);
        this.compositionStart = this.compositionStart.bind(this);
        this.compositionEnd = this.compositionEnd.bind(this);

        this.appKeydown = this.appKeydown.bind(this);
        this.appPointerDownCapture = this.appPointerDownCapture.bind(this);
        this.appMousewheel = this.appMousewheel.bind(this);
        this.appMouseMove = this.appMouseMove.bind(this);
        this.appContextMenu = this.appContextMenu.bind(this);

        this.appMouseDown = this.appMouseDown.bind(this);
        this.appMouseUp = this.appMouseUp.bind(this);

        this.appFocusIn = this.appFocusIn.bind(this);
        this.appFocusOut = this.appFocusOut.bind(this);

        //custom event
        this.initNode = this.initNode.bind(this);
        this.renderEditNode = this.renderEditNode.bind(this);
        this.mindMapChange = this.mindMapChange.bind(this);

        this.initEvent();
        //this.center();
        this.dispLevel=0;
        this.initControlPanel();
    }

    initControlPanel() {
        const ownerDocument = this.containerEL.ownerDocument;
        const panel = ownerDocument.createElement('div');
        panel.classList.add('mm-control-panel');
        const group = () => {
            const el = ownerDocument.createElement('div');
            el.classList.add('mm-control-group');
            panel.appendChild(el);
            return el;
        };
        const button = (parent: HTMLElement, cls: string, icon: string, label: string, onClick: (e: MouseEvent) => void) => {
            const el = ownerDocument.createElement('button');
            el.type = 'button';
            el.classList.add('mm-ctrl-btn', cls);
            el.setAttribute('aria-label', label);
            setIcon(el, icon);
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                if (!el.classList.contains('is-disabled')) {
                    onClick(e);
                }
            });
            parent.appendChild(el);
            return el;
        };

        const edit = group();
        button(edit, 'mm-ctrl-new-mindmap', 'file-plus', t('Create new mindmap'), () => this.view?.plugin.newMindMap());
        button(edit, 'mm-ctrl-search', 'search', t('Search nodes'), () => this.openSearch());
        this.undoButton = button(edit, 'mm-ctrl-undo', 'undo-2', t('Undo'), () => this.undo());
        this.redoButton = button(edit, 'mm-ctrl-redo', 'redo-2', t('Redo'), () => this.redo());
        button(edit, 'mm-ctrl-export', 'download', t('Export'), (e) => this.showExportMenu(e));

        const view = group();
        button(view, 'mm-ctrl-zoom-in', 'zoom-in', t('Zoom in'), () => this.setScale('up'));
        button(view, 'mm-ctrl-zoom-out', 'zoom-out', t('Zoom out'), () => this.setScale('down'));
        button(view, 'mm-ctrl-center', 'scan', t('Fit to view'), () => this.fit());

        // Append to containerEL so it stays fixed relative to the viewport, not the scaled content
        this.containerEL.appendChild(panel);
        this.controlPanel = panel;
        this.updateHistoryButtons();
    }

    showExportMenu(evt: MouseEvent) {
        const view = this.view;
        if (!view) {
            return;
        }
        const menu = new Menu();
        menu.addItem((item) => item.setTitle(t('Export to PNG (HQ)')).setIcon('image').onClick(() => view.exportToPng(2)));
        menu.addItem((item) => item.setTitle(t('Export to JPEG (HQ)')).setIcon('image').onClick(() => view.exportToJpeg(2)));
        menu.addItem((item) => item.setTitle(t('Export to html')).setIcon('file-code').onClick(() => view.exportToHtml()));
        menu.addItem((item) => item.setTitle(t('Export to XMind')).setIcon('network').onClick(() => view.exportToXmind()));
        menu.showAtMouseEvent(evt);
    }

    // A fresh history (new map or text changed outside the map) with the
    // toolbar's undo/redo state kept in sync.
    resetHistory() {
        this.exec = new Exec();
        this.exec.history.change = () => this.updateHistoryButtons();
        this.updateHistoryButtons();
    }

    updateHistoryButtons() {
        const history = this.exec?.history;
        this.undoButton?.classList.toggle('is-disabled', !history?.canUndo());
        this.redoButton?.classList.toggle('is-disabled', !history?.canRedo());
    }

    openSearch() {
        return search.openSearch.call(this);
    }
    createSearchButton(ownerDocument: Document, icon: string, label: string) {
        return search.createSearchButton.call(this, ownerDocument, icon, label);
    }
    scheduleSearchRefresh() {
        return search.scheduleSearchRefresh.call(this);
    }
    updateSearchResults(generation: number) {
        return search.updateSearchResults.call(this, generation);
    }
    flushSearchRefresh() {
        return search.flushSearchRefresh.call(this);
    }
    refreshSearchHighlights() {
        return search.refreshSearchHighlights.call(this);
    }
    navigateSearch(direction: 1 | -1) {
        return search.navigateSearch.call(this, direction);
    }
    isNodeWithin(node: INode, ancestor: INode) {
        return search.isNodeWithin.call(this, node, ancestor);
    }
    scrollNodeIntoView(node: INode) {
        return search.scrollNodeIntoView.call(this, node);
    }
    revealNode(node: INode) {
        return navigation.revealNode.call(this, node);
    }
    patchFromData(data: INodeData): boolean {
        return patch.patchFromData.call(this, data);
    }

    onNodeExpansionChanged(node: INode) {
        this.searchTemporarilyExpandedIds.delete(node.getId());
        this.updateEffectiveNodeVisibility();
    }

    updateEffectiveNodeVisibility() {
        if (!this.root) {
            return;
        }

        const visit = (node: INode, visible: boolean) => {
            const wasVisible = node.isShow();
            if (visible) {
                node.show();
                if (!wasVisible) {
                    node.refreshBox();
                    node.clearCacheData();
                }
            } else {
                node.hide();
            }
            const childrenVisible = visible && (
                node.isExpand || this.searchTemporarilyExpandedIds.has(node.getId())
            );
            node.children.forEach((child) => visit(child, childrenVisible));
        };

        visit(this.root, true);
    }
    closeSearch(restoreTemporaryExpansion = true) {
        return search.closeSearch.call(this, restoreTemporaryExpansion);
    }

    setMenuIcon(){
        var addNodeDom = document.createElement('span');
        var deleteNodeDom = document.createElement('span');
        var focusNodeDom = document.createElement('span');
        
        addNodeDom.classList.add('mm-icon-add-node');
        deleteNodeDom.classList.add('mm-icon-delete-node');
        focusNodeDom.classList.add('mm-icon-focus-node');
        
        addNodeDom.innerHTML = addIcon;
        deleteNodeDom.innerHTML = deleteIcon;
        focusNodeDom.innerHTML = focusIcon;
        
        addNodeDom.title = "Add Child Node";
        deleteNodeDom.title = "Delete Node";
        focusNodeDom.title = "Focus Node";
        
        this._menuDom.appendChild(addNodeDom);
        this._menuDom.appendChild(deleteNodeDom);
        this._menuDom.appendChild(focusNodeDom);
    }

    setAppSetting() {
        this.appEl.style.width = `${this.setting.canvasSize}px`;
        this.appEl.style.height = `${this.setting.canvasSize}px`;
        this.contentEL.style.width = `100%`;
        this.contentEL.style.height = `100%`;
        //  this.contentEL.style.color=`${this.setting.color};`;
        this.contentEL.style.background = `${this.setting.background}`;
        this.contentEL.style.fontSize = `${this.setting.fontSize}px`;
        this.contentEL.style.setProperty('--mm-node-max-width', `${this.setting.nodeMaxWidth || 800}px`);
        const nodeGlowSize = Math.min(24, Math.max(0, Number(this.setting.nodeGlowSize) || 0));
        this.contentEL.style.setProperty('--mm-node-glow-offset', `${nodeGlowSize}px`);
        this.contentEL.style.setProperty('--mm-node-glow-offset-negative', `${-nodeGlowSize}px`);
        this.contentEL.style.setProperty('--mm-node-glow-blur', `${nodeGlowSize * 1.6}px`);
        this.contentEL.style.setProperty('--mm-node-glow-spread', `${-nodeGlowSize}px`);
    }
    //create node
    init(collapsedIds?: string[]) {
        var that = this;
        var data = this.data;
        var x = this.setting.canvasSize / 2 - 60;
        var y = this.setting.canvasSize / 2 - 200;
        var waitCollapseNodes:INode[]=[];
        var nodeFragment = document.createDocumentFragment();
        this.isInitializingNodes = true;

        function initNode(d: INodeData, isRoot: boolean, p?: INode, level = 0) {
            that._nodeNum++;
            var n = new INode(d, that);
            // Set before the first measurement so nodes are sized with their level's font.
            if (level) {
                n.containEl.classList.add(levelClass(level));
            }
            // if (collapsedIds && collapsedIds.includes(n.getId())) {
            //     n.isExpand = false;
            // }
            // if (p && (!p.isExpand || p.isHide)) {
            //     n.isHide = true;
            // }

            nodeFragment.appendChild(n.containEl);
            if (isRoot) {
                n.setPosition(x, y);
                that.root = n;
                n.data.isRoot = true;
            } else {
                n.setPosition(0, 0);
                p.children.push(n);
                n.parent = p;
            }

            if(!d.expanded){
                waitCollapseNodes.push(n)
            }
            if (d.children && d.children.length) {
                d.children.forEach((dd: INodeData) => {
                    initNode(dd, false, n, level + 1);
                });
            }
        }
        initNode(data, true);
        this.contentEL.appendChild(nodeFragment);

        if(waitCollapseNodes.length){
            waitCollapseNodes.forEach(n=>{
                n.collapse();
            });
        }
    }

    traverseBF(callback: Function, node?: INode) {
        var array = [];
        array.push(node || this.root);
        var currentNode = array.shift();
        while (currentNode) {
            for (let i = 0, len = currentNode.children.length; i < len; i++) {
                array.push(currentNode.children[i]);
            }
            callback(currentNode);
            currentNode = array.shift();
        }
    }

    traverseDF(callback: Function, node?: INode, cbFirst?: boolean) {
        function recurse(currentNode: INode) {
            if (currentNode) {
                if (cbFirst) {
                    callback(currentNode);
                }
                if (currentNode.children) {
                    for (var i = 0, length = currentNode.children.length; i < length; i++) {
                        recurse(currentNode.children[i]);
                    }
                }
                if (!cbFirst) {
                    callback(currentNode);
                }
            }
        }
        recurse(node || this.root);

    }

    getNodeById(id: string) {
        var snode: INode = null;
        this.traverseDF((n: INode) => {
            if (n.getId() == id) {
                snode = n;
            }
        });

        return snode;
    }

    clearSelectNode() {
        this.reportedSelectNode = null;
        if (this.selectNode) {
            this.lastSelectedNode = this.selectNode;
            this.selectNode.unSelect();
            this.selectNode = null
        }
        this.collapseSelectionTo();
        if (this.editNode) {
            if(this.editNode.data.isEdit){
                this.editNode.commitEdit();
            }
            this.editNode = null;
        }
    }

    isSelectableNode(node: INode) {
        return selection.isSelectableNode.call(this, node);
    }
    selectedList(): INode[] {
        return selection.selectedList.call(this);
    }
    topmostSelected(): INode[] {
        return selection.topmostSelected.call(this);
    }
    toggleSelection(node: INode) {
        return selection.toggleSelection.call(this, node);
    }
    selectRange(node: INode) {
        return selection.selectRange.call(this, node);
    }
    collapseSelectionTo(node?: INode) {
        return selection.collapseSelectionTo.call(this, node);
    }
    selectAllVisible() {
        return selection.selectAllVisible.call(this);
    }
    selectInRect(rect: { left: number; top: number; right: number; bottom: number }, additive: boolean) {
        return selection.selectInRect.call(this, rect, additive);
    }
    pruneSelection() {
        return selection.pruneSelection.call(this);
    }
    captureSelection(): SelectionSnapshot {
        return selection.captureSelection.call(this);
    }
    restoreSelection(snapshot: SelectionSnapshot) {
        return selection.restoreSelection.call(this, snapshot);
    }


    initEvent() {
        const hostDocument = this.containerEL.ownerDocument;
        this.appEl.addEventListener('click', this.appClickFn);
        this.appEl.addEventListener('contextmenu', this.appContextMenu);
        this.appEl.addEventListener('mouseover', this.appMouseOverFn);
        this.appEl.addEventListener('dblclick', this.appDblclickFn);
        this.appEl.addEventListener('dragstart', this.appDragstart);
        this.appEl.addEventListener('dragover', this.appDragover);
        this.appEl.addEventListener('dragend', this.appDragend);
        this.appEl.addEventListener('drop', this.appDrop);
        hostDocument.addEventListener('keyup', this.appKeyup);
        hostDocument.addEventListener('keydown', this.appKeydown);
        hostDocument.addEventListener('compositionstart',this.compositionStart)
        hostDocument.addEventListener('compositionend',this.compositionEnd)
        hostDocument.body.addEventListener('wheel', this.appMousewheel);

        if(Platform.isDesktop){
            this.appEl.addEventListener('mousedown', this.appMouseDown);
            this.appEl.addEventListener('mouseup', this.appMouseUp);
        }

        this.appEl.addEventListener('mousemove', this.appMouseMove);

        this.containerEL.addEventListener('focusin', this.appFocusIn);
        this.containerEL.addEventListener('mousedown', this.appPointerDownCapture, true);
        this.containerEL.addEventListener('focusout', this.appFocusOut);
        //custom event
        this.on('initNode', this.initNode);
        this.on('renderEditNode', this.renderEditNode);
        this.on('mindMapChange', this.mindMapChange);

    }

    removeEvent() {
        const hostDocument = this.containerEL.ownerDocument;
        this.appEl.removeEventListener('click', this.appClickFn);
        this.appEl.removeEventListener('contextmenu', this.appContextMenu);
        this.appEl.removeEventListener('dragstart', this.appDragstart);
        this.appEl.removeEventListener('dragover', this.appDragover);
        this.appEl.removeEventListener('dragend', this.appDragend);
        this.appEl.removeEventListener('dblclick', this.appDblclickFn);
        this.appEl.removeEventListener('mouseover', this.appMouseOverFn);
        this.appEl.removeEventListener('drop', this.appDrop);
        hostDocument.removeEventListener('keyup', this.appKeyup);
        hostDocument.removeEventListener('keydown', this.appKeydown);
        hostDocument.removeEventListener('compositionstart',this.compositionStart)
        hostDocument.removeEventListener('compositionend',this.compositionEnd)

        hostDocument.body.removeEventListener('wheel', this.appMousewheel);

        if(Platform.isDesktop){
            this.appEl.removeEventListener('mousedown', this.appMouseDown);
            this.appEl.removeEventListener('mouseup', this.appMouseUp);
        }

        this.appEl.removeEventListener('mousemove', this.appMouseMove);

        this.containerEL.removeEventListener('focusin', this.appFocusIn);
        this.containerEL.removeEventListener('mousedown', this.appPointerDownCapture, true);
        this.containerEL.removeEventListener('focusout', this.appFocusOut);
        this.containerEL.classList.remove('mapdown-viewport');

        this.off('initNode', this.initNode);
        this.off('renderEditNode', this.renderEditNode);
        this.off('mindMapChange', this.mindMapChange);
        if (this.renderRefreshFrame !== null) {
            this.containerEL.ownerDocument.defaultView?.cancelAnimationFrame(this.renderRefreshFrame);
            this.renderRefreshFrame = null;
        }
        if (this.nodeRemeasureTimer !== null) {
            this.containerEL.ownerDocument.defaultView?.clearTimeout(this.nodeRemeasureTimer);
            this.nodeRemeasureTimer = null;
        }
        this.pendingNodeRemeasure.clear();
        if (this.focusTimer !== null) {
            this.containerEL.ownerDocument.defaultView?.clearTimeout(this.focusTimer);
            this.focusTimer = null;
        }
    }

    initNode(evt: CustomEvent) {
        if (!this.isInitializingNodes) {
            // A node rendered after the initial build (patched or re-rendered text).
            evt.detail?.node?.clearCacheData();
            this.requestRenderRefresh();
            return;
        }
        this._tempNum++;
        //console.log(this._nodeNum,this._tempNum);

        if (this._tempNum == this._nodeNum) {
            this.isInitializingNodes = false;
            this.refreshNodeBoxes();
            this.refresh();
            this.emit('initialLayoutComplete');
            //this.center();
        }
    }

    refreshNodeBoxes() {
        this.traverseBF((n: INode) => {
            n.refreshBox();
        });
    }

    scheduleNodeRemeasure(node: INode) {
        this.pendingNodeRemeasure.add(node);
        if (this.nodeRemeasureTimer !== null) {
            return;
        }

        const ownerWindow = this.containerEL.ownerDocument.defaultView;
        if (!ownerWindow) {
            node.refreshBox();
            node.clearCacheData();
            return;
        }

        this.nodeRemeasureTimer = ownerWindow.setTimeout(() => {
            this.nodeRemeasureTimer = null;
            const nodes = Array.from(this.pendingNodeRemeasure);
            this.pendingNodeRemeasure.clear();
            let changed = false;
            nodes.forEach((pendingNode) => {
                if (!this.isNodeInTree(pendingNode)) {
                    return;
                }
                const { width, height } = pendingNode.box;
                pendingNode.refreshBox();
                if (pendingNode.box.width !== width || pendingNode.box.height !== height) {
                    pendingNode.clearCacheData();
                    changed = true;
                }
            });
            // Relayout only when a size actually changed.
            if (changed) {
                this.refresh();
            }
        }, 230);
    }

    renderEditNode(evt: CustomEvent) {
        var node = evt.detail.node || null;
        node?.clearCacheData();
        this.requestRenderRefresh();
    }

    requestRenderRefresh() {
        if (this.renderRefreshFrame !== null) {
            return;
        }

        const ownerWindow = this.containerEL.ownerDocument.defaultView;
        if (!ownerWindow) {
            this.refresh();
            return;
        }

        this.renderRefreshFrame = ownerWindow.requestAnimationFrame(() => {
            this.renderRefreshFrame = null;
            this.refresh();
        });
    }

    mindMapChange() {
        //console.log(this.view)
        this.view?.mindMapChange();
        if (this.searchPanel) {
            this.scheduleSearchRefresh();
        }
    }
    appPointerDownCapture() {
        this.suppressFocus = false;
    }
    appFocusIn(evt: FocusEvent){
        this.suppressFocus = false;
        if (this.focusTimer !== null) {
            this.containerEL.ownerDocument.defaultView?.clearTimeout(this.focusTimer);
        }
        this.focusTimer = this.containerEL.ownerDocument.defaultView.setTimeout(() => {
            this.focusTimer = null;
            if (this.containerEL.contains(evt.relatedTarget as Node)) return;
            this.isFocused = true;
        }, 100);
    }
    appFocusOut(evt: FocusEvent){
        if (this.containerEL.contains(evt.relatedTarget as Node)) return;
        if (this.focusTimer !== null) {
            this.containerEL.ownerDocument.defaultView?.clearTimeout(this.focusTimer);
            this.focusTimer = null;
        }
        this.isFocused = false;
    }
    appKeydown(e: KeyboardEvent) {
        if (!this.isFocused) return; // Check if Mindmap is in focus or not
        var keyCode = e.keyCode || e.which || e.charCode;
        if (e.isComposing || this.isComposing || keyCode === 229) return;
        this.handleAppKeydown(e, keyCode);
    }
    handleAppKeydown(e: KeyboardEvent, keyCode: number) {
        return keyboard.handleAppKeydown.call(this, e, keyCode);
    }

     compositionStart(e: KeyboardEvent) {

        this.isComposing = true;
     }
     compositionEnd(e: KeyboardEvent) {

        this.isComposing = false;
     }

    appKeyup(e: KeyboardEvent) {
        if (!this.isFocused) return; // Check if Mindmap is in focus or not
        // Arrow navigation runs on keyup; reveal the node it moved to.
        const selectedBefore = this.selectNode;
        this.handleAppKeyup(e);
        const keyCode = e.keyCode || e.which || e.charCode;
        const isArrowKey = keyCode >= 37 && keyCode <= 40;
        if (isArrowKey && this.selectNode && this.selectNode !== selectedBefore && !this.selectNode.data.isEdit) {
            this.revealNode(this.selectNode);
        }
    }
    handleAppKeyup(e: KeyboardEvent) {
        return keyboard.handleAppKeyup.call(this, e);
    }
    _hierarchySelectNode(node: INode, direct: string) {
        return navigation._hierarchySelectNode.call(this, node, direct);
    }
    __selectChildren(node: INode, direct: string) {
        return navigation.__selectChildren.call(this, node, direct);
    }

    _formatNode(node: INode, i_prefix_1: string, i_prefix_2: string) {
        var text = node.data.text;

        if( (text.substring(0,2) == i_prefix_1)  ||
            (text.substring(0,2) == i_prefix_2)  )
        {// Prefix must be substracted, bold first
            text = text.substring(2); // Remove leading prefix

            if( (text.substring(text.length-2) == i_prefix_1)  ||
                (text.substring(text.length-2) == i_prefix_2)  )
            {// Suffix must be substracted
                text = text.substring(0,text.length-2);
            }
            // else: no trailing prefix
        }

        else if(    (text.substring(1,3) == i_prefix_1)  ||
                    (text.substring(1,3) == i_prefix_2)  )
        {// Prefix must be substracted, italic (?) first
            text = text[0] + text.substring(3); // Remove prefix

            if( (text.slice(-3, -1) == i_prefix_1)   ||
                (text.slice(-3, -1) == i_prefix_2)   )
            {// Suffix must be substracted
                text = text.substring(0,text.length-3) +
                text.slice(-1);
            }
            // else: no trailing prefix
        }

        else if(    (text.substring(2,4) == i_prefix_1)  ||
                    (text.substring(2,4) == i_prefix_2)  )
        {// Prefix must be substracted, highlight (?) first
            text = text.substring(0,2) + text.substring(4); // Remove prefix

            if( (text.slice(-4, -2) == i_prefix_1)   ||
                (text.slice(-4, -2) == i_prefix_2)   )
            {// Suffix must be substracted
                text = text.substring(0,text.length-4) +
                text.slice(-2);
            }
            // else: no trailing prefix
        }

        else {// No pre-/suf-fix: add it
            text = i_prefix_1+text+i_prefix_1;
        }

        // Set the text in the node
        node.mindmap.execute('changeNodeText',{
            node:node,
            text:text,
            oldText:node.data.text
        });
        // node.data.oldText = node.data.text;
        // node.setText(text);
        node.select();
    }


    _moveAsParent(node: INode) {
        if( (!node.data.isEdit)     &&
            (!node.data.isRoot)     &&
            (node.getLevel() > 1)   )
        {// The node can be moved
            this.moveNode(node, node.parent, 'down');
        }

        return;
    }


    _moveAsChild(movedNode: INode, newParentNode: INode) {
        if( (!movedNode.data.isEdit)  &&
            (!movedNode.data.isRoot)  )
        {// The node can be moved
            this.moveNode(movedNode, newParentNode, 'child-right');
        }


        return;
    }


    _toggleExpandNode(node: INode) {
        if (node && !node.data.isEdit) {
            if (node.isExpand) {
                node.mindmap.execute('collapseNode', {
                    node
                });
            }
            else {
                node.mindmap.execute('expandNode', {
                    node
                });
            }
        }

        return;
    }
    _selectNode(node: INode, direct: string) {
        return navigation._selectNode.call(this, node, direct);
    }
    appClickFn(evt: MouseEvent) {
        return pointer.appClickFn.call(this, evt);
    }
    appContextMenu(evt: MouseEvent) {
        return pointer.appContextMenu.call(this, evt);
    }
    appDragstart(evt: MouseEvent) {
        return pointer.appDragstart.call(this, evt);
    }
    appDragend(evt: MouseEvent) {
        return pointer.appDragend.call(this, evt);
    }
    appDragover(evt: MouseEvent) {
        return pointer.appDragover.call(this, evt);
    }
    _getDragType(node:INode, x:number, y:number) {
        return pointer._getDragType.call(this, node, x, y);
    }
    appDrop(evt: any) {
        return pointer.appDrop.call(this, evt);
    }
    appMouseOverFn(evt: MouseEvent) {
        return pointer.appMouseOverFn.call(this, evt);
    }
    appMouseMove(evt: MouseEvent) {
        return pointer.appMouseMove.call(this, evt);
    }
    appMouseDown(evt:MouseEvent) {
        return pointer.appMouseDown.call(this, evt);
    }
    appMouseUp(evt:MouseEvent) {
        return pointer.appMouseUp.call(this, evt);
    }
    appDblclickFn(evt: MouseEvent) {
        return pointer.appDblclickFn.call(this, evt);
    }
    appMousewheel(evt: any) {
        return pointer.appMousewheel.call(this, evt);
    }

    clearNode() {
        //delete node
        this.traverseBF((n: INode) => {
            this.contentEL.removeChild(n.containEl);
        });

        //delete line
        if (this.mmLayout) {
            this.mmLayout.svgDom?.clear();
        }

    }

    clear() {
        this.closeSearch(false);
        this.controlPanel?.remove();
        this.controlPanel = undefined;
        if (this.root) {
            this.traverseBF((node: INode) => node.releaseRenderComponent(), this.root);
        }
        this.clearNode();
        this.removeEvent();
        this.fileSuggest?.destroy();
        this.draw?.clear();
    }
    //get node list rect point
    getBoundingRect(list: INode[]) {
        var box = {
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            right: 0,
            bottom: 0
        };
        list.forEach((item, i) => {
            var b = item.getBox();
           // console.log(b.x,b.y);
            if (i == 0) {
                box.x = b.x;
                box.y = b.y;
                box.right = b.x + b.width;
                box.bottom = b.y + b.height;
            } else {
                if (b.x < box.x) {
                    box.x = b.x
                }
                if (b.y < box.y) {
                    box.y = b.y
                }
                if (b.x + b.width > box.right) {
                    box.right = b.x + b.width;
                }
                if (b.y + b.height > box.bottom) {
                    box.bottom = b.y + b.height;
                }
            }
        });

        box.width = box.right - box.x;
        box.height = box.bottom - box.y;

        return box;
    }

    moveNode(dragNode: INode, dropNode: INode, type:string, setInHistory: boolean = true) {

        if (!dragNode || !dropNode || !type || dragNode == dropNode || dragNode.data.isRoot) {
            return
        }

        const isSiblingMove = type == 'top' || type == 'left' || type == 'down' || type == 'right';
        if (isSiblingMove && !dropNode.parent) {
            return;
        }

        var flag = false;
        var p = dropNode.parent;
        while (p) {
            if (p == dragNode) {
                flag = true;
                break;
            }
            p = p.parent;
        }
        if (flag) {  //parent  can not change to child
            return;
        }

        dropNode.clearCacheData();
        dragNode.clearCacheData();

        // A left/right drop opens a collapsed target; MoveNode records it for undo.
        const expandTarget = type == 'right' || type == 'left' ? dropNode : undefined;

        if (type == 'top' || type == 'left' ||type == 'down' || type == 'right') {
            this.execute('moveNode', { type: 'siblings', node: dragNode, oldParent: dragNode.parent, dropNode, direct: type, inHistory: setInHistory, expandTarget})
        }
        else if (type.indexOf('child') > -1) {
            var typeArr = type.split('-');
            if (typeArr[1]) {
                this.execute('moveNode', { type: 'child', node: dragNode, oldParent: dragNode.parent, parent: dropNode, direct: typeArr[1], inHistory: setInHistory })
            }
            else {
                this.execute('moveNode', { type: 'child', node: dragNode, oldParent: dragNode.parent, parent: dropNode, inHistory: setInHistory });
            }
        }

       // this.execute('moveNode', { type: 'child', node: dragNode, oldParent: dragNode.parent, parent: dropNode })
    }


    // Moves several nodes together: as children of dropNode, or as siblings
    // placed one after another at the drop position. One undo step.
    moveNodes(nodes: INode[], dropNode: INode, type: string) {
        if (nodes.length <= 1) {
            this.moveNode(nodes[0], dropNode, type);
            return;
        }
        const isSiblingMove = type == 'top' || type == 'left' || type == 'down' || type == 'right';
        const movesOnto = (node: INode) => {
            for (let p: INode | undefined = dropNode; p; p = p.parent) {
                if (p === node) {
                    return true;
                }
            }
            return false;
        };
        if (!type || (isSiblingMove && !dropNode.parent) || nodes.some(movesOnto)) {
            return;
        }
        const before = this.captureSelection();
        this.batch(() => {
            let previous: INode | undefined;
            nodes.forEach((node) => {
                if (previous && isSiblingMove) {
                    this.moveNode(node, previous, 'down');
                } else {
                    this.moveNode(node, dropNode, type);
                }
                previous = node;
            });
        }, () => this.restoreSelection(before));
    }

    // Move all the current node's siblings as this node's children
    moveAllSiblingsAsChildren(node: INode) {
        var sibs = node.getSiblings();
        sibs.forEach((sib) => {
            this._moveAsChild(sib, node);
        })

        return;
    }


    // Move the current node's next siblings as this node's children
    moveNextSiblingsAsChildren(node: INode) {
        var sibs = node.getAllNextSiblings();
        sibs.forEach((sib) => {
            this._moveAsChild(sib, node);
        })

        return;
    }


    // Join the current node with the following node
    joinWithFollowingNode(node: INode, in_asCitation: Boolean) {
        let joinedNode = node.getNextSibling();

        // Set node's text, except for the starting emoticon and finishing link (if any)
        const emoticonRegex = /^[\u263a-\u27bf\u{1f300}-\u{1f9ff}]/u;
        // Regex to match links with the link pattern [🔗](...)
        // [🔗] is constant and (...) is any content inside parentheses.
        const linkRegex = /\[🔗\]\(.*\.pdf\)/g;
        const pageRegex = / \(p\. \d+\)$/;
        // Remove the emoticon and links from the text
        let node_text = (node.data.text)
            .replace(linkRegex, "")        // Remove all links of the form [🔗](...)
            .trimEnd()                     // Trim ending whitespace
            .replace(pageRegex, "")        // Remove last page of the form (p. ...)
        let joinedText = joinedNode.data.text
            .replace(emoticonRegex, "")    // Remove starting emoticon
            .trimStart();                  // Trim leading whitespace

        let l_middle_text = " "
        if (in_asCitation)
        { l_middle_text += "(…)"
        }
        l_middle_text += "<br>"
        node.setText(node_text + l_middle_text + joinedText);

        // let joinedText = joinedNode.data.text.replace(emoticonRegex, "").trimStart();
        // node.setText(node.data.text + " (…) " + joinedText);
        // node.setText(node.data.text + " (…) " + joinedNode.data.text);


        if(!joinedNode.isLeaf())
        {// The joined node has children: copy them to the current node
            joinedNode.children.forEach((n) => {
                //this._moveAsChild(n, node);
                let copiedNode = this.copyNode(n);
                this.selectNode.unSelect();
                node.select();
                this.pasteNode(copiedNode);
            });
        }

        // Delete joined node
        this.removeNode(joinedNode);

        this.clearSelectNode();
        this.refresh();
        this.scale(this.mindScale);
        node.select();
    }

    //execute cmd , store history
    execute(name: string, data?: any) {
        return this.exec.execute(name, data);
    }

    // One undo step, layout and save for the commands `run` executes.
    batch(run: () => void, select?: () => void): boolean {
        return this.exec.batch(this, run, select);
    }

    // Nodes an operation applies to: the selection, or the primary node.
    actionNodes(topmost: boolean): INode[] {
        if (!this.selectedNodes.size) {
            return this.selectNode ? [this.selectNode] : [];
        }
        return topmost ? this.topmostSelected() : this.selectedList();
    }

    // Nodes copied or cut: the topmost selected nodes, or the root alone.
    clipboardNodes(): INode[] {
        const nodes = this.actionNodes(true);
        return nodes.length ? nodes : (this.selectNode ? [this.selectNode] : []);
    }

    // Deletes the selected nodes with their subtrees; returns whether any was.
    deleteSelection(): boolean {
        return this.deleteNodes(this.actionNodes(true));
    }

    deleteNodes(list: INode[]): boolean {
        const nodes = list.filter((n) => !n.data.isRoot && !n.data.isEdit && this.isNodeInTree(n));
        if (!nodes.length) {
            return false;
        }
        if (nodes.length == 1) {
            this.execute('deleteNodeAndChild', { node: nodes[0] });
            return true;
        }
        const parent = nodes[0].parent;
        return this.batch(
            () => nodes.forEach((node) => this.execute('deleteNodeAndChild', { node })),
            () => {
                this.clearSelectNode();
                if (parent && this.isNodeInTree(parent)) {
                    parent.select();
                }
            });
    }

    // Collapses (or expands, following the primary node) every selected node.
    toggleExpandSelection() {
        const primary = this.selectNode;
        if (!primary || primary.data.isEdit) {
            return;
        }
        const nodes = this.actionNodes(false);
        if (nodes.length <= 1) {
            this._toggleExpandNode(primary);
            return;
        }
        const collapse = primary.isExpand;
        const targets = nodes.filter((n) => n.children.length && n.isExpand === collapse);
        const before = this.captureSelection();
        this.batch(
            () => targets.forEach((node) => this.execute(collapse ? 'collapseNode' : 'expandNode', { node })),
            () => this.restoreSelection(before));
    }

    // Applies a whole-node format to every selected node.
    formatSelection(format: (node: INode) => void) {
        const nodes = this.actionNodes(false);
        if (nodes.length <= 1) {
            nodes.forEach(format);
            return;
        }
        const before = this.captureSelection();
        this.batch(() => nodes.forEach(format), () => this.restoreSelection(before));
    }
    undo() {
        this.exec.undo();
    }

    redo() {
        this.exec.redo();
    }

    addNode(node: INode, parent?: INode, index = -1) {
        if (parent) {
            parent.addChild(node, index);
            if (parent.direct) {
                node.direct = parent.direct;
            }
            this._addNodeDom(node);
            node.clearCacheData();
        }
    }

    _addNodeDom(node: INode) {
        this.traverseBF((n: INode) => {
            if (!this.contentEL.contains(n.containEl)) {
                this.contentEL.appendChild(n.containEl);
            }
        }, node);
    }

    removeNode(node: INode) {
        if (node.parent) {
            var p = node.parent;
            var i = node.parent.removeChild(node);
            this._removeChildDom(node);
            p.clearCacheData();
            return i;
        } else {
            this._removeChildDom(node);
            return -1;
        }

    }

    // Whether a node is the focused node or inside its subtree.
    isNodeWithinFocus(node: INode) {
        for (let current: INode | undefined = node; current; current = current.parent) {
            if (current === this.focusedNode) {
                return true;
            }
        }
        return false;
    }

    isNodeInTree(node: INode) {
        // Removed nodes keep their parent pointer for undo, so check membership.
        let current = node;
        while (current.parent) {
            if (!current.parent.children.includes(current)) {
                return false;
            }
            current = current.parent;
        }
        return current === this.root;
    }

    _removeChildDom(node: INode) {
        this.traverseBF((n: INode) => {
            if (this.contentEL.contains(n.containEl)) {
                this.contentEL.removeChild(n.containEl);
            }
        }, node);
    }

    //layout
    layout() {
        if (!this.root) {
            return;
        }

        // A focused node removed by delete or undo leaves focus mode.
        let lostFocusedNode = false;
        if (this.focusedNode && !this.isNodeInTree(this.focusedNode)) {
            this.focusedNode = undefined;
            lostFocusedNode = true;
        }
        var activeRoot = this.focusedNode || this.root;

        this.updateEffectiveNodeVisibility();

        // Restore each node's effective collapsed state before applying focus-mode styling.
        this.traverseBF((n: INode) => {
            n.containEl.style.display = n.isShow() ? 'block' : 'none';
            n.containEl.classList.remove('mm-node-dimmed');
        }, this.root);

        // ALWAYS layout from this.root so the tree shape does not change
        if (!this.mmLayout) {
            this.mmLayout = new Layout(this.root, this.setting.layoutDirect||'mind map', this.colors, this);
            activeRoot.select();
            if (activeRoot === this.root) {
                this.fitOnOpen();
            } else {
                this.centerOnNode(activeRoot);
            }
        } else {
            this.mmLayout.layout(this.root, this.setting.layoutDirect || this.mmLayout.direct || 'mind map');
        }

        // Apply Focus Mode AFTER layout finishes
        if (this.focusedNode) {
            let activeSubtree = new Set<INode>();
            this.traverseBF((n: INode) => activeSubtree.add(n), activeRoot);
            
            this.traverseBF((n: INode) => {
                if (!activeSubtree.has(n)) {
                    n.containEl.classList.add('mm-node-dimmed');
                    n.containEl.style.opacity = '';
                    n.containEl.style.visibility = '';
                    n.containEl.style.pointerEvents = '';
                } else {
                    n.containEl.classList.remove('mm-node-dimmed');
                    n.containEl.style.opacity = '';
                    n.containEl.style.visibility = '';
                    n.containEl.style.pointerEvents = '';
                }
            }, this.root);
            
            const overlayOpacity = Math.min(
                0.8,
                Math.max(0, Number(this.setting.focusOverlayOpacity) || 0)
            );
            const glowSize = Math.min(
                400,
                Math.max(0, Number(this.setting.focusGlowSize) || 0)
            );
            this.appEl.style.backgroundColor = `rgba(0, 0, 0, ${overlayOpacity})`;
            this.appEl.style.boxShadow = `inset 0 0 ${glowSize}px rgba(0, 0, 0, ${overlayOpacity})`;
        } else {
            this.traverseBF((n: INode) => {
                n.containEl.classList.remove('mm-node-dimmed');
                n.containEl.style.opacity = '';
                n.containEl.style.visibility = '';
                n.containEl.style.pointerEvents = '';
            }, this.root);
            
            this.appEl.style.backgroundColor = '';
            this.appEl.style.boxShadow = '';
        }

        // Draw once after focus and visibility classes are final.
        if (this.mmLayout && this.mmLayout.createLink) {
            this.mmLayout.createLink();
        }

        // The selection was made while still dimmed, so it could not take keyboard focus.
        // Wait until the un-dim visibility transition has started before focusing.
        if (lostFocusedNode && this.selectNode) {
            const node = this.selectNode;
            const ownerWindow = this.containerEL.ownerDocument.defaultView;
            const refocus = () => {
                if (this.selectNode === node && !node.data.isEdit && node.containEl.isConnected) {
                    node.containEl.focus({ preventScroll: true });
                }
            };
            if (ownerWindow) {
                ownerWindow.requestAnimationFrame(() => ownerWindow.requestAnimationFrame(refocus));
            } else {
                refocus();
            }
        }

    }

    refresh() {
        // A lone selected node keeps its old behaviour even when hidden.
        if (this.selectedNodes.size > 1) {
            this.pruneSelection();
        }
        this.layout();
    }

    exitFocusMode() {
        const previouslyFocusedNode = this.focusedNode;
        if (!previouslyFocusedNode) {
            return;
        }

        this.focusedNode = undefined;
        this.refresh();
        this.clearSelectNode();
        previouslyFocusedNode.select();
        this.centerOnNode(previouslyFocusedNode);
    }

    emit(name: string, data?: any) {
        var evt = new CustomEvent(name, {
            detail: data || {}
        });
        this.appEl.dispatchEvent(evt);
    }

    on(name: string, fn: any) {
        this.appEl.addEventListener(name, fn);
    }

    off(name: string, fn: any) {
        if (name && fn) {
            this.appEl.removeEventListener(name, fn);
        }
    }
    center() {
        return viewport.center.call(this);
    }
    centerOnNode(node: INode) {
        return viewport.centerOnNode.call(this, node);
    }
    fit() {
        return viewport.fit.call(this);
    }
    fitOnOpen() {
        return viewport.fitOnOpen.call(this);
    }

    _resetMaxDisplayedLevel() {
        this.dispLevel = 0;
        return;
    }


    _getMaxDisplayedLevel(node: INode)
    {// Returns the highest displayed level.
     // Use getMaxDisplayedLevel (without _).
        if( (node.getLevel() > tempDispLevel)   &&
            (node.isShow())                     )
        {// Displayed node with higher level
            tempDispLevel = node.getLevel();
        }

        if(!node.isLeaf())
        {// The node has children
            node.children.forEach((n) => {
                this._getMaxDisplayedLevel(n);
            });
        }

        return;
    }


    getMaxDisplayedLevel()
    {// Returns the highest displayed level.
        tempDispLevel = 0;
        this._getMaxDisplayedLevel(this.root);
        this.dispLevel = tempDispLevel;

        return this.dispLevel;
    }


    getMaxNodeDisplayedLevel(node: INode)
    {// Returns the highest displayed level.
        tempDispLevel = 0;
        this._getMaxDisplayedLevel(node);

        return tempDispLevel;
    }


    _setDisplayedLevel(node: INode, level:number)
    {// Display nodes whose level is <= number
        var currentLevel = 0;

        if( (node.getLevel()<level) )
        {// Current level is to be displayed
            node.expand();
            if(!node.isLeaf())
            {// The node has children
                node.children.forEach((n) => {
                    this._setDisplayedLevel(n, level);
                });
            }
        }
        else{
            node.collapse();
        }

        return;
    }


    setDisplayedLevel(level:number)
    {// Display nodes whose level is <= number
        var currentLevel = 0;

        if(level>0) {
            var minLevel = 0;

            this.root.expand();
            this.root.children.forEach((n) => {
                this._setDisplayedLevel(n, level);
            });
        }
        else
        {
            this.root.collapse();
        }

        return;
    }


    setChildrenDisplayedLevel(level:number)
    {// Display children nodes whose level is <= number
        var currentLevel = 0;
        let node = this.selectNode;

        if(level>0 && node) {
            var minLevel = 0;

            if(node.getLevel() == level)
            {// Max required displayed level is node level
                node.mindmap.execute('collapseNode', {
                    node
                });
            }
            else
            {// Expand to required level
                node.expand();
                node.children.forEach((n) => {
                    this._setDisplayedLevel(n, level);
                });
            }
        }
        else
        {
            this.root.collapse();
        }

        this.scale(this.mindScale);

        return;
    }
    _setMindScalePointer(node: INode) {
        return viewport._setMindScalePointer.call(this, node);
    }
    getMarkdown() {
        return serialize.getMarkdown.call(this);
    }
    scale(num: number) {
        return viewport.scale.call(this, num);
    }
    setScale(type: string) {
        return viewport.setScale.call(this, type);
    }
    copyNode(node?:any) {
        return serialize.copyNode.call(this, node);
    }
    pasteNode(text:string) {
        return serialize.pasteNode.call(this, text);
    }

  commitActiveEdit(): boolean {
        if (!this.editNode?.data.isEdit) {
            return false;
        }

        const changed = this.editNode.commitEdit();
        this.editNode = null;
        return changed;
  }
    getCollapsedBlockIds(): string[] {
        return serialize.getCollapsedBlockIds.call(this);
    }

    getNodeAtBodyLine(line: number): INode | null {
        return serialize.getNodeAtBodyLine.call(this, line);
    }

}
