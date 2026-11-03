import History from './History'
import * as cmd from './Cmds'
import { uuid } from '../utils'
import {t} from '../lang/helpers'
import INode from './INode'

interface DataProps {
    node?:INode,
    parent?:INode,
    oldParent?:INode,

    //change node text
    text?:string,
    oldText?:string,

    //change root position
    oldPos?:{
        x:number,
        y:number
    },
    newPos?:{
        x:number,
        y:number
    },

    // Add command to history
    inHistory?:boolean,

    // Collapsed node a move opens; undone with the move
    expandTarget?:INode,

    data?:any
};

export default class Exec{
    history:History = new History(50);
    // Batch collecting the commands run inside MindMap.batch().
    recording:cmd.BatchCommand = null;

    private run(command:cmd.Command){
        if (this.recording) {
            if (command.execute()) {
                this.recording.commands.push(command);
            }
        } else {
            this.history.execute(command);
        }
    }

    execute(name:string,data?:DataProps){
        var l_return = null;
        switch(name){
            case 'addChildNode':
            case 'addSiblingNode':
                if(data){
                    var d = {
                        id: uuid(),
                        text: data.text || t('Sub title')
                    }
                    var parent:INode = data.parent;
                    var node = new INode(d,parent.mindmap);
                    this.run(new cmd.AddNode(node, data.parent, parent.mindmap));
                    l_return = node;
                }
                break;
            case 'deleteNodeAndChild':
                if(data){
                    var node =data.node;
                    this.run(new cmd.RemoveNode(node, node.mindmap));
                }
                break;
            case 'changeNodeText':
                if(data){
                    this.run(new cmd.ChangeNodeText(data.node, data.oldText, data.text));
                }
                break;
            case 'moveNode':
                if(data.inHistory === undefined || data.inHistory == true) {
                    if(data){
                    this.run(new cmd.MoveNode(data));
                }
                } else {// inHistory == false
                    if(data){
                        (new cmd.MoveNode(data)).execute();
                    }
                }
            break;
            case 'movePosition':
                if(data){
                    this.run(new cmd.MovePos(data.node,data.oldPos,data.newPos));
                }
               break
            case 'expandNode':
                if(data){
                    this.run(new cmd.ExpandNode(data.node));
                }
                break;
            case 'collapseNode':
                if(data){
                    this.run(new cmd.CollapseNode(data.node));
                }
            break
            case 'pasteNode':
                this.run(new cmd.PasteNode(data.node,data.data));
                break;
       }

       return l_return;
    }


    // Runs the commands `run` executes as one undo step with one layout and
    // one save; `select` then sets the selection kept for redo.
    batch(mind:any, run:() => void, select?:() => void):boolean{
        if (this.recording) {
            run();
            return true;
        }
        const batch = new cmd.BatchCommand(mind);
        batch.before = mind.captureSelection();
        this.recording = batch;
        try {
            cmd.suspendRefresh(mind, run);
        } finally {
            this.recording = null;
        }
        if (!batch.commands.length) {
            return false;
        }
        select?.();
        batch.after = mind.captureSelection();
        this.history.record(batch);
        return true;
    }

    undo(){
        this.history.undo()
    }

    redo(){
        this.history.redo()
    }
}
