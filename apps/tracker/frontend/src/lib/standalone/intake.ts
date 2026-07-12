// Shared handles for the standalone file/folder pickers, so both the empty-state
// hero and the header "add" button can open them. StandaloneIntake registers its
// hidden <input>s here on mount; anything else just calls pickFiles/pickFolder.
let filesInput: HTMLInputElement | null = null;
let folderInput: HTMLInputElement | null = null;

export function registerFiles(el: HTMLInputElement | null): void {
  filesInput = el;
}
export function registerFolder(el: HTMLInputElement | null): void {
  folderInput = el;
}
export function pickFiles(): void {
  filesInput?.click();
}
export function pickFolder(): void {
  folderInput?.click();
}
