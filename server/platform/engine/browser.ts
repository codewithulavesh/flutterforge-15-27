/**
 * Minimal, real Chrome DevTools Protocol client.
 *
 * Playwright/Puppeteer are not dependencies of this project, but Chrome is
 * present on the host and `ws` is available. This module launches headless
 * Chrome, attaches to a page target and exposes the operations the engineer
 * needs: navigate, inspect the accessibility/text tree, click by selector or
 * coordinate, type, press keys, read console errors and capture screenshots.
 *
 * Flutter Web renders to a canvas, so coordinate clicks and the semantics tree
 * are first-class; DOM selectors work for normal web content.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { BrowserConsoleEntry, BrowserPort, BrowserSnapshot } from './types.js';

const CHROME_CANDIDATES = [
  process.env.FLUTTERFORGE_CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);

export function resolveChromePath(): string | null {
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Array<(params: any) => void>>();

  constructor(private readonly socket: WebSocket) {
    this.socket.on('message', (data) => this.onMessage(data));
  }

  on(method: string, listener: (params: any) => void): () => void {
    const list = this.listeners.get(method) ?? [];
    list.push(listener);
    this.listeners.set(method, list);
    return () => {
      const current = this.listeners.get(method) ?? [];
      this.listeners.set(method, current.filter((entry) => entry !== listener));
    };
  }

  private onMessage(data: WebSocket.RawData): void {
    let message: any;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${message.error.message ?? 'CDP error'}${message.error.code ? ` (${message.error.code})` : ''}`));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method === 'string') {
      for (const listener of this.listeners.get(message.method) ?? []) {
        try {
          listener(message.params);
        } catch {
          // Listener errors must not tear down the connection.
        }
      }
    }
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 60_000): Promise<any> {
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify(payload), (error) => {
        if (!error) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // already closed
    }
  }
}

export class ChromeBrowser implements BrowserPort {
  private constructor(
    private readonly child: ChildProcess,
    private readonly connection: CdpConnection,
    private readonly sessionId: string,
    private readonly userDataDir: string,
    private readonly consoleEntries: BrowserConsoleEntry[],
  ) {}

  static async launch(options: { signal?: AbortSignal } = {}): Promise<ChromeBrowser> {
    const chrome = resolveChromePath();
    if (!chrome) {
      throw new Error('Chrome/Chromium was not found. Set FLUTTERFORGE_CHROME_PATH or install Google Chrome for browser inspection.');
    }
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flutterforge-chrome-'));
    const child = spawn(chrome, [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-extensions',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--mute-audio',
      '--window-size=1280,800',
      `--user-data-dir=${userDataDir}`,
      '--remote-debugging-port=0',
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    const endpoint = await new Promise<string>((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Chrome did not expose a DevTools endpoint within 20s.'));
      }, 20_000);
      timer.unref?.();
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString();
        const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) {
          cleanup();
          resolve(match[1]);
        }
      };
      const onExit = (code: number | null) => {
        cleanup();
        reject(new Error(`Chrome exited before DevTools was ready (code ${code ?? 'signal'}).`));
      };
      const cleanup = () => {
        clearTimeout(timer);
        child.stderr?.off('data', onData);
        child.off('exit', onExit);
      };
      child.stderr?.on('data', onData);
      child.once('exit', onExit);
    });

    const socket = new WebSocket(endpoint, { maxPayload: 64 * 1024 * 1024 });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out connecting to Chrome DevTools.')), 10_000);
      timer.unref?.();
      socket.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    const connection = new CdpConnection(socket);

    const target = await connection.send('Target.createTarget', { url: 'about:blank' });
    const attached = await connection.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const sessionId = attached.sessionId as string;

    const browser = new ChromeBrowser(child, connection, sessionId, userDataDir, []);
    await connection.send('Page.enable', {}, sessionId);
    await connection.send('Runtime.enable', {}, sessionId);
    await connection.send('Log.enable', {}, sessionId).catch(() => undefined);
    await connection.send('Network.enable', {}, sessionId).catch(() => undefined);

    connection.on('Runtime.consoleAPICalled', (params) => {
      const text = Array.isArray(params?.args)
        ? params.args.map((arg: any) => (typeof arg?.value === 'string' ? arg.value : arg?.description ?? arg?.type ?? '')).join(' ')
        : '';
      browser.consoleEntries.push({ type: String(params?.type ?? 'log'), text, at: Date.now() });
      if (browser.consoleEntries.length > 500) browser.consoleEntries.shift();
    });
    connection.on('Runtime.exceptionThrown', (params) => {
      const details = params?.exceptionDetails;
      const text = details?.exception?.description ?? details?.text ?? 'Uncaught exception';
      browser.consoleEntries.push({ type: 'exception', text, at: Date.now() });
    });
    connection.on('Log.entryAdded', (params) => {
      const entry = params?.entry;
      if (!entry) return;
      browser.consoleEntries.push({ type: String(entry.level ?? 'log'), text: String(entry.text ?? ''), at: Date.now() });
    });
    connection.on('Network.loadingFailed', (params) => {
      if (params?.canceled) return;
      browser.consoleEntries.push({
        type: 'network-error',
        text: `${params?.type ?? 'request'} failed: ${params?.errorText ?? 'unknown error'}`,
        at: Date.now(),
      });
    });

    options.signal?.addEventListener('abort', () => {
      void browser.close();
    }, { once: true });

    return browser;
  }

  private async evaluate(expression: string): Promise<any> {
    const result = await this.connection.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    }, this.sessionId, 30_000);
    if (result?.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'Page evaluation failed.');
    }
    return result?.result?.value;
  }

  private async readSnapshot(): Promise<BrowserSnapshot> {
    const raw = await this.evaluate(`(() => {
      const placeholder = document.querySelector('flt-semantics-placeholder');
      if (placeholder && !window.__ffSemantics) { try { placeholder.click(); window.__ffSemantics = true; } catch {} }
      const selectorFor = (el) => {
        if (el.id) return '#' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id);
        const parts = [];
        let node = el;
        while (node && node.nodeType === 1 && parts.length < 5) {
          let part = node.tagName.toLowerCase();
          if (node.classList && node.classList.length > 0) part += '.' + [...node.classList].slice(0, 2).map(c => CSS.escape(c)).join('.');
          const parent = node.parentElement;
          if (parent) {
            const siblings = [...parent.children].filter(s => s.tagName === node.tagName);
            if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
          }
          parts.unshift(part);
          node = parent;
        }
        return parts.join(' > ');
      };
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const interactive = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="textbox"],[aria-label],[flt-semantics]')]
        .filter(visible)
        .slice(0, 120)
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          text: (el.getAttribute('aria-label') || el.innerText || el.value || '').trim().slice(0, 160),
          selector: selectorFor(el),
          role: el.getAttribute('role') || undefined,
        }))
        .filter((entry) => entry.text.length > 0);
      const semantics = [...document.querySelectorAll('flt-semantics, [aria-label]')]
        .map((el) => el.getAttribute('aria-label') || el.textContent || '')
        .map((text) => text.trim())
        .filter((text) => text.length > 0)
        .slice(0, 200);
      return JSON.stringify({
        url: location.href,
        title: document.title,
        text: (semantics.length > 0 ? semantics.join('\\n') : (document.body ? document.body.innerText : '')).slice(0, 20000),
        elements: interactive,
      });
    })()`);
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return {
      url: String(parsed?.url ?? ''),
      title: String(parsed?.title ?? ''),
      text: String(parsed?.text ?? ''),
      elements: Array.isArray(parsed?.elements) ? parsed.elements : [],
    };
  }

  async navigate(url: string): Promise<BrowserSnapshot> {
    const load = new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 30_000);
      timeout.unref?.();
      const off = this.connection.on('Page.loadEventFired', () => {
        clearTimeout(timeout);
        off();
        resolve();
      });
    });
    await this.connection.send('Page.navigate', { url }, this.sessionId, 30_000);
    await load;
    await new Promise((resolve) => setTimeout(resolve, 400));
    return this.readSnapshot();
  }

  async snapshot(): Promise<BrowserSnapshot> {
    return this.readSnapshot();
  }

  async click(input: { selector?: string; x?: number; y?: number }): Promise<string> {
    if (typeof input.x === 'number' && typeof input.y === 'number') {
      const base = { x: input.x, y: input.y, button: 'left', clickCount: 1 };
      await this.connection.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: input.x, y: input.y }, this.sessionId);
      await this.connection.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base }, this.sessionId);
      await this.connection.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base }, this.sessionId);
      return `Clicked at (${input.x}, ${input.y}).`;
    }
    if (!input.selector) throw new Error('click requires selector or x/y coordinates.');
    const selector = JSON.stringify(input.selector);
    const clicked = await this.evaluate(`(() => {
      const el = document.querySelector(${selector});
      if (!el) return false;
      el.scrollIntoView({block:'center'});
      if (typeof el.click === 'function') el.click();
      else el.dispatchEvent(new MouseEvent('click', {bubbles:true}));
      return true;
    })()`);
    if (!clicked) throw new Error(`No element matched selector ${input.selector}.`);
    return `Clicked ${input.selector}.`;
  }

  async typeText(input: { text: string; selector?: string; submit?: boolean }): Promise<string> {
    if (input.selector) {
      const selector = JSON.stringify(input.selector);
      const text = JSON.stringify(input.text);
      const focused = await this.evaluate(`(() => {
        const el = document.querySelector(${selector});
        if (!el) return false;
        el.focus();
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, ${text}); else el.value = ${text};
        el.dispatchEvent(new Event('input', {bubbles:true}));
        el.dispatchEvent(new Event('change', {bubbles:true}));
        return true;
      })()`);
      if (!focused) throw new Error(`No element matched selector ${input.selector}.`);
    } else {
      await this.connection.send('Input.insertText', { text: input.text }, this.sessionId);
    }
    if (input.submit) {
      await this.pressKey('Enter');
    }
    return `Typed ${input.text.length} characters${input.selector ? ` into ${input.selector}` : ''}.`;
  }

  async pressKey(key: string): Promise<string> {
    const map: Record<string, { key: string; code: string; windowsVirtualKeyCode: number }> = {
      Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
      Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
      Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
      Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
      ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
      ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
      ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
      ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
    };
    const entry = map[key];
    if (!entry) throw new Error(`Unsupported key "${key}". Supported: ${Object.keys(map).join(', ')}.`);
    await this.connection.send('Input.dispatchKeyEvent', { type: 'keyDown', ...entry }, this.sessionId);
    await this.connection.send('Input.dispatchKeyEvent', { type: 'keyUp', ...entry }, this.sessionId);
    return `Pressed ${key}.`;
  }

  async screenshot(name: string): Promise<string> {
    const result = await this.connection.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, this.sessionId, 30_000);
    return String(result?.data ?? '');
  }

  async console(): Promise<BrowserConsoleEntry[]> {
    return [...this.consoleEntries];
  }

  async close(): Promise<void> {
    this.connection.close();
    try {
      this.child.kill('SIGKILL');
    } catch {
      // already gone
    }
    await fs.rm(this.userDataDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** A port that reports a precise, honest error when Chrome is unavailable. */
export class UnavailableBrowser implements BrowserPort {
  constructor(private readonly reason: string) {}
  private fail(): never {
    throw new Error(this.reason);
  }
  async navigate(): Promise<BrowserSnapshot> { return this.fail(); }
  async snapshot(): Promise<BrowserSnapshot> { return this.fail(); }
  async click(): Promise<string> { return this.fail(); }
  async typeText(): Promise<string> { return this.fail(); }
  async pressKey(): Promise<string> { return this.fail(); }
  async screenshot(): Promise<string> { return this.fail(); }
  async console(): Promise<BrowserConsoleEntry[]> { return this.fail(); }
  async close(): Promise<void> {}
}
