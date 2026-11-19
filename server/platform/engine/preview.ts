import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { PreviewPort, PreviewStatus, ToolContext } from './types.js';
import { redact, truncate } from './util.js';

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.ico': 'image/x-icon' };

/** Static output on its own origin; generated code never runs in the application server. */
export class EngineerPreview {
  private server: http.Server | null = null;
  private current: PreviewStatus | null = null;
  private token = randomBytes(24).toString('hex');
  private releases = new Map<string, string>();
  constructor(private readonly projectId: string, private readonly root: string) {}
  bind(context: ToolContext): PreviewPort {
    return {
      start: async () => {
        const previous = this.current;
        const build: PreviewStatus = { projectId: this.projectId, sessionId: this.token, status: 'building', url: null, port: null, logs: [] };
        if (!previous?.url) this.current = build;
        try {
          for (const argv of [['flutter', 'pub', 'get'], ['flutter', 'build', 'web', '--no-pub']]) {
            const result = await context.sandbox.run({ argv, cwd: this.root, timeoutMs: 600000 }, { signal: context.signal });
            build.logs.push(truncate(redact(`${argv.join(' ')}: exit ${result.exitCode}\n${result.stdout}\n${result.stderr}`), 4000));
            build.logs = build.logs.slice(-100);
            if (result.exitCode !== 0 || result.timedOut || result.killed) throw new Error(build.logs.join('\n'));
          }
          return await this.publish();
        } catch (error) {
          build.status = 'failed';
          build.logs.push(error instanceof Error ? error.message : String(error));
          throw error;
        }
      },
      status: () => this.current,
      stop: session => this.stop(session),
      reload: () => ({ ok: this.current?.status === 'running', body: { url: this.current?.url, message: 'Reload the static preview frame to display the latest build.' } }),
    };
  }
  async publish() {
    const buildRoot = path.join(this.root, 'build', 'web');
    await fs.access(path.join(buildRoot, 'index.html'));
    const revision = randomBytes(12).toString('hex');
    const staged = await fs.mkdtemp(path.join(os.tmpdir(), 'flutterforge-preview-'));
    try {
      if (await fs.realpath(buildRoot) !== path.join(await fs.realpath(this.root), 'build', 'web')) throw new Error('Unexpected preview build path.');
      await fs.cp(buildRoot, staged, { recursive: true, verbatimSymlinks: true });
      if (!(await fs.lstat(path.join(staged, 'index.html'))).isFile()) throw new Error('Missing preview entry document.');
    } catch (error) { await fs.rm(staged, { recursive: true, force: true }); throw error; }
    if (!this.server) {
      this.server = http.createServer(async (req, res) => {
        res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'no-store');
        try {
          if (!['GET', 'HEAD'].includes(req.method ?? '')) { res.writeHead(405).end(); return; }
          const url = new URL(req.url ?? '/', 'http://localhost');
          const revisionId = url.pathname.split('/')[2];
          const release = this.releases.get(revisionId);
          const prefix = `/${this.token}/${revisionId}/`;
          if (!release) { res.writeHead(404).end(); return; }
          if (!url.pathname.startsWith(prefix)) { res.writeHead(404).end(); return; }
          const relative = decodeURIComponent(url.pathname.slice(prefix.length)) || 'index.html';
          if (relative.split(/[\\/]/).some(part => part === '..' || part.startsWith('.'))) { res.writeHead(403).end(); return; }
          const file = path.resolve(release, relative);
          const real = await fs.realpath(file);
          const realRoot = await fs.realpath(release);
          if (!real.startsWith(`${realRoot}${path.sep}`)) { res.writeHead(403).end(); return; }
          const stat = await fs.stat(real);
          if (!stat.isFile() || stat.size > 64 * 1024 * 1024) { res.writeHead(404).end(); return; }
          let bytes = await fs.readFile(real);
          if (relative === 'index.html') bytes = Buffer.from(bytes.toString().replace(/<base\s+href=["'][^"']*["']\s*\/?>/i, `<base href="${prefix}">`));
          res.setHeader('Content-Type', MIME[path.extname(real)] ?? 'application/octet-stream');
          res.setHeader('Content-Length', bytes.length); res.writeHead(200); res.end(req.method === 'HEAD' ? undefined : bytes);
        } catch { res.writeHead(404).end(); }
      });
      await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(0, '127.0.0.1', resolve); });
    }
    this.releases.set(revision, staged);
    if (this.releases.size > 2) {
      const oldest = this.releases.entries().next().value!;
      this.releases.delete(oldest[0]);
      await fs.rm(oldest[1], { recursive: true, force: true });
    }
    const address = this.server.address() as import('node:net').AddressInfo;
    this.current = { projectId: this.projectId, sessionId: this.token, status: 'running', port: address.port,
      url: `http://127.0.0.1:${address.port}/${this.token}/${revision}/`, logs: this.current?.logs ?? ['Serving the verified Flutter web build.'] };
    return { sessionId: this.token, status: 'running', url: this.current.url };
  }
  status() { return this.current; }
  stop(sessionId: string) {
    if (sessionId !== this.token) return false;
    this.server?.close(); this.server?.closeAllConnections(); this.server = null;
    for (const directory of this.releases.values()) void fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    this.releases.clear();
    if (this.current) this.current = { ...this.current, status: 'stopped', url: null, port: null };
    return true;
  }
  close() { this.stop(this.token); }
}
