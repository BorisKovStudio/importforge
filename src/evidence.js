import { baseline, checkConfig, parseFixture, apply, evaluate } from './harness.js';

// Historical runs did not store a before/after snapshot. Reconstruct v0 only
// when the recorded version is zero and the saved active v1 belongs to this run.
// Never silently substitute today's config for a different historical version.
export function firstImprovement(run, active, records) {
  if (!run) return null;
  const trace = run.trace || [];
  const loaded = trace.find(e => e.step === 'harness_loaded');
  const scored = trace.find(e => e.step === 'independent_evaluation');
  const tool = trace.find(e => e.step === 'model_tool_call');
  const saved = trace.find(e => e.step === 'atlas_readback');
  if (!run.synthetic || run.version !== 1 || loaded?.version !== 0 ||
      active?.version !== 1 || active.runId !== run._id ||
      scored?.decision !== 'accepted' || !tool?.toolCallId || !saved ||
      !trace.every(e => e.runId === run._id)) throw new Error('Historical evidence mismatch.');
  const before = checkConfig(baseline), after = checkConfig(active.config);
  const rows = parseFixture(run.fixture);
  const beforeRows = apply(rows, before), afterRows = apply(rows, after);
  const beforeValid = beforeRows.filter(x => !x.errors.length).length;
  const afterValid = afterRows.filter(x => !x.errors.length).length;
  if (scored.beforeScore !== evaluate(before) || scored.afterScore !== evaluate(after) ||
      scored.afterScore <= scored.beforeScore || scored.total !== 4 ||
      beforeValid !== trace.find(e => e.step === 'immutable_validation')?.valid ||
      afterValid !== run.accepted || records.length !== run.accepted ||
      saved.imported !== run.accepted || saved.version !== 1 ||
      run.rejected.length !== afterRows.length - afterValid ||
      records.some(x => x.runId !== run._id || x.synthetic !== true) ||
      afterRows.filter(x => !x.errors.length).some(x => !records.some(record =>
        ['sku', 'name', 'price', 'quantity'].every(key => record[key] === x.record[key])))) {
    throw new Error('Historical evaluation/readback mismatch.');
  }
  const meanings = { sku: 'Код товара', name: 'Название', price: 'Цена', quantity: 'Количество' };
  const changes = Object.keys(meanings).map(key => ({
    rule: meanings[key], before: before.aliases[key], after: after.aliases[key],
    effect: `${after.aliases[key]} → ${key}`
  }));
  changes.push(
    { rule: 'Пробелы · trim', before: before.trim, after: after.trim, effect: 'Убирать пробелы по краям' },
    { rule: 'Десятичная запятая', before: before.decimalComma, after: after.decimalComma, effect: 'Читать «12,50» как число 12.5' }
  );
  return {
    runId: run._id, at: scored.at, verifiedAt: new Date().toISOString(),
    evaluation: { before: scored.beforeScore, after: scored.afterScore, total: scored.total },
    beforeVersion: loaded.version, afterVersion: active.version, changes,
    firstFile: { beforeValid, afterValid, rejected: run.rejected.length },
    before, after, records, source: 'Atlas runs + harness + catalog; before reconstructed from code baseline v0',
    steps: trace.map(e => e.step)
  };
}
