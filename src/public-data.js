import { unzipSync, strFromU8 } from 'fflate';
import catalog from './catalog.js';

const nativeFetch = globalThis.fetch.bind(globalThis);
const publishedPlots = new Map(catalog.plots.map(plot => [plot.plot_id, plot]));
let activePlot = null;
let activeBundle = null;
let activePromise = null;
let activeController = null;
let epoch = 0;
let progressHandler = () => {};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

function abortError() {
  return new DOMException('The selected plot changed', 'AbortError');
}

function withSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) reject(abortError());
        else resolve(value);
      },
      error => {
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    );
  });
}

async function readArchive(response, plot, signal) {
  if (!response.ok) throw new Error('ไม่สามารถโหลดชุดภาพสำรวจที่เผยแพร่ได้');
  const total =
    Number(response.headers.get('Content-Length')) || plot.zip_bytes || 0;
  if (total > 50 * 1024 * 1024)
    throw new Error('ชุดภาพสำรวจมีขนาดเกินที่กำหนด');
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 50 * 1024 * 1024)
      throw new Error('ชุดภาพสำรวจมีขนาดเกินที่กำหนด');
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  while (true) {
    if (signal.aborted) throw abortError();
    const { done, value } = await reader.read();
    if (done) break;
    loaded += value.byteLength;
    if (loaded > 50 * 1024 * 1024) {
      await reader.cancel();
      throw new Error('ชุดภาพสำรวจมีขนาดเกินที่กำหนด');
    }
    chunks.push(value);
    progressHandler({ plot_id: plot.plot_id, loaded, total });
  }
  const archive = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return archive;
}

function allowedMember(name) {
  return (
    /^(dataset\.json|inventory\.(json|csv|xlsx))$/.test(name) ||
    /^(?:lod\/)?(?:overview|t_-?\d+_-?\d+)\.(?:bin|rgb)$/.test(name)
  );
}

async function loadPlot(plotId, signal) {
  const plot = publishedPlots.get(plotId);
  if (!plot) throw new Error('ไม่พบแปลงในชุดข้อมูลที่เผยแพร่');
  if (signal?.aborted) throw abortError();
  if (activePlot !== plotId) {
    activeController?.abort();
    activePlot = plotId;
    activeBundle = null;
    activePromise = null;
    activeController = new AbortController();
    epoch++;
  }
  if (activeBundle) return activeBundle;
  if (!activePromise) {
    const currentEpoch = epoch;
    const controller = activeController;
    activePromise = (async () => {
      const resource = new URL(plot.resource_url, globalThis.location.href);
      const relativeResource = !/^[a-z][a-z0-9+.-]*:/i.test(plot.resource_url);
      const privateHost =
        /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1\]?|\[fc|\[fd|\[fe80:)/i.test(
          resource.hostname
        ) || /^172\.(1[6-9]|2\d|3[01])\./.test(resource.hostname);
      if (
        resource.username ||
        resource.password ||
        (relativeResource &&
          (resource.origin !== globalThis.location.origin ||
            !resource.pathname.endsWith(`/resources/${plotId}.zip`))) ||
        (!relativeResource && (resource.protocol !== 'https:' || privateHost))
      ) {
        throw new Error('ตำแหน่งชุดข้อมูลไม่ถูกต้อง');
      }
      if (relativeResource && !resource.search && plot.sha256)
        resource.searchParams.set('v', plot.sha256.slice(0, 16));
      const response = await nativeFetch(resource.href, {
        signal: controller.signal,
      });
      const archive = await readArchive(response, plot, controller.signal);
      if (plot.sha256) {
        if (!globalThis.crypto?.subtle)
          throw new Error('เบราว์เซอร์นี้ตรวจสอบชุดข้อมูลไม่ได้');
        const digest = new Uint8Array(
          await globalThis.crypto.subtle.digest('SHA-256', archive)
        );
        const actual = Array.from(digest, byte =>
          byte.toString(16).padStart(2, '0')
        ).join('');
        if (actual !== plot.sha256.toLowerCase())
          throw new Error('ชุดภาพสำรวจไม่ผ่านการตรวจสอบความสมบูรณ์');
      }
      if (currentEpoch !== epoch || controller.signal.aborted)
        throw abortError();
      const files = unzipSync(archive, {
        filter: file => allowedMember(file.name),
      });
      if (!files['dataset.json'])
        throw new Error('ชุดภาพสำรวจไม่มีข้อมูลประกอบ');
      const data = JSON.parse(strFromU8(files['dataset.json']));
      delete files['dataset.json'];
      if (data.plot?.plot_id !== plotId || data.manifest?.plot_id !== plotId) {
        throw new Error('ชุดภาพสำรวจไม่ตรงกับแปลงที่เลือก');
      }
      const bundle = { data, files };
      if (currentEpoch !== epoch || activePlot !== plotId) throw abortError();
      activeBundle = bundle;
      return bundle;
    })().catch(error => {
      if (currentEpoch === epoch) activePromise = null;
      throw error;
    });
  }
  return withSignal(activePromise, signal);
}

function member(bundle, name) {
  return bundle.files[name] || bundle.files[`lod/${name}`] || null;
}

function binaryResponse(bytes, type = 'application/octet-stream') {
  if (!bytes) return json({ detail: 'ไม่พบข้อมูลส่วนนี้ในชุดที่เผยแพร่' }, 404);
  return new Response(bytes, {
    headers: {
      'Content-Type': type,
      'Content-Length': String(bytes.byteLength),
    },
  });
}

function floatPoints(bytes) {
  if (!bytes || bytes.byteLength % 12)
    throw new Error('ตำแหน่งจุดในชุดข้อมูลไม่ถูกต้อง');
  const aligned = bytes.byteOffset % 4 === 0 ? bytes : bytes.slice();
  return new Float32Array(
    aligned.buffer,
    aligned.byteOffset,
    aligned.byteLength / 4
  );
}

function treeDetail(bundle, treeId) {
  const detail = bundle.data.details?.[treeId];
  if (!detail || detail.tree?.tree_id !== treeId) return null;
  return detail;
}

function croppedCloud(bundle, treeId, params) {
  const detail = treeDetail(bundle, treeId);
  if (!detail) return null;
  const row = detail.tree;
  const center = detail.plane.center;
  const origin = detail.plane.ground_base_xyz || [row.x, row.y, row.z_ground];
  const radius = Math.max(
    0.3,
    Math.min(3, Number(params.get('radius_m')) || 1.5)
  );
  const maxPoints = Math.floor(
    Math.max(100, Math.min(30000, Number(params.get('max_points')) || 30000))
  );
  const exact = (detail.slice_xyz_world || []).slice(0, maxPoints);
  const budget = maxPoints - exact.length;
  const manifest = bundle.data.manifest;
  const minZ = origin[2] - 0.5;
  const maxZ =
    origin[2] + Math.max(3.3, (row.measurement_height_m || 1.3) + 1.2);
  const tiles = manifest.tiles
    .filter(tile => {
      const b = tile.bounds;
      return (
        b[0][0] <= center[0] + radius &&
        b[1][0] >= center[0] - radius &&
        b[0][1] <= center[1] + radius &&
        b[1][1] >= center[1] - radius
      );
    })
    .slice(0, 9);
  const chosen = [];
  let seen = 0;
  let seed = 1701;
  for (const tile of tiles) {
    const points = floatPoints(member(bundle, `${tile.tile_id}.bin`));
    for (let i = 0; i < points.length; i += 3) {
      const x = points[i] + manifest.origin[0];
      const y = points[i + 1] + manifest.origin[1];
      const z = points[i + 2] + manifest.origin[2];
      if (
        (x - center[0]) ** 2 + (y - center[1]) ** 2 > radius ** 2 ||
        z < minZ ||
        z > maxZ
      )
        continue;
      seen++;
      if (chosen.length < budget) chosen.push([x, y, z]);
      else if (budget > 0) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const replace = Math.floor((seed / 4294967296) * seen);
        if (replace < budget) chosen[replace] = [x, y, z];
      }
    }
  }
  const points = [...chosen, ...exact];
  return {
    points,
    tree: row,
    origin,
    point_count: points.length,
    radius_m: radius,
    bounds: [
      [center[0] - radius, center[1] - radius, minZ],
      [center[0] + radius, center[1] + radius, maxZ],
    ],
    coordinate_system:
      'Published world coordinates; context is sampled LOD plus exact measurement slice',
    read_only: true,
  };
}

export function setDownloadProgressHandler(handler) {
  progressHandler = typeof handler === 'function' ? handler : () => {};
}

export async function publicFetch(input, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return json(
      { detail: 'เวอร์ชันดูผลเท่านั้น ไม่เปิดแก้ไขหรือบันทึกข้อมูล' },
      405
    );
  }
  const url = new URL(String(input), globalThis.location.href);
  if (url.origin !== globalThis.location.origin)
    return json({ detail: 'ไม่อนุญาตให้เรียกข้อมูลภายนอก' }, 403);
  if (url.pathname === '/api/plots') return json(catalog);
  const match = url.pathname.match(
    /^\/api\/plots\/([a-zA-Z0-9_-]+)(?:\/(.*))?$/
  );
  if (!match || !publishedPlots.has(match[1]))
    return json({ detail: 'ไม่พบข้อมูลที่เผยแพร่' }, 404);
  const plotId = match[1];
  const route = match[2] || '';
  try {
    const bundle = await loadPlot(plotId, options.signal);
    if (options.signal?.aborted) throw abortError();
    if (route === 'trees')
      return json({
        plot_id: plotId,
        trees: bundle.data.trees,
        count: bundle.data.trees.length,
      });
    if (route === 'overview') return json(bundle.data.manifest);
    if (route === 'overview/terrain')
      return json(bundle.data.terrain || { available: false });
    const binary = route.match(
      /^overview\/(points|colors)\/(overview|t_-?\d+_-?\d+)$/
    );
    if (binary)
      return binaryResponse(
        member(bundle, `${binary[2]}.${binary[1] === 'points' ? 'bin' : 'rgb'}`)
      );
    const tree = route.match(/^trees\/([a-zA-Z0-9_-]+)(?:\/(cloud|history))?$/);
    if (tree) {
      const detail = treeDetail(bundle, tree[1]);
      if (!detail) return json({ detail: 'ไม่พบต้นนี้ในแปลงที่เลือก' }, 404);
      if (tree[2] === 'history')
        return json({
          events: [],
          count: 0,
          published: false,
          mode: 'view_only',
        });
      if (tree[2] === 'cloud')
        return json(croppedCloud(bundle, tree[1], url.searchParams));
      return json(detail);
    }
    if (route === 'export') {
      const format = url.searchParams.get('format');
      const type = {
        csv: 'text/csv; charset=utf-8',
        json: 'application/json; charset=utf-8',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }[format];
      if (!type) return json({ detail: 'ชนิดไฟล์ไม่ถูกต้อง' }, 422);
      return binaryResponse(member(bundle, `inventory.${format}`), type);
    }
    return json({ detail: 'ไม่พบข้อมูลส่วนนี้ในเวอร์ชันดูผล' }, 404);
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    return json({ detail: error.message || 'ไม่สามารถอ่านชุดข้อมูลได้' }, 503);
  }
}
