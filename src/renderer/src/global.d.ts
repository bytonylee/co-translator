import type { TranslatorApi } from "../../shared/types";

declare global {
  interface Window {
    translator: TranslatorApi;
    zero?: {
      invoke<T = unknown>(command: string, payload?: unknown): Promise<T>;
    };
  }
}

export {};
