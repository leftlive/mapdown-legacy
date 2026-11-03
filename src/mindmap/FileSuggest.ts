import { App, TFile, prepareFuzzySearch } from 'obsidian';
import Node from './INode';

export class FileSuggest {
    app: App;
    containerEl: HTMLElement;
    node: Node;
    files: TFile[] = [];
    selectedIndex: number = 0;
    activeQuery: string = "";
    isOpen: boolean = false;

    constructor(app: App) {
        this.app = app;
        this.containerEl = document.createElement('div');
        this.containerEl.addClass('suggestion-container');
        this.containerEl.style.position = 'absolute';
        this.containerEl.style.zIndex = '1000';
        this.containerEl.style.display = 'none';
        this.containerEl.style.backgroundColor = 'var(--background-secondary)';
        this.containerEl.style.border = '1px solid var(--background-modifier-border)';
        this.containerEl.style.borderRadius = '6px';
        this.containerEl.style.boxShadow = '0 4px 8px rgba(0,0,0,0.1)';
        document.body.appendChild(this.containerEl);
    }

    open(node: Node, rect: DOMRect, query: string) {
        this.node = node;
        // Show the list in the window that holds the node (popouts included).
        const nodeDocument = node.contentEl.ownerDocument;
        if (this.containerEl.ownerDocument !== nodeDocument || !this.containerEl.isConnected) {
            nodeDocument.body.appendChild(this.containerEl);
        }
        this.activeQuery = query;
        this.updateSuggestions();
        if (this.files.length === 0) {
            this.close();
            return;
        }
        this.isOpen = true;
        this.containerEl.style.display = 'block';
        this.containerEl.style.top = `${rect.bottom + 5}px`;
        this.containerEl.style.left = `${rect.left}px`;
    }

    close() {
        this.isOpen = false;
        this.containerEl.style.display = 'none';
    }

    destroy() {
        this.close();
        this.containerEl.remove();
    }

    updateSuggestions() {
        const allFiles = this.app.vault.getMarkdownFiles();
        if (!this.activeQuery) {
            this.files = allFiles.slice(0, 10);
        } else {
            const fuzzy = prepareFuzzySearch(this.activeQuery);
            const results = allFiles.map(file => {
                const match = fuzzy(file.basename);
                return { file, match };
            }).filter(item => item.match)
              .sort((a, b) => b.match.score - a.match.score)
              .slice(0, 10);
            this.files = results.map(item => item.file);
        }
        this.selectedIndex = 0;
        this.render();
    }

    render() {
        this.containerEl.empty();
        this.files.forEach((file, index) => {
            const itemEl = this.containerEl.createDiv('suggestion-item');
            if (index === this.selectedIndex) {
                itemEl.addClass('is-selected');
            }
            itemEl.setText(file.basename);
            itemEl.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.selectFile(file);
            });
        });
    }

    handleKeydown(e: KeyboardEvent): boolean {
        if (!this.isOpen) return false;
        
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            this.selectedIndex = (this.selectedIndex + 1) % this.files.length;
            this.render();
            return true;
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            this.selectedIndex = (this.selectedIndex - 1 + this.files.length) % this.files.length;
            this.render();
            return true;
        } else if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            if (this.files[this.selectedIndex]) {
                this.selectFile(this.files[this.selectedIndex]);
            }
            return true;
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            this.close();
            return true;
        }
        return false;
    }

    selectFile(file: TFile) {
        if (this.node) {
            const contentEl = this.node.contentEl;
            const selection = contentEl.ownerDocument.defaultView.getSelection();
            if (!selection || selection.rangeCount === 0) return;
            
            const range = selection.getRangeAt(0);
            const text = contentEl.innerText;
            
            // Find the [[ before the cursor
            const preCursorRange = range.cloneRange();
            preCursorRange.selectNodeContents(contentEl);
            preCursorRange.setEnd(range.endContainer, range.endOffset);
            const textBeforeCursor = preCursorRange.toString();
            
            const matchIndex = textBeforeCursor.lastIndexOf('[[');
            if (matchIndex !== -1) {
                const hasDuplicateBasename = this.app.vault.getMarkdownFiles().some((candidate) => {
                    return candidate.path !== file.path && candidate.basename === file.basename;
                });
                const linkTarget = hasDuplicateBasename
                    ? file.path.replace(/\.md$/, '')
                    : file.basename;
                const newText = text.substring(0, matchIndex) + `[[${linkTarget}]]` + text.substring(textBeforeCursor.length);
                contentEl.innerText = newText;
                
                // Set cursor to end of the inserted link
                const newCursorPos = matchIndex + `[[${linkTarget}]]`.length;
                const newRange = document.createRange();
                
                // Because innerText might create new text nodes or single text node
                if (contentEl.firstChild) {
                    try {
                        newRange.setStart(contentEl.firstChild, newCursorPos);
                        newRange.collapse(true);
                        selection.removeAllRanges();
                        selection.addRange(newRange);
                    } catch(e) {}
                }
            }
        }
        this.close();
    }
}
