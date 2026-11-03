// Keyboard selection movement between nodes and scrolling the selection into view.
// Methods run with `this` bound to the MindMap instance.
import INode from './INode';
import type MindMap from './mindmap';

// Scroll just enough to show a keyboard-selected or newly added node.
export function revealNode(this: MindMap, node: INode) {
    const ownerWindow = this.containerEL.ownerDocument.defaultView;
    const generation = ++this.revealGeneration;
    const reveal = () => {
        if (generation !== this.revealGeneration || !node.containEl.isConnected || !node.isShow()) {
            return;
        }
        const margin = 40;
        const nodeRect = node.containEl.getBoundingClientRect();
        const containerRect = this.containerEL.getBoundingClientRect();
        let dx = 0;
        let dy = 0;
        if (nodeRect.left - margin < containerRect.left) {
            dx = nodeRect.left - margin - containerRect.left;
        } else if (nodeRect.right + margin > containerRect.left + this.containerEL.clientWidth) {
            dx = nodeRect.right + margin - (containerRect.left + this.containerEL.clientWidth);
        }
        if (nodeRect.top - margin < containerRect.top) {
            dy = nodeRect.top - margin - containerRect.top;
        } else if (nodeRect.bottom + margin > containerRect.top + this.containerEL.clientHeight) {
            dy = nodeRect.bottom + margin - (containerRect.top + this.containerEL.clientHeight);
        }
        if (dx || dy) {
            this.containerEL.scrollBy({ left: dx, top: dy });
        }
    };
    if (ownerWindow) {
        ownerWindow.requestAnimationFrame(() => ownerWindow.requestAnimationFrame(reveal));
    } else {
        reveal();
    }
}

export function _hierarchySelectNode(this: MindMap, node: INode, direct: string) {
    if (!node) {
        return;
    }
    var viewportWidth = this.containerEL.clientWidth;
    var viewportHeight = this.containerEL.clientHeight;
    var diagonalViewport = Math.sqrt(viewportWidth * viewportWidth + viewportHeight * viewportHeight);
    const MAX_PARENT_DISTANCE = diagonalViewport / 5;
    var waitNode: INode = null;
    var nodePos = node.getPosition();
    // var mind = this;
    var rootPos = this.root.getPosition();
    var rootDirect = rootPos.x > nodePos.x ? 'right' : 'left';

    if (node === this.root) {
        waitNode = this.__selectChildren(node,direct);
        if (waitNode) {
            this.clearSelectNode();
            waitNode.select();
            return;
        }
    };

    if(direct === 'up'){
        if(node.parent){
            var indexOfNode = node.parent.children.indexOf(node);
            if (indexOfNode === 0 ) {
                var parentPos = node.parent.getPosition();
                var dx = Math.abs(parentPos.x - nodePos.x);
                var dy = Math.abs(parentPos.y - nodePos.y);
                var dis = Math.sqrt(dx * dx + dy * dy);
                if(dis > MAX_PARENT_DISTANCE){
                    this._selectNode(node,direct);
                    return;
                }
                waitNode = node.parent;
                this.clearSelectNode();
                waitNode.select();
                return;
            }else if (indexOfNode > 0){
                waitNode = node.parent.children[indexOfNode - 1];
                this.clearSelectNode();
                waitNode.select();
                return;
            }
        }
        this._selectNode(node,direct);
    }
    else if(direct === 'down'){
        if(node.parent){
            var indexOfNode = node.parent.children.indexOf(node);
            if (indexOfNode === (node.parent.children.length - 1) ) {
                var parentPos = node.parent.getPosition();
                var dx = Math.abs(parentPos.x - nodePos.x);
                var dy = Math.abs(parentPos.y - nodePos.y);
                var dis = Math.sqrt(dx * dx + dy * dy);
                if(dis > MAX_PARENT_DISTANCE){
                    this._selectNode(node,direct);
                    return;
                }
                waitNode = node.parent;
                this.clearSelectNode();
                waitNode.select();
                return;
            }else if (indexOfNode < (node.parent.children.length - 1)){
                waitNode = node.parent.children[indexOfNode + 1];
                this.clearSelectNode();
                waitNode.select();
                return;
            }
        }
        this._selectNode(node,direct);
    }
    else if(direct === 'right') {
        if(rootDirect === 'right' && node.parent){
            waitNode = node.parent;
            this.clearSelectNode();
            waitNode.select();
            return;
        }else{
            waitNode = this.__selectChildren(node,direct);
            if (waitNode) {
                this.clearSelectNode();
                waitNode.select();
                return;
            }
        }
        // this._selectNode(node,direct);
    }
    else if(direct === 'left') {
        if(rootDirect === 'left' && node.parent){
            waitNode = node.parent;
            this.clearSelectNode();
            waitNode.select();
            return;
        }else{
            waitNode = this.__selectChildren(node,direct);
            if (waitNode) {
                this.clearSelectNode();
                waitNode.select();
                return;
            }
        }
        // this._selectNode(node,direct);
    }
}

export function __selectChildren(this: MindMap, node: INode, direct: string) {
    if (!node) return;
    if (!node.isExpand) return;
    var minDis: number;
    var waitNode: INode = null;
    var pos = node.getPosition();
    if (node.children) {
        node.children.forEach(n => {
            var p = n.getPosition();
            var dx = Math.abs(p.x - pos.x);
            var dy = Math.abs(p.y - pos.y);
            var dis = Math.sqrt(dx * dx + dy * dy);
            var _helper = ()=>{
                if (minDis) {
                    if (minDis > dis) {
                        minDis = dis;
                        waitNode = n;
                    }
                } else {
                    minDis = dis;
                    waitNode = n;
                }
            }
            switch (direct) {
                case "right":
                    if (p.x > pos.x) _helper()
                    break;
                case "left":
                    if (p.x < pos.x) _helper()
                    break;
                case "up":
                    if (p.y < pos.y) _helper()
                    break;
                case "down":
                    if (p.y > pos.y) _helper()
                    break;
            }
        });
    }
    return waitNode;
}

export function _selectNode(this: MindMap, node: INode, direct: string) {
    if (!node) {
        return;
    }

    var minDis: number;
    var waitNode: INode = null;
    var pos = node.getPosition();
    var rootPos = this.root.getPosition();
    var level = node.getLevel();
    var mind = this;

    if (node === this.root && (direct === 'up' || direct === 'down')) {
        mind.traverseDF((n: INode) => {
            if (n === node || !n.isShow()) {
                return;
            }

            const p = n.getPosition();
            const dx = Math.abs(p.x - pos.x);
            const dy = Math.abs(p.y - pos.y);
            const dis = Math.sqrt(dx * dx + dy * dy);
            const isCandidate = direct === 'up' ? p.y < pos.y : p.y > pos.y;

            if (isCandidate && (!minDis || minDis > dis)) {
                minDis = dis;
                waitNode = n;
            }
        });

        if (waitNode) {
            mind.clearSelectNode();
            waitNode.select();
        }
        return;
    }

    if (node === this.root && (direct === 'left' || direct === 'right')) {
        mind.traverseDF((n: INode) => {
            if (n === node || !n.isShow()) {
                return;
            }

            const p = n.getPosition();
            const dx = Math.abs(p.x - pos.x);
            const dy = Math.abs(p.y - pos.y);
            const dis = Math.sqrt(dx * dx + dy * dy);
            const isCandidate = direct === 'left' ? p.x < pos.x : p.x > pos.x;

            if (isCandidate && (!minDis || minDis > dis)) {
                minDis = dis;
                waitNode = n;
            }
        });

        if (waitNode) {
            mind.clearSelectNode();
            waitNode.select();
        }
        return;
    }

    mind.traverseDF((n: INode) => {
        var p = n.getPosition();
        var l = n.getLevel();
        var dx = Math.abs(p.x - pos.x);
        var dy = Math.abs(p.y - pos.y);
        var dis = Math.sqrt(dx * dx + dy * dy);
        switch (direct) {
            case "right":
                if( ((pos.x>this.root.getPosition().x)  &&
                     (l == level+1)                     )   ||
                    ((pos.x<this.root.getPosition().x)  &&
                     (l == level-1)                     )   ||
                    ((level == 0)                       &&
                     l==1)                                  )
                {// The tested node is at the correct level
                    if( (n == node.parent) || (node == n.parent) )
                    {// Move only within same lineage
                        if (p.x > pos.x) {
                            if (minDis) {
                                if (minDis > dis) {
                                    minDis = dis;
                                    waitNode = n;
                                }
                            } else {
                                minDis = dis;
                                waitNode = n;
                            }
                        }
                    }
                }
                break;
            case "left":
                if( ((pos.x>this.root.getPosition().x)  &&
                     (l == level-1)                     )   ||
                    ((pos.x<this.root.getPosition().x)  &&
                     (l == level+1)                     )   ||
                     ((level == 0)                      &&
                      l==1)                                 )
                {// The tested node is at the correct level
                    if( (n == node.parent) || (node == n.parent) )
                    {// Move only within same lineage
                        if (p.x < pos.x) {
                            if (minDis) {
                                if (minDis > dis) {
                                    minDis = dis;
                                    waitNode = n;
                                }
                            } else {
                                minDis = dis;
                                waitNode = n;
                            }
                        }
                    }
                }
                break;
            case "up":
                if( (n.isShow())                &&
                    (((pos.x<rootPos.x) &&
                      (p.x<rootPos.x)   )   ||
                     ((pos.x>rootPos.x) &&
                      (p.x>rootPos.x)   )   )   )
                {// Move only on shown nodes + on the same side of the root
                    if (p.y < pos.y) {
                        if(level == l)
                        {
                            if (minDis) {
                                if (minDis > dis) {
                                    minDis = dis;
                                    waitNode = n;
                                }
                            } else {
                                minDis = dis;
                                waitNode = n;
                            }
                        }
                    }
                }
                break;
            case "down":
                if( (n.isShow())                &&
                    (((pos.x<rootPos.x) &&
                      (p.x<rootPos.x)   )   ||
                     ((pos.x>rootPos.x) &&
                      (p.x>rootPos.x)   )   )   )
                {// Move only on shown nodes + on the same side of the root
                    if (p.y > pos.y) {
                        if(level == l)
                        {
                            if (minDis) {
                                if (minDis > dis) {
                                    minDis = dis;
                                    waitNode = n;
                                }
                            } else {
                                minDis = dis;
                                waitNode = n;
                            }
                        }
                    }
                }
                break;
        }
    });

    if (waitNode) {
        mind.clearSelectNode();
        waitNode.select();
    }
}
