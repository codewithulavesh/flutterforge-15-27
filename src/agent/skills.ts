import { SKILL_DEFINITIONS, type FlutterSkill } from '../../server/platform/engine/skillCatalog';
export { SKILL_DEFINITIONS, type FlutterSkill, type SkillCategory } from '../../server/platform/engine/skillCatalog';

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
