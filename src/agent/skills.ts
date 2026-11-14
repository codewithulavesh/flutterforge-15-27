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
];

export class SkillRegistry {
  private static activeSkillIds: Set<string> = new Set(
    SKILL_DEFINITIONS.filter((s) => s.enabledByDefault).map((s) => s.id)
  );

  public static getAllSkills(): FlutterSkill[] {
    return SKILL_DEFINITIONS.map((s) => ({
      ...s,
      enabled: this.activeSkillIds.has(s.id),
    }));
  }

  public static getActiveSkills(): FlutterSkill[] {
    return this.getAllSkills().filter((s) => s.enabled);
  }

  public static isSkillActive(id: string): boolean {
    return this.activeSkillIds.has(id);
  }

  public static setSkillActive(id: string, active: boolean): void {
    if (active) {
      this.activeSkillIds.add(id);
    } else {
      this.activeSkillIds.delete(id);
    }
  }

  public static setSkillEnabled(id: string, enabled: boolean): void {
    this.setSkillActive(id, enabled);
  }

  public static toggleSkill(id: string): boolean {
    if (this.activeSkillIds.has(id)) {
      this.activeSkillIds.delete(id);
      return false;
    }
    this.activeSkillIds.add(id);
    return true;
  }

  public static formatPromptInjection(skills: FlutterSkill[]): string {
    return skills.map((s) => `### ${s.name}\n${s.rules.join('\n')}`).join('\n\n');
  }
}
