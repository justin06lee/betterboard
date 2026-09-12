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
  bench?: boolean;
  storeLoad(): Promise<{ manifest: string | null; legacy: boolean }>;
  storeRead(name: string): Promise<Uint8Array>;
  storeReadText(name: string): Promise<string>;
  storePut(name: string, data: Uint8Array | string): Promise<void>;
  storeCommit(manifest: unknown): Promise<void>;
  storeQuarantine(): Promise<void>;
  fileReadBegin(kind: 'open' | 'legacy-autosave'): Promise<{ token: number; size: number; name: string } | null>;
  fileRead(token: number, max: number): Promise<Uint8Array | null>;
  fileReadEnd(token: number): Promise<void>;
  fileWriteBegin(): Promise<number | null>;
  fileWrite(token: number, text: string): Promise<void>;
  fileWriteEnd(token: number, ok: boolean): Promise<boolean>;
  onFlush(cb: () => void): void;
  flushed(): void;
  openImages(): Promise<string[]>;
  clipboardImage(): Promise<string | null>;
  clipboardText(): Promise<string>;
  clipboardWriteImage(dataURL: string, text?: string): Promise<boolean>;
  clipboardWriteText(text: string): Promise<void>;
  loadStickers(): Promise<unknown[]>;
  saveStickers(stickers: unknown[]): Promise<boolean>;
  exportPNG(dataURL: string): Promise<boolean>;
  exportAnimation(bytes: Uint8Array, format: 'mp4' | 'webm' | 'gif'): Promise<boolean>;
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
