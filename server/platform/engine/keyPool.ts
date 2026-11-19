/** Server-only credential rotation. Never exposes keys in diagnostics. */
export function configuredKeys(env: NodeJS.ProcessEnv, provider: string, primary?: string): string[] {
  const prefix = provider === 'openrouter' ? 'OPENROUTER' : provider === 'deepseek' ? 'DEEPSEEK' : 'FLUTTERFORGE_LLM';
  const values = [primary, env[`${prefix}_API_KEY`], env[`${prefix}_API_KEYS`],
    ...(provider === 'openai-compatible' ? [] : [env[`VITE_${prefix}_API_KEY`], env[`VITE_${prefix}_API_KEYS`]]),
    ...Object.keys(env).filter(name => new RegExp(`^(?:VITE_)?${prefix}_API_KEY_\\d+$`).test(name)).sort().map(name => env[name])];
  return [...new Set(values.flatMap(value => (value ?? '').split(/[\s,;]+/)).map(value => value.trim()).filter(Boolean))];
}

export class ServerKeyPool {
  private cursor = 0;
  private cooldowns = new Map<string, number>();
  private readonly keys: string[];
  constructor(keys: string[], private readonly now = Date.now) {
    this.keys = [...new Set(keys.filter(Boolean))];
    if (!this.keys.length) throw new Error('No model credentials configured.');
  }
  /** Metadata only; suitable for diagnostics without revealing credentials. */
  status() {
    return { total: this.keys.length, available: this.keys.filter(key => (this.cooldowns.get(key) ?? 0) <= this.now()).length };
  }
  private next(tried: Set<string>) {
    for (let count = 0; count < this.keys.length; count++) {
      const key = this.keys[this.cursor++ % this.keys.length];
      if (!tried.has(key) && (this.cooldowns.get(key) ?? 0) <= this.now()) return key;
    }
    return undefined;
  }
  fetch(transport: typeof fetch = globalThis.fetch): typeof fetch {
    return async (input, init) => {
      const tried = new Set<string>();
      // Clone before retries so Request bodies, as well as SDK string bodies, can be replayed.
      const template = new Request(input, init);
      for (;;) {
        template.signal.throwIfAborted();
        const key = this.next(tried);
        if (!key) return Response.json({ error: { message: 'All configured model keys are unavailable or cooling down. Retry after the provider quota resets.', code: 429 } }, { status: 429 });
        tried.add(key);
        const request = template.clone();
        request.headers.set('Authorization', `Bearer ${key}`);
        const response = await transport(request);
        if (![401, 402, 429].includes(response.status)) return response;
        const now = this.now();
        const retry = response.headers.get('retry-after');
        const retryAt = retry ? (Number.isFinite(Number(retry)) ? now + Number(retry) * 1000 : Date.parse(retry)) : NaN;
        const errorBody = await response.text();
        const daily = /free-models-per-day|daily|per.day/i.test(errorBody);
        const nextDay = (Math.floor(now / 86400000) + 1) * 86400000;
        const until = response.status === 401 ? Infinity : Number.isFinite(retryAt) ? Math.max(now + 1000, retryAt)
          : daily ? nextDay : now + (response.status === 402 ? 3600000 : 60000);
        this.cooldowns.set(key, until);
        // Each credential is attempted at most once. Streams are returned untouched on success;
        // never restart a response after the caller has received generated tokens.
      }
    };
  }
}
