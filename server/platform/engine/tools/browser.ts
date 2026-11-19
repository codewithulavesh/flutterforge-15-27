/**
 * Browser inspection tools backed by real headless Chrome (CDP).
 *
 * Use these after `preview_start`: navigate to the preview URL, read the
 * rendered text/semantics tree, interact with the UI, read console/network
 * errors and capture a PNG screenshot artifact.
 */
import { z } from 'zod';
import type { EngineerToolSpec, ToolOutcome } from '../types.js';
import { truncate } from '../util.js';

export const browserTools: EngineerToolSpec[] = [
  {
    name: 'browser_open',
    description:
      'Open a URL in a real headless Chrome page and return the rendered text, title, interactive elements and any console errors. '
      + 'For Flutter Web, semantics are enabled automatically when the accessibility placeholder is present.',
    schema: z.object({ url: z.string().url() }),
    invoke: async (input, context): Promise<ToolOutcome> => {
      const preview = context.preview.status(context.projectId);
      if (!preview?.url || !String(input.url).startsWith(preview.url)) throw new Error('Browser inspection is limited to this project’s running preview URL.');
      const snapshot = await context.browser.navigate(String(input.url));
      const consoleEntries = await context.browser.console();
      const errors = consoleEntries.filter((entry) => entry.type === 'error' || entry.type === 'exception' || entry.type === 'network-error');
      return {
        content: [
          `URL: ${snapshot.url}`,
          `Title: ${snapshot.title}`,
          `Rendered text:\n${truncate(snapshot.text, 12_000) || '(empty)'}`,
          `Interactive elements:\n${snapshot.elements.slice(0, 40).map((entry, index) => `${index + 1}. ${entry.tag}${entry.role ? `[${entry.role}]` : ''} ${JSON.stringify(entry.text)} selector=${entry.selector}`).join('\n') || '(none)'}`,
          errors.length > 0 ? `Console errors:\n${errors.slice(-20).map((entry) => `- [${entry.type}] ${truncate(entry.text, 400)}`).join('\n')}` : 'Console errors: none',
        ].join('\n\n'),
        data: { url: snapshot.url, title: snapshot.title, elements: snapshot.elements.length, errors: errors.length },
      };
    },
  },
  {
    name: 'browser_snapshot',
    description: 'Read the current page: rendered text, semantics, interactive elements and console errors.',
    schema: z.object({}),
    invoke: async (_input, context): Promise<ToolOutcome> => {
      const snapshot = await context.browser.snapshot();
      const consoleEntries = await context.browser.console();
      const errors = consoleEntries.filter((entry) => entry.type === 'error' || entry.type === 'exception' || entry.type === 'network-error');
      return {
        content: [
          `URL: ${snapshot.url}`,
          `Title: ${snapshot.title}`,
          `Rendered text:\n${truncate(snapshot.text, 12_000) || '(empty)'}`,
          `Interactive elements:\n${snapshot.elements.slice(0, 40).map((entry, index) => `${index + 1}. ${entry.tag} ${JSON.stringify(entry.text)} selector=${entry.selector}`).join('\n') || '(none)'}`,
          errors.length > 0 ? `Console errors:\n${errors.slice(-20).map((entry) => `- [${entry.type}] ${truncate(entry.text, 400)}`).join('\n')}` : 'Console errors: none',
        ].join('\n\n'),
        data: { url: snapshot.url, elements: snapshot.elements.length, errors: errors.length },
      };
    },
  },
  {
    name: 'browser_click',
    description:
      'Click in the page. Provide a CSS selector, or x/y viewport coordinates (needed for Flutter Web canvas widgets).',
    schema: z.object({
      selector: z.string().optional(),
      x: z.number().min(0).max(10_000).optional(),
      y: z.number().min(0).max(10_000).optional(),
    }),
    invoke: async (input, context): Promise<ToolOutcome> => {
      if (!input?.selector && (typeof input?.x !== 'number' || typeof input?.y !== 'number')) {
        throw new Error('browser_click requires selector or x and y.');
      }
      const message = await context.browser.click({ selector: input?.selector, x: input?.x, y: input?.y });
      return { content: message, data: { clicked: true } };
    },
  },
  {
    name: 'browser_type',
    description: 'Type text into the focused element, or focus a selector first. Set submit=true to press Enter afterwards.',
    schema: z.object({
      text: z.string().max(2000),
      selector: z.string().optional(),
      submit: z.boolean().optional(),
    }),
    invoke: async (input, context): Promise<ToolOutcome> => {
      const message = await context.browser.typeText({ text: String(input.text), selector: input.selector, submit: input.submit === true });
      return { content: message, data: { typed: input.text.length } };
    },
  },
  {
    name: 'browser_key',
    description: 'Press a key: Enter, Tab, Escape, Backspace or an arrow key.',
    schema: z.object({ key: z.enum(['Enter', 'Tab', 'Escape', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) }),
    invoke: async (input, context): Promise<ToolOutcome> => {
      const message = await context.browser.pressKey(input.key);
      return { content: message, data: { key: input.key } };
    },
  },
  {
    name: 'browser_console',
    description: 'Return captured console messages, uncaught exceptions and failed network requests.',
    schema: z.object({}),
    invoke: async (_input, context): Promise<ToolOutcome> => {
      const entries = await context.browser.console();
      if (entries.length === 0) return { content: 'No console messages captured.', data: { entries: 0 } };
      return {
        content: entries.slice(-100).map((entry) => `[${entry.type}] ${truncate(entry.text, 1000)}`).join('\n'),
        data: { entries: entries.length },
      };
    },
  },
  {
    name: 'browser_screenshot',
    description: 'Capture a PNG screenshot of the current page and save it as a project artifact. Returns the artifact path.',
    schema: z.object({ name: z.string().max(100).optional() }),
    invoke: async (input, context): Promise<ToolOutcome> => {
      const base64 = await context.browser.screenshot(input?.name ?? 'screenshot');
      if (!base64) throw new Error('Chrome returned an empty screenshot.');
      const safe = String(input?.name ?? `screenshot-${Date.now()}`).replace(/[^A-Za-z0-9._-]+/g, '-');
      const file = await context.artifacts.write(`${safe}.png`, Buffer.from(base64, 'base64'), 'image/png');
      return { content: `Screenshot saved: ${file}\nInspect it before claiming the UI is correct.`, data: { path: file } };
    },
  },
];
