// Mouse, drag-and-drop and wheel handling on the canvas.
// Methods run with `this` bound to the MindMap instance.
import INode from './INode';
import { Notice } from 'obsidian';
import { mindmapHoverSource } from '../constants';
import { t } from 'src/lang/helpers';
import type MindMap from './mindmap';

export function appClickFn(this: MindMap, evt: MouseEvent) {
    var targetEl = evt.target as HTMLElement;

    if (targetEl) {

        var internalLink = targetEl.closest('a.internal-link');
        if (internalLink) {
            evt.preventDefault();
            evt.stopPropagation();
            var href = internalLink.getAttribute("data-href") || internalLink.getAttribute("href");
            if (href) {
                const openMode = this.view.plugin.settings.linkOpenMode;
                (this.view.app.workspace as any).openLinkText(
                    href,
                    this.view.file.path,
                    openMode === "current" ? false : openMode
                );
            }
            return;
        }

        if (targetEl.hasClass('mm-node-bar')) {
            evt.preventDefault();
            evt.stopPropagation();
            var id = targetEl.closest('.mm-node').getAttribute('data-id');
            var node = this.getNodeById(id);

            if (node.isExpand) {
                node.mindmap.execute('collapseNode', {
                    node
                });
            } else {
                node.mindmap.execute('expandNode', {
                    node
                });
            }
            return
        }

        if(targetEl.closest('.mm-node-menu')){
             if(targetEl.closest('.mm-icon-add-node')){
                  var selectNode = this.selectNode;
                  if(selectNode){
                     this.collapseSelectionTo(selectNode);
                     selectNode.mindmap.execute("addChildNode", { parent: selectNode });
                     this._menuDom.style.display='none';
                  }
             }

             if(targetEl.closest('.mm-icon-delete-node')){
                if (this.deleteSelection()) {
                   this._menuDom.style.display='none';
                }
             }

             if(targetEl.closest('.mm-icon-focus-node')){
                var selectNode = this.selectNode;
                if(selectNode && !selectNode.data.isEdit){
                   this.collapseSelectionTo(selectNode);
                   if (this.focusedNode === selectNode) {
                       this.exitFocusMode();
                   } else {
                       this.focusedNode = selectNode;
                       this.refresh();
                       this.centerOnNode(selectNode);
                   }
                   this._menuDom.style.display='none';
                }
             }
             return;
        }

        if (targetEl.closest('.mm-node')) {
            var id = targetEl.closest('.mm-node').getAttribute('data-id');
            var node = this.getNodeById(id);
            // While a node is edited, any click ends the edit like a plain click.
            var canExtend = node && !node.data.isEdit && !this.editNode?.data.isEdit;
            if (canExtend && (evt.metaKey || evt.ctrlKey)) {
                this.toggleSelection(node);
            } else if (canExtend && evt.shiftKey) {
                this.selectRange(node);
            } else if (node && (!node.isSelect || this.selectedNodes.size > 1)) {
                this.clearSelectNode();
                node.select();
            }
            this._menuDom.style.display='none';
        } else {
            // The click that ends a box selection keeps it.
            if (Date.now() - this.marqueeEndedAt > 300) {
                this.clearSelectNode();
            }
            this._menuDom.style.display='none';
        }
    }
}

// Drag on the canvas: selects the visible nodes inside the box; with
// Cmd/Ctrl or Shift the box adds to the selection.
function startMarquee(this: MindMap, evt: MouseEvent) {
    const doc = this.containerEL.ownerDocument;
    const box = doc.createElement('div');
    box.className = 'mm-marquee';
    doc.body.appendChild(box);
    const x0 = evt.clientX, y0 = evt.clientY;
    const additive = evt.metaKey || evt.ctrlKey || evt.shiftKey;
    const rect = (e: MouseEvent) => ({
        left: Math.min(x0, e.clientX), top: Math.min(y0, e.clientY),
        right: Math.max(x0, e.clientX), bottom: Math.max(y0, e.clientY),
    });
    const move = (e: MouseEvent) => {
        const r = rect(e);
        box.style.left = `${r.left}px`;
        box.style.top = `${r.top}px`;
        box.style.width = `${r.right - r.left}px`;
        box.style.height = `${r.bottom - r.top}px`;
    };
    const up = (e: MouseEvent) => {
        doc.removeEventListener('mousemove', move, true);
        doc.removeEventListener('mouseup', up, true);
        box.remove();
        const r = rect(e);
        if (r.right - r.left < 4 && r.bottom - r.top < 4) {
            return;
        }
        this.marqueeEndedAt = Date.now();
        this.selectInRect(r, additive);
    };
    doc.addEventListener('mousemove', move, true);
    doc.addEventListener('mouseup', up, true);
    move(evt);
}

export function appContextMenu(this: MindMap, evt: MouseEvent) {
    // Releasing the right button after panning is not a context click.
    if (this.panMoved) {
        this.panMoved = false;
        evt.preventDefault();
        return;
    }
    if (!this.isFocused) return;

    let targetEl = evt.target as HTMLElement;
    if (targetEl.closest('.mm-node')) {
        evt.preventDefault();
        evt.stopPropagation();

        var id = targetEl.closest('.mm-node').getAttribute('data-id');
        var node = this.getNodeById(id);

        // Right-clicking inside a multiple selection keeps it.
        if (node.isSelect && this.selectedNodes.size > 1) {
            node.addToSelection(true);
        } else {
            this.clearSelectNode();
            node.select();
        }

        this._menuDom.style.display = 'flex';

        // Calculate position
        var box = this.selectNode.getBox();
        var rootPos = this.root.getBox();

        // If the node is on the left side of the root (or is root), we might position differently
        // Usually we show it on the outer edge
        if (box.x < rootPos.x) {
            // Node is on the left side of root, place menu on the left of the node
            this._menuDom.style.left = `${box.x - 40}px`;
        } else {
            // Node is on the right side of root (or is root), place menu on the right
            this._menuDom.style.left = `${box.x + box.width + 10}px`;
        }

        // Vertically center with the node
        this._menuDom.style.top = `${box.y + box.height/2 - 45}px`;
    }
}

export function appDragstart(this: MindMap, evt: MouseEvent) {
    evt.stopPropagation();
    this.startX = evt.pageX;
    this.startY = evt.pageY;
    if (evt.target instanceof HTMLElement) {
        if (evt.target.closest('.mm-node')) {
            var id = evt.target.closest('.mm-node').getAttribute('data-id');
            this._dragNode = this.getNodeById(id);
            this.drag = true;
            // Dragging a node outside a multiple selection drags it alone.
            if (this._dragNode && this.selectedNodes.size > 1 && !this._dragNode.isSelect) {
                this._dragNode.select();
            }
        }
    }
}

export function appDragend(this: MindMap, evt: MouseEvent) {
    this.drag = false;
    this._dragNode = undefined;
    this._indicateDom.style.display = 'none'
    this._menuDom.style.display = 'none';
    this.appEl.querySelectorAll('.mm-drag-over-child').forEach(el => el.classList.remove('mm-drag-over-child'));
}

export function appDragover(this: MindMap, evt: MouseEvent) {
    evt.preventDefault();
    evt.stopPropagation();
    var target =evt.target as HTMLElement;
    var x = evt.pageX;
    var y = evt.pageY;

    if (this.drag) {
        this.dx = x - this.startX;
        this.dx = y - this.startY;
    }

    // Clear previous child highlights
    this.appEl.querySelectorAll('.mm-drag-over-child').forEach(el => el.classList.remove('mm-drag-over-child'));

    if(target.closest('.mm-node')){
        var nodeEl = target.closest('.mm-node') as HTMLElement;
        var nodeId = nodeEl.getAttribute('data-id');
        var node = this.getNodeById(nodeId);
        var box = node.getBox();
        this._dragType = this._getDragType(node, x, y);

        if (this._dragType.startsWith('child-')) {
            // Dragging as a child: highlight the node itself
            nodeEl.classList.add('mm-drag-over-child');
            this._indicateDom.style.display = 'none';
        } else {
            // Dragging as a sibling: show indicator line
            this._indicateDom.style.display = 'block';
            this._indicateDom.className = 'mm-node-layout-indicate';

            if (this._dragType === 'top' || this._dragType === 'down') {
                this._indicateDom.classList.add('mm-indicator-horizontal');
                this._indicateDom.style.left = box.x + 'px';
                this._indicateDom.style.top = (this._dragType === 'top' ? box.y - 4 : box.y + box.height + 2) + 'px';
                this._indicateDom.style.width = box.width + 'px';
            } else if (this._dragType === 'left' || this._dragType === 'right') {
                this._indicateDom.classList.add('mm-indicator-vertical');
                this._indicateDom.style.left = (this._dragType === 'left' ? box.x - 4 : box.x + box.width + 2) + 'px';
                this._indicateDom.style.top = box.y + 'px';
                this._indicateDom.style.height = box.height + 'px';
            }
        }
    }else{
        this._indicateDom.style.display = 'none';
    }

}

export function _getDragType(this: MindMap, node:INode, x:number, y:number) {
    if (!node) return;

    var box = node.contentEl.getBoundingClientRect();

    var direct = node.direct;
    var topThreshold = box.y + box.height * 0.25;
    var bottomThreshold = box.y + box.height * 0.75;
    var leftThreshold = box.x + box.width * 0.25;
    var rightThreshold = box.x + box.width * 0.75;

    switch (direct) {
        case 'right':
            if (y < topThreshold) return 'top';
            if (y > bottomThreshold) return 'down';
            return 'child-right';
        case 'left':
            if (y < topThreshold) return 'top';
            if (y > bottomThreshold) return 'down';
            return 'child-left';
        case 'top':
        case 'up':
            if (x < leftThreshold) return 'left';
            if (x > rightThreshold) return 'right';
            return 'child-top';
        case 'down':
        case 'bottom':
            if (x < leftThreshold) return 'left';
            if (x > rightThreshold) return 'right';
            return 'child-down';
        default:
            if (y < topThreshold) return 'top';
            if (y > bottomThreshold) return 'down';
            return 'child';
    }
}

export function appDrop(this: MindMap, evt: any) {
    const isInternalNodeDrag = Boolean(this._dragNode && this.drag);
    if (isInternalNodeDrag && evt.target instanceof HTMLElement) {
        if (evt.target.closest('.mm-node')) {
            evt.preventDefault();
            var dropNodeId = evt.target.closest('.mm-node').getAttribute('data-id');
            var dropNode = this.getNodeById(dropNodeId);
            if (this._dragNode.data.isRoot) {

            } else {
                // A node of a multiple selection drags the whole selection.
                var dragged = this._dragNode.isSelect && this.selectedNodes.size > 1
                    ? this.topmostSelected()
                    : [this._dragNode];
                if (evt.ctrlKey) {// Ctrl key pressed: copy the nodes
                    let copiedNode = this.copyNode(dragged);
                    dropNode.select();
                    this.pasteNode(copiedNode);

                }
                else {// Move the nodes
                    this.moveNodes(dragged, dropNode, this._dragType);
                }
            }
        }
    }

    // A dropped .xmind file becomes a new note; the open map is left alone.
    const file: File | undefined = evt.dataTransfer?.files?.[0];
    const plugin = this.view?.plugin;
    if (file && plugin && file.name.toLowerCase().endsWith('.xmind')) {
        evt.preventDefault();
        const folder = plugin.app.fileManager.getNewFileParent(this.view.file?.path || '');
        file.arrayBuffer()
            .then((data) => plugin.importXmind(data, file.name, folder))
            .catch((err) => {
                console.error('Failed to read the dropped XMind file:', err);
                new Notice(t('Parse xmind error'));
            });
    }

    this._indicateDom.style.display = 'none'
    this._menuDom.style.display = 'none';
}

export function appMouseOverFn(this: MindMap, evt: MouseEvent) {
    if (!this.view?.plugin.settings.enableLinkPreview) {
        return;
    }

    const targetEl = evt.target as HTMLElement;
    const linkEl = targetEl.closest("a.internal-link") as HTMLElement;
    const sourcePath = this.view?.file?.path;

    if (linkEl && sourcePath) {
        const linktext = linkEl.getAttribute("data-href") || linkEl.getAttribute("href") || linkEl.innerText;
        if (!linktext) {
            return;
        }
        this.view.app.workspace.trigger("hover-link", {
            event: evt,
            source: mindmapHoverSource,
            hoverParent: this.view,
            targetEl: linkEl,
            linktext,
            sourcePath,
        });
    }
}

export function appMouseMove(this: MindMap, evt: MouseEvent) {
    const targetEl = evt.target as HTMLElement;
    // The button was released outside the canvas, so mouseup never reached appEl.
    if (this.drag && !this._dragNode && evt.buttons === 0) {
        this.drag = false;
    }
    this.scalePointer = [];
    this.scalePointer.push(evt.offsetX, evt.offsetY);
    if (targetEl.closest('.mm-node')) {
        var id = targetEl.closest('.mm-node').getAttribute('data-id');
        var node = this.getNodeById(id);
        if (node) {
            var box = node.getBox();
            this.scalePointer = [];
            this.scalePointer.push(box.x + box.width / 2, box.y + box.height / 2);
        }
    }
    if (this.drag && !this._dragNode) {
        const dx = evt.pageX - this.startX, dy = evt.pageY - this.startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
            this.panMoved = true;
        }
        this.containerEL.scrollLeft = this._left - dx;
        this.containerEL.scrollTop = this._top - dy;
    }
}

// Left drag on the canvas box-selects (adding with Cmd/Ctrl or Shift); right
// drag on the canvas or middle drag anywhere pans.
export function appMouseDown(this: MindMap, evt:MouseEvent) {
    const targetEl = evt.target as HTMLElement;
    const nodeEl = targetEl.closest('.mm-node');
    this.panMoved = false;
    if (targetEl.closest('.mm-control-panel, .mapdown-search-panel')) {
        return;
    }
    // Shift+click extends the node selection, not the text selection.
    if (nodeEl && evt.shiftKey && !nodeEl.classList.contains('mm-edit-node')) {
        evt.preventDefault();
    }
    if (!nodeEl && evt.button === 0) {
        // Keeps text from being selected; focus the map as the click would.
        evt.preventDefault();
        this.appEl.focus({ preventScroll: true });
        startMarquee.call(this, evt);
        return;
    }
    if (evt.button === 1 || (evt.button === 2 && !nodeEl)) {
        if (evt.button === 1) {
            evt.preventDefault();
        }
        this.drag = true;
        this.panMoved = false;
        this.startX = evt.pageX;
        this.startY = evt.pageY;
        this._left = this.containerEL.scrollLeft;
        this._top = this.containerEL.scrollTop;
    }
}

export function appMouseUp(this: MindMap, evt:MouseEvent) {
    this.drag = false;
}

export function appDblclickFn(this: MindMap, evt: MouseEvent) {
    if (evt.target instanceof HTMLElement) {

        if (evt.target.hasClass('mm-node-bar')) {
            evt.preventDefault();
            evt.stopPropagation();
            return;
        }
        if (evt.target.closest('.mm-node') instanceof HTMLElement) {
            var id = evt.target.closest('.mm-node').getAttribute('data-id');
            const clicked = this.getNodeById(id);
            this.collapseSelectionTo(clicked);
            this.selectNode = clicked;
            if (!this.editNode || (this.editNode && this.editNode != this.selectNode)) {
                this.selectNode?.edit();
                this.editNode = this.selectNode;
                this._menuDom.style.display='none';
            }
        }
    }
}

export function appMousewheel(this: MindMap, evt: any) {
    // The listener is on the body; only zoom the map under the pointer.
    const target = evt.target as Node | null;
    if (!target || !this.containerEL.contains(target)) {
        return;
    }
    // if(!evt) evt = window.event;
    var ctrlKey = evt.ctrlKey || evt.metaKey;
    // Listens to the standard wheel event; Electron 43 no longer fires mousewheel.
    var delta = -evt.deltaY;

    if (delta) {
        if (delta < 0) {
            if (ctrlKey) {
                this.setScale("down");
            }
        } else {
            if (ctrlKey) {
                this.setScale("up");
            }
        }
    }
}
