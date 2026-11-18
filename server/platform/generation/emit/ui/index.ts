/**
 * UI layer assembly. One page file per spec screen, plus the shared
 * presentational component library. Screen ids are unique in a validated spec;
 * a map still guards the file set if an unvalidated IR slips through.
 */
import type { EmitContext, GeneratedFile, ScreenSpec } from '../../contracts.js';
import { emitComponents } from './components.js';
import { emitFormPage } from './forms.js';
import {
  emitChat,
  emitDashboard,
  emitDetail,
  emitList,
  emitOnboarding,
  emitProfile,
  emitSettings,
} from './screens.js';

function emitPage(ctx: EmitContext, screen: ScreenSpec): GeneratedFile {
  switch (screen.kind) {
    case 'dashboard':
      return emitDashboard(ctx, screen);
    case 'list':
      return emitList(ctx, screen);
    case 'detail':
      return emitDetail(ctx, screen);
    case 'form':
      return emitFormPage(ctx, screen);
    case 'chat':
      return emitChat(ctx, screen);
    case 'profile':
      return emitProfile(ctx, screen);
    case 'settings':
      return emitSettings(ctx, screen);
    case 'onboarding':
      return emitOnboarding(ctx, screen);
    default: {
      const unknown: never = screen.kind;
      throw new Error(`unknown screen kind: ${String(unknown)}`);
    }
  }
}

export function emitUiLayer(ctx: EmitContext): GeneratedFile[] {
  const files = new Map<string, GeneratedFile>();
  for (const component of emitComponents()) files.set(component.path, component);
  for (const screen of ctx.spec.screens ?? []) {
    const page = emitPage(ctx, screen);
    files.set(page.path, page);
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}
