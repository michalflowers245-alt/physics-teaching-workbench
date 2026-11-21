import test from 'node:test';
import assert from 'node:assert/strict';
import Domain from '../exam-engine/exam-domain.js';

test('已收录但未审的题目不再显示未收录，找题与正式结论区分', () => {
  const report = { knowledge: [], abilities: [], actualErrors: [], expectedErrors: [], recommendedTopics: [], quality: { questions: 900 } };
  const answers = Domain.buildFourAnswers(report);
  assert.match(answers[2].answer, /题目已收录/);
  assert.match(answers[2].answer, /不足以判断真实易错/);
  assert.match(answers[3].answer, /题单草稿/);
  assert.doesNotMatch(answers[3].answer, /先导入/);
  report.quality.questions = 0;
  assert.match(Domain.buildFourAnswers(report)[3].answer, /先导入/);
});
