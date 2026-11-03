import Node, { levelClass } from './INode'
import MindMap from './mindmap';

export default class Layout {
    layoutName='mindmap';
    direct:string='';
    root:Node;
    mind?:MindMap;
    levelDis:number = 40;
    nodeDis:number = 8;
    firstLevelDis:number = 80;
    firstNodeDis:number = 20;
    svgDom?:any;
    isCache:boolean = true;
    lefts:Node[]=[];
    rights:Node[]=[];
    colors:string[]=[];
    lineWidth = 1;
    pathMap: Record<string, any> = {};
    constructor(node:Node,direct?:string,colors?:string[], mind?:MindMap){
       this.root = node||null;
       this.mind = mind || node?.mindmap || null;
       this.direct = direct||'mindmap';
       this.colors=colors||[];
      
       if (!this.root || !this.mind?.edgeGroup) {
           return;
       }
       if (!this.svgDom) this.svgDom = this.mind.edgeGroup.group();

       this.layout();
    }

 

    setDirect() {
        var me = this;
        var len = this.root.children.length;
        var root = this.root;
        this.rights = [];
        this.lefts= [];
        if (this.direct == 'right') {
            this.rights = root.children;

            this.rights.forEach(r => {
                this._setDirect(r, 'right')
                
            })

        } else if (this.direct == 'left') {
            this.lefts = root.children;
            this.lefts.forEach(r => {
                this._setDirect(r, 'left')
            });

        } else if (this.direct == 'clockwise') {
            root.children.forEach(function (child, i) {
                if (i < len / 2) {
                    me.rights.push(child);
                    me._setDirect(child, 'right');
                } else {
                    me.lefts.push(child);
                    me._setDirect(child, 'left');
                }
            });
            me.lefts.reverse();
        }
        
        else {

            root.children.forEach(function (child, i) {
                if (i < len / 2) {
                    me.rights.push(child);
                    me._setDirect(child, 'right');
                } else {
                    me.lefts.push(child);
                    me._setDirect(child, 'left');
                }
            });
        }
    }

    countDescendants(n:Node): number {
        return n.children.reduce((sum, c) => sum + 1 + this.countDescendants(c), 0);
    }

    // Search can show a collapsed branch without changing its saved state.
    isExpandedForLayout(n:Node) {
        return n.isExpand || Boolean(this.mind?.searchTemporarilyExpandedIds?.has(n.getId()));
    }

    _setDirect(n:Node, direct:string) {
        n.stroke='';
        n.direct = direct;
        var isSelected = n.isSelect || n.mindmap?.selectNode === n;
        var isEditing = Boolean(n.data?.isEdit);
        var level = n.getLevel();
        var isSecondLevel = level == 1;
        // Levels have different font sizes, so a level change needs a remeasure.
        var wantedLevel = levelClass(level);
        var levelChanged = wantedLevel !== '' && !n.containEl.classList.contains(wantedLevel);

        // Only touch classes that change: rewriting the class list restyles
        // every node, which dominates layout time on large maps.
        const classList = n.containEl.classList;
        const wanted: Record<string, boolean> = {
            'mm-node': true,
            'mm-node-left': direct == 'left',
            'mm-node-right': direct == 'right',
            'mm-node-leaf': n.isLeaf(),
            'mm-node-collapse': !this.isExpandedForLayout(n),
            'mm-node-second': isSecondLevel,
            'mm-node-third': level == 2,
            'mm-node-deep': level >= 3,
        };
        if (isSelected) {
            wanted['mm-node-select'] = true;
        }
        if (isEditing) {
            wanted['mm-edit-node'] = true;
        }
        for (const name in wanted) {
            if (classList.contains(name) !== wanted[name]) {
                if (wanted[name]) {
                    classList.add(name);
                } else {
                    classList.remove(name);
                }
            }
        }
        // A collapsed node shows how many nodes it hides.
        const hidden = wanted['mm-node-collapse'] && !n.isLeaf() ? String(this.countDescendants(n)) : '';
        if (n._barDom && n._barDom.textContent !== hidden) {
            n._barDom.textContent = hidden;
        }

        if (levelChanged) {
            n.refreshBox();
            n.clearCacheData();
            this.mind?.scheduleNodeRemeasure(n);
        }
        
        n.children.forEach(c => {
            this._setDirect(c, direct)
        });
        
    }

    layout(node?:Node,direct?:string){
        if(node) this.root = node;
        if(direct) this.direct = direct;
        this.setDirect();

        if(this.direct == 'right'){
           this.layoutRight();
        }else if(this.direct == 'left'){
           this.layoutLeft();
        }else{
           this.layoutMindMap()
        }

        this._dolayout();

        // balance layout
        this._doRefresh();

    }

    layoutMindMap(){
         this.layoutRight();
         this.layoutLeft();
    }

    layoutRight(arr?:Node[],parent?:Node){
       var rights = arr||this.rights;
       var p = parent||this.root;
       var pos = p.getPosition();
       var box = p.getBox();
       var plevel = p.getLevel();
       if(plevel==0 ){
           var dis = this.firstLevelDis;
           var nodeDis = this.firstNodeDis;
       }else{
           var dis = this.levelDis;
           var nodeDis = this.nodeDis;
       }

       var {disHeight,height} = this._getNodesHeight(rights);
      
       var h = height / rights.length;
        if(plevel == 0 ){
             var next:number[] = [parseInt(pos.x + box.width + dis+''), parseInt(pos.y +  box.height/2  - disHeight / 2  +'')];
        }else if(plevel == 1){
            var next:number[] = [parseInt(pos.x + box.width + dis+''), parseInt(pos.y +  box.height/2  - disHeight / 2  - h/2 - this.lineWidth/2 +'')];
        }else{
            var next:number[] = [parseInt(pos.x + box.width + dis+''), parseInt(pos.y + box.height - disHeight / 2 - h/2 +'')];
        }

       rights.forEach((child) => {
           child.setPosition(next[0], next[1]);
           var childBox = child.getBox();
           next[1] += parseInt(childBox.height + nodeDis +'');
       });

       rights.forEach((item) => {
           if(this.isExpandedForLayout(item)){
               this.layoutRight(item.children,item);
           }
       });
       
    }

    layoutLeft(arr?:Node[],parent?:Node){
        var lefts = arr||this.lefts;
        var p = parent||this.root;
        var pos = p.getPosition();
        var box = p.getBox();
        var plevel = p.getLevel();
        if(plevel==0){
            var dis = this.firstLevelDis;
            var nodeDis = this.firstNodeDis;
        }else{
            var dis = this.levelDis;
            var nodeDis = this.nodeDis;
        }
        var  {disHeight,height} = this._getNodesHeight(lefts);
        var h = height / lefts.length;
        if(plevel==0){
            var next = [parseInt(pos.x - dis+''), parseInt(pos.y + box.height/2  - disHeight / 2 +'')];
        }else if(plevel == 1 ){
            var next = [parseInt(pos.x - dis+''), parseInt(pos.y + box.height/2  - disHeight / 2  - h/2 - this.lineWidth/2  +'')];
        }else{
           var next = [parseInt(pos.x - dis+''), parseInt(pos.y + box.height - disHeight / 2 - h/2 +'')];
        }

       // var next = [parseInt(pos.x - dis+''), parseInt(pos.y - disHeight / 2 +'')];
        lefts.forEach((child) => {
            var childBox = child.getBox();
            child.setPosition(parseInt(next[0] - childBox.width+''), parseInt(next[1]+''));
            next[1] += childBox.height + nodeDis;
        });

        lefts.forEach((item) => {
            if(this.isExpandedForLayout(item)){
              this.layoutLeft(item.children,item)
            }
        });

    }

    _getNodesHeight(nodes:Node[]){
        if (nodes[0] && nodes[0].getLevel() == 1) {
            var dis = this.firstNodeDis;
        } else {
            var dis = this.nodeDis;
        }
        var h = 0;
        var h1 = 0;
        if(nodes.length==1){
            var h =nodes[0].getBox().height;
            return {
                disHeight:h,
                height:h
            };
        }
        nodes.forEach((item, index) => {
            var height = item.getBox().height;
            h += height;
            h1 += height;
            if (index != nodes.length - 1) {
                h += dis;
            }
        });
        return {
            disHeight:h,
            height:h1
        };
    }

    _doRefresh() {
        var root = this.root;
        var rootPos = root.getPosition();
        var rootBox = root.getBox();
        var center = rootPos.y + rootBox.height / 2;
        var rights = this.rights;
        var lefts = this.lefts;
        if (rights.length >= 2) {
            var firstNode = rights[0];
            var lastNode = rights[rights.length - 1];

            var firstPos = firstNode.getPosition();
            var lastPos = lastNode.getPosition();
            var lastBox = lastNode.getBox();
            var dis1 = lastPos.y + lastBox.height - center;
            var dis2 = center - firstPos.y;
            if (Math.abs(dis1) != Math.abs(dis2)) {
                var dy = Math.abs(Math.abs(dis1) - Math.abs(dis2)) / 2 +'';
                if (Math.abs(dis1) > Math.abs(dis2)) {
                    rights.forEach(c => {
                        this.moveNode(c, 0, -parseInt(dy))
                    });
                } else {
                    rights.forEach(c => {
                        this.moveNode(c, 0, parseInt(dy))
                    });
                }
            }
        }

        if (lefts.length >= 2) {
            var firstNode = lefts[0];
            var lastNode = lefts[lefts.length - 1];

            var firstPos = firstNode.getPosition();
            var lastPos = lastNode.getPosition();
            var lastBox = lastNode.getBox();
            var dis1 = lastPos.y + lastBox.height - center;
            var dis2 = center - firstPos.y;
            if (Math.abs(dis1) != Math.abs(dis2)) {
                var dy = Math.abs(Math.abs(dis1) - Math.abs(dis2)) / 2 +'';
                if (Math.abs(dis1) > Math.abs(dis2)) {
                    lefts.forEach(c => {
                        this.moveNode(c, 0, -parseInt(dy))
                    });
                } else {
                    lefts.forEach(c => {
                        this.moveNode(c, 0, parseInt(dy))
                    });
                }
            }
        }
    }

    moveNode(node:Node, dx:number, dy:number) {
        node.move(dx, dy);
        node && node.children && node.children.forEach((child) => {
            this.moveNode(child, dx, dy);
        });
    }

    //fix 0.5 line width bug
    linePoint(arr:any[], lineWidth:number) {
        let num = 0;
        var func:Function;
        if (lineWidth % 2 == 1) {
            num = 0.5
            func = parseInt;
        }else{
            func = Math.ceil;
        }
        var p = arr.map((item:any) => {
            return [func(item[0]) + num, func(item[1]) + num]
        });
        return p;
    }

    _dolayout(){
        var me = this;
        var mind = this.mind;

        mind.traverseDF((n:Node) => {
            if (n == me.root) return;

            if (!me.isExpandedForLayout(n)) {
                return
            }
           
            var box = n.getCBox();

            if (me.isCache && n.boundingRect) {
                var cbox = n.boundingRect;
            } else {
                var list = n.getShowNodeList();
                if (list.length) {
                     cbox = mind.getBoundingRect(list);
                }
            }

            if(!cbox) return;
         
            if (n.boundingRect && me.isCache) {
                var topDy = cbox.topDy,
                    downDy = cbox.downDy;
            } else {
                 topDy = Math.abs(cbox.y - box.y);
                 downDy = Math.abs(cbox.y + cbox.height - box.y - box.height);
                 cbox.topDy = topDy;
                 cbox.downDy = downDy;
                 n.boundingRect = cbox;
            }

            me._adjustNode(n, 0, topDy, downDy);
        });
    }



    _adjustNode(node:Node, dx:number, dy1:number, dy2:number) {
        if (!node) {
            return;
        }
        var direct = node.direct;
        if (node && node != this.root) {
            var sibs = node.getSiblings();
            var pos = node.getPosition();
            sibs.forEach((sib) => {
                if (sib.direct == direct) {
                    var sibPos = sib.getPosition();
                    if (sibPos.y > pos.y) {
                        this.moveNode(sib, dx, dy2);
                    } else {
                        this.moveNode(sib, dx, -dy1);
                    }
                }
            })

        }
    }

    refresh(node?:Node,direct?:string){
        this.layout(node,direct);
    }

    createLink(){
        var me = this;
        // this.svgDom && this.svgDom.clear(); // Removed to support transition animation
        if (this.root.getChildren().length == 0) {
            for (const id in this.pathMap) {
                this.pathMap[id].remove();
            }
            this.pathMap = {};
            return;
        }

		var dis = this.levelDis;
		var root = this.root;
        var lineWidth = this.lineWidth;

		var rootLevel = this.root.getLevel();

        var activePaths = new Set<string>();

		function createLine(node:Node) {
			if (!me.isExpandedForLayout(node)) {
				return;
			}
			var children = node.getChildren();
			var pos = node.getPosition();
			var box = node.getBox();
			box.height = box.height + lineWidth;
         
			var level = node.getLevel();
			children.length && children.forEach(function (child) {
				var direct = child.direct;
				var childPos = child.getPosition();
				var childBox = {
					...child.getBox()
				};

				childBox.height = childBox.height + lineWidth;

				let _stroke =  node.stroke?node.stroke:(child.stroke?child.stroke:'var(--text-muted)');

                if(!child.stroke){
                    child.stroke = _stroke;
                }

                child._barDom.style.backgroundColor = _stroke;
                child._barDom.style.borderColor = _stroke;

				child.containEl.style.setProperty('--node-stroke', _stroke);

				if (level == rootLevel) {
					var from = {
						x: pos.x + box.width / 2,
						y: pos.y + box.height / 2
					};
				} else {
					if (direct == 'right') {
						var from = {
							x: pos.x + box.width,
							y: pos.y + box.height / 2
						};
					} else {
						var from = {
							x: pos.x,
							y: pos.y + box.height / 2
						};
					}
				}

				if (direct == 'right') {
					var to = {
						x: childPos.x,
						y: childBox.height / 2 + childPos.y
					};
				} else {
					var to = {
						x: childPos.x + childBox.width,
						y: childBox.height / 2 + childPos.y
					};
				}


				if (lineWidth % 2 == 1) {

					var x1 = parseInt(from.x+'') - 0.5;
					var x2 = parseInt(to.x+'') - 0.5;

					var y1 = parseInt(from.y+'') - 0.5;
					var y2 = parseInt(to.y+'') - 0.5;
				} else {
					var x1 = parseInt(from.x+'');
					var y1 = parseInt(from.y+'');
					var x2 = parseInt(to.x+'');
					var y2 = parseInt(to.y+'');
				}

				if (
					!node.isShow() || !child.isShow() ||
					node.containEl.classList.contains('mm-node-dimmed') ||
					child.containEl.classList.contains('mm-node-dimmed')
				) {
					createLine(child);
					return;
				}

                var pathId = node.data.id + '->' + child.data.id;
                activePaths.add(pathId);
                var line1 = me.pathMap[pathId];
                if (!line1) {
                    if (level == rootLevel) {
                        line1 = me.svgDom.path().stroke({
                            color: _stroke,
                            width: lineWidth + 1,
                            linecap: 'round',
                            linejoin: 'round'
                        }).fill('none');
                    } else {
                        line1 = me.svgDom.path().stroke({
                            color: _stroke,
                            width: lineWidth,
                            linecap: 'round',
                            linejoin: 'round'
                        }).fill('none');
                    }
                    me.pathMap[pathId] = line1;
                    line1._mmStroke = _stroke;
                } else if (line1._mmStroke !== _stroke) {
                    line1.stroke({ color: _stroke });
                    line1._mmStroke = _stroke;
                }
                // Rewriting an unchanged path still costs a repaint.
                const plot = (d: string) => {
                    if (line1._mmPath !== d) {
                        line1.plot(d);
                        line1._mmPath = d;
                    }
                };

				if (lineWidth % 2 == 1) {
					var x11 = parseInt(childPos.x+'') - 0.5;
					var x22 = parseInt(childPos.x + childBox.width+'') - 0.5;

					var y11 = y2;
					var y22 = y2;

				} else {
					var x11 = parseInt(childPos.x+'')
					var y11 = parseInt(childBox.height + childPos.y+'')
					var x22 = parseInt(childPos.x + childBox.width+'')
					var y22 = parseInt(childBox.height + childPos.y+'')
				}

				if (level == rootLevel) {
					var cpx11 = {
						x: from.x + dis / 2,
						y: from.y
					};
					var cpx12 = {
						x: from.x + dis / 2,
						y: to.y
					};
					if (direct == 'left') {
						cpx11.x = from.x - dis / 2;
						cpx12.x = from.x - dis / 2;
					}

					var pathStr = `M${x1} ${y1}  C ${cpx11.x} ${cpx11.y}, ${cpx12.x} ${cpx12.y}, ${x2} ${y2}`;
					plot(pathStr);

				} else {

					// Underline removed for card-style layout
					// me.svgDom.line(x11, y11, x22, y22).stroke({
					// 	color: _stroke,
					// 	width: lineWidth,
					// 	linecap: 'miter',
					// 	linejoin: 'miter'
					// }).fill('none');

					//var c = parseInt((to.y - from.y) / 6+'');
					 var cpx11 = {
						x: from.x + dis / 2,
						y: from.y
					}
					 var cpx12 = {
						x: from.x + dis / 2,
						y: to.y
					}
					if (direct == 'left') {
						cpx11.x = from.x - dis / 2;
						cpx12.x = from.x - dis / 2;
					}

					cpx11.x = parseInt(cpx11.x+'');
					cpx11.y = parseInt(cpx11.y+'');
					cpx12.x = parseInt(cpx12.x+'');
					cpx12.y = parseInt(cpx12.y+'');

					var path = `M${x1} ${y1}  C ${cpx11.x} ${cpx11.y}, ${cpx12.x} ${cpx12.y}, ${x2} ${y2}`;
					plot(path);

				}

				createLine(child);
			});
		}

		const obsidianColors = [
			'var(--mm-color-1)',
			'var(--mm-color-2)',
			'var(--mm-color-3)',
			'var(--mm-color-4)',
			'var(--mm-color-5)',
			'var(--mm-color-6)',
			'var(--mm-color-7)',
			'var(--mm-color-8)'
		];

        let colorArray = this.colors && this.colors.length > 0 ? this.colors : obsidianColors;

        //Set Node link Color
        this.root.children.forEach((c:Node,i:number)=>{
            c.stroke = colorArray[i % colorArray.length];
        });

		createLine(root);

        for (const id in this.pathMap) {
            if (!activePaths.has(id)) {
                this.pathMap[id].remove();
                delete this.pathMap[id];
            }
        }
    }

    

}
