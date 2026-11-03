// Asks how to open a note that is not a mind map yet: converting in place
// rewrites it on the first edit, a copy leaves it untouched.
import { App, Modal, Setting } from 'obsidian';
import { t, tf } from './lang/helpers';

export type ConvertChoice = 'in-place' | 'copy' | null;

export function askConvertMode(app: App, noteName: string): Promise<ConvertChoice> {
    return new Promise((resolve) => {
        let choice: ConvertChoice = null;
        const modal = new Modal(app);
        modal.titleEl.setText(t('Open as a mind map?'));
        modal.contentEl.createEl('p', { text: tf('Convert note explanation', noteName) });
        new Setting(modal.contentEl)
            .addButton((b) => b.setButtonText(t('Cancel')).onClick(() => modal.close()))
            .addButton((b) => b.setButtonText(t('Save as a new mind map')).onClick(() => {
                choice = 'copy';
                modal.close();
            }))
            .addButton((b) => b.setButtonText(t('Convert this note')).setCta().onClick(() => {
                choice = 'in-place';
                modal.close();
            }));
        modal.onClose = () => resolve(choice);
        modal.open();
    });
}
