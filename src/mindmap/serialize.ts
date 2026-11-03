// Markdown output, node copy and paste, and collapsed-state ids.
// Methods run with `this` bound to the MindMap instance.
import INode from './INode';
import { remapNodeIds, uuid } from '../utils';
import { t } from 'src/lang/helpers';
import type MindMap from './mindmap';
import { writeOutline } from './outline';

export function getMarkdown(this: MindMap) {
    return writeOutline<INode>(this.root, this.setting.headLevel, {
        children: (n) => n.children,
        text: (n) => n.data.text,
        blockId: (n) => {
            const isPersistentlyCollapsed = !n.isExpand || this.searchTemporarilyExpandedIds?.has(n.getId());
            if (!n.data.blockId && isPersistentlyCollapsed) {
                n.data.blockId = n.getId();
            }
            return n.data.blockId || '';
        },
        written: (n, range) => {
            n.data.sourceRange = range;
        },
    });
}

// The node written at or before a body line (blank lines and paragraphs
// belong to the node above). Nodes are visited in document order.
export function getNodeAtBodyLine(this: MindMap, line: number): INode | null {
    let found: INode | null = null;
    this.traverseDF((n: INode) => {
        const range = n.data.sourceRange;
        if (range && range.start <= line) {
            found = n;
        }
    }, this.root, true);
    return found || this.root || null;
}

// Copies one node or a list of nodes; each becomes a root (pid null) in the data.
export function copyNode(this: MindMap, node?:any) {
    var nodes: INode[] = Array.isArray(node) ? node : [node || this.selectNode].filter(Boolean);
    if(nodes.length){
       var data:any = [];
       function copyNode(n:INode, pid:any) {
              var d = n.getData();
              d.id = uuid();
              d.pid = pid;
              data.push({
                  id:d.id,
                  text:d.text,
                  pid:pid,
                  expanded:n.isExpand,
                  note:d.note
              });
              n.children.forEach((c) => {
                 copyNode(c, d.id);
              });
      }

       nodes.forEach((n) => copyNode(n, null));

       var _data = {
           type:'copyNode',
           text:data
       };

       return JSON.stringify(_data);

    }else{
        return ''
    }
  }

  export function pasteNode(this: MindMap, text:string) {
    var node = this.selectNode;
    if(text){
        try{
              var json =JSON.parse(text);
              if(json.type&&json.type=='copyNode' && Array.isArray(json.text) && node){
                var data = remapNodeIds(json.text);
               this.execute('pasteNode',{
                   node:node,
                   data:data
               })

               navigator.clipboard.writeText('');
              }
        }catch(err){
            console.error(err)
        }
    }

  }

  export function getCollapsedBlockIds(this: MindMap): string[] {
    const ids: string[] = [];
    this.traverseBF((node: INode) => {
        if (!node.isExpand || this.searchTemporarilyExpandedIds?.has(node.getId())) {
            if (!node.data.blockId) {
                node.data.blockId = node.getId();
            }
            ids.push(node.data.blockId);
        }
    });
    return ids;
  }
