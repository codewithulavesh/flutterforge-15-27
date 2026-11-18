import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchPrompt, recipeStarter, RECIPES } from '../../platform/generation/recipes/index.js';
import { validateDartFiles } from '../../platform/dart/validate.js';
import { verifyProjectContract } from '../../platform/qa/contract.js';
import { analyzeVisualQa } from '../../platform/qa/visualQa.js';

test('matchPrompt returns the intended recipe for common phrases', () => {
  assert.equal(matchPrompt('build me a todo app')?.id, 'todo');
  assert.equal(matchPrompt('counter app')?.id, 'counter');
  assert.equal(matchPrompt('a flashcard study tool')?.id, 'flashcards');
  assert.equal(matchPrompt('flashcard deck')?.id, 'flashcards');
});

test('no recipe matches gibberish and returns null', () => {
  assert.equal(matchPrompt('asdfasdf zxcvxcv qqqq'), null);
});

for (const recipe of RECIPES) {
  test(`recipe '${recipe.id}' produces a valid Flutter project`, () => {
    const packageName = ({ todo: 'todo_app', counter: 'counter_app', flashcards: 'flashcard_app' } as Record<string, string>)[recipe.id];
    const files = recipeStarter(recipe, recipe.displayName, packageName);
    const paths = files.map((f) => f.path).sort();
    for (const required of ['pubspec.yaml', 'lib/main.dart', 'lib/app/app.dart', 'lib/app/theme.dart']) {
      assert.ok(paths.includes(required), `missing ${required}`);
    }

    const validator = validateDartFiles({ files, packageName });
    assert.equal(validator.passed, true, validator.diagnostics.map((d) => `${d.path}: ${d.code} ${d.message}`).join('\n'));

    const contract = verifyProjectContract({ files, packageName, expectations: { requiredDependencies: ['flutter', 'go_router', 'provider'] } });
    assert.equal(contract.passed, true, contract.blockers.map((b) => b.message).join('\n'));

    const qa = analyzeVisualQa(files);
    assert.equal(qa.passed, true, qa.diagnostics.map((d) => `${d.code}: ${d.message}`).join('\n'));
  });
}
