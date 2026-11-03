import INode from './INode'
import MindMap  from './mindmap';
import type { SelectionSnapshot } from './selection';

export abstract class Command {
    name:string;
    mind?:any;
    constructor(name:string) {
        this.name = name;
    }
    execute(): boolean {return false}
    undo() {}
    redo() {
        this.execute();
    }
    // A collapsed node the command has to open (e.g. the parent of a new
    // child); the expansion is undone together with the command.
    expandTarget?:INode;
    expandedTarget = false;
    expandTargetIfCollapsed() {
        this.expandedTarget = false;
        const node = this.expandTarget;
        if (node && !node.isExpand) {
            node.expand();
            node.clearCacheData();
            this.expandedTarget = true;
        }
    }
    restoreTargetCollapse() {
        if (this.expandedTarget && this.expandTarget) {
            this.expandTarget.collapse();
            this.expandTarget.clearCacheData();
            this.expandedTarget = false;
        }
    }
    refresh(mind?:any){
            var m = mind||this.mind;
            if(m){
                // Inside a batch, layout and saving run once at the end.
                if (m.refreshSuspended) {
                    m.refreshPending = true;
                    return;
                }
                m.emit('renderEditNode',{});
                m.emit('mindMapChange',{});
            }
    }
}

// Runs `run` with layout and saving deferred to a single pass at the end.
export function suspendRefresh(mind:any, run:() => void) {
    mind.refreshSuspended++;
    try {
        run();
    } finally {
        mind.refreshSuspended--;
        if (!mind.refreshSuspended && mind.refreshPending) {
            mind.refreshPending = false;
            mind.emit('renderEditNode', {});
            mind.emit('mindMapChange', {});
        }
    }
}

// Commands run by Exec.batch(), undone and redone as one step.
export class BatchCommand extends Command {
    commands:Command[] = [];
    mind:MindMap;
    before:SelectionSnapshot;
    after:SelectionSnapshot;
    constructor(mind:MindMap) {
        super('batch');
        this.mind = mind;
    }
    execute():boolean {
        return this.commands.length > 0;
    }
    undo() {
        suspendRefresh(this.mind, () => {
            for (let i = this.commands.length - 1; i >= 0; i--) {
                this.commands[i].undo();
            }
        });
        this.restoreSelectionLater(this.before);
    }
    redo() {
        suspendRefresh(this.mind, () => this.commands.forEach((c) => c.redo()));
        this.restoreSelectionLater(this.after);
    }
    // Child commands reselect nodes in timeouts; run after them.
    restoreSelectionLater(snapshot:SelectionSnapshot) {
        setTimeout(() => {
            if (snapshot) {
                this.mind.restoreSelection(snapshot);
            }
        }, 0);
    }
}

export class AddNode extends Command {
    node:INode;
    parent:INode = null;
    mind:MindMap =null;
    index:number = -1;
    constructor(node:INode, parent:INode, mind?:MindMap) {
        super('addNode');
        this.node = node;
        this.parent = parent;
        this.mind = mind||this.node.mindmap;
        this.expandTarget = parent;
    }
    execute():boolean {
        // Adding a node changes the layout of its whole sibling group. Keep the
        // viewport stable while the initial layout and edit state are applied.
        const appEl = this.mind.appEl;
        const ownerWindow = appEl.ownerDocument.defaultView;
        appEl.classList.add('mm-no-transition');
        this.mind.clearSelectNode();
        this.expandTargetIfCollapsed();
        if (this.index > -1) {
            this.mind.addNode(this.node, this.parent, this.index);   //add node to position of parent children
        } else {
            this.mind.addNode(this.node, this.parent);
        }
        this.node.refreshBox();
        this.refresh();
        setTimeout(()=>{
            this.node.select();
            this.node.edit();
            this.mind.revealNode(this.node);
            const release = () => appEl.classList.remove('mm-no-transition');
            if (ownerWindow) {
                ownerWindow.requestAnimationFrame(() => ownerWindow.requestAnimationFrame(release));
            } else {
                release();
            }
        },0);
        return true; //exit with no error
    }

    undo() {
        var p = this.node.parent;
        this.index = this.mind.removeNode(this.node);
        this.mind.clearSelectNode();
        this.restoreTargetCollapse();
        setTimeout(()=>{
            this.refresh();
            p&&p.select();
        },0)
    }
}


export class RemoveNode extends Command {
    node:INode;
    parent:INode = null;
    mind:MindMap =null;
    index:number = -1;
    constructor(node:INode, mind?:MindMap) {
        super('removeNode');
        this.node = node;
        this.parent = this.node.parent||null;
        this.mind = mind||this.node.mindmap;
    }
    execute():boolean {
        if(this.node.data.isRoot == true){
            return false;
        }
        this.node.clearCacheData();
        this.mind.clearSelectNode();
        this.index = this.mind.removeNode(this.node);
        this.refresh();
        this.parent && this.parent.select();
        return true; //exit with no error
    }

    undo() {
        this.mind.addNode(this.node, this.parent, this.index);
        this.node.clearCacheData();
        this.node.refreshBox();
        this.mind.clearSelectNode();
        this.refresh();
        setTimeout(()=>{
            this.node.select();
        },0)
    }
}


export class ChangeNodeText extends Command {
    node:INode;
    oldText:string;
    text:string;
    isFirst:boolean;
    constructor(node:INode, oldText:string, text:string) {
        super('changeNodeText');
        this.node = node;
        this.oldText = oldText;
        this.text = text;
        this.isFirst = true;
    }
    execute():boolean {
        //if(!this.isFirst){
            this.node.setText(this.text);
        //}
        this.node.refreshBox();
        this.node.clearCacheData();
        if (this.node.data.isRoot) {
            this.node.mindmap.view?.markRootTitleChange(this.text);
        }
        this.refresh(this.node.mindmap);
        return true; //exit with no error
    }
    undo() {
        this.node.setText(this.oldText);
        this.node.clearCacheData();
        this.node.refreshBox();
        if (this.node.data.isRoot) {
            this.node.mindmap.view?.markRootTitleChange(this.oldText);
        }
        this.refresh(this.node.mindmap);
        this.isFirst =false;
    }
}

export class MoveNode extends Command {
    data:any={};
    node:INode;
    oldParent:INode;
    parent:INode;
    newParent?:INode;
    dropNode?:INode;
    type?:string;
    index:number = -1;
    constructor(data:any) {
        super('moveNode');
        this.data = data;
        if (this.data.type.indexOf('child') > -1) {
            this.node = this.data.node;
            this.oldParent = this.data.oldParent;
            this.parent = this.data.parent;
        } else {
            this.node = this.data.node;
            this.oldParent = this.node.parent;
            this.dropNode = this.data.dropNode;
            this.newParent = this.dropNode.parent;
            this.type = this.data.direct;
        }
        this.expandTarget = this.data.expandTarget;
    }

    execute():boolean {
        this.node.mindmap.clearSelectNode();
        this.expandTargetIfCollapsed();
        if (this.data.type.indexOf('child') > -1) {
            if (!this.parent || !this.oldParent || this.parent === this.node) {
                return false;
            }
            if (this.oldParent) {
                this.index = this.oldParent.removeChild(this.node)
            }
            this.parent.addChild(this.node);
            this.node.mindmap.traverseBF((n:INode) => {
                n.boundingRect = null;
                n.stroke = ''
            }, this.node);

            this.node.clearCacheData();
            this.oldParent.clearCacheData();
            this.refresh(this.node.mindmap);
            this.node.select();
        } else {

            if (!this.oldParent || !this.newParent || !this.dropNode) {
                return false;
            }

            if (this.oldParent) {
                this.index = this.oldParent.removeChild(this.node);
            }
            this.node.mindmap.traverseBF((n:INode) => {
                n.boundingRect = null;
                n.stroke = ''
            }, this.node);

            this.oldParent.clearCacheData();
            var dropNodeIndex = this.newParent.children.indexOf(this.dropNode);

            if (this.type == 'top' || this.type == 'left') {
                this.newParent.addChild(this.node, dropNodeIndex)
            }
            else {
                this.newParent.addChild(this.node, dropNodeIndex + 1);
            }

            this.node.clearCacheData();
            this.refresh(this.node.mindmap);
            this.node.select();
        }
        return true; //exit with no error
    }

    undo() {
        this.node.mindmap.clearSelectNode();
        if (this.data.type.indexOf('child') > -1) {
            this.parent.removeChild(this.node);
            if (this.oldParent) {
                this.oldParent.addChild(this.node, this.index);
            }

            this.node.mindmap.traverseBF((n:INode) => {
                n.boundingRect = null;
                n.stroke = ''
            }, this.node);

            this.parent.clearCacheData();
            this.node.clearCacheData();
            this.restoreTargetCollapse();
            this.refresh(this.node.mindmap);
            this.node.select();
        }
        else {
            this.newParent.removeChild(this.node);
            this.dropNode.clearCacheData();
            this.oldParent.addChild(this.node, this.index);
            this.node.clearCacheData();
            this.restoreTargetCollapse();
            this.refresh(this.node.mindmap);
            this.node.select();
        }
    }
}


export class MovePos extends Command {
    node:INode;
    oldPos:any;
    newPos:any;
    constructor(node:INode, oldPos:any, newPos:any) {
        super('movePos');
        this.node = node;
        this.oldPos = oldPos;
        this.newPos = newPos;
    }

    execute():boolean {
        this.node.setPosition(this.newPos.x, this.newPos.y);
        this.refresh(this.node.mindmap);
        return true; //exit with no error
    }

    undo() {
        this.node.setPosition(this.oldPos.x, this.oldPos.y);
        this.refresh(this.node.mindmap);
    }
}

export class CollapseNode extends Command{
   node:INode;
   constructor(node:INode){
       super('collapseNOde')
       this.node = node;
       this.node.mindmap.clearSelectNode();

       this.node.refreshBox();
   }
   execute(){
       this.node.clearCacheData();
       this.node.collapse();
       this.refresh(this.node.mindmap);
       this.node.select();
       return true; //exit with no error
   }
   undo(){
    this.node.clearCacheData();
    this.node.expand();
    this.refresh(this.node.mindmap);
    this.node.select();
   }
}

export class ExpandNode extends Command{
    node:INode;
    constructor(node:INode){
        super('collapseNOde')
        this.node = node;
        this.node.mindmap.clearSelectNode();
        this.node.refreshBox();
    }
    execute(){
        this.node.clearCacheData();
        this.node.expand();
        this.refresh(this.node.mindmap);
        this.node.select();
        return true; //exit with no error
    }
    undo(){
     this.node.clearCacheData();
     this.node.collapse();
     this.refresh(this.node.mindmap);
     this.node.select();
    }
 }


 export class PasteNode extends Command {
    node:INode
    data:any
    waitCollapse:any[]=[]
    // Top-level pasted nodes (several when several subtrees were copied).
    firstNodes:INode[] = []
    indexes:number[] = []
    constructor(node:any, data:any) {
        super('copyNode');
        this.node = node;
        this.data = data;
        this.mind= this.node.mindmap;
        this.waitCollapse = [];
        this.expandTarget = node;
    }

    execute():boolean {
        this.firstNodes = [];
        this.waitCollapse = [];
        this.expandTargetIfCollapsed();
        this.paste();
        if (!this.firstNodes.length) {
            this.restoreTargetCollapse();
        }
        return this.firstNodes.length > 0;
    }

    undo() {
        if (this.firstNodes.length) {
            this.indexes = [];
            for (let i = this.firstNodes.length - 1; i >= 0; i--) {
                this.indexes[i] = this.mind.removeNode(this.firstNodes[i]);
            }
            this.node.clearCacheData();
            this.restoreTargetCollapse();
            this.refresh(this.node.mindmap);
        }
    }

    // Re-attach the pasted subtrees so later redo commands still reference them.
    redo() {
        if (!this.firstNodes.length) {
            this.execute();
            return;
        }
        this.expandTargetIfCollapsed();
        this.firstNodes.forEach((n, i) => {
            this.mind.addNode(n, this.node, this.indexes[i]);
            n.clearCacheData();
            n.refreshBox();
        });
        this.node.clearCacheData();
        this.refresh(this.mind);
    }

    paste() {
        const created = new Map<string, INode>();
        this.data.forEach((d:any, i:number) => {

            var parent = d.pid ? created.get(d.pid) : null;
            // Entries without a parent in the data are the copied subtrees' roots.
            if (!parent && i > 0 && d.pid) {
                return;
            }
            var n = new INode(d, this.mind);

            n.mindmap = this.mind;
            if (d.expanded === false) {
                this.waitCollapse.push(n);
            }
            if (!parent) {
                n.data.pid = this.node.getId();
                this.mind.addNode(n, this.node);
                this.firstNodes.push(n);
            } else {
                this.mind.addNode(n, parent);
            }
            n.setPosition(0,0);
            n.refreshBox();

            created.set(d.id, n);
        });
        if (this.firstNodes.length) {
            this.firstNodes[this.firstNodes.length - 1].clearCacheData();
            this.refresh(this.mind);
        }
        this.waitCollapse.forEach((node) => node.collapse());
    }
}
