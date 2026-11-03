// Keyboard shortcuts handled on keydown and keyup while the map has focus.
// Methods run with `this` bound to the MindMap instance.
import INode from './INode';
import type MindMap from './mindmap';

export function handleAppKeydown(this: MindMap, e: KeyboardEvent, keyCode: number) {
    var ctrlKey = e.ctrlKey || e.metaKey;
    var shiftKey = e.shiftKey;
    var altKey = e.altKey;

    // if (ctrlKey) {                         // Shift -> Selecting
    //     // ctrl -> selecting
    //     this.selectingNodes = true;
    // } else {
    //     this.selectingNodes = false;
    // }

    if (!ctrlKey && !shiftKey && !altKey) { // No special key
        // Editing, adding nodes and focus mode act on the primary node alone.
        const primaryOnly = keyCode == 70 || keyCode == 32 || keyCode == 13 || keyCode == 9 ||
            keyCode == 45 || e.key == 'Enter' || e.key == 'Tab';
        if (primaryOnly && this.selectNode && !this.selectNode.data.isEdit) {
            this.collapseSelectionTo(this.selectNode);
        }
        let exitedFocus = false;

        // Focus Mode: F key (70)
        if (keyCode == 70) {
            var node = this.selectNode;
            if (node && !node.data.isEdit) {
                e.preventDefault();
                e.stopPropagation();
                if (this.focusedNode === node) {
                    this.exitFocusMode();
                } else {
                    this.focusedNode = node;
                    this.refresh();
                    this.centerOnNode(node);
                }
            }
        }

        // Esc key (27) to exit Focus Mode
        if (keyCode == 27) {
            if (this.focusedNode) {
                e.preventDefault();
                e.stopPropagation();
                this.exitFocusMode();
                exitedFocus = true;
            }
        }
        // Space
        if (keyCode == 32) {
            var node = this.selectNode;
            if (node && !node.data.isEdit) {
                e.preventDefault();
                e.stopPropagation();
                node.edit();
                this._menuDom.style.display = 'none';
            }
        }

        // Enter
        if (keyCode == 13 || e.key =='Enter') {
            var node = this.selectNode;
            if(node) {
                if (!node.data.isEdit) {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!node.parent) return;
                    var newNode = node.mindmap.execute('addSiblingNode', {
                        parent: node.parent
                    });
                    this._menuDom.style.display='none';
                    this.moveNode(newNode, node, 'down', false);
                }
                else {
                    e.preventDefault();
                    e.stopPropagation();
                    this.clearSelectNode();
                    node.select();
                    node.mindmap.editNode=null;
                }
            }
        }

        // Delete / Backspace
        if (keyCode == 46 || e.key == 'Delete' || e.key == 'Backspace') {
            var node = this.selectNode;
            if (node && !node.data.isEdit && this.deleteSelection()) {
                e.preventDefault();
                e.stopPropagation();
                this._menuDom.style.display='none';
            }
        }

        // Tab / Insert
        if (keyCode == 9 || keyCode == 45 || e.key == 'Tab') {
            var node = this.selectNode;
            if(node) {
                if (!node.data.isEdit) {
                    e.preventDefault();
                    e.stopPropagation();
                    node.mindmap.execute("addChildNode", { parent: node });
                    this._menuDom.style.display='none';
                } else{
                    e.preventDefault();
                    e.stopPropagation();
                    this.clearSelectNode();
                    node.select();
                    node.mindmap.editNode=null;
                }
            }
        }

        // Escape
        if (keyCode == 27) {
            e.preventDefault();
            e.stopPropagation();

            var node = this.selectNode;
            if (node && node.data.isEdit) {
                node.select();
                node.mindmap.editNode = null;
                node.cancelEdit();
            } else if (!exitedFocus && this.selectedNodes.size) {
                this.clearSelectNode();
            }
        }
    }

    // While editing, Ctrl+Z/Y belong to the text field's native undo.
    if (ctrlKey && !shiftKey && !altKey && !this.editNode?.data.isEdit && !this.selectNode?.data.isEdit) {  // CTRL key
        //ctrl + y
        if (keyCode == 89) {
            e.preventDefault();
            e.stopPropagation();
            this.redo();
        }

        //ctrl + z
        if (keyCode == 90) {
            e.preventDefault();
            e.stopPropagation();
            this.undo();
        }

        //ctrl + a
        if (keyCode == 65) {
            e.preventDefault();
            e.stopPropagation();
            this.selectAllVisible();
        }
    }

        // Shift + F2 : Edit as space does
    // if (!ctrlKey && shiftKey && !altKey) {  // SHIFT key
    //     if (keyCode == 113) {
    //     // if (keyCode == 45) {
    //         var node = this.selectNode;
    //         if (node && !node.data.isEdit) {
    //             e.preventDefault();
    //             e.stopPropagation();
    //             if (!node.isExpand) {
    //                 node.expand();
    //             }
    //             if (!node.parent) return;
    //             node.mindmap.execute('addSiblingNode', {
    //                 parent: node.parent
    //             });
    //             this._menuDom.style.display='none';
    //         }
    //     }
    // }
}

export function handleAppKeyup(this: MindMap, e: KeyboardEvent) {
    var keyCode = e.keyCode || e.which || e.charCode;
    var ctrlKey = e.ctrlKey || e.metaKey;
    var shiftKey = e.shiftKey;
    var altKey = e.altKey;

    // if (ctrlKey) {                         // Shift -> Selecting
    //     // Ctrl -> selecting
    //     this.selectingNodes = true;
    // } else {
    //     this.selectingNodes = false;
    // }

    if (!ctrlKey && !shiftKey && !altKey) { // NO SPECIAL KEY
        // Arrow keys and Home move a single selection.
        const isNavigation = (keyCode >= 37 && keyCode <= 40) || keyCode == 36;
        if (isNavigation && this.selectNode && !this.selectNode.data.isEdit) {
            this.collapseSelectionTo(this.selectNode);
        }
        // up
        if (keyCode == 38 || e.key == 'ArrowUp') {
            e.preventDefault();
            e.stopPropagation();

            var node = this.selectNode;
            if( node && !node.data.isEdit )
            {
                if (node === this.root) {
                    this._selectNode(node, "up");
                    return;
                }
                var l_selectedNode = node;
                while(  (this.selectNode == node)       &&
                        (l_selectedNode != this.root)   )
                {
                    this._selectNode(l_selectedNode, "up");
                    l_selectedNode = l_selectedNode.parent;
                }
            }
        }

        if (keyCode == 40 || e.key == 'ArrowDown') {
            e.preventDefault();
            e.stopPropagation();

            var node = this.selectNode;
            if( node && !node.data.isEdit )
            {
                if (node === this.root) {
                    this._selectNode(node, "down");
                    return;
                }
                var l_selectedNode = node;
                while(  (this.selectNode == node)       &&
                        (l_selectedNode != this.root)   )
                {
                    this._selectNode(l_selectedNode, "down");
                    l_selectedNode = l_selectedNode.parent;
                }
            }
        }

        if (keyCode == 39 || e.key == 'ArrowRight') {
            e.preventDefault();
            e.stopPropagation();

            var node = this.selectNode;
            if (node && !node.data.isEdit) {
                if (node === this.root) {
                    this._selectNode(node, "right");
                    return;
                }
                var rootPos = this.root.getPosition();
                var nodePos = node.getPosition();
                if(rootPos.x > nodePos.x)
                {// Node on left side of the mindmap
                    node.unSelect();
                    node.parent.select();
                }
                else
                {
                    var node = this.selectNode;
                    if (!node.isExpand && node.children.length) {
                        node.mindmap.execute('expandNode', {
                            node
                        });
                    }
                    this._selectNode(node, "right");
                }
            }
        }

        if (keyCode == 37 || e.key == 'ArrowLeft') {
            e.preventDefault();
            e.stopPropagation();

            var node = this.selectNode;
            if (node && !node.data.isEdit) {
                if (node === this.root) {
                    this._selectNode(node, "left");
                    return;
                }
                var rootPos = this.root.getPosition();
                var nodePos = node.getPosition();
                if(rootPos.x < nodePos.x)
                {// Node on right side of the mindmap
                    node.unSelect();
                    node.parent.select();
                }
                else
                {
                    var node = this.selectNode;
                    if (!node.isExpand && node.children.length) {
                        node.mindmap.execute('expandNode', {
                            node
                        });
                    }
                    this._selectNode(node, "left");
                }
            }
        }

        // Home : Select root node
        if (keyCode == 36) {
            e.preventDefault();
            e.stopPropagation();

            if( (!this.selectNode)          ||
                (!this.selectNode.data.isEdit)   )
            {// No edition: select root node
                if(this.selectNode)
                { this.selectNode.unSelect(); }
                this.root.select();
                this.center();
            }
        }
    }


    if (ctrlKey && !shiftKey && !altKey) {  // CTRL KEY
        /*//ctr + /  (or Ctrl + NumpadDivide) toggle expand node
        // if ((keyCode == 191) || (keyCode == 111)) {
        //     var node = this.selectNode;
        //     this._toggleExpandNode(node);
        // }
        if ((keyCode == 191) || (keyCode == 111)) {
            var node = this.selectNode;
            if (node && !node.data.isEdit) {
                if (node.isExpand) {
                    node.mindmap.execute('collapseNode', {
                        node
                    })
                } else {
                    node.mindmap.execute('expandNode', {
                        node
                    })
                }
            }
        }*/

        // Ctrl + B => Bold
        // if (keyCode == 66) {
        //     e.preventDefault();
        //     e.stopPropagation();

        //     if(this.selectNode) {
        //         var l_prefix_1 = "**";
        //         var l_prefix_2 = "__";
        //         var node = this.selectNode;

        //         if(node.data.isEdit)
        //         {// A node is edited: set in bold only the selected part
        //             var l_check_prefix = true;
        //             node.setSelectedText(l_prefix_1, l_prefix_2, l_check_prefix);
        //         }

        //         else
        //         {// Set in bold the whole node
        //             this._formatNode(node, l_prefix_1, l_prefix_2);
        //             e.preventDefault();
        //             e.stopPropagation();
        //         }

        //         this.refresh();
        //         this.scale(this.mindScale);
        //     }
        //     //else: no node selected: nothing to do
        // }


        // Ctrl + I => Italic
        // if (keyCode == 73) {
        //     e.preventDefault();
        //     e.stopPropagation();

        //     if(this.selectNode) {
        //         var node = this.selectNode;

        //         if(node.data.isEdit)
        //         {// A node is edited: set in italics only the selected part
        //             node.setSelectedText_italic();
        //         }

        //         else
        //         {// Set in italics the whole node
        //             var text = node.data.text;
        //             if( (  ((text.substring(0,1)=="*") ||
        //                     (text.substring(0,1)=="_") )        &&
        //                 (text.substring(0,2)!="**")             &&
        //                 (text.substring(0,2)!="__")             )   ||
        //                 (text.substring(0,3)=="***")                ||
        //                 (text.substring(0,3)=="___")                )
        //             {// Already italic
        //                 text = text.substring(1); // Remove leading * / _

        //                 if( (text.substring(text.length-1)=="*") ||
        //                     (text.substring(text.length-1)=="_") )   {
        //                     // Remove trailing * / _
        //                     text = text.substring(0,text.length-1);
        //                 }
        //                 // else: no trailing *
        //             }
        //             else {// Not in italic
        //                 text = "*"+text+"*"; // Use "*" to allow bold/italic change in whatever order
        //             }

        //             // Set in node text
        //             node.data.oldText = node.data.text;
        //             node.setText(text);
        //             e.preventDefault();
        //             e.stopPropagation();
        //         }

        //         this.refresh();
        //         this.scale(this.mindScale);
        //     }
        //     //else: no node selected: nothing to do
        // }


        // ctrl + E  center mindmap view
        // if (keyCode == 69) {
        //     e.preventDefault();
        //     e.stopPropagation();

        //     //this.center();
        //     this.centerOnNode(this.selectNode);
        // }


        // ctrl + Up: Move one node above
        // if (keyCode == 38 || e.key == 'ArrowUp') {
        //     e.preventDefault();
        //     e.stopPropagation();

        //     var node = this.selectNode;
        //     if(!node)
        //     {// No node selected: select root node
        //         this.root.select();
        //         node = this.selectNode;
        //     }
        //     else if((!node.data.isEdit)  &&
        //             (!node.data.isRoot)  )
        //     {// The node can be moved
        //         var type='top';
        //         if(node.getIndex() == 0)
        //         {// First sibling: move BELOW "previous" (=last) node
        //             type='down';
        //         }
        //         //else: no special treatment
        //         this.moveNode(node, node.getPreviousSibling(), type);
        //     }
        //     this.centerOnNode(this.selectNode);
        // }


        // // Ctrl + Down: Move one step below
        // if (keyCode == 40 || e.key == 'ArrowDown') {
        //     e.preventDefault();
        //     e.stopPropagation();

        //     var node = this.selectNode;
        //     if(!node)
        //     {// No node selected: select root node
        //         this.root.select();
        //         node = this.selectNode;
        //     }
        //     else if((!node.data.isEdit)  &&
        //             (!node.data.isRoot)  )
        //     {// The node can be moved
        //         var type='down';
        //         if(node.getIndex() == node.parent.children.length-1)
        //         {// Last sibling: move ABOVE "next" (=first) node
        //             type='top';
        //         }
        //         //else: no special treatment
        //         this.moveNode(node, node.getNextSibling(), type);
        //     }
        //     this.centerOnNode(this.selectNode);
        // }


        // // Ctrl + Left
        // if (keyCode == 37 || e.key == 'ArrowLeft') {
        //     e.preventDefault();
        //     e.stopPropagation();

        //     var node = this.selectNode;
        //     if(!node)
        //     {// No node selected: select root node
        //         this.root.select();
        //         node = this.selectNode;
        //     }
        //     else {// Move current node as parent/child depending on the position
        //         var rootPos = this.root.getPosition();
        //         var nodePos = node.getPosition();
        //         if(rootPos.x < nodePos.x)
        //         {
        //             this._moveAsParent(node);
        //         }
        //         else
        //         {
        //             this._moveAsChild(node, node.getPreviousSibling());
        //         }
        //     }
        //     this.centerOnNode(this.selectNode);
        // }


        // // Ctrl + Right
        // if (keyCode == 39 || e.key == 'ArrowRight') {
        //     e.preventDefault();
        //     e.stopPropagation();

        //     var node = this.selectNode;
        //     if(!node)
        //     {// No node selected
        //         this.root.select();
        //         node = this.selectNode;
        //     }
        //     else {
        //         var rootPos = this.root.getPosition();
        //         var nodePos = node.getPosition();
        //         if(rootPos.x < nodePos.x)
        //         {
        //             // this.selectedNodes.forEach((n:INode) => {
        //             //     this._moveAsChild(n);
        //             // });
        //             this._moveAsChild(node, node.getPreviousSibling());
        //         }
        //         else
        //         {
        //             this._moveAsParent(node);
        //         }
        //     }
        //     this.centerOnNode(this.selectNode);
        // }


        // // Ctrl + J: Join with following node
        // if (keyCode == 74) {
        //     e.preventDefault();
        //     e.stopPropagation();

        //     var node = this.selectNode;
        //     if(node)
        //     {  this.joinWithFollowingNode(node); }
        //     // else: No node selected: nothing to do
        // }



        // Ctrl + Home : Select root node
        if (keyCode == 36) {
            e.preventDefault();
            e.stopPropagation();

            if( (!this.selectNode)              ||
                (!this.selectNode.data.isEdit)  )
            {// No edition: select root node
                if(this.selectNode && !this.selectNode.data.isRoot)
                {
                    this.selectNode.unSelect();
                    this.root.select();
                }
                this.center();
            }
        }
    }


    if (ctrlKey && shiftKey && !altKey) {   // CTRL + SHIFT key
        // //Shift + Ctrl + space: toggle expand node
        // if (keyCode == 32) {
        //     e.preventDefault();
        //     e.stopPropagation();

        //     var node = this.selectNode;
        //     if(node)
        //     { this._toggleExpandNode(node); }
        // }


        // Ctrl + Shift + Z => Old text
        // if (keyCode == 90) {
        //     e.preventDefault();
        //     e.stopPropagation();

        //     var node = this.selectNode;
        //     if(node) {
        //         // var text = (node.data.oldText as string);
        //         var text = (node.data.oldText);
        //         node.setText(text);
        //         e.preventDefault();
        //         e.stopPropagation();
        //         console.log(text+" / "+node.data.text);
        //     }
        // }


        // Ctrl + Shift + Home : Center map
        // if (keyCode == 36) {
        //     e.preventDefault();
        //     e.stopPropagation();

        //     this.center();
        // }

    }


    if (altKey && !ctrlKey && !shiftKey) {          // Alt key

        // Alt + H => Highlight
        // if (keyCode == 72) {
        //     e.preventDefault();
        //     e.stopPropagation();

        //     if(this.selectNode) {// There is a node selected: format
        //         var l_prefix_1 = "==";
        //         var l_prefix_2 = l_prefix_1;
        //         var node = this.selectNode;

        //         if(node.data.isEdit)
        //         {// A node is edited: set in bold only the selected part
        //             var l_check_prefix = true;
        //             node.setSelectedText(l_prefix_1, l_prefix_2, l_check_prefix);
        //         }

        //         else
        //         {// Set in bold the whole node
        //             this._formatNode(node, l_prefix_1, l_prefix_2);
        //             e.preventDefault();
        //             e.stopPropagation();
        //         }
        //     }
        //     //else: no node selected: nothing to do
        // }


        // Alt + é => Strike through
        // if (keyCode == 50) {
        //     e.preventDefault();
        //     e.stopPropagation();

        //     if(this.selectNode) {// There is a node selected: format
        //         var l_prefix_1 = "~~";
        //         var l_prefix_2 = l_prefix_1;
        //         var node = this.selectNode;

        //         if(node.data.isEdit)
        //         {// A node is edited: set in bold only the selected part
        //             var l_check_prefix = true;
        //             node.setSelectedText(l_prefix_1, l_prefix_2, l_check_prefix);
        //         }

        //         else
        //         {// Set in bold the whole node
        //             this._formatNode(node, l_prefix_1, l_prefix_2);
        //             e.preventDefault();
        //             e.stopPropagation();
        //         }
        //     }
        //     //else: no node selected: nothing to do
        // }


        // Alt + Home : Node info in console
        // if (keyCode == 36) {
        //     e.preventDefault();
        //     e.stopPropagation();

        //     var node = this.selectNode;
        //     if(node) {
        //         console.log("Node idx: "+node.getIndex());
        //         console.log("Previous node idx: "+node.getPreviousSibling().getIndex());
        //         console.log("Next node idx: "+node.getNextSibling().getIndex());
        //         console.log("Node pos: x="+node.getPosition().x+" / y="+node.getPosition().y);
        //         console.log("Node dim: x="+node.getDimensions().x+" / y="+node.getDimensions().y);
        //         console.log("Canvas: "+this.setting.canvasSize);
        //         console.log("Disp scroll: x="+this.containerEL.scrollLeft+" / y="+this.containerEL.scrollTop);
        //         console.log("Disp client: x="+this.containerEL.clientWidth+" / y="+this.containerEL.clientHeight);

        //         //node.setText
        //     }
        // }


        // // Alt + PageUp: collapse one level from max displayed level
        // if (keyCode == 33) {
        //     e.preventDefault();
        //     e.stopPropagation();

        //     node = this.selectNode;
        //     if( (node)                                                  &&
        //         (this.getMaxNodeDisplayedLevel(node)>node.getLevel())   )
        //     {// Collapse only if current selected node would not be hidden
        //         this.setChildrenDisplayedLevel(this.getMaxNodeDisplayedLevel(node)-1);
        //         this.refresh();
        //         this.scale(this.mindScale);
        //         this.selectNode.select();
        //     }
        // }


        // // Alt + PageDn: expand one level
        // if (keyCode == 34) {
        //     e.preventDefault();
        //     e.stopPropagation();

        //     node = this.selectNode;
        //     if(node) {
        //         this.setChildrenDisplayedLevel(this.getMaxNodeDisplayedLevel(node)+1);
        //         this.refresh();
        //         this.scale(this.mindScale);
        //         this.selectNode.select();
        //     }
        // }


    }


    if (altKey && !ctrlKey && shiftKey) {           // Alt + Shift key

        // Alt + Shift + PageUp: collapse one level from current node
        // if (keyCode == 33) {
        //     if(this.selectNode) {
        //         this.setDisplayedLevel(this.selectNode.getLevel()-1);
        //         this.refresh();
        //         this.selectNode.parent.select();
        //     }
        // }


        // Alt + PageDn: expand one level
        // if (keyCode == 34) {
        //     if(this.selectNode) {
        //         this.setDisplayedLevel(this.selectNode.getLevel()+1);
        //         this.refresh();
        //         this.selectNode.select();
        //     }
        // }

    }


    if (altKey && ctrlKey && !shiftKey) {           // Alt + Ctrl key
        // Alt + Ctrl + S: Select node's text
        // if (keyCode == 83) {
        //     e.preventDefault();
        //     e.stopPropagation();

        //     let node = this.selectNode;
        //     if(node) {
        //         node.edit();
        //         node.selectText();
        //     }
        // }


    }


    if (altKey && ctrlKey && shiftKey) {            // Alt + Ctrl+ Shift key
        // None
        // if (keyCode == xx) {
        //     e.preventDefault();
        //     e.stopPropagation();

        //     let node = this.selectNode;
        //     if(node) {
        //         TBD
        //     }
        // }
    }


}
