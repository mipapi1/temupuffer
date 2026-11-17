# Indexer (`indexer/main.py` → `temupuffer/indexer.py`)

A loop that turns WAL entries into index segments, plus a small HTTP server for health checks and
the console. It never serves data.

```
claim a job (queue.json, If-Match)          ← claim + heartbeat
  read meta.json and manifest.json (etag)
  LIST wal/ after the cursor → take up to INDEXER_MAX_ROWS_PER_PASS rows
  build a segment → PUT its files (If-None-Match, random id)
  PUT manifest.json (If-Match)              ← commit point: the cursor moves, the tail shrinks
  4+ segments → merge the smallest ones (up to INDEXER_MAX_SEGMENT_ROWS) → PUT manifest (If-Match)
finish the job (remove it, or requeue it if there's more work or a rerun)
every INDEXER_SWEEP_S: queue any namespace whose WAL is ahead of its cursor
```

Every failure is handled by object storage alone:

| What fails | What happens |
|---|---|
| The indexer dies mid-build | Its segment files are orphans nobody points to. The heartbeat stops, the claim expires, and another indexer redoes the work |
| Two indexers on one namespace (an expired claim) | Both build; one manifest swap wins, and the loser deletes its files (`lost_manifest_races`) |
| A query node dies before queueing a job | The sweep finds WAL entries past the cursor and queues them |
| A write lands during a pass | The `rerun` flag puts the job back in line instead of removing it |
| A query is still reading an old segment | After a merge, old segments are only deleted after `GC_DELAY_S` (2 min) |

Slowed down for demos: in Compose and on K3s I set `INDEXER_PASS_DELAY_S=1` and
`INDEXER_MAX_ROWS_PER_PASS=3000`, so you can watch the backlog drain. Set them to 0 and 50000 to
watch it race.

**Q:** Why can a merge that covers *every* segment drop deleted rows (tombstones), while a merge of only
some segments has to keep them?
