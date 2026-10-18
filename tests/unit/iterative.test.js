// Iterative grouping: more tabs grouped without joining unrelated work.
import { test, expect } from 'vitest';
import { WORKDAY, score } from '../fixtures/workday.js';
import { goalGraph, clusterGoals, iterativeGoals } from '../../src/lib/goals.js';
import { buildLineage } from '../../src/lib/lineage.js';

const tabs = WORKDAY.map((x) => x.tab);
const graph = goalGraph(tabs, { edges: buildLineage(tabs) });

test('iterative passes group far more tabs than one strict pass, with no wrong pairs', () => {
  const strict = score(clusterGoals(tabs.map((t) => t.id), graph.w));
  const it = score(iterativeGoals(tabs.map((t) => t.id), graph).map((g) => g.ids));
  expect(strict.coverage).toBeLessThan(0.6);
  expect(it.coverage).toBeGreaterThanOrEqual(0.9);
  expect(it.recall).toBeGreaterThan(strict.recall * 2);
  expect(it.precision).toBe(1);
  expect(it.strays).toBe(0);
});

test('every goal knows which pass made it; short terms like Q4 now count', () => {
  const goals = iterativeGoals(tabs.map((t) => t.id), graph);
  expect(goals.every((g) => [1, 3].includes(g.pass))).toBe(true);
  expect(graph.docs.get(12).terms.has('q4')).toBe(true);
});

test('a goal never grows past its size cap', () => {
  const ids = tabs.map((t) => t.id);
  const all = { w: () => 1, docs: graph.docs, idf: graph.idf };
  expect(Math.max(...iterativeGoals(ids, all, { maxSize: 5 }).map((g) => g.ids.length))).toBeLessThanOrEqual(5);
});
