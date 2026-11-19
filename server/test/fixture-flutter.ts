#!/usr/bin/env -S npx tsx
/**
 * Test double for the Flutter SDK.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);

if (args.includes('--version')) {
  process.stdout.write('Flutter 9.9.9-fixture • fixture\n');
  process.exit(0);
}

if (args[0] === 'create') {
  const target = args[args.length - 1];
  const platformsArg = args.find((arg) => arg.startsWith('--platforms='));
  const platforms = platformsArg ? platformsArg.slice('--platforms='.length).split(',') : ['web'];
  for (const platform of platforms) {
    const dir = path.join(target, platform);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'index.html'),
      '<!DOCTYPE html><html><body><script src="flutter_bootstrap.js"></script></body></html>\n',
      'utf8',
    );
  }
  process.stdout.write(`Created fixture runners: ${platforms.join(', ')}\n`);
  process.exit(0);
}

if (args[0] === 'pub') {
  process.stdout.write('Resolving dependencies (fixture)...\n');
  process.exit(0);
}

if (args[0] === 'build' && args[1] === 'web') {
  const out = path.join(process.cwd(), 'build', 'web');
  await fs.mkdir(path.join(out, 'assets'), { recursive: true });
  await fs.writeFile(
    path.join(out, 'index.html'),
    '<!DOCTYPE html><html><body><h1>PREVIEW_OK</h1></body></html>\n',
    'utf8',
  );
  await fs.writeFile(path.join(out, 'flutter_bootstrap.js'), '// fixture\n', 'utf8');
  process.stdout.write('✓ Built build/web\n');
  process.exit(0);
}

if (args[0] === 'build' && args[1] === 'apk') {
  const out = path.join(process.cwd(), 'build', 'app', 'outputs', 'flutter-apk');
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(out, 'app-release.apk'), 'FIXTURE-APK\n', 'utf8');
  process.stdout.write('✓ Built build/app/outputs/flutter-apk/app-release.apk\n');
  process.exit(0);
}

if (args[0] === 'build' && args[1] === 'appbundle') {
  const out = path.join(process.cwd(), 'build', 'app', 'outputs', 'bundle', 'release');
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(out, 'app-release.aab'), 'FIXTURE-AAB\n', 'utf8');
  process.stdout.write('✓ Built build/app/outputs/bundle/release/app-release.aab\n');
  process.exit(0);
}

if (args[0] === 'build' && args[1] === 'ios') {
  const out = path.join(process.cwd(), 'build', 'ios', 'iphoneos', 'Runner.app');
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(out, 'Info.plist'), '<plist><dict/></plist>\n', 'utf8');
  process.stdout.write('✓ Built build/ios/iphoneos/Runner.app (unsigned fixture)\n');
  process.exit(0);
}

if (args[0] === 'run') {
  const http = await import('node:http');
  const portIndex = args.indexOf('--web-port');
  const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 8080;
  http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!DOCTYPE html><html><body><h1>PREVIEW_OK</h1></body></html>');
  }).listen(port, '127.0.0.1', () => {
    process.stdout.write(`lib/main.dart is being served at http://127.0.0.1:${port}/\n`);
  });
  setInterval(() => {}, 60_000);
} else {
  process.stderr.write(`fixture flutter: unsupported args ${args.join(' ')}\n`);
  process.exit(1);
}
