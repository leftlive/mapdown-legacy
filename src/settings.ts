export class MindMapSettings {
    theme:string = 'dark';
    canvasSize:number = 8000;
    background:string = 'transparent';
    fontSize:number = 16;
    headLevel:number = 1;
    layout:string="mindmap";
    layoutDirect:string = 'mindmap'
    color?:string;
    exportMdModel?:string;
    //strokeArray?:string=''
    strokeArray?:any[];
    focusOnMove:boolean = false;
    focusOverlayOpacity:number = 0.4;
    focusGlowSize:number = 150;
    nodeGlowSize:number = 10;
    nodeMaxWidth:number = 800;
    enableLinkPreview:boolean = true;
    linkOpenMode:'current' | 'tab' | 'window' = 'window';
    syncSelection:boolean = true;
}
