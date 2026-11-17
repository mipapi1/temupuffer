// Sanity checks: the engine should reproduce the README's "$ / TiB read" table (within its own
// rounding, i.e. same order of magnitude and within ~2x) and basic timing math.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, resolveReference, type Workload, type Step } from '../src/lib/engine.ts';
import { READ_COST, OPERATIONS, shortName } from '../src/lib/reference.ts';
import { TiB, GiB, parseBytes, parseDuration, parseCount, formatBytes, formatDuration, napkin } from '../src/lib/units.ts';

const ref = resolveReference();
const batch = (bytes: number): Workload => ({ mode: 'batch', totalBytes: bytes, rps: 0, requestBytes: 0, tier: 'monthly' });

const CASES: [string, string, Partial<Step> & { ioBytes?: number }][] = [
  ['Memory Sequential Read, 1 thread', 'memory-sequential-read-64-b-1-thread', {}],
  ['SSD Sequential Read (8 KiB)', 'ssd-sequential-read-8-kib-1-thread', {}],
  ['Network Same-Zone (32 KiB)', 'network-same-zone-32-kib', {}],
  ['Network Cross-Zone (64 KiB)', 'network-cross-zone-64-kib', {}],
  ['Blob Storage, Regional Read (128 KiB)', 'blob-storage-regional-read-128-kib', {}],
  ['HDD Sequential Read (8 KiB)', 'hdd-sequential-read-8-kib-1-thread', {}],
];

for (const [readmeName, opId, extra] of CASES) {
  test(`$/TiB matches README: ${readmeName}`, () => {
    const want = READ_COST.find((r) => r.name === readmeName);
    assert.ok(want, `README row ${readmeName}`);
    assert.ok(OPERATIONS.find((o) => o.id === opId), `operation ${opId}`);
    // Throughput rows are measured with many requests in flight; use enough parallelism to be throughput-bound.
    const step: Step = { id: 'x', kind: 'op', opId, parallelism: 1, ...extra } as Step;
    if (step.kind === 'op' && !/^(memory|cpu)/.test(opId)) step.parallelism = /blob/.test(opId) ? 1024 : 32;
    const r = evaluate(batch(TiB), [step], ref);
    const got = r.totals.costUsd;
    const ratio = got / want!.perTiB;
    assert.ok(ratio > 0.5 && ratio < 2, `${readmeName}: got $${got.toFixed(4)} want ~$${want!.perTiB}`);
  });
}

test('throughput vs latency bound', () => {
  // 1 GiB of random SSD reads, 8 KiB at a time, one in flight → latency bound: 131072 × 100 μs = 13.1 s
  const r = evaluate(batch(GiB), [{ id: 'a', kind: 'op', opId: 'ssd-random-read-8-kib-1-thread', parallelism: 1 }], ref);
  assert.equal(r.steps[0].bound, 'latency');
  assert.ok(Math.abs(r.steps[0].timeNs / 1e9 - 13.1) < 0.1);
  // with 128 in flight it becomes throughput bound: 1 GiB / 5 GiB/s = 0.2 s
  const r2 = evaluate(batch(GiB), [{ id: 'a', kind: 'op', opId: 'ssd-random-read-8-kib-1-thread', parallelism: 128 }], ref);
  assert.equal(r2.steps[0].bound, 'throughput');
  assert.ok(Math.abs(r2.steps[0].timeNs / 1e9 - 0.2) < 0.01);
});

test('compression shrinks downstream bytes', () => {
  const r = evaluate(batch(GiB), [
    { id: 'a', kind: 'op', opId: 'cpu-compress-lz4-zstd-1-4-kib-1-thread', parallelism: 1, ratio: 4 },
    { id: 'b', kind: 'op', opId: 'network-cross-zone-64-kib', parallelism: 64 },
  ], ref);
  assert.equal(r.steps[1].inBytes, GiB / 4);
  // compress at 500 MiB/s: 2.048 s
  assert.ok(Math.abs(r.steps[0].timeNs / 1e9 - 2.048) < 0.01);
});

test('stream mode capacity', () => {
  const w: Workload = { mode: 'stream', totalBytes: 0, rps: 100_000, requestBytes: 1024, tier: 'monthly' };
  const r = evaluate(w, [{ id: 'a', kind: 'op', opId: 'cpu-serialize-json-protobuf-256-b-1-thread', parallelism: 1 }], ref);
  // 100k × 1 KiB = 97.7 MiB/s at 2 GiB/s per thread → ~0.05 threads
  assert.ok(r.steps[0].unitsNeeded > 0.04 && r.steps[0].unitsNeeded < 0.06);
});

test('units', () => {
  assert.equal(parseBytes('1 GiB'), GiB);
  assert.equal(parseBytes('500MB'), 500e6);
  assert.equal(parseDuration('100us'), 100e3);
  assert.equal(parseCount('10k'), 10_000);
  assert.equal(formatBytes(1.5 * GiB), '1.5 GiB');
  assert.equal(formatDuration(2_500_000), '2.5 ms');
  assert.deepEqual(napkin(2.6e6), { c: 3, e: 6 });
});

test('short names', () => {
  const n = (id: string) => shortName(OPERATIONS.find((o) => o.id === id)!);
  assert.equal(n('cpu-compress-lz4-zstd-1-4-kib-1-thread'), 'CPU Compress (lz4, zstd -1)');
  assert.equal(n('ssd-random-read-8-kib-1-thread'), 'SSD Random Read');
  assert.equal(n('database-query-primary-key-mysql-postgres-1-rtt'), 'Database Query, primary key (MySQL, Postgres)');
});
