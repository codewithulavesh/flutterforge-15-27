export interface KeyStatus {
  key: string;
  maskedKey: string;
  isHealthy: boolean;
  cooldownUntil: number;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  lastError?: string;
}

export class OpenRouterKeyPool {
  private static instance: OpenRouterKeyPool;
  private keys: Map<string, KeyStatus> = new Map();
  private currentIndex = 0;

  private constructor() {
    this.initKeys();
  }

  public static getInstance(): OpenRouterKeyPool {
    if (!this.instance) {
      this.instance = new OpenRouterKeyPool();
    }
    return this.instance;
  }

  private initKeys() {
    try {
      // 1. Load multi-key pool from environment variables
      if (typeof import.meta !== 'undefined' && import.meta.env) {
        const envPool = import.meta.env.VITE_OPENROUTER_API_KEYS as string | undefined;
        if (envPool) {
          for (const k of envPool.split(',')) this.addKey(k);
        }
        const singleKey = import.meta.env.VITE_OPENROUTER_API_KEY as string | undefined;
        if (singleKey) this.addKey(singleKey);
        const orKey = import.meta.env.OPENROUTER_API_KEY as string | undefined;
        if (orKey) this.addKey(orKey);
      }

      // 2. Load stored keys from localStorage
      if (typeof localStorage !== 'undefined') {
        const storedPool = localStorage.getItem('openrouter_api_keys');
        if (storedPool) {
          for (const k of storedPool.split(',')) this.addKey(k);
        }
        const stored =
          localStorage.getItem('openrouter_api_key') ||
          localStorage.getItem('openrouter_key') ||
          localStorage.getItem('ff_openrouter_key');
        if (stored) this.addKey(stored);
      }
    } catch {
      // ignore
    }
  }

  public addKey(key: string) {
    if (!key) return;
    const parts = key.split(',').map((k) => k.trim()).filter(Boolean);
    for (const trimmed of parts) {
      if (trimmed && !this.keys.has(trimmed)) {
        this.keys.set(trimmed, {
          key: trimmed,
          maskedKey: this.maskKey(trimmed),
          isHealthy: true,
          cooldownUntil: 0,
          totalRequests: 0,
          successfulRequests: 0,
          failedRequests: 0,
        });
      }
    }
  }

  public getAllKeys(): string[] {
    return Array.from(this.keys.keys());
  }

  public getNextKey(): string {
    const keyArray = Array.from(this.keys.values());
    if (keyArray.length === 0) return '';
    const now = Date.now();
    for (let i = 0; i < keyArray.length; i++) {
      const idx = (this.currentIndex + i) % keyArray.length;
      const status = keyArray[idx];
      if (status.cooldownUntil <= now) {
        this.currentIndex = (idx + 1) % keyArray.length;
        return status.key;
      }
    }
    // All in cooldown: return least recently used
    const fallback = keyArray[this.currentIndex % keyArray.length]?.key || '';
    this.currentIndex = (this.currentIndex + 1) % keyArray.length;
    return fallback;
  }

  public markSuccess(key: string) {
    const status = this.keys.get(key);
    if (status) {
      status.totalRequests++;
      status.successfulRequests++;
      status.isHealthy = true;
      status.cooldownUntil = 0;
    }
  }

  public markFailure(key: string, error: string) {
    const status = this.keys.get(key);
    if (status) {
      status.totalRequests++;
      status.failedRequests++;
      status.lastError = error;
      // 30s cooldown on failure
      status.cooldownUntil = Date.now() + 30000;
      status.isHealthy = false;
    }
  }

  private maskKey(key: string): string {
    if (key.length <= 16) return '****';
    return `${key.substring(0, 10)}...${key.substring(key.length - 6)}`;
  }
}

export const keyPool = OpenRouterKeyPool.getInstance();
