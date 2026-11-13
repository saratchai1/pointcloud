// Fetch only the four previously published, checksum-pinned derived datasets.
// No raw TLS/LAS files or private credentials should ever be deployed.
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import catalog from '../src/catalog.js';

const assetRoot = join(process.cwd(), 'public', 'resources');
const mirrors = [
  process.env.PUBLISHED_ASSET_BASE_URL,
  'https://mangrove-tls-team-viewer.netlify.app',
  'https://mangrove-tls-team-viewer-y43ku2.v2.appdeploy.ai',
].filter(Boolean);

async function validFile(path, plot) {
  try {
    const info = await stat(path);
    if (info.size !== plot.zip_bytes) return false;
    const hash = createHash('sha256').update(await readFile(path)).digest('hex');
    return hash === plot.sha256;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

async function fetchPlot(plot) {
  const filename = plot.resource_url.split('/').pop();
  const target = join(assetRoot, filename);
  if (await validFile(target, plot)) {
    console.log(`Verified cached dataset: ${filename}`);
    return;
  }

  for (const base of mirrors) {
    const url = new URL(plot.resource_url, base);
    const temp = `${target}.partial`;
    try {
      console.log(`Fetching checksum-pinned dataset: ${filename} (${url.origin})`);
      const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temp));
      if (!(await validFile(temp, plot))) throw new Error('SHA-256/size mismatch');
      await rename(temp, target);
      console.log(`Verified SHA-256: ${filename}`);
      return;
    } catch (err) {
      await rm(temp, { force: true });
      console.warn(`Mirror failed: ${url.origin} (${err.message})`);
    }
  }
  throw new Error(`No valid public derived dataset available: ${filename}`);
}

await mkdir(assetRoot, { recursive: true });
await Promise.all(catalog.plots.map(fetchPlot));

