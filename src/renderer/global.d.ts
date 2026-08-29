export type AiConnectionKind = 'embedded' | 'remote';

export interface AiConnection {
  id: string;
  name: string;
  kind: AiConnectionKind;
  model: string;
  url: string;
  keySet: boolean;
  keyHint: string;
}

export interface AiConnectionState {
  active: string;
  connections: AiConnection[];
  error?: string;
}

interface AiAsk {
  requestId: string;
  connectionId: string;
  messages: {
    role: 'user' | 'assistant';
    text: string;
    image?: string;
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

  aiConnections(): Promise<AiConnectionState>;
  aiLocalProviders(): Promise<{ providers: string[]; error: string }>;
  aiSaveConnection(connection: Partial<AiConnection> & { key?: string; clearKey?: boolean }): Promise<AiConnectionState>;
  aiSetActive(id: string): Promise<AiConnectionState>;
  aiDeleteConnection(id: string): Promise<AiConnectionState>;
  aiAsk(payload: AiAsk): Promise<void>;
  aiCancel(): Promise<void>;
  onAiDelta(cb: (text: string) => void): void;
  onAiDone(cb: () => void): void;
  onAiError(cb: (message: string) => void): void;
  onAiDraw(cb: (payload: { requestId: string; drawing: unknown }) => void): void;
}

declare global {
  interface Window {
    betterboard: BetterboardAPI;
  }
}

export {};
