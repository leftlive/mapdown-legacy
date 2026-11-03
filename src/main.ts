import {
  Plugin,
  WorkspaceLeaf,
  TFile,
  TFolder,
  ViewState,
  MarkdownView,
  Notice,
  addIcon,
  normalizePath
} from 'obsidian';
// import DEFAULT_SETTINGS from './setting'
import { around } from 'monkey-around'
import { MindMapSettings } from './settings';
import { MindMapSettingsTab } from './settingTab'

import { MindMapView, mindmapIcon, mindmapIconSvg, mindmapViewType, plainNoteAsMindMap } from "./MindMapView";
import { frontMatterKey, mindmapHoverSource } from './constants';
import { t, tf } from './lang/helpers'
import { availableNotePath, importXmindFile, pickXmindFile } from './mindmap/import/importFile';
import { askConvertMode } from './convertModal';
import { createCursorListener, editorSyncExtension } from './editorSync';
import type { EditorView } from '@codemirror/view';


export default class MindMapPlugin extends Plugin {
  settings: MindMapSettings;
  // View mode per file within a leaf, so a Markdown choice does not leak to other files.
  mindmapFileModes: { [leafAndFile: string]: string } = {};

  private getFileModeKey(leaf: WorkspaceLeaf | null | undefined, path: string | null | undefined) {
    return `${(leaf as any)?.id || ''}::${path || ''}`;
  }

  getFileMode(leaf: WorkspaceLeaf | null | undefined, path: string | null | undefined) {
    return this.mindmapFileModes[this.getFileModeKey(leaf, path)];
  }

  setFileMode(leaf: WorkspaceLeaf | null | undefined, path: string | null | undefined, mode: string) {
    this.mindmapFileModes[this.getFileModeKey(leaf, path)] = mode;
  }

  private moveFileModes(oldPath: string, newPath: string) {
    const suffix = `::${oldPath}`;
    for (const key of Object.keys(this.mindmapFileModes)) {
      if (key.endsWith(suffix)) {
        const leafPart = key.slice(0, key.length - suffix.length);
        this.mindmapFileModes[`${leafPart}::${newPath}`] = this.mindmapFileModes[key];
        delete this.mindmapFileModes[key];
      }
    }
  }

  clearLeafFileModes(leaf: WorkspaceLeaf) {
    const prefix = `${(leaf as any)?.id || ''}::`;
    for (const key of Object.keys(this.mindmapFileModes)) {
      if (key.startsWith(prefix)) {
        delete this.mindmapFileModes[key];
      }
    }
  }
  _loaded: boolean = false;
  timeOut: any = null;
  markdownMindMapActions = new WeakMap<MarkdownView, HTMLElement>();

  async onload() {

    await this.loadSettings();
    await this.migrateRecoveryDrafts();
    await this.ensurePagePreviewEnabled();
    addIcon(mindmapIcon, mindmapIconSvg);

    const createMindmapRibbonIcon = this.addRibbonIcon(
      mindmapIcon,
      t('Create new mindmap'),
      () => this.newMindMap()
    );
    createMindmapRibbonIcon.addClass('mapdown-ribbon-create');

    this.addCommand({
      id: 'Create New MindMap',
      name: `${t('Create new mindmap')}`,
      checkCallback: (checking: boolean) => {
        let leaf = this.app.workspace.activeLeaf;
        if (leaf) {
          if (!checking) {
            const targetFolder = this.app.fileManager.getNewFileParent(
              this.app.workspace.getActiveFile()?.path || ""
            );
            if (targetFolder) {
              this.newMindMap(targetFolder);
            }
          }
          return true;
        }
        return false;
      }
    });

    this.addCommand({
      id: 'import-xmind',
      name: t('Import from XMind…'),
      callback: () => pickXmindFile(this, this.getNewFileFolder()),
    });

    this.addCommand({
      id: 'Toggle to markdown or mindmap',
      name: `${t('Toggle markdown/mindmap')}`,
      mobileOnly: false,
      callback: async () => {
        const leaf = this.app.workspace.activeLeaf;
        const viewType = leaf?.view?.getViewType?.();
        if (!leaf || !viewType) {
          return;
        }

        if (viewType === mindmapViewType) {
          await this.setMarkdownView(leaf);
        } else if (viewType === 'markdown') {
          await this.openNoteAsMindMap(leaf);
        }
      }
    });

    this.addCommand({
      id: 'toggle-selection-sync',
      name: t('Toggle selection sync with Markdown'),
      callback: async () => {
        this.settings.syncSelection = !this.settings.syncSelection;
        await this.saveSettings();
        new Notice(t(this.settings.syncSelection ? 'Selection sync turned on' : 'Selection sync turned off'));
      }
    });

    this.addCommand({
      id: 'Set to mindmap view',
      name: `${t('Set to mindmap mode')}`,
      mobileOnly: false,
      callback: async () => {
        const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if(markdownView!=null)
        {
          await this.openNoteAsMindMap(markdownView.leaf);
        }
      }
    });

    this.addCommand({
      id: 'convert-to-new-mindmap',
      name: t('Save as a new mind map'),
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
        if (!file || this.isMindMapNote(file)) {
          return false;
        }
        if (!checking) {
          this.convertToNewMindMap(file);
        }
        return true;
      }
    });

    this.addCommand({
      id: 'Search mindmap nodes',
      name: `${t('Search nodes')}`,
      checkCallback: (checking: boolean) => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if (!mindmapView?.mindmap) {
          return false;
        }
        if (!checking) {
          mindmapView.mindmap.openSearch();
        }
        return true;
      }
    });

     this.addCommand({
      id: 'Set to markdown view',
      name: `${t('Set to markdown mode')}`,
      mobileOnly: false,
      callback: async () => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if(mindmapView!=null){
          await this.setMarkdownView(mindmapView.leaf);
        }
      }
    });

    // Alt + Shift + C
    this.addCommand({
      id: 'Copy Node',
      name: `${t('Copy node')}`,
      checkCallback: (checking: boolean) => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if (mindmapView) {
          var mindmap = mindmapView.mindmap;
          var node = mindmap.selectNode;
          if (node && !node.data.isEdit) {
            if (!checking) {
              var text = mindmap.copyNode(mindmap.clipboardNodes());
              navigator.clipboard.writeText(text).catch((err) => {
                console.error('Failed to copy mindmap node:', err);
                new Notice(t('Copy node') + ': failed');
              });
            }
            return true;
          }
        }
        return false;
      }
    });

    // Alt + Shift + X
    this.addCommand({
      id: 'Cut Node',
      name: `${t('Cut node')}`,
      checkCallback: (checking: boolean) => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if (mindmapView) {
          var mindmap = mindmapView.mindmap;
          var node = mindmap.selectNode;
          if (node && !node.data.isEdit) {
            if (!checking) {
              var nodes = mindmap.clipboardNodes();
              var text = mindmap.copyNode(nodes);
              navigator.clipboard.writeText(text).then(() => {
                if (mindmapView.mindmap === mindmap && mindmap.deleteNodes(nodes)) {
                  mindmap._menuDom.style.display = 'none';
                }
              }).catch((err) => {
                console.error('Failed to cut mindmap node:', err);
                new Notice(t('Cut node') + ': failed');
              });
            }
            return true;
          }
        }
        return false;
      }
    });

    // Alt + Shift + V
    this.addCommand({
      id: 'Paste Node',
      name: `${t('Paste node')}`,
      callback: () => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if(mindmapView){
          var mindmap = mindmapView.mindmap;
          navigator.clipboard.readText().then(text=>{
              if (mindmapView.mindmap === mindmap && mindmap.selectNode) {
                mindmap.collapseSelectionTo(mindmap.selectNode);
                mindmap.pasteNode(text);
              }
              // Copy once more so that the node can be copied once more
              return navigator.clipboard.writeText(text);
          }).catch((err) => {
              console.error('Failed to paste mindmap node:', err);
              new Notice(t('Paste node') + ': failed');
          });
        }
      }
    });





    // Alt + Shift + Z
    this.addCommand({
      id: 'Undo',
      name: `${t('Undo')}`,
      callback: () => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if(mindmapView){
          var mindmap = mindmapView.mindmap;
          mindmap.undo();
        }
      }
    });

    // Alt + Shift + Y
    this.addCommand({
      id: 'Redo',
      name: `${t('Redo')}`,
      callback: () => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if(mindmapView){
          var mindmap = mindmapView.mindmap;
          mindmap.redo();
        }
      }
    });

    // Alt + Ctrl + Shift + Z
    this.addCommand({
      id: 'Replace by the previous text',
      name: `${t('Replace by the previous text')}`,
      callback: () => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if(mindmapView){
          var mindmap = mindmapView.mindmap;
          var node = mindmap.selectNode;
          if(node) {
              if (node.data.isEdit) {
                  node.cancelEdit();
                  return;
              }
              // _oldText holds the text from before the last edit session.
              var text = node._oldText;
              if (typeof text !== 'string' || text === node.data.text) return;
              mindmap.execute('changeNodeText', {
                  node,
                  text,
                  oldText: node.data.text
              });
          }
  }
      }
    });

    // Shift + F2
    this.addCommand({
      id: 'Edit node',
      name: `${t('Edit node')}`,
      hotkeys: [
        {
          modifiers: ['Shift'],
          key: 'F2',
        },
      ],
      checkCallback: (checking: boolean) => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if (mindmapView) {
          var mindmap = mindmapView.mindmap;
          var node = mindmap.selectNode;
          if (node && !node.data.isEdit) {
            if (!checking) {
              node.edit();
              mindmap._menuDom.style.display = 'none';
            }
            return true;
          }
        }
        return false;
      }
    });

    // Alt + Shift + Enter
    this.addCommand({
      id: 'Add sibling/end editing',
      name: `${t('Add sibling/end editing')}`,
      callback: () => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if(mindmapView){
          var mindmap = mindmapView.mindmap;
          var node = mindmap.selectNode;
          if(node) {// A node is selected
            if (!node.data.isEdit) {// Not editing a node => Add sibling node
              // if (!node.isExpand) {
              //   node.expand();
              // }
              if (!node.parent) return;
              var newNode = node.mindmap.execute('addSiblingNode', {
                parent: node.parent
              });
              mindmap._menuDom.style.display='none';

              // Move the new node under the previously selected one
              // Do not add this command to the history
              mindmap.moveNode(newNode, node, 'down', false);
            }
            else {// Editing mode => end edit mode
              //node.cancelEdit();

              mindmap.clearSelectNode();
              node.select();
              node.mindmap.editNode=null;
              //this.selectNode.unSelect();
            }
          }
        }
      }
    });

    // Shift + Tab / Insert
    this.addCommand({
      id: 'Insert child',
      name: `${t('Insert child')}`,
      callback: () => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if(mindmapView){
          var mindmap = mindmapView.mindmap;
          var node = mindmap.selectNode;
          if(node) {
            if (!node.data.isEdit) {// Not editing
              if (!node.isExpand) {
                node.expand();
              }
              node.mindmap.execute("addChildNode", { parent: node });
              mindmap._menuDom.style.display='none';
            } else{
              // mindmap.selectNode.unSelect();
              mindmap.clearSelectNode();
              node.select();
              node.mindmap.editNode=null;
            }
          }
          //else: no node selected -> nothing to do
        }
      }
    });

    // Shift + Delete
    this.addCommand({
      id: 'Delete node & child',
      name: `${t('Delete node & child')}`,
      hotkeys: [
        {
          modifiers: ['Shift'],
          key: 'Delete',
        },
      ],
      checkCallback: (checking: boolean) => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if (mindmapView) {
          var mindmap = mindmapView.mindmap;
          var node = mindmap.selectNode;
          if (node && !node.data.isEdit && mindmap.actionNodes(true).some((n) => !n.data.isRoot)) {
            if (!checking) {
              mindmap.deleteSelection();
              mindmap._menuDom.style.display='none';
            }
            return true;
          }
        }
        return false;
      }
    });

    // Alt + Shift + S
    this.addCommand({
      id: 'Select the node\'s text',
      name: `${t('Select the node\'s text')}`,
      callback: () => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if(mindmapView){
          var mindmap = mindmapView.mindmap;
          let node = mindmap.selectNode;
          if(node) {
            node.edit();
            node.selectText();
          }
          //else: no node selected
        }
      }
    });

    // Alt + Shift + B
    this.addCommand({
      id: 'Bold the node\'s text',
      name: `${t('Bold the node\'s text')}`,
      hotkeys: [
        {
          modifiers: ['Alt', 'Shift'],
          key: 'B',
        },
      ],
      callback: () => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if(mindmapView){
          var mindmap = mindmapView.mindmap;
          if(mindmap.selectNode) {
            var l_prefix_1 = "**"; // Applied prefix
            var l_prefix_2 = "__"; // Alternate prefix to look for
            var node = mindmap.selectNode;

            if(node.data.isEdit)
            {// A node is edited: set in bold only the selected part
              var l_check_prefix = true;
              var l_set_as_suffix = true;
              node.setSelectedText(l_prefix_1, l_prefix_2, l_check_prefix, l_set_as_suffix, true);
            }

            else
            {// Set in bold the whole node
              mindmap.formatSelection((n) => mindmap._formatNode(n, l_prefix_1, l_prefix_2));
            }

            mindmap.refresh();
            mindmap.scale(mindmap.mindScale);
          }
          //else: no node selected: nothing to do
        }
      }
    });

    // Alt + Shift + I
    this.addCommand({
      id: 'Italicize the node\'s text',
      name: `${t('Italicize the node\'s text')}`,
      hotkeys: [
        {
          modifiers: ['Alt', 'Shift'],
          key: 'I',
        },
      ],
      callback: () => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if(mindmapView){
          var mindmap = mindmapView.mindmap;
          if(mindmap.selectNode) {
            var node = mindmap.selectNode;

            if(node.data.isEdit)
            {// A node is edited: set in italics only the selected part
              node.setSelectedText_italic();
            }

            else
            {// Set in italics the whole node
              mindmap.formatSelection((node) => {
              var text = node.data.text;
              if( (   ( (text.substring(0,1)=="*")  ||
                        (text.substring(0,1)=="_")  )   &&
                    (text.substring(0,2)!="**")         &&
                    (text.substring(0,2)!="__")         )   ||
                  (text.substring(0,3)=="***")              ||
                  (text.substring(0,3)=="_**")              ||
                  (text.substring(0,3)=="__*")              ||
                  (text.substring(0,3)=="___")              ||
                  (text.substring(0,3)=="**_")              ||
                  (text.substring(0,3)=="*__")              )
              {// Already italic
                if(text.slice(0, 3).includes("_")) {
                  // Replace only the first "_" in the first 3 chars (that make the italic)
                  text = text.slice(0, 3).replace('_', '') + text.slice(3);
                  // Replace only the first "_" in the LAST 3 chars (that make the italic)
                  text = text.slice(0, -3) + text.slice(-3).replace('_', '');
                }
                else{// A "*" is making the italic
                  text = text.slice(0, 3).replace('*', '') + text.slice(3);
                  text = text.slice(0, -3) + text.slice(-3).replace('*', '');
                }
              }
              else {// Not in italic
                text = "_"+text+"_";
                // Used to use "*" to allow bold/italic change in whatever order
                // However "***" is not displayed as bold + italic, so use _ for italic and * for bold
              }

              // Set node text
              node.mindmap.execute('changeNodeText',{
                  node:node,
                  text:text,
                  oldText:node.data.text
              });
              });
              // node.data.oldText = node.data.text;
              // node.setText(text);
            }

            mindmap.refresh();
            mindmap.scale(mindmap.mindScale);
          }
          //else: no node selected: nothing to do

        }
      }
    });

    // Alt + Shift + H
    this.addCommand({
      id: 'Highlight the node\'s text',
      name: `${t('Highlight the node\'s text')}`,
      hotkeys: [
        {
          modifiers: ['Alt', 'Shift'],
          key: 'H',
        },
      ],
      callback: () => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if(mindmapView){
          var mindmap = mindmapView.mindmap;
          if(mindmap.selectNode) {// There is a node selected: format
            var l_prefix_1 = "==";
            var l_prefix_2 = l_prefix_1;
            var node = mindmap.selectNode;

            if(node.data.isEdit)
            {// A node is edited: set in bold only the selected part
              var l_check_prefix = true;
              var l_set_as_suffix = true;
              node.setSelectedText(l_prefix_1, l_prefix_2, l_check_prefix, l_set_as_suffix, true);
            }

            else
            {// Set in bold the whole node
              mindmap.formatSelection((n) => mindmap._formatNode(n, l_prefix_1, l_prefix_2));
            }
          }
        }
        //else: no node selected: nothing to do
      }
    });

    // Alt + Shift + 2
    this.addCommand({
      id: 'Strike through the node\'s text',
      name: `${t('Strike through the node\'s text')}`,
      callback: () => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if(mindmapView){
          var mindmap = mindmapView.mindmap;
          if(mindmap.selectNode) {// There is a node selected: format
            var l_prefix_1 = "~~";
            var l_prefix_2 = l_prefix_1;
            var node = mindmap.selectNode;

            if(node.data.isEdit)
            {// A node is edited: set in bold only the selected part
              var l_check_prefix = true;
              var l_set_as_suffix = true;
              node.setSelectedText(l_prefix_1, l_prefix_2, l_check_prefix, l_set_as_suffix, true);
            }

            else
            {// Set in bold the whole node
              mindmap.formatSelection((n) => mindmap._formatNode(n, l_prefix_1, l_prefix_2));
            }
        }
        //else: no node selected: nothing to do
}
      }
    });

    // Alt + Shift + T
    this.addCommand({
      id: 'Add tabulation',
      name: `${t('Add tabulation')}`,
      hotkeys: [
        {
          modifiers: ['Alt', 'Shift'],
          key: 't',
        },
      ],
      callback: () => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if(mindmapView){
          var mindmap = mindmapView.mindmap;
          let node = mindmap.selectNode;
          if(node) {
            if(node.data.isEdit)
              {// A node is edited: set in bold only the selected part

              }
            node.insertText('    ');
          }
          //else: no node selected
        }
      }
    });

    // Alt + Ctrl + Shift + L
    this.addCommand({
      id: 'Add line break (<br>)',
      name: `${t('Add line break (<br>)')}`,
      hotkeys: [
        {
          modifiers: ['Alt','Ctrl', 'Shift'],
          key: 'l',
        },
      ],
      callback: () => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if(mindmapView){
          var mindmap = mindmapView.mindmap;
          let node = mindmap.selectNode;
          if(node) {
            if(node.data.isEdit)
              {// A node is edited: set in bold only the selected part

              }
            node.setSelectedText('<br>', '<br>', false, false, false);
          }
          //else: no node selected
        }
      }
    });

    // Alt + Shift + L
    this.addCommand({
      id: 'Remove line breaks (<br>)',
      name: `${t('Remove line breaks (<br>)')}`,
      hotkeys: [
        {
          modifiers: ['Alt','Shift'],
          key: 'l',
        },
      ],
      callback: () => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if(mindmapView){
          var mindmap = mindmapView.mindmap;
          let node = mindmap.selectNode;
          if(node) {
            node.removeLineBreak();
          }
          //else: no node selected
        }
      }
    });

    // (Shift +) Escape
    this.addCommand({
      id: 'Cancel edit',
      name: `${t('Cancel edit')}`,
      callback: () => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if(mindmapView){
          var mindmap = mindmapView.mindmap;
          var node = mindmap.selectNode;
          if (node && node.data.isEdit) {
            node.select();
            node.mindmap.editNode = null;
            node.cancelEdit();
            //this.selectNode.unSelect();
          }
        }
      }
    });

    // Alt + Dn
    this.addCommand({
      id: 'Expand one level',
      name: `${t('Expand one level')}`,
      hotkeys: [
        {
          modifiers: ['Alt'],
          key: 'ArrowDown',
        },
      ],
      callback: () => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if(mindmapView){
          var mindmap = mindmapView.mindmap;
          if(mindmap.selectNode) {
            mindmap.setDisplayedLevel(mindmap.selectNode.getLevel()+1);
            mindmap.refresh();
            mindmap._selectNode(mindmap.selectNode, "right");
          }
        }
      }
    });

    // Alt + PgDn
    this.addCommand({
      id: 'Expand one level from the max. displayed level',
      name: `${t('Expand one level from the max. displayed level')}`,
      hotkeys: [
        {
          modifiers: ['Alt'],
          key: 'PageDown',
        },
      ],
      callback: () => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if(mindmapView){
          var mindmap = mindmapView.mindmap;
          var node = mindmap.selectNode;
          if(node)
          {// Expand
            mindmap.setChildrenDisplayedLevel(mindmap.getMaxNodeDisplayedLevel(node)+1);
            mindmap.refresh();
            //mindmap.scale(mindmap.mindScale);
            mindmap.selectNode.select();
          }
        }
      }
    });

    // Alt + Up
    this.addCommand({
      id: 'Collapse one level',
      name: `${t('Collapse one level')}`,
      hotkeys: [
        {
          modifiers: ['Alt'],
          key: 'ArrowUp',
        },
      ],
      callback: () => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if(mindmapView){
          var mindmap = mindmapView.mindmap;
            if(mindmap.selectNode) {
              mindmap.setDisplayedLevel(mindmap.selectNode.getLevel()-1);
              mindmap.refresh();
              mindmap.selectNode.parent.select();
          }
        }
      }
    });

    // Alt + PgUp:
      this.addCommand({
        id: 'Collapse one level from the max. displayed level',
        name: `${t('Collapse one level from the max. displayed level')}`,
        hotkeys: [
          {
            modifiers: ['Alt'],
            key: 'PageUp',
          },
        ],
          callback: () => {
          const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
          if(mindmapView){
            var mindmap = mindmapView.mindmap;
            var node = mindmap.selectNode;
            if( (node)                                                  &&
                (mindmap.getMaxNodeDisplayedLevel(node)>node.getLevel())   )
            {// Collapse only if current selected node would not be hidden
              mindmap.setChildrenDisplayedLevel(mindmap.getMaxNodeDisplayedLevel(node)-1);
              mindmap.refresh();
              mindmap.scale(mindmap.mindScale);
              mindmap.selectNode.select();
            }
          }
        }
      });

    // Ctrl + Shift + Space
    this.addCommand({
      id: 'Toggle expand/collapse node',
      name: `${t('Toggle expand/collapse node')}`,
      hotkeys: [
        {
          modifiers: ['Mod', 'Shift'],
          key: 'Space',
        },
      ],
      callback: () => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if(mindmapView){
          var mindmap = mindmapView.mindmap;
          if(mindmap.selectNode)
          { mindmap.toggleExpandSelection(); }
        }
      }
    });

    // Alt + Shift + Up
    this.addCommand({
      id: 'Move the current node above',
      name: `${t('Move the current node above')}`,
      hotkeys: [
        {
          modifiers: ['Alt', 'Shift'],
          key: 'ArrowUp',
        },
      ],
      callback: () => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if(mindmapView){
          var mindmap = mindmapView.mindmap;
          var node = mindmap.selectNode;
          if(!node)
          {// No node selected: select root node
            mindmap.root.select();
            node = mindmap.selectNode;
          }
          else if((!node.data.isEdit)  &&
                  (!node.data.isRoot)  )
          {// The node can be moved
            var type='top';
            if(node.getIndex() == 0)
            {// First sibling: move BELOW "previous" (=last) node
              type='down';
            }
            //else: no special treatment
            mindmap.moveNode(node, node.getPreviousSibling(), type);
          }
          if ((this.settings.focusOnMove == true))
          {
            mindmap.centerOnNode(mindmap.selectNode);
          }
        }
      }
    });

    // Alt + Shift + Down
    this.addCommand({
      id: 'Move the current node below',
      name: `${t('Move the current node below')}`,
      hotkeys: [
        {
          modifiers: ['Alt', 'Shift'],
          key: 'ArrowDown',
        },
      ],
      callback: () => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if(mindmapView){
          var mindmap = mindmapView.mindmap;
          var node = mindmap.selectNode;
          if(!node)
          {// No node selected: select root node
            mindmap.root.select();
            node = mindmap.selectNode;
          }
          else if((!node.data.isEdit)  &&
                  (!node.data.isRoot)  )
          {// The node can be moved
            var type='down';
            if(node.getIndex() == node.parent.children.length-1)
            {// Last sibling: move ABOVE "next" (=first) node
                type='top';
            }
            //else: no special treatment
            mindmap.moveNode(node, node.getNextSibling(), type);
          }
          if((this.settings.focusOnMove == true))
            {
            mindmap.centerOnNode(mindmap.selectNode);
          }
        }
      }
    });

    // Alt + Shift + Left
    this.addCommand({
      id: 'Move the current node left',
      name: `${t('Move the current node left')}`,
      hotkeys: [
        {
          modifiers: ['Alt', 'Shift'],
          key: 'ArrowLeft',
        },
      ],
      callback: () => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if(mindmapView){
          var mindmap = mindmapView.mindmap;
          var node = mindmap.selectNode;
          if(!node)
          {// No node selected: select root node
            mindmap.root.select();
            node = mindmap.selectNode;
          }
          else {// Move current node as parent/child depending on the position
            var rootPos = mindmap.root.getPosition();
            var nodePos = node.getPosition();
            if(rootPos.x < nodePos.x)
            {
              mindmap._moveAsParent(node);
            }
            else
            {
              mindmap._moveAsChild(node, node.getPreviousSibling());
            }
          }
          if((this.settings.focusOnMove == true))
            {
            mindmap.centerOnNode(mindmap.selectNode);
          }
        }
      }
    });

    // Alt + Shift + Right
    this.addCommand({
      id: 'Move the current node right',
      name: `${t('Move the current node right')}`,
      hotkeys: [
        {
          modifiers: ['Alt', 'Shift'],
          key: 'ArrowRight',
        },
      ],
      callback: () => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if(mindmapView){
          var mindmap = mindmapView.mindmap;
          var node = mindmap.selectNode;
          if(!node)
          {// No node selected
            mindmap.root.select();
            node = mindmap.selectNode;
          }
          else {
            var rootPos = mindmap.root.getPosition();
            var nodePos = node.getPosition();
            if(rootPos.x < nodePos.x)
            {
              // mindmap.selectedNodes.forEach((n:INode) => {
              //     mindmap._moveAsChild(n);
              // });
              mindmap._moveAsChild(node, node.getPreviousSibling());
            }
            else
            {
              mindmap._moveAsParent(node);
            }
          }
          if((this.settings.focusOnMove == true))
            {
            mindmap.centerOnNode(mindmap.selectNode);
          }
        }
      }
    });


    // Alt + Shift + D
    this.addCommand({
      id: 'Move next siblings as children',
      name: `${t('Move next siblings as children')}`,
      hotkeys: [
        {
          modifiers: ['Alt', 'Shift'],
          key: 'D',
        },
      ],
      callback: () => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if(mindmapView){
          var mindmap = mindmapView.mindmap;
          var node = mindmap.selectNode;
          if(node)
          {  mindmap.moveNextSiblingsAsChildren(node); }
          // else: No node selected: nothing to do
        }
      }
    });


    this.addCommand({
      id: 'Move all siblings as children',
      name: `${t('Move all siblings as children')}`,
      hotkeys: [
        {
          modifiers: ['Alt', 'Ctrl', 'Shift'],
          key: 'D',
        },
      ],
      callback: () => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if(mindmapView){
          var mindmap = mindmapView.mindmap;
          var node = mindmap.selectNode;
          if(node)
          {  mindmap.moveAllSiblingsAsChildren(node); }
          // else: No node selected: nothing to do
        }
      }
    });


    // Alt + Shift + J
    this.addCommand({
      id: 'Join with the node below',
      name: `${t('Join with the node below')}`,
      hotkeys: [
        {
          modifiers: ['Alt', 'Shift'],
          key: 'J',
        },
      ],
      callback: () => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if(mindmapView){
          var mindmap = mindmapView.mindmap;
          var node = mindmap.selectNode;
          if(node)
          {  mindmap.joinWithFollowingNode(node, false); }
          // else: No node selected: nothing to do
        }
      }
    });

    // Alt + Shift + Ctrl + J
    this.addCommand({
      id: 'Join as citation with the node below',
      name: `${t('Join as citation with the node below')}`,
      hotkeys: [
        {
          modifiers: ['Alt', 'Shift', 'Ctrl'],
          key: 'J',
        },
      ],
      callback: () => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if(mindmapView){
          var mindmap = mindmapView.mindmap;
          var node = mindmap.selectNode;
          if(node)
          {  mindmap.joinWithFollowingNode(node, true); }
          // else: No node selected: nothing to do
        }
      }
    });

    // Alt + E
    this.addCommand({
      id: 'Center mindmap view on the current node',
      name: `${t('Center mindmap view on the current node')}`,
      hotkeys: [
        {
          modifiers: ['Alt'],
          key: 'E',
        },
      ],
      callback: () => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if(mindmapView){
          var mindmap = mindmapView.mindmap;
          mindmap.centerOnNode(mindmap.selectNode);
        }
      }
    });

    // Alt + Shift + E
    this.addCommand({
      id: 'Center mindmap view',
      name: `${t('Center mindmap view')}`,
      callback: () => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if(mindmapView){
          var mindmap = mindmapView.mindmap;
          mindmap.center();
        }
      }
    });

    // Zoom in
    this.addCommand({
      id: 'Zoom in',
      name: `${t('Zoom in')}`,
      hotkeys: [
        {
          modifiers: ['Alt'],
          key: '=',
        },
      ],
      callback: () => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if(mindmapView){
          var mindmap = mindmapView.mindmap;
          mindmap.setScale("up");
        }
      }
    });

    // Zoom out
    this.addCommand({
      id: 'Zoom out',
      name: `${t('Zoom out')}`,
      hotkeys: [
        {
          modifiers: ['Alt'],
          key: '-',
        },
      ],
      callback: () => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if(mindmapView){
          var mindmap = mindmapView.mindmap;
          mindmap.setScale("down");
        }
      }
    });

    this.addCommand({
      id: 'Display the node\'s info in console',
      name: `${t('Display the node\'s info in console')}`,
      callback: () => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if(mindmapView){
          var mindmap = mindmapView.mindmap;
          var node = mindmap.selectNode;
          if(node) {
            console.debug("Node idx: "+node.getIndex());
            console.debug("Previous node idx: "+node.getPreviousSibling().getIndex());
            console.debug("Next node idx: "+node.getNextSibling().getIndex());
            console.debug("Node pos: x="+node.getPosition().x+" / y="+node.getPosition().y);
            console.debug("Node dim: x="+node.getDimensions().x+" / y="+node.getDimensions().y);
            console.debug("Canvas: "+mindmap.setting.canvasSize);
            console.debug("Disp scroll: x="+mindmap.containerEL.scrollLeft+" / y="+mindmap.containerEL.scrollTop);
            console.debug("Disp client: x="+mindmap.containerEL.clientWidth+" / y="+mindmap.containerEL.clientHeight);
            //node.setText
          }
        }
      }
    });



    this.addCommand({
      id: 'Export to html',
      name: `${t('Export to html')}`,
      callback: () => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if(mindmapView){
            mindmapView.exportToHtml();
        }
      }
    });


    this.addCommand({
      id: 'export-xmind',
      name: t('Export to XMind'),
      checkCallback: (checking) => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if (!checking && mindmapView) {
          mindmapView.exportToXmind();
        }
        return !!mindmapView;
      }
    });

    this.addCommand({
      id: 'Export to JPEG (LQ)',
      name: `${t('Export to JPEG (LQ)')}`,
      callback: () => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if (mindmapView) {
          mindmapView.exportToJpeg(1);
        }
      }
    });

    this.addCommand({
      id: 'Export to PNG (LQ)',
      name: `${t('Export to PNG (LQ)')}`,
      callback: () => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if(mindmapView){
            mindmapView.exportToPng(1);
        }
      }
    });


    this.addCommand({
      id: 'Export to JPEG',
      name: `${t('Export to JPEG')}`,
      callback: () => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if (mindmapView) {
          mindmapView.exportToJpeg(2);
        }
      }
    });

    this.addCommand({
      id: 'Export to PNG',
      name: `${t('Export to PNG')}`,
      callback: () => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if(mindmapView){
            mindmapView.exportToPng(2);
        }
      }
    });


    this.addCommand({
      id: 'Export to JPEG (HQ)',
      name: `${t('Export to JPEG (HQ)')}`,
      callback: () => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if (mindmapView) {
          mindmapView.exportToJpeg(4);
        }
      }
    });

    this.addCommand({
      id: 'Export to PNG (HQ)',
      name: `${t('Export to PNG (HQ)')}`,
      callback: () => {
        const mindmapView = this.app.workspace.getActiveViewOfType(MindMapView);
        if(mindmapView){
            mindmapView.exportToPng(4);
        }
      }
    });


    this.registerView(mindmapViewType, (leaf) => new MindMapView(leaf, this));
    this.registerEditorExtension([
      editorSyncExtension,
      createCursorListener((cm) => this.onEditorCursor(cm)),
    ]);
    this.registerEvents();
    this.registerMonkeyAround();
    this.app.workspace.onLayoutReady(() => {
      this.updateMarkdownMindMapActions();
    });


    this.addSettingTab(new MindMapSettingsTab(this.app, this));
    this._loaded = true;

  }

  async ensurePagePreviewEnabled() {
    if (!this.settings.enableLinkPreview) {
      return;
    }

    const internalPlugins = (this.app as any).internalPlugins;
    const pagePreview = internalPlugins?.getPluginById?.("page-preview");

    if (pagePreview && !pagePreview.enabled) {
      await pagePreview.enable(false);
    }
  }

  onunload() {
    if (this.cursorSyncTimer !== null) {
      window.clearTimeout(this.cursorSyncTimer);
      this.cursorSyncTimer = null;
    }

    this.app.workspace.detachLeavesOfType(mindmapViewType);
    (this.app.workspace as any).unregisterHoverLinkSource?.(mindmapHoverSource);
    this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
      const action = this.markdownMindMapActions.get(leaf.view as MarkdownView);
      action?.remove();
    });

  }

  async newMindMap(folder?: TFolder) {
    const targetFolder = folder
      ? folder
      : this.app.fileManager.getNewFileParent(
        this.app.workspace.getActiveFile()?.path || ""
      );

    try {
      // @ts-ignore
      const mindmap: TFile = await this.app.fileManager.createNewMarkdownFile(
        targetFolder,
        `${t('Untitled mindmap')}`
      );

      await this.app.fileManager.processFrontMatter(mindmap, (frontmatter) => {
        frontmatter[frontMatterKey] = 'basic';
      });
      await this.openMindMapFile(mindmap);
    } catch (e) {
      console.error("Error creating mindmap board:", e);
    }
  }

  // Opens a mind map note in a new tab, in map mode.
  async openMindMapFile(file: TFile) {
    await this.waitForMindmapMetadata(file);
    const leaf = this.app.workspace.getLeaf(true);
    this.setFileMode(leaf, file.path, mindmapViewType);
    await leaf.setViewState(
      {
        type: mindmapViewType,
        state: { file: file.path },
        popstate: true,
      } as ViewState,
      { focus: true }
    );
  }

  isMindMapNote(file: TFile) {
    return Boolean(this.app.metadataCache.getFileCache(file)?.frontmatter?.[frontMatterKey]);
  }

  // A plain note asks first: converting in place rewrites it on the first
  // edit (with a backup), a copy leaves it as it is.
  async openNoteAsMindMap(leaf: WorkspaceLeaf) {
    const file = (leaf.view as any).file as TFile | null;
    if (file && !this.isMindMapNote(file)) {
      const choice = await askConvertMode(this.app, file.basename);
      if (choice === 'copy') {
        await this.convertToNewMindMap(file);
      }
      if (choice !== 'in-place') {
        return;
      }
    }
    this.setFileMode(leaf, file?.path, mindmapViewType);
    await this.setMindMapView(leaf);
  }

  async convertToNewMindMap(file: TFile) {
    try {
      const content = plainNoteAsMindMap(await this.app.vault.read(file), file.basename, this.settings.headLevel);
      const name = tf('{0} (mind map)', file.basename);
      const base = file.parent && !file.parent.isRoot() ? `${file.parent.path}/${name}` : name;
      const created = await this.app.vault.create(await availableNotePath(this, normalizePath(base)), content);
      await this.openMindMapFile(created);
      return created;
    } catch (err) {
      console.error('Failed to convert the note to a mind map:', err);
      new Notice(t('Import failed: unable to create the note'));
      return null;
    }
  }

  importXmind(data: ArrayBuffer, name: string, folder?: TFolder) {
    return importXmindFile(this, data, name, folder || this.getNewFileFolder());
  }

  private getNewFileFolder() {
    return this.app.fileManager.getNewFileParent(this.app.workspace.getActiveFile()?.path || "");
  }

  private async waitForMindmapMetadata(file: TFile) {
    for (let i = 0; i < 20; i++) {
      const cache = this.app.metadataCache.getFileCache(file);
      if (cache?.frontmatter?.[frontMatterKey]) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  // Text -> map sync: after the cursor settles in a Markdown editor, select the
  // node on that line in every mind map view of the same file.
  private pendingCursorEditor: EditorView | null = null;
  private cursorSyncTimer: number | null = null;

  private onEditorCursor(cm: EditorView) {
    if (!this.settings.syncSelection) {
      return;
    }
    this.pendingCursorEditor = cm;
    const ownerWindow = cm.dom.ownerDocument.defaultView || window;
    if (this.cursorSyncTimer !== null) {
      ownerWindow.clearTimeout(this.cursorSyncTimer);
    }
    this.cursorSyncTimer = ownerWindow.setTimeout(() => {
      this.cursorSyncTimer = null;
      const editor = this.pendingCursorEditor;
      this.pendingCursorEditor = null;
      if (editor) {
        this.syncEditorCursorToMaps(editor);
      }
    }, 80);
  }

  private syncEditorCursorToMaps(cm: EditorView) {
    let markdownView: MarkdownView | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof MarkdownView && (leaf.view.editor as any)?.cm === cm) {
        markdownView = leaf.view;
      }
    });
    const file = (markdownView as MarkdownView | null)?.file;
    if (!file) {
      return;
    }
    const state = cm.state;
    const line = state.doc.lineAt(state.selection.main.head).number - 1;
    const text = state.doc.toString();
    this.app.workspace.getLeavesOfType(mindmapViewType).forEach((leaf) => {
      const view = leaf.view as MindMapView;
      if (view.file === file) {
        view.selectNodeFromEditor(line, text);
      }
    });
  }

  async loadSettings() {
    this.settings = Object.assign({
      canvasSize: 8000,
      headLevel: 1,
      fontSize: 16,
      background: 'transparent',
      layout: 'mindmap',
      layoutDirect: 'mindmap',
      focusOnMove: false,
      focusOverlayOpacity: 0.4,
      focusGlowSize: 150,
      nodeGlowSize: 10,
      nodeMaxWidth: 800,
      enableLinkPreview: true,
      linkOpenMode: 'window',
      syncSelection: true,
    }, await this.loadData() || await this.loadLegacySettings());
  }

  // The plugin was called MindMark (id `mindmark`) before 0.3.0.
  private legacyPluginDir() {
    return `${this.app.vault.configDir}/plugins/mindmark`;
  }

  // A first start under the new id takes over the old plugin's settings.
  private async loadLegacySettings() {
    const path = `${this.legacyPluginDir()}/data.json`;
    try {
      if (!(await this.app.vault.adapter.exists(path))) {
        return null;
      }
      const data = JSON.parse(await this.app.vault.adapter.read(path));
      await this.saveData(data);
      new Notice(t('Settings migrated from MindMark'));
      return data;
    } catch (err) {
      console.error('Mapdown could not migrate the MindMark settings:', err);
      return null;
    }
  }

  getRecoveryDraftDirectory() {
    return normalizePath(`${this.manifest.dir || `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/recovery`);
  }

  // Unsaved drafts left by MindMark move to this plugin's folder; the old
  // plugin folder itself is left for the user to remove.
  private async migrateRecoveryDrafts() {
    const adapter = this.app.vault.adapter;
    const legacy = `${this.legacyPluginDir()}/recovery`;
    const target = this.getRecoveryDraftDirectory();
    try {
      if (legacy === target || !(await adapter.exists(legacy))) {
        return;
      }
      const { files } = await adapter.list(legacy);
      if (!files.length) {
        return;
      }
      if (!(await adapter.exists(target))) {
        await adapter.mkdir(target);
      }
      for (const file of files) {
        const destination = `${target}/${file.split('/').pop()}`;
        if (!(await adapter.exists(destination))) {
          await adapter.rename(file, destination);
        }
      }
    } catch (err) {
      console.error('Mapdown could not move the MindMark recovery drafts:', err);
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async setMarkdownView(leaf: WorkspaceLeaf): Promise<boolean> {
    if (leaf.view instanceof MindMapView) {
      try {
        await leaf.view.formatAndSaveMarkdown();
      } catch (err) {
        console.error('Mapdown kept the mindmap view open because saving failed:', err);
        return false;
      }
    }

    const file = (leaf.view as any).file as TFile | null;
    this.setFileMode(leaf, file?.path, 'markdown');

    await leaf.setViewState(
      {
        type: "markdown",
        state: leaf.view.getState(),
        popstate: true,
      } as ViewState,
      { focus: true }
    );
    this.updateMarkdownMindMapActions();
    return true;
  }

  async setMindMapView(leaf: WorkspaceLeaf) {
    await leaf.setViewState({
      type: mindmapViewType,
      state: leaf.view.getState(),
      popstate: true,
    } as ViewState);
  }

  updateMarkdownMindMapActions() {
    this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
      const view = leaf.view as MarkdownView;
      const file = view.file;
      let action = this.markdownMindMapActions.get(view);

      if (!file || file.extension !== 'md') {
        action?.remove();
        this.markdownMindMapActions.delete(view);
        return;
      }

      if (!action?.isConnected) {
        // A map note opens directly; a plain note asks how to convert first.
        action = view.addAction(mindmapIcon, "", async () => {
          if (!view.file) {
            return;
          }
          if (this.isMindMapNote(view.file)) {
            this.setFileMode(leaf, view.file.path, mindmapViewType);
            await this.setMindMapView(leaf);
          } else {
            await this.openNoteAsMindMap(leaf);
          }
        });
        action.addClass("mapdown-return-action");
        (view as any).modeButtonEl?.before(action);
        this.markdownMindMapActions.set(view, action);
      }
      action.setAttribute("aria-label", t(this.isMindMapNote(file) ? "Open as mindmap board" : "Open as a mind map…"));
    });
  }

  registerEvents() {
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.moveFileModes(oldPath, file.path);
      })
    );

    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.updateMarkdownMindMapActions();
      })
    );

    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        this.updateMarkdownMindMapActions();
      })
    );

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file: TFile,source:string,leaf?:WorkspaceLeaf) => {
        // Add a menu item to the folder context menu to create a board
        if (file instanceof TFolder) {
          menu.addItem((item) => {
            item
              .setTitle(`${t('New mindmap board')}`)
              .setIcon('document')
              .onClick(() => this.newMindMap(file));
          });
        }

        if (file instanceof TFile && file.extension.toLowerCase() === 'xmind') {
          menu.addItem((item) => {
            item
              .setTitle(t('Import as mindmap'))
              .setIcon('download')
              .onClick(async () => {
                this.importXmind(await this.app.vault.readBinary(file), file.basename, file.parent || this.app.vault.getRoot());
              });
          });
        }

        //add markdown view menu  open as mind map view

        if(leaf&&this.getFileMode(leaf, file.path) == 'markdown'){
             const cache = this.app.metadataCache.getFileCache(file);
             if(cache?.frontmatter && cache.frontmatter[frontMatterKey]){
                  menu.addItem((item) => {
                   item
                   .setTitle(`${t('Open as mindmap board')}`)
                   .setIcon("document")
                   .onClick(() => {
                     this.setFileMode(leaf, file.path, mindmapViewType);
                     this.setMindMapView(leaf);
                   });
                 }).addSeparator();
            }
        }

        // A plain note: the dialog offers converting in place or a new map.
        if (file instanceof TFile && file.extension === 'md' && !this.isMindMapNote(file)) {
          menu.addItem((item) => {
            item
              .setTitle(t('Open as a mind map…'))
              .setIcon(mindmapIcon)
              .onClick(async () => {
                let target = leaf;
                if ((target?.view as any)?.file !== file) {
                  target = this.app.workspace.getLeaf(false);
                  await target.openFile(file);
                }
                await this.openNoteAsMindMap(target);
              });
          });
        }
      })
    );

    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        this.updateMarkdownMindMapActions();
        this.app.workspace.getLeavesOfType(mindmapViewType).forEach((leaf) => {
          const view = leaf.view as MindMapView;
          if (view?.file === file && typeof view.onFileMetadataChange === 'function') {
              view.onFileMetadataChange(file);
          }
        });
      })
    );

    (this.app.workspace as any).registerHoverLinkSource?.(mindmapHoverSource, {
      display: 'Mapdown',
      defaultMod: false,
    });
  }

  private afterViewStateSettled(leaf: WorkspaceLeaf, result: any) {
    return Promise.resolve(result).then((value) => {
      if (leaf.view instanceof MindMapView && leaf.view.hasUnwritableState) {
        leaf.view.returnUnwritableStateToMarkdown();
      }
      return value;
    });
  }

  registerMonkeyAround() {
    const self = this;

    this.register(
      around(WorkspaceLeaf.prototype, {
        // Kanbans can be viewed as markdown or kanban, and we keep track of the mode
        // while the file is open. When the file closes, we no longer need to keep track of it.
        detach(next) {
          return function () {
            self.clearLeafFileModes(this);

            return next.apply(this);
          };
        },

        setViewState(next) {

          return function (state: ViewState, ...rest: any[]) {
            // new Notice( state.type);
            const filePath = typeof state.state?.file === 'string'
              ? state.state.file
              : null;

            if (
              self._loaded &&
              state.type === "markdown" &&
              filePath &&
              // And the current mode of the file is not set to markdown
              self.getFileMode(this, filePath) !== "markdown"
            ) {
              // Then check for the kanban frontMatterKey
              const cache = self.app.metadataCache.getCache(filePath);

              //   new Notice(cache.frontmatter[frontMatterKey]);

              if (cache?.frontmatter && cache.frontmatter[frontMatterKey]) {
                // If we have it, force the view type to kanban
                const newState = {
                  ...state,
                  type: mindmapViewType,
                };

                self.setFileMode(this, filePath, mindmapViewType);

                return self.afterViewStateSettled(this, next.apply(this, [newState, ...rest]));
              }
            }

            return self.afterViewStateSettled(this, next.apply(this, [state, ...rest]));
          };
        },
      })
    );



    // this.register(
    //   around(MarkdownView.prototype, {
    //     onMoreOptionsMenu(next) {
    //       return function (menu: Menu) {
    //         const file = this.file;
    //         const cache = file
    //           ? self.app.metadataCache.getFileCache(file)
    //           : null;

    //         if (
    //           !file ||
    //           !cache?.frontmatter ||
    //           !cache.frontmatter[frontMatterKey]
    //         ) {
    //           return next.call(this, menu);
    //         }



    //         menu
    //           .addItem((item) => {
    //             item
    //               .setTitle(`${t('Open as mindmap board')}`)
    //               .setIcon("document")
    //               .onClick(() => {
    //                 self.mindmapFileModes[this.leaf.id || file.path] =
    //                   mindmapViewType;
    //                 self.setMindMapView(this.leaf);
    //               });
    //           })
    //           .addSeparator();

    //         next.call(this, menu);
    //       };
    //     },
    //   })
    // );


  }


}
