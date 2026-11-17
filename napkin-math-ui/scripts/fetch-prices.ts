// Refresh the local cloud pricing cache in data/cloud/*.json.
//   node scripts/fetch-prices.ts            # all providers
//   node scripts/fetch-prices.ts aws azure  # subset
//   GCP_API_KEY=… node scripts/fetch-prices.ts gcp
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Provider, ProviderDataset } from '../src/lib/schema.ts';
import { fetchAws } from './providers/aws.ts';
import { fetchAzure } from './providers/azure.ts';
import { fetchGcp } from './providers/gcp.ts';
import { log } from './lib/http.ts';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'data', 'cloud');
const FETCHERS: Record<Provider, () => Promise<ProviderDataset>> = { aws: fetchAws, azure: fetchAzure, gcp: fetchGcp };

const wanted = (process.argv.slice(2).filter((a) => a in FETCHERS) as Provider[]);
const providers = wanted.length ? wanted : (Object.keys(FETCHERS) as Provider[]);

await mkdir(outDir, { recursive: true });
const metaPath = path.join(outDir, 'meta.json');
const meta: Record<string, unknown> = JSON.parse(await readFile(metaPath, 'utf8').catch(() => '{}'));

let failed = 0;
await Promise.all(
  providers.map(async (p) => {
    const t0 = Date.now();
    try {
      const ds = await FETCHERS[p]();
      // Compact JSON keeps the cache small; the UI lazy-loads it.
      await writeFile(path.join(outDir, `${p}.json`), JSON.stringify(ds));
      meta[p] = { fetchedAt: ds.fetchedAt, mode: ds.mode, compute: ds.compute.length, blockStorage: ds.blockStorage.length, objectStorage: ds.objectStorage.length, network: ds.network.length };
      log(p, `wrote data/cloud/${p}.json (${ds.compute.length} compute SKUs) in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    } catch (e: any) {
      failed++;
      log(p, 'FAILED — keeping previous cache:', e.message);
    }
  }),
);
await writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n');
process.exit(failed ? 1 : 0);
