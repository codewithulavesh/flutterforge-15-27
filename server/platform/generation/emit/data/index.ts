/**
 * Data layer assembly.
 *
 * Owns `lib/data`, `lib/state/<entity>_controller.dart` and `test/data`:
 * one model, seed, repository, controller and two Dart tests per entity.
 * Everything is pure and deterministic; the UI and app layers compile against
 * this exact surface.
 */
import type { EmitContext, EntitySpec, GeneratedFile } from '../../contracts.js';
import { modelFile, sortFiles } from '../shared.js';
import { emitController, emitControllerTest } from './controllers.js';
import { emitModel, emitModelTest } from './models.js';
import { emitRepository } from './repositories.js';
import { emitSeed } from './seed.js';

function uniqueEntities(entities: EntitySpec[]): EntitySpec[] {
  const seen = new Set<string>();
  const unique: EntitySpec[] = [];
  for (const entity of entities ?? []) {
    const key = modelFile(entity);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entity);
  }
  return unique;
}

/** Emit the complete data/state layer for a spec. */
export function emitDataLayer(ctx: EmitContext): GeneratedFile[] {
  const spec = ctx.spec;
  const files: GeneratedFile[] = [];
  for (const entity of uniqueEntities(spec.entities ?? [])) {
    files.push(
      emitModel(entity),
      emitSeed(spec, entity),
      emitRepository(entity),
      emitController(entity),
      emitModelTest(spec, entity),
      emitControllerTest(spec, entity),
    );
  }
  return sortFiles(files);
}
