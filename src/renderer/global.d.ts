interface BetterboardAPI {
  autosave(json: string): Promise<void>;
  loadAutosave(): Promise<string | null>;
  saveBoard(json: string): Promise<boolean>;
  openBoard(): Promise<string | null>;
  exportPNG(dataURL: string): Promise<boolean>;
  confirm(message: string, detail?: string): Promise<boolean>;
  onMenu(cb: (action: string) => void): void;
}

declare global {
  interface Window {
    betterboard: BetterboardAPI;
  }
}

export {};
