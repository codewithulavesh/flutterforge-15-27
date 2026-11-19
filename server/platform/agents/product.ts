/**
 * Product & UX agents.
 *
 * They answer two questions: “does the app actually deliver the brief?” and
 * “can a user move through it without dead ends or blank states?”
 */
import type { AgentDefinition, AgentFinding, ReviewContext } from './types.js';
import {
  capFindings,
  dartFiles,
  finding,
  libFiles,
  parsePubspec,
  stripDart,
  truncate,
} from './shared.js';

const STOPWORDS = new Set([
  'a', 'an', 'and', 'app', 'application', 'build', 'create', 'design', 'for', 'from',
  'help', 'in', 'into', 'is', 'it', 'make', 'me', 'my', 'of', 'on', 'or', 'our',
  'please', 'should', 'some', 'that', 'the', 'their', 'them', 'this', 'to', 'track',
  'tracker', 'use', 'user', 'users', 'want', 'with', 'would', 'you', 'your',
]);

function promptKeywords(prompt: string | undefined): string[] {
  if (!prompt) return [];
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !STOPWORDS.has(word));
  return [...new Set(words)];
}

/** Feature screens, across the naming conventions real Flutter projects use. */
function pageFiles(context: ReviewContext) {
  return libFiles(context).filter(
    (file) => file.path.includes('/features/') && /(?:_page|_screen|_view)\.dart$/.test(file.path),
  );
}

function pageClassName(content: string): string | null {
  const match = /class\s+([A-Za-z_][A-Za-z0-9_]*)\s+extends\s+(?:StatefulWidget|StatelessWidget|ConsumerWidget|ConsumerStatefulWidget)/.exec(content);
  return match ? match[1] : null;
}

export const productOwnerAgent: AgentDefinition = {
  id: 'product-owner',
  name: 'Mara',
  title: 'Product Owner',
  department: 'product',
  description: 'Checks that the shipped app answers the original brief: screens exist, requirements are covered, and nothing important was silently dropped.',
  capabilities: ['requirements-coverage', 'scope-audit', 'acceptance-criteria'],
  mode: 'deterministic',
  run(context) {
    const findings: AgentFinding[] = [];
    const pages = pageFiles(context);
    if (pages.length === 0) {
      findings.push(finding('PRODUCT_NO_SCREENS', 'blocker', 'No feature screens were emitted (lib/features/**/*_page.dart, *_screen.dart).', {
        suggestion: 'Run the generation pipeline or scaffold a starter before shipping.',
      }));
      return findings;
    }

    const keywords = promptKeywords(context.prompt);
    if (keywords.length >= 3) {
      const corpus = context.files
        .map((file) => `${file.path}\n${stripDart(file.content)}`)
        .join('\n')
        .toLowerCase();
      const missing = keywords.filter((word) => !corpus.includes(word));
      const coverage = (keywords.length - missing.length) / keywords.length;
      if (coverage < 0.5) {
        findings.push(finding('PRODUCT_BRIEF_COVERAGE_LOW', 'major', `Only ${Math.round(coverage * 100)}% of the brief's distinctive terms appear in the project.`, {
          evidence: truncate(`missing: ${missing.slice(0, 8).join(', ')}`),
          suggestion: 'Confirm the missing concepts are intentionally out of scope, or add screens/fields for them.',
        }));
      } else if (coverage < 0.75) {
        findings.push(finding('PRODUCT_BRIEF_COVERAGE_PARTIAL', 'minor', `${Math.round(coverage * 100)}% of the brief's distinctive terms appear in the project.`, {
          evidence: truncate(`missing: ${missing.slice(0, 8).join(', ')}`),
        }));
      }
    }

    const withoutScaffold = pages.filter((file) => !/\bScaffold\s*\(/.test(stripDart(file.content)));
    for (const file of withoutScaffold.slice(0, 4)) {
      findings.push(finding('PRODUCT_SCREEN_NO_SCAFFOLD', 'minor', 'Screen has no Scaffold, so it cannot own app bars, snackbars or safe-area handling.', {
        file: file.path,
        suggestion: 'Wrap the page body in a Scaffold (or document the deliberate exception).',
      }));
    }

    const prompt = (context.prompt ?? '').toLowerCase();
    const wantsAuth = /\b(login|sign\s*in|sign\s*up|auth|account|password)\b/.test(prompt);
    const hasAuth = dartFiles(context).some((file) => /(auth|login|signin|signup|account)/i.test(file.path) || /Supabase\.auth|signInWith/i.test(file.content));
    if (wantsAuth && !hasAuth) {
      findings.push(finding('PRODUCT_AUTH_MISSING', 'major', 'The brief asks for accounts/authentication, but no auth surface was found.', {
        suggestion: 'Add a sign-in/account flow or explicitly descope it with the user.',
      }));
    }

    const pubspec = parsePubspec(context.pubspec);
    if (!pubspec.description) {
      findings.push(finding('PRODUCT_NO_DESCRIPTION', 'minor', 'pubspec.yaml has no description, so the project has no one-line product statement.', {
        file: 'pubspec.yaml',
        suggestion: 'Add a one-sentence `description:` that matches the brief.',
      }));
    }

    return capFindings(findings);
  },
};

export const uxArchitectAgent: AgentDefinition = {
  id: 'ux-architect',
  name: 'Iris',
  title: 'UX Architect',
  department: 'product',
  description: 'Traces navigation reachability and verifies that every data screen handles loading, empty and error states.',
  capabilities: ['navigation-graph', 'state-coverage', 'dead-end-detection'],
  mode: 'deterministic',
  run(context) {
    const findings: AgentFinding[] = [];
    const pages = pageFiles(context);
    if (pages.length === 0) {
      return [finding('UX_NO_PAGES', 'blocker', 'There are no feature pages to navigate to.', { suggestion: 'Emit at least a dashboard and one data screen.' })];
    }

    for (const page of pages) {
      const className = pageClassName(page.content);
      if (!className) continue;
      const otherCorpus = context.files
        .filter((file) => file.path !== page.path && file.path.endsWith('.dart'))
        .map((file) => stripDart(file.content))
        .join('\n');
      if (!otherCorpus.includes(className)) {
        findings.push(finding('UX_UNREACHABLE_SCREEN', 'major', `${className} is never referenced by the router, shell or another screen.`, {
          file: page.path,
          suggestion: 'Register a route (GoRoute/onGenerateRoute) or remove the screen.',
        }));
      }
    }

    const dataPages = pages.filter((file) => /(list|detail|form|dashboard|home)_page\.dart$/.test(file.path));
    const projectCorpus = libFiles(context).map((file) => stripDart(file.content)).join('\n');
    const hasLoading = /\b(loading|isLoading|CircularProgressIndicator|AsyncView)\b/i.test(projectCorpus);
    const hasError = /\b(error|hasError|onError|catch\s*\()\b/i.test(projectCorpus);
    const hasEmpty = /\b(empty|EmptyState|no\s+items|nothing\s+here)\b/i.test(projectCorpus);
    if (dataPages.length > 0 && !(hasLoading && hasError && hasEmpty)) {
      const missing = [
        hasLoading ? null : 'loading',
        hasError ? null : 'error',
        hasEmpty ? null : 'empty',
      ].filter(Boolean) as string[];
      findings.push(finding('UX_STATE_COVERAGE_GAP', 'major', `The app has data screens but no project-wide ${missing.join('/')} state.`, {
        suggestion: 'Render an explicit state for every data surface: loading, error-with-retry, and empty.',
      }));
    }

    const appBars = pages.filter((file) => !/\bAppBar\s*\(/.test(stripDart(file.content)));
    for (const file of appBars.slice(0, 3)) {
      findings.push(finding('UX_NO_APP_BAR', 'minor', 'Screen has no AppBar, which weakens orientation and back navigation.', {
        file: file.path,
        suggestion: 'Give the screen a title (or a SliverAppBar in a CustomScrollView).',
      }));
    }

    const shell = libFiles(context).find((file) => /(router|navigation|shell|nav)/i.test(file.path));
    if (!shell) {
      findings.push(finding('UX_NO_NAVIGATION_LAYER', 'minor', 'No router or navigation shell file was found.', {
        suggestion: 'Centralize routes so screens stay reachable as the app grows.',
      }));
    }

    return capFindings(findings);
  },
};
