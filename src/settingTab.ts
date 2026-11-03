import {
    App,
    PluginSettingTab,
    Setting,
} from 'obsidian';
import MindMap from './main';
import { t } from './lang/helpers'
import { MindMapView, mindmapViewType } from './MindMapView';
import MyNode from './mindmap/INode';

export class MindMapSettingsTab extends PluginSettingTab {
    plugin: MindMap;
    constructor(app: App, plugin: MindMap) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;

        containerEl.empty();

        new Setting(containerEl)
            .setName(t('Canvas size'))
            .setDesc(t('Canvas size desc'))
            .addDropdown(dropDown =>
                dropDown
                    .addOption('4000', '4000')
                    .addOption('6000', '6000')
                    .addOption('8000', '8000')
                    .addOption('10000', '10000')
                    .addOption('12000', '12000')
                    .addOption('16000', '16000')
                    .addOption('20000', '20000')
                    .addOption('30000', '30000')
                    .addOption('36000', '36000')
                    .setValue(this.plugin.settings.canvasSize.toString() || '8000')
                    .onChange((value: string) => {
                        var _v = Number.parseInt(value)
                        this.plugin.settings.canvasSize = _v;
                        this.plugin.saveData(this.plugin.settings);
                        const mindmapLeaves = this.app.workspace.getLeavesOfType(mindmapViewType);
                        mindmapLeaves.forEach((leaf) => {
                            var v = leaf.view as MindMapView;
                            if (!v.mindmap) {
                                return;
                            }
                            v.mindmap.setting.canvasSize = _v;
                            v.mindmap.setAppSetting();
                            var box = v.mindmap.root.getBox();
                            v.mindmap.root.setPosition(_v / 2 - box.width / 2, _v / 2 - box.height / 2);
                            v.mindmap.refresh();
                            v.mindmap.center();
                        });
                    }));

        new Setting(containerEl)
            .setName(t('Canvas background'))
            .setDesc(t('Canvas background desc'))
            .addText(text =>
                text
                    .setValue(this.plugin.settings.background || 'transparent')
                    .setPlaceholder(t('Canvas background placeholder'))
                    .onChange((value: string) => {
                        this.plugin.settings.background = value;
                        this.plugin.saveData(this.plugin.settings);
                        const mindmapLeaves = this.app.workspace.getLeavesOfType(mindmapViewType);
                        mindmapLeaves.forEach((leaf) => {
                            var v = leaf.view as MindMapView;
                            if (!v.mindmap) {
                                return;
                            }
                            v.mindmap.setting.background = this.plugin.settings.background;
                            v.mindmap.setAppSetting();
                        });
                    }));

        new Setting(containerEl)
            .setName(t('Max level of node to markdown head'))
            .setDesc(t('Max level of node to markdown head desc'))
            .addDropdown(dropDown =>
                dropDown
                    .addOption('0', '0')
                    .addOption('1', '1')
                    .addOption('2', '2')
                    .addOption('3', '3')
                    .addOption('4', '4')
                    .addOption('5', '5')
                    .addOption('6', '6')
                    .setValue(this.plugin.settings.headLevel.toString() || '2')
                    .onChange((value: string) => {
                        this.plugin.settings.headLevel = Number.parseInt(value);
                        this.plugin.saveData(this.plugin.settings);
                        const mindmapLeaves = this.app.workspace.getLeavesOfType(mindmapViewType);
                        mindmapLeaves.forEach((leaf) => {
                            var v = leaf.view as MindMapView;
                            if (!v.mindmap) {
                                return;
                            }
                            v.mindmap.setting.headLevel = this.plugin.settings.headLevel;
                        });
                    }));



        new Setting(containerEl)
            .setName(t('Font size'))
            .setDesc(t('Font size desc'))
            .addText(text =>
                text
                    .setValue(this.plugin.settings.fontSize?.toString() || '16')
                    .setPlaceholder(t('Font size placeholder'))
                    .onChange((value: string) => {
                        const fontSize = Number.parseInt(value);
                        // Ignore partial or invalid input instead of saving NaN.
                        if (!Number.isFinite(fontSize) || fontSize < 8 || fontSize > 72) {
                            return;
                        }
                        this.plugin.settings.fontSize = fontSize;
                        this.plugin.saveData(this.plugin.settings);
                        const mindmapLeaves = this.app.workspace.getLeavesOfType(mindmapViewType);
                        mindmapLeaves.forEach((leaf) => {
                            var v = leaf.view as MindMapView;
                            if (!v.mindmap) {
                                return;
                            }
                            v.mindmap.setting.fontSize = this.plugin.settings.fontSize;
                            v.mindmap.setAppSetting();
                            v.mindmap.traverseBF((n: MyNode) => {
                                n.boundingRect = null;
                                n.refreshBox();
                            })
                            v.mindmap.refresh();
                        });
                    }));

        new Setting(containerEl)
            .setName(t('Node glow size'))
            .setDesc(t('Node glow size desc'))
            .addSlider((slider) =>
                slider
                    .setLimits(0, 24, 1)
                    .setValue(this.plugin.settings.nodeGlowSize ?? 10)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.nodeGlowSize = value;
                        await this.plugin.saveSettings();
                        const mindmapLeaves = this.app.workspace.getLeavesOfType(mindmapViewType);
                        mindmapLeaves.forEach((leaf) => {
                            const view = leaf.view as MindMapView;
                            if (!view.mindmap) {
                                return;
                            }
                            view.mindmap.setting.nodeGlowSize = value;
                            view.mindmap.setAppSetting();
                        });
                    }),
            );

        new Setting(containerEl)
            .setName(t('Node max width'))
            .setDesc(t('Node max width desc'))
            .addSlider((slider) =>
                slider
                    .setLimits(240, 1200, 20)
                    .setValue(this.plugin.settings.nodeMaxWidth || 800)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.nodeMaxWidth = value;
                        await this.plugin.saveSettings();
                        const mindmapLeaves = this.app.workspace.getLeavesOfType(mindmapViewType);
                        mindmapLeaves.forEach((leaf) => {
                            const view = leaf.view as MindMapView;
                            if (!view.mindmap) {
                                return;
                            }
                            view.mindmap.setting.nodeMaxWidth = value;
                            view.mindmap.setAppSetting();
                            view.mindmap.traverseBF((n: MyNode) => {
                                n.boundingRect = null;
                                n.refreshBox();
                            });
                            view.mindmap.refresh();
                        });
                    }),
            );

        new Setting(containerEl)
            .setName(t('Mind map layout direct'))
            .setDesc(t('Mind map layout direct desc'))
            .addDropdown(dropDown =>
                dropDown
                    .addOption('mindmap', t('Centered'))
                    .addOption('right', t('Right'))
                    .addOption('left', t('Left'))
                    .addOption('clockwise', t('Clockwise'))
                    .setValue(this.plugin.settings.layoutDirect && this.plugin.settings.layoutDirect !== 'mind map'
                        ? this.plugin.settings.layoutDirect
                        : 'mindmap')
                    .onChange((value: string) => {
                        this.plugin.settings.layoutDirect = value;
                        this.plugin.saveData(this.plugin.settings);
                        const mindmapLeaves = this.app.workspace.getLeavesOfType(mindmapViewType);
                        mindmapLeaves.forEach((leaf) => {
                            var v = leaf.view as MindMapView;
                            if (!v.mindmap) {
                                return;
                            }
                            v.mindmap.setting.layoutDirect = this.plugin.settings.layoutDirect;
                            v.mindmap.refresh();
                        });
                    }));

        const strokeSetting = new Setting(containerEl)
            .setName(t('Stroke Array'))
            .setDesc(t('Stroke Array Desc'));

        const palettes = [
            { name: t('Classic palette'), colors: ['#e63946', '#f4a261', '#e9c46a', '#2a9d8f', '#264653'] },
            { name: t('Pastel palette'), colors: ['#cdb4db', '#ffc8dd', '#ffafcc', '#bde0fe', '#a2d2ff'] },
            { name: t('Bright palette'), colors: ['#ff595e', '#ffca3a', '#8ac926', '#1982c4', '#6a4c93'] },
            { name: t('Ocean palette'), colors: ['#03045e', '#0077b6', '#00b4d8', '#90e0ef', '#caf0f8'] },
            { name: t('Forest palette'), colors: ['#d8f3dc', '#b7e4c7', '#95d5b2', '#74c69d', '#52b788', '#40916c', '#2d6a4f', '#1b4332'] },
            { name: t('Earth palette'), colors: ['#cb997e', '#ddbea9', '#ffe8d6', '#b7b7a4', '#a5a58d', '#6b705c'] },
            { name: t('Vintage palette'), colors: ['#22223b', '#4a4e69', '#9a8c98', '#c9ada7', '#f2e9e4'] },
        ];

        const palettesDiv = strokeSetting.settingEl.createDiv('mm-color-palettes');

        palettes.forEach(({ name, colors }) => {
            const paletteEl = palettesDiv.createDiv('mm-color-palette');
            const currentStroke = this.plugin.settings.strokeArray?.join(',') || '';
            const isMatch = currentStroke === colors.join(',');
            paletteEl.setAttribute('title', name);
            paletteEl.setAttribute('aria-label', name);

            if (isMatch) {
                paletteEl.classList.add('is-active');
            }

            colors.forEach(color => {
                const block = paletteEl.createDiv('mm-color-block');
                block.style.backgroundColor = color;
            });

            paletteEl.onclick = () => {
                // Update UI active state
                palettesDiv.querySelectorAll('.mm-color-palette').forEach(el => el.classList.remove('is-active'));
                paletteEl.classList.add('is-active');

                // Save setting
                this.plugin.settings.strokeArray = colors;
                this.plugin.saveData(this.plugin.settings);

                // Update views
                const mindmapLeaves = this.app.workspace.getLeavesOfType(mindmapViewType);
                mindmapLeaves.forEach((leaf) => {
                    var v = leaf.view as MindMapView;
                    if (!v.mindmap) {
                        return;
                    }
                    v.mindmap.setting.strokeArray = this.plugin.settings.strokeArray;
                    if( v.mindmap.mmLayout){
                        v.mindmap.mmLayout.colors = v.mindmap.setting.strokeArray;
                    }
                    v.mindmap.traverseBF((n: MyNode) => {
                        n.boundingRect = null;
                        n.refreshBox();
                    })
                    v.mindmap.refresh();
                });
            };
        });

        new Setting(containerEl)
            .setName(t('Center view after moving node'))
            .setDesc(t('Center view after moving node desc'))
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.focusOnMove).onChange((value) => {
                        this.plugin.settings.focusOnMove = value;
                        this.plugin.saveData(this.plugin.settings);

                }),
            );

        new Setting(containerEl)
            .setName(t('Sync selection with Markdown'))
            .setDesc(t('Sync selection with Markdown desc'))
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.syncSelection)
                    .onChange(async (value) => {
                        this.plugin.settings.syncSelection = value;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName(t('Focus overlay opacity'))
            .setDesc(t('Focus overlay opacity desc'))
            .addSlider((slider) =>
                slider
                    .setLimits(0, 80, 5)
                    .setValue(Math.round(this.plugin.settings.focusOverlayOpacity * 100))
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.focusOverlayOpacity = value / 100;
                        await this.plugin.saveSettings();
                        this.app.workspace.getLeavesOfType(mindmapViewType).forEach((leaf) => {
                            const view = leaf.view as MindMapView;
                            if (!view.mindmap) {
                                return;
                            }
                            view.mindmap.setting.focusOverlayOpacity =
                                this.plugin.settings.focusOverlayOpacity;
                            if (view.mindmap.focusedNode) {
                                view.mindmap.refresh();
                            }
                        });
                    }),
            );

        new Setting(containerEl)
            .setName(t('Enable internal link preview'))
            .setDesc(t('Enable internal link preview desc'))
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.enableLinkPreview)
                    .onChange(async (value) => {
                        this.plugin.settings.enableLinkPreview = value;
                        await this.plugin.saveSettings();
                        if (value) {
                            await this.plugin.ensurePagePreviewEnabled();
                        }
                    }),
            );

        new Setting(containerEl)
            .setName(t('Focus glow size'))
            .setDesc(t('Focus glow size desc'))
            .addSlider((slider) =>
                slider
                    .setLimits(0, 400, 10)
                    .setValue(this.plugin.settings.focusGlowSize ?? 150)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.focusGlowSize = value;
                        await this.plugin.saveSettings();
                        this.app.workspace.getLeavesOfType(mindmapViewType).forEach((leaf) => {
                            const view = leaf.view as MindMapView;
                            if (!view.mindmap) {
                                return;
                            }
                            view.mindmap.setting.focusGlowSize = value;
                            if (view.mindmap.focusedNode) {
                                view.mindmap.refresh();
                            }
                        });
                    }),
            );

        new Setting(containerEl)
            .setName(t('Internal link open mode'))
            .setDesc(t('Internal link open mode desc'))
            .addDropdown((dropdown) =>
                dropdown
                    .addOption('current', t('Current tab'))
                    .addOption('tab', t('New tab'))
                    .addOption('window', t('New window'))
                    .setValue(this.plugin.settings.linkOpenMode)
                    .onChange(async (value: 'current' | 'tab' | 'window') => {
                        this.plugin.settings.linkOpenMode = value;
                        await this.plugin.saveSettings();
                    }),
            );



    }
}
