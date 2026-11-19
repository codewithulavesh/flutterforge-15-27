/**
 * Delivery agents — code review, documentation, release readiness and CI.
 *
 * Shipping is a separate discipline from writing code. These agents review the
 * repository the way a release manager would: what will surprise the next
 * engineer, what is missing from the handoff, and what will fail the store.
 */
import type { AgentDefinition, AgentFinding } from './types.js';
import {
  capFindings,
  countMatches,
  finding,
  libFiles,
  parsePubspec,
  stripDart,
} from './shared.js';

export const codeReviewerAgent: AgentDefinition = {
  id: 'code-reviewer',
  name: 'Elena',
  title: 'Staff Code Reviewer',
  department: 'delivery',
  description: 'Reviews the tree for unfinished work, duplicate implementations, dead code and debug leftovers before a human ever sees it.',
  capabilities: ['review-hygiene', 'duplication', 'dead-code', 'debug-leftovers'],
  mode: 'deterministic',
  run(context) {
    const findings: AgentFinding[] = [];
    const files = libFiles(context);
    if (files.length === 0) return findings;

    let markers = 0;
    let markerFile: string | null = null;
    let commentedCode = 0;
    let debugPrints = 0;
    for (const file of files) {
      const code = stripDart(file.content);
      const todo = countMatches(file.content, /\b(TODO|FIXME|HACK|XXX)\b/g);
      if (todo > 0 && !markerFile) markerFile = file.path;
      markers += todo;
      commentedCode += countMatches(file.content, /^\s*\/\/\s*(?:final|var|const|if|for|return|await|\}|\);)/gm);
      debugPrints += countMatches(code, /\bdebugPrint\s*\(/g);
    }
    if (markers > 0) {
      findings.push(finding('REVIEW_UNFINISHED', 'minor', `${markers} TODO/FIXME/HACK marker(s) are still in shipped code.`, {
        file: markerFile ?? undefined,
        suggestion: 'Resolve them, or convert them to tracked issues outside the source.',
      }));
    }
    if (commentedCode > 5) {
      findings.push(finding('REVIEW_COMMENTED_CODE', 'minor', `${commentedCode} lines of commented-out code.`, {
        suggestion: 'Delete dead code — version control already remembers it.',
      }));
    }
    if (debugPrints > 0) {
      findings.push(finding('REVIEW_DEBUG_PRINT', 'minor', `${debugPrints} debugPrint() call(s) remain in lib/.`, {
        suggestion: 'Route diagnostics through the logger and strip debug output from release builds.',
      }));
    }

    const duplicates = new Map<string, string[]>();
    for (const file of files) {
      const normalized = file.content.replace(/\s+/g, ' ').trim();
      if (normalized.length < 400) continue;
      const existing = duplicates.get(normalized);
      if (existing) existing.push(file.path);
      else duplicates.set(normalized, [file.path]);
    }
    for (const paths of duplicates.values()) {
      if (paths.length < 2) continue;
      findings.push(finding('REVIEW_DUPLICATE_FILE', 'major', 'Two files have byte-identical content, so fixes must be applied twice.', {
        file: paths[1],
        evidence: `${paths[0]} ≡ ${paths[1]}`,
        suggestion: 'Extract the shared implementation into one module.',
      }));
      break;
    }

    if (files.some((file) => countMatches(file.content, /\/\/\s*ignore_for_file\s*:/g) > 0)) {
      findings.push(finding('REVIEW_FILE_LINT_SUPPRESSION', 'minor', 'A file disables lints wholesale with ignore_for_file.', {
        suggestion: 'Narrow the suppression to the lines that need it.',
      }));
    }

    return capFindings(findings);
  },
};

export const docsWriterAgent: AgentDefinition = {
  id: 'docs-writer',
  name: 'Milo',
  title: 'Documentation Engineer',
  department: 'delivery',
  description: 'Checks that a new engineer can run, understand and ship the project from the repository alone.',
  capabilities: ['readme', 'runbook', 'handoff'],
  mode: 'deterministic',
  run(context) {
    const findings: AgentFinding[] = [];
    const readme = context.files.find((file) => /^readme(\.md)?$/i.test(file.path));
    if (!readme) {
      findings.push(finding('DOCS_NO_README', 'major', 'README.md is missing.', {
        file: 'README.md',
        suggestion: 'Document what the app is, how to run it, and how to verify a change.',
      }));
    } else {
      const text = readme.content.trim();
      if (text.length < 200) {
        findings.push(finding('DOCS_README_THIN', 'minor', 'README is too short to onboard anyone.', {
          file: readme.path,
          suggestion: 'Add purpose, prerequisites, run/test/build commands and project layout.',
        }));
      }
      if (!/\bflutter\s+(run|build|test|pub\s+get)\b/.test(text)) {
        findings.push(finding('DOCS_NO_RUN_INSTRUCTIONS', 'minor', 'README has no flutter run/build/test instructions.', {
          file: readme.path,
        }));
      }
    }

    if (!context.files.some((file) => /^licen[cs]e/i.test(file.path))) {
      findings.push(finding('DOCS_NO_LICENSE', 'info', 'No LICENSE file was found.', {
        file: 'LICENSE',
        suggestion: 'Enterprise and store distribution both require explicit licensing.',
      }));
    }
    if (!context.files.some((file) => /^changelog/i.test(file.path))) {
      findings.push(finding('DOCS_NO_CHANGELOG', 'info', 'No CHANGELOG was found.', {
        file: 'CHANGELOG.md',
        suggestion: 'Record released versions so support can map reports to builds.',
      }));
    }
    if (!context.files.some((file) => /^docs\//.test(file.path))) {
      findings.push(finding('DOCS_NO_ARCHITECTURE_NOTE', 'info', 'No docs/ directory exists.', {
        suggestion: 'Add a short architecture note: layers, state, data flow and deployment.',
      }));
    }

    return capFindings(findings);
  },
};

export const releaseEngineerAgent: AgentDefinition = {
  id: 'release-engineer',
  name: 'Dario',
  title: 'Release Engineer',
  department: 'delivery',
  description: 'Checks versioning, platform manifests and signing state so a build can actually reach a store.',
  capabilities: ['versioning', 'signing', 'platform-manifests', 'store-readiness'],
  mode: 'deterministic',
  run(context) {
    const findings: AgentFinding[] = [];
    const pubspec = parsePubspec(context.pubspec);
    if (!context.pubspec) {
      return [finding('REL_NO_PUBSPEC', 'blocker', 'Cannot assess release readiness without pubspec.yaml.', { file: 'pubspec.yaml' })];
    }

    if (!pubspec.version) {
      findings.push(finding('REL_NO_VERSION', 'major', 'pubspec.yaml has no version.', {
        file: 'pubspec.yaml',
        suggestion: 'Use semantic versioning, e.g. 1.0.0+1.',
      }));
    } else if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(pubspec.version)) {
      findings.push(finding('REL_BAD_VERSION', 'minor', `Version "${pubspec.version}" is not semver.`, { file: 'pubspec.yaml' }));
    }

    const hasAndroid = context.files.some((file) => /^android\//.test(file.path));
    const hasIos = context.files.some((file) => /^ios\//.test(file.path));
    const hasWeb = context.files.some((file) => /^web\//.test(file.path));

    if (hasAndroid) {
      const gradle = context.files.find((file) => /^android\/app\/(?:build\.gradle|build\.gradle\.kts)$/.test(file.path));
      if (gradle && /release\s*\{[\s\S]{0,500}?signingConfig\s+signingConfigs\.debug/.test(gradle.content)) {
        findings.push(finding('REL_ANDROID_DEBUG_SIGNING', 'major', 'The release build is signed with the debug keystore.', {
          file: gradle.path,
          suggestion: 'Configure a release keystore from the vault/CI secrets before shipping.',
        }));
      }
      if (gradle && !/applicationId\s+["']/.test(gradle.content)) {
        findings.push(finding('REL_ANDROID_NO_APPID', 'major', 'Android applicationId is not set.', { file: gradle.path }));
      }
    }

    if (hasIos) {
      const plist = context.files.find((file) => /^ios\/Runner\/Info\.plist$/.test(file.path));
      if (plist) {
        if (!/CFBundleShortVersionString/.test(plist.content)) {
          findings.push(finding('REL_IOS_NO_VERSION', 'major', 'Info.plist has no CFBundleShortVersionString.', { file: plist.path }));
        }
        if (!/CFBundleVersion/.test(plist.content)) {
          findings.push(finding('REL_IOS_NO_BUILD', 'major', 'Info.plist has no CFBundleVersion.', { file: plist.path }));
        }
      }
    }

    if (hasWeb && !context.files.some((file) => file.path === 'web/index.html')) {
      findings.push(finding('REL_WEB_NO_INDEX', 'minor', 'web/ exists but web/index.html is missing.', { file: 'web/index.html' }));
    }

    if (!hasAndroid && !hasIos && !hasWeb) {
      findings.push(finding('REL_NO_TARGET', 'info', 'No platform runner folders are present yet.', {
        suggestion: 'Run `flutter create . --platforms web,android,ios` before the first release.',
      }));
    }

    return capFindings(findings);
  },
};

export const devopsEngineerAgent: AgentDefinition = {
  id: 'devops-engineer',
  name: 'Nadia',
  title: 'DevOps & CI Engineer',
  department: 'delivery',
  description: 'Audits reproducibility and automation: lockfile, gitignore, CI pipeline, container build and environment contract.',
  capabilities: ['ci', 'reproducibility', 'gitignore', 'containers'],
  mode: 'deterministic',
  run(context) {
    const findings: AgentFinding[] = [];

    const gitignore = context.files.find((file) => file.path === '.gitignore');
    if (!gitignore) {
      findings.push(finding('DEVOPS_NO_GITIGNORE', 'major', '.gitignore is missing — build output and local state will be committed.', {
        file: '.gitignore',
        suggestion: 'Ignore .dart_tool/, build/, ephemeral/ and local .env files.',
      }));
    } else {
      const missing = ['.dart_tool', 'build/'].filter((entry) => !gitignore.content.includes(entry));
      if (missing.length > 0) {
        findings.push(finding('DEVOPS_GITIGNORE_GAPS', 'minor', `.gitignore does not exclude ${missing.join(', ')}.`, {
          file: '.gitignore',
        }));
      }
    }

    if (!context.files.some((file) => file.path === 'pubspec.lock')) {
      findings.push(finding('DEVOPS_NO_LOCKFILE', 'major', 'pubspec.lock is not committed — dependency resolution is not reproducible.', {
        file: 'pubspec.lock',
        suggestion: 'Commit the lockfile for applications and use `flutter pub get --enforce-lockfile` in CI.',
      }));
    }

    const workflows = context.files.filter((file) => /^\.github\/workflows\/.+\.ya?ml$/.test(file.path));
    if (workflows.length === 0) {
      findings.push(finding('DEVOPS_NO_CI', 'major', 'No GitHub Actions workflow exists — nothing verifies a change automatically.', {
        file: '.github/workflows/ci.yml',
        suggestion: 'Add a CI job that runs `flutter analyze`, `flutter test` and a build.',
      }));
    } else {
      const corpus = workflows.map((file) => file.content).join('\n');
      if (!/\bflutter\s+(test|analyze|build)\b/.test(corpus)) {
        findings.push(finding('DEVOPS_CI_NO_FLUTTER', 'minor', 'CI workflows never run flutter test/analyze/build.', {
          file: workflows[0].path,
        }));
      }
    }

    if (!context.files.some((file) => file.path === 'analysis_options.yaml')) {
      findings.push(finding('DEVOPS_NO_ANALYSIS_OPTIONS', 'minor', 'No analysis_options.yaml — lint rules are whatever the SDK defaults happen to be.', {
        file: 'analysis_options.yaml',
        suggestion: 'Enable flutter_lints (or a stricter rule set) and fail CI on analyzer findings.',
      }));
    }

    if (!context.files.some((file) => /^Dockerfile$/i.test(file.path))) {
      findings.push(finding('DEVOPS_NO_DOCKERFILE', 'info', 'No Dockerfile — server/agent deployment is not containerized.', {
        file: 'Dockerfile',
      }));
    }

    if (!context.files.some((file) => /^\.env\.example$/.test(file.path))) {
      findings.push(finding('DEVOPS_NO_ENV_CONTRACT', 'info', 'No .env.example — required configuration is undocumented.', {
        file: '.env.example',
      }));
    }

    return capFindings(findings);
  },
};
