/**
 * Design & accessibility agents.
 *
 * They protect the two things generated apps most often get wrong: a real,
 * token-driven theme (not scattered hex literals) and controls a screen reader
 * can actually operate.
 */
import type { AgentDefinition, AgentFinding } from './types.js';
import {
  callBlocks,
  capFindings,
  countMatches,
  finding,
  libFiles,
  stripDart,
} from './shared.js';

const THEME_PATH = /(theme|tokens|colors|design_system|palette)/i;
const RAW_COLOR = /\bColor\s*\(\s*0x[0-9a-fA-F]{8}\s*\)/g;
const SMALL_FONT = /fontSize\s*:\s*(\d{1,2}(?:\.\d+)?)/g;

export const designSystemAgent: AgentDefinition = {
  id: 'design-system',
  name: 'Noor',
  title: 'Design System Engineer',
  department: 'design',
  description: 'Verifies a real Material 3 theme, token discipline (no scattered hex literals), dark-mode support and consistent shape/spacing.',
  capabilities: ['theme-tokens', 'material3', 'dark-mode', 'color-discipline'],
  mode: 'deterministic',
  run(context) {
    const findings: AgentFinding[] = [];
    const files = libFiles(context);
    if (files.length === 0) {
      return [finding('DESIGN_NO_SOURCE', 'blocker', 'There is no lib/ source to review.', { suggestion: 'Generate or scaffold the app first.' })];
    }

    const stripped = files.map((file) => ({ path: file.path, code: stripDart(file.content) }));
    const hasTheme = stripped.some((file) => /\bThemeData\s*\(/.test(file.code) || /\bColorScheme\.fromSeed\s*\(/.test(file.code));
    if (!hasTheme) {
      findings.push(finding('DESIGN_NO_THEME', 'blocker', 'No ThemeData/ColorScheme was found — the app is not themed.', {
        suggestion: 'Define a Material 3 theme with ColorScheme.fromSeed and register it on MaterialApp.',
      }));
    }

    const m3 = stripped.some((file) => /useMaterial3\s*:\s*true/.test(file.code));
    const m3Off = stripped.some((file) => /useMaterial3\s*:\s*false/.test(file.code));
    if (m3Off) {
      findings.push(finding('DESIGN_M3_DISABLED', 'major', 'useMaterial3 is explicitly disabled.', {
        suggestion: 'Ship Material 3 unless the product deliberately targets the M2 visual language.',
      }));
    } else if (!m3) {
      findings.push(finding('DESIGN_M3_IMPLICIT', 'minor', 'Material 3 is not explicitly enabled in the theme.', {
        suggestion: 'Set `useMaterial3: true` so the visual language is intentional and stable across Flutter upgrades.',
      }));
    }

    let rawColors = 0;
    let rawColorFile: string | null = null;
    for (const file of stripped) {
      if (THEME_PATH.test(file.path)) continue;
      const count = countMatches(file.code, RAW_COLOR);
      if (count > 0 && !rawColorFile) rawColorFile = file.path;
      rawColors += count;
    }
    if (rawColors > 0) {
      findings.push(finding(
        rawColors > 6 ? 'DESIGN_RAW_COLORS' : 'DESIGN_RAW_COLOR',
        rawColors > 6 ? 'major' : 'minor',
        `${rawColors} raw Color(0x…) literal(s) live outside the theme layer.`,
        {
          file: rawColorFile ?? undefined,
          suggestion: 'Move every color into ColorScheme/ThemeExtension and reference it via Theme.of(context).',
        },
      ));
    }

    const hasDark = stripped.some((file) => /\b(darkTheme|ThemeMode\.dark|brightness\s*:\s*Brightness\.dark)\b/.test(file.code));
    if (!hasDark) {
      findings.push(finding('DESIGN_NO_DARK_MODE', 'minor', 'No dark theme or ThemeMode handling was found.', {
        suggestion: 'Add a dark ColorScheme and expose a theme toggle if the product supports it.',
      }));
    }

    const hasShape = stripped.some((file) => /\b(BorderRadius|RoundedRectangleBorder|CardTheme|shape\s*:)/.test(file.code));
    if (!hasShape) {
      findings.push(finding('DESIGN_NO_SHAPE_SCALE', 'minor', 'No shared shape/radius treatment was found.', {
        suggestion: 'Define card/button radii in the theme so components stay visually consistent.',
      }));
    }

    const hasTypography = stripped.some((file) => /\b(TextTheme|fontFamily|Typography)\b/.test(file.code));
    if (!hasTypography) {
      findings.push(finding('DESIGN_NO_TYPOGRAPHY', 'info', 'No typography scale is declared.', {
        suggestion: 'Define a TextTheme (or a font family) instead of relying on defaults.',
      }));
    }

    return capFindings(findings);
  },
};

export const accessibilityAgent: AgentDefinition = {
  id: 'accessibility',
  name: 'Tess',
  title: 'Accessibility Auditor',
  department: 'design',
  description: 'Audits labels, tooltips, semantics, image descriptions and readable type sizes against WCAG-oriented expectations for Flutter.',
  capabilities: ['semantics', 'labels', 'contrast-inputs', 'text-scaling'],
  mode: 'deterministic',
  run(context) {
    const findings: AgentFinding[] = [];
    const files = libFiles(context);
    if (files.length === 0) return findings;

    let iconButtons = 0;
    let unlabeledIconButtons = 0;
    let textFields = 0;
    let unlabeledFields = 0;
    let images = 0;
    let undescribedImages = 0;
    let smallFonts = 0;
    let smallFontFile: string | null = null;
    let hasSemantics = false;
    let gestureDetectors = 0;

    for (const file of files) {
      const code = stripDart(file.content);
      if (/\bSemantics\s*\(/.test(code)) hasSemantics = true;
      gestureDetectors += countMatches(code, /\bGestureDetector\s*\(/);

      const iconBlocks = callBlocks(code, 'IconButton');
      iconButtons += iconBlocks.length;
      for (const block of iconBlocks) {
        if (!/\btooltip\s*:/.test(block.body)) unlabeledIconButtons += 1;
      }

      const fieldBlocks = [...callBlocks(code, 'TextField'), ...callBlocks(code, 'TextFormField')];
      textFields += fieldBlocks.length;
      for (const block of fieldBlocks) {
        if (!/\b(labelText|label|hintText|semanticLabel|helperText)\s*:/.test(block.body)) unlabeledFields += 1;
      }

      const imageBlocks = [...callBlocks(code, 'Image.asset'), ...callBlocks(code, 'Image.network')];
      images += imageBlocks.length;
      for (const block of imageBlocks) {
        if (!/\b(semanticLabel|excludeFromSemantics)\s*:/.test(block.body)) undescribedImages += 1;
      }

      const fontMatches = [...code.matchAll(SMALL_FONT)];
      for (const match of fontMatches) {
        const size = Number(match[1]);
        if (Number.isFinite(size) && size < 12) {
          smallFonts += 1;
          smallFontFile ??= file.path;
        }
      }
    }

    if (unlabeledIconButtons > 0) {
      findings.push(finding('A11Y_ICON_TOOLTIP', 'major', `${unlabeledIconButtons} of ${iconButtons} IconButton(s) have no tooltip or semantic label.`, {
        suggestion: 'Add `tooltip:` (or wrap in Semantics(label: …)) so the control is announceable.',
      }));
    }
    if (unlabeledFields > 0) {
      findings.push(finding('A11Y_FIELD_LABEL', 'major', `${unlabeledFields} of ${textFields} text field(s) have no label/hint.`, {
        suggestion: 'Every field needs a visible or semantic label — placeholder-only inputs fail accessibility.',
      }));
    }
    if (undescribedImages > 0) {
      findings.push(finding('A11Y_IMAGE_LABEL', 'minor', `${undescribedImages} of ${images} image(s) have no semanticLabel.`, {
        suggestion: 'Describe meaningful images; mark decorative ones with excludeFromSemantics.',
      }));
    }
    if (smallFonts > 0) {
      findings.push(finding('A11Y_SMALL_TEXT', 'minor', `${smallFonts} text style(s) set fontSize below 12.`, {
        file: smallFontFile ?? undefined,
        suggestion: 'Use the TextTheme scale; body copy below 12sp is unreadable at default text scale.',
      }));
    }
    if (gestureDetectors > 0 && !hasSemantics) {
      findings.push(finding('A11Y_GESTURE_NO_SEMANTICS', 'minor', `${gestureDetectors} GestureDetector(s) exist but the project never uses Semantics.`, {
        suggestion: 'Prefer InkWell/IconButton, or wrap custom gestures in Semantics(button: true, label: …).',
      }));
    }

    return capFindings(findings);
  },
};
