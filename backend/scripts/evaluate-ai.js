import { parseArgs } from 'node:util';
import { fixtureResponse, syntheticTickets } from '../fixtures/synthetic-tickets.js';
import { classify, clefModel, jevModel } from '../src/classifier.js';
import { createWorkersAi } from './workers-ai.js';

function getLiveBinding() {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!/^[0-9a-f]{32}$/i.test(account ?? '') || !token) {
    throw new Error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN for live inference.');
  }
  return createWorkersAi(account, () => token);
}

function summarize(observations) {
  const matches = field => observations.filter(item => (
    item.outcome === 'classified' && item[field] === item.expected[field]
  )).length;
  return {
    calls: observations.length,
    autoRouted: observations.filter(item => item.outcome === 'classified').length,
    expectedDepartment: matches('department'),
    expectedUrgency: matches('urgency'),
    manualReview: observations.filter(item => item.status === 'manual_review').length
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      live: { type: 'boolean' },
      repeats: { type: 'string', default: '3' },
      model: { type: 'string', default: clefModel }
    }
  });
  const { model } = values;
  if (model !== clefModel && model !== jevModel) throw new Error('Use a supported model ID.');
  const repeats = Number(values.repeats);
  if (!Number.isInteger(repeats) || repeats < 2 || repeats > 10) {
    throw new Error('Use --repeats with an integer from 2 to 10.');
  }
  const live = values.live ? getLiveBinding() : null;
  const all = [];
  const perMessage = [];
  for (const sample of syntheticTickets) {
    const binding = live ?? { run: () => fixtureResponse(sample.department, sample.urgency) };
    const observations = [];
    for (let run = 0; run < repeats; run++) {
      observations.push({ ...await classify(binding, sample.message, model), expected: sample });
    }
    all.push(...observations);
    const classifications = observations.map(item => item.suggestion ?? item);
    const decisions = classifications.map(item => item.department && item.urgency
      ? `${item.department}/${item.urgency}` : 'No decision');
    const scores = observations.map(item => item.confidence).filter(Number.isFinite);
    perMessage.push({
      scenario: sample.id, style: sample.style,
      intended: `${sample.department}/${sample.urgency}`,
      observed: [...new Set(decisions)].join(', '),
      outcome: [...new Set(observations.map(item => item.outcome))].join(', '),
      confidenceMin: scores.length ? Math.min(...scores) : null,
      confidenceMax: scores.length ? Math.max(...scores) : null
    });
  }

  console.log(values.live ? 'Live model results for synthetic messages' : 'Offline simulation with scripted responses');
  console.log(`Model configuration: ${model}. Repeated ${repeats} times per message.`);
  console.table(perMessage);
  console.table([...new Set(syntheticTickets.map(item => item.style))].map(style => ({
    style, ...summarize(all.filter(item => item.expected.style === style))
  })));
  if (!values.live) {
    console.log('Offline results verify the evaluation workflow. Use --live to measure provider behavior.');
  } else if (all.every(item => item.confidence === null)) {
    throw new Error('Live evaluation received no valid classifications. Check account access and model configuration.');
  } else {
    console.log('This small set compares writing styles and repeatability. Broader accuracy and fairness require more data.');
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
