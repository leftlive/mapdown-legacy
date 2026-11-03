// Centering, fitting and zooming the canvas.
// Methods run with `this` bound to the MindMap instance.
import INode from './INode';
import { Notice } from 'obsidian';
import type MindMap from './mindmap';

export function center(this: MindMap) {
    //console.log("Center mindmap")
    this._setMindScalePointer(this.root);
    var oldScale = this.mindScale;
    this.scale(100);

    var w = this.containerEL.clientWidth;
    var h = this.containerEL.clientHeight;
    this.containerEL.scrollTop = this.setting.canvasSize / 2 - h / 2 - 60;
    this.containerEL.scrollLeft = this.setting.canvasSize / 2 - w / 2 + 30;

    this.scale(oldScale);
}

export function centerOnNode(this: MindMap, node: INode) {
    if(node == null)
    {//No node given as input argument
        this.center();
    } else {
        //console.log("Center mindmap on node "+node.getId())
        this._setMindScalePointer(node);
        var oldScale = this.mindScale;
        this.scale(100);

        var w = this.containerEL.clientWidth;
        var h = this.containerEL.clientHeight;
        let pos_x = node.getPosition().x;
        let pos_y = node.getPosition().y;
        let dim_x = node.getDimensions().x;
        let dim_y = node.getDimensions().y;
        //this.containerEL.scrollTop = this.setting.canvasSize / 2 - h / 2 - 60 ;
        //this.containerEL.scrollLeft = this.setting.canvasSize / 2 - w / 2 + 30 ;
        this.containerEL.scrollTop  = pos_y - (h/2 - dim_y/2) + 90;
        //this.containerEL.scrollLeft = pos_x - (w/2 - dim_x/2) + 40;
        this.containerEL.scrollLeft = pos_x - (w/2 - dim_x/2) + 200;

        this.scale(oldScale);
    }
}

// Bounding box of the visible nodes under `from`.
function visibleBounds(this: MindMap, from: INode) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    this.traverseBF((n: INode) => {
        if (n.containEl.style.display === 'none') return;
        const pos = n.getPosition();
        const dim = n.getDimensions();
        minX = Math.min(minX, pos.x);
        minY = Math.min(minY, pos.y);
        maxX = Math.max(maxX, pos.x + dim.x);
        maxY = Math.max(maxY, pos.y + dim.y);
    }, from);
    return minX === Infinity ? null : { minX, minY, maxX, maxY };
}

// Scale around (x, y) and scroll so that point is centered in the viewport.
function showPoint(this: MindMap, x: number, y: number, scalePercent: number) {
    this.scalePointer = [x, y];
    this.scale(scalePercent);
    this.containerEL.scrollLeft = x - this.containerEL.clientWidth / 2;
    this.containerEL.scrollTop = y - this.containerEL.clientHeight / 2;
}

export function fit(this: MindMap) {
    if (!this.root) return;
    const bounds = visibleBounds.call(this, this.focusedNode || this.root);
    const w = this.containerEL.clientWidth;
    const h = this.containerEL.clientHeight;
    if (!bounds || !w || !h) return;
    const padding = 80;
    const scaleX = w / (bounds.maxX - bounds.minX + padding * 2);
    const scaleY = h / (bounds.maxY - bounds.minY + padding * 2);
    const newScale = Math.min(scaleX, scaleY, 1);
    showPoint.call(this, (bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2, newScale * 100);
}

// First view of a map: show the whole map when it fits at a readable size,
// otherwise keep the root in the middle.
export function fitOnOpen(this: MindMap) {
    if (!this.root) return;
    const bounds = visibleBounds.call(this, this.root);
    const w = this.containerEL.clientWidth;
    const h = this.containerEL.clientHeight;
    if (!bounds || !w || !h) {
        this.centerOnNode(this.root);
        return;
    }
    const padding = 60;
    const fitScale = Math.min(
        w / (bounds.maxX - bounds.minX + padding * 2),
        h / (bounds.maxY - bounds.minY + padding * 2),
        1,
    );
    const MIN_READABLE = 0.6;
    if (fitScale >= MIN_READABLE) {
        showPoint.call(this, (bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2, Math.floor(fitScale * 100));
        return;
    }
    const box = this.root.getBox();
    showPoint.call(this, box.x + box.width / 2, box.y + box.height / 2, MIN_READABLE * 100);
}

export function _setMindScalePointer(this: MindMap, node: INode) {
    this.scalePointer = [];
    // var root = this.root;
    if (node) {
        var rbox = node.getBox();
        this.scalePointer.push(rbox.x + rbox.width / 2, rbox.y + rbox.height / 2);
        if(!node.isSelect){
            this.clearSelectNode();
            node.select();
        }
    }
}

export function scale(this: MindMap, num: number) {
    if (num < 20) {
        num = 20;
    }
    if (num > 300) {
        num = 300;
    }
    this.mindScale = num;
    if (this.scalePointer.length) {
        this.appEl.style.transformOrigin = `${this.scalePointer[0]}px ${this.scalePointer[1]}px`;
        this.appEl.style.transform = "scale(" + this.mindScale / 100 + ")";
    } else {
        this.appEl.style.transform = "scale(" + this.mindScale / 100 + ")";
    }

}

export function setScale(this: MindMap, type: string) {
    if (type == "up") {
        var n = this.mindScale + 10;
    } else {
        var n = this.mindScale - 10;
    }
    this.scale(n);

    if (this.timeOut) {
        clearTimeout(this.timeOut)
    }

    this.timeOut = setTimeout(() => {
        new Notice(`${n} %`);
    }, 600);
}
