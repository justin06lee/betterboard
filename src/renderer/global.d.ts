interface AiKeyStatus {
  set: boolean;
  hint: string; // last four characters, for confirming which key is stored
}

interface AiAsk {
  model: string;
  messages: {
    role: 'user' | 'assistant';
    content:
      | string
      | ({ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } })[];
  }[];
}

interface BetterboardAPI {
  platform: string;
  autosave(json: string): Promise<void>;
  loadAutosave(): Promise<string | null>;
  saveBoard(json: string): Promise<boolean>;
  openBoard(): Promise<string | null>;
  openImages(): Promise<string[]>;
  clipboardImage(): Promise<string | null>;
  clipboardText(): Promise<string>;
  exportPNG(dataURL: string): Promise<boolean>;
  confirm(message: string, detail?: string): Promise<boolean>;
  onMenu(cb: (action: string) => void): void;

  aiKeyStatus(): Promise<AiKeyStatus>;
  aiSetKey(key: string): Promise<AiKeyStatus>;
  aiAsk(payload: AiAsk): Promise<void>;
  aiCancel(): Promise<void>;
  onAiDelta(cb: (text: string) => void): void;
  onAiDone(cb: () => void): void;
  onAiError(cb: (message: string) => void): void;
}

declare global {
  interface Window {
    betterboard: BetterboardAPI;
  }
}

export {};
