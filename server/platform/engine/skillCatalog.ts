export type SkillCategory =
  | 'ui'
  | 'architecture'
  | 'motion'
  | 'platform'
  | 'backend'
  | 'data'
  | 'custom';

export interface FlutterSkill {
  id: string;
  name: string;
  description: string;
  category: SkillCategory;
  rules: string[];
  packages?: string[];
  requiredPackages?: Record<string, string>;
  enabled?: boolean;
  enabledByDefault?: boolean;
}

export const SKILL_DEFINITIONS: FlutterSkill[] = [
  {
    id: 'modern-ui',
    name: 'Modern Flutter UI',
    description: 'Current Material 3 styling, theme tokens, responsive layouts',
    category: 'ui',
    rules: ['Use Material 3', 'Apply ColorScheme tokens', 'Support responsive layouts'],
    enabled: true,
    enabledByDefault: true,
  },
  {
    id: 'clean-architecture',
    name: 'Feature-First Architecture',
    description: 'Clean feature-based structure with separated screens, widgets, and state',
    category: 'architecture',
    rules: ['Organize by features', 'Separate logic from UI', 'Keep screens modular'],
    enabled: true,
    enabledByDefault: true,
  },
  {
    id: 'animations-motion',
    name: 'Motion & Animations',
    description: 'Hero transitions, smooth route navigation, and micro-interactions',
    category: 'motion',
    rules: ['Use Hero animations for detail transitions', 'Smooth implicit animations'],
    enabled: true,
    enabledByDefault: true,
  },
  {
    id: 'desktop-web-parity',
    name: 'Desktop & Web Parity',
    description: 'Adaptive keyboard shortcuts, scrolling behavior, and responsive widths',
    category: 'platform',
    rules: ['Handle desktop input', 'Avoid fixed mobile dimensions', 'Support mouse and hover states'],
    enabled: true,
    enabledByDefault: true,
  },
  {
    id: 'supabase-production',
    name: 'Supabase Backend',
    description: 'PostgreSQL tables, Row-Level Security, auth states, and queries',
    category: 'backend',
    rules: ['Always enable RLS', 'Use parameterized queries', 'Handle unauthenticated states'],
    enabled: false,
    enabledByDefault: false,
  },
  {
    id: 'accessibility',
    name: 'Accessible interactions',
    description: 'Keyboard navigation, descriptive labels, and readable text at larger sizes',
    category: 'ui',
    rules: ['Label interactive controls', 'Preserve keyboard focus order', 'Check layouts with enlarged text'],
    enabledByDefault: false,
  },
  {
    id: 'regression-tests',
    name: 'Behavioral tests',
    description: 'Exercise a requested change through its visible controls and verify the result',
    category: 'architecture',
    rules: ['Add a focused widget test for changed behavior', 'Exercise error and empty states where relevant'],
    enabledByDefault: true,
  },
];
