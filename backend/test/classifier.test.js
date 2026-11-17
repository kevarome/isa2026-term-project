import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureResponse, syntheticTickets } from '../fixtures/synthetic-tickets.js';
import { classify, clefModel, jevModel } from '../src/classifier.js';

test('routes the four representative responses using Clef Flash and only the support message', async () => {
  for (const sample of syntheticTickets.filter(item => item.style === 'plain')) {
    const ai = {
      run(modelId, { model, state, questions }) {
        assert.equal(modelId, clefModel);
        assert.equal(model, 'clef-flash');
        assert.deepEqual(state, { support_message: sample.message });
        assert.deepEqual(Object.keys(questions.department.criteria).sort(), ['account', 'billing', 'general', 'technical']);
        assert.deepEqual(Object.keys(questions.urgency.criteria).sort(), ['high', 'low', 'medium']);
        return fixtureResponse(sample.department, sample.urgency);
      }
    };
    const result = await classify(ai, sample.message);
    assert.equal(result.department, sample.department);
    assert.equal(result.urgency, sample.urgency);
    assert.equal(result.confidence, 0.94);
    assert.equal(result.status, 'open');
    assert.equal(result.outcome, 'classified');
  }
});

test('can select Jev with its original request shape', async () => {
  const result = await classify({
    run(model, input) {
      assert.equal(model, jevModel);
      assert.equal(Object.hasOwn(input, 'model'), false);
      return fixtureResponse('billing', 'medium');
    }
  }, 'The same plan charge appears twice on my bill.', jevModel);
  assert.equal(result.department, 'billing');
  assert.equal(result.outcome, 'classified');
});

function assertReview(result, outcome) {
  assert.equal(result.outcome, outcome);
  assert.equal(result.status, 'manual_review');
  assert.equal(result.department, null);
  assert.equal(result.urgency, null);
}

test('holds low-confidence suggestions for staff and rejects invalid responses', async () => {
  const message = 'My service has been acting strangely and I need help.';
  const lowConfidence = fixtureResponse('technical', 'medium');
  lowConfidence.answers.urgency.confidence = 0.54;
  const review = await classify({ run: () => lowConfidence }, message);
  assertReview(review, 'low_confidence');
  assert.equal(review.confidence, 0.54);
  assert.deepEqual(review.suggestion, { department: 'technical', urgency: 'medium' });

  for (const malformed of [
    {},
    fixtureResponse('unknown', 'medium'),
    fixtureResponse('constructor', 'high'),
    fixtureResponse(['technical'], 'medium'),
    fixtureResponse('technical', 'critical'),
    fixtureResponse('billing', 'medium', 1.1),
    fixtureResponse('account', 'medium', '0.9')
  ]) {
    assertReview(await classify({ run: () => malformed }, message), 'invalid_output');
  }
});

test('queues offline, failed and timed-out requests for manual review', async t => {
  const message = 'My internet is unavailable today.';
  assertReview(await classify(undefined, message), 'unavailable');
  assertReview(await classify({ run: () => Promise.reject(new Error('quota exceeded')) }, message), 'provider_error');

  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = classify({ run: () => new Promise(() => {}) }, message);
  t.mock.timers.tick(12000);
  assertReview(await pending, 'timeout');
});
