import axios from 'axios';
import { cacheAvailabilityResults, getCachedAvailabilityResults } from '../lib/cache.js';
import { isVideo } from '../lib/extension.js';
import { getMagnetLink } from '../lib/magnetHelper.js';
import { delay } from '../lib/promises.js';
import { Type } from '../lib/types.js';
import { chunkArray, BadTokenError, AccessDeniedError } from './mochHelper.js';
import StaticResponse from './static.js';

const KEY = 'torbox';
const BASE_URL = 'https://api.torbox.app/v1/api';
const MIN_SIZE = 5 * 1024 * 1024;
const CATALOG_PAGE_SIZE = 100;
const CHECK_CHUNK = 80;

function client(apiKey, ip) {
  return axios.create({
    baseURL: BASE_URL,
    timeout: 15000,
    headers: { Authorization: `Bearer ${apiKey}` },
    ...(ip ? { proxy: false } : {})
  });
}

export async function getCachedStreams(streams, apiKey) {
  const hashes = streams.map(s => s.infoHash);
  const available = await _getInstantAvailable(hashes, apiKey);
  if (!available) {
    return undefined;
  }
  return streams.reduce((acc, stream) => {
    const entry = available[stream.infoHash];
    acc[stream.infoHash] = {
      url: `${apiKey}/${stream.infoHash}/null/${stream.fileIdx}`,
      cached: !!entry
    };
    return acc;
  }, {});
}

async function _getInstantAvailable(hashes, apiKey, retries = 2) {
  const cached = await getCachedAvailabilityResults(hashes);
  const missing = hashes.filter(h => !cached[h]);
  if (!missing.length) {
    return cached;
  }
  const c = client(apiKey);
  const batches = chunkArray(missing, CHECK_CHUNK);
  try {
    const results = await Promise.all(batches.map(async batch => {
      const params = new URLSearchParams();
      batch.forEach(h => params.append('hash', h));
      params.append('format', 'object');
      params.append('list_files', 'false');
      const resp = await c.get(`/torrents/checkcached?${params.toString()}`);
      const data = resp.data?.data;
      const out = {};
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        Object.keys(data).forEach(h => {
          if (data[h]) {
            out[h.toLowerCase()] = true;
          }
        });
      }
      return out;
    }));
    const merged = results.reduce((a, b) => Object.assign(a, b), {});
    await cacheAvailabilityResults(merged);
    return Object.assign(cached, merged);
  } catch (error) {
    if (toCommonError(error)) {
      return Promise.reject(error);
    }
    if (retries > 0) {
      await delay(1000);
      return _getInstantAvailable(hashes, apiKey, retries - 1);
    }
    console.warn(`Failed Torbox availability [${hashes[0]}]:`, error?.message);
    return undefined;
  }
}

export async function resolve({ ip, apiKey, infoHash, fileIndex }) {
  console.log(`Unrestricting Torbox ${infoHash} [${fileIndex}]`);
  try {
    const torrent = await _createOrFindTorrent(apiKey, infoHash);
    if (!torrent) {
      return Promise.reject('Failed Torbox torrent creation');
    }
    if (torrent.download_finished || torrent.download_present) {
      return _requestDownloadLink(apiKey, torrent, fileIndex);
    }
    if (torrent.download_state && /down|queue|stalled|metaDL|check/i.test(torrent.download_state)) {
      console.log(`Downloading to Torbox ${infoHash} [${fileIndex}]...`);
      return StaticResponse.DOWNLOADING;
    }
    if (torrent.download_state && /error|stop|miss/i.test(torrent.download_state)) {
      return StaticResponse.FAILED_DOWNLOAD;
    }
    return StaticResponse.DOWNLOADING;
  } catch (error) {
    if (_accessDenied(error)) {
      return StaticResponse.FAILED_ACCESS;
    }
    return Promise.reject(`Failed Torbox unrestrict ${infoHash}: ${error?.message || JSON.stringify(error)}`);
  }
}

async function _createOrFindTorrent(apiKey, infoHash) {
  const existing = await _findTorrent(apiKey, infoHash);
  if (existing) {
    return existing;
  }
  const c = client(apiKey);
  const magnet = await getMagnetLink(infoHash);
  const form = new URLSearchParams();
  form.append('magnet', magnet);
  form.append('seed', '1');
  form.append('allow_zip', 'false');
  const resp = await c.post('/torrents/createtorrent', form, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  const torrentId = resp.data?.data?.torrent_id || resp.data?.data?.id;
  if (!torrentId) {
    return Promise.reject(`Torbox createtorrent returned no id: ${JSON.stringify(resp.data)}`);
  }
  return _getTorrentInfo(apiKey, torrentId);
}

async function _findTorrent(apiKey, infoHash) {
  const c = client(apiKey);
  const resp = await c.get('/torrents/mylist', { params: { bypass_cache: 'true' } });
  const list = resp.data?.data || [];
  return list.find(t => (t.hash || '').toLowerCase() === infoHash.toLowerCase());
}

async function _getTorrentInfo(apiKey, torrentId) {
  const c = client(apiKey);
  const resp = await c.get('/torrents/mylist', {
    params: { id: torrentId, bypass_cache: 'true' }
  });
  return resp.data?.data;
}

async function _requestDownloadLink(apiKey, torrent, fileIndex) {
  const c = client(apiKey);
  const files = torrent.files || [];
  let fileId;
  if (Number.isInteger(fileIndex) && files[fileIndex]) {
    fileId = files[fileIndex].id;
  } else {
    const videos = files.filter(f => isVideo(f.name || f.short_name || '') && (f.size || 0) > MIN_SIZE);
    const target = videos.sort((a, b) => (b.size || 0) - (a.size || 0))[0] || files[0];
    fileId = target?.id;
  }
  if (!fileId) {
    return StaticResponse.FAILED_DOWNLOAD;
  }
  const resp = await c.get('/torrents/requestdl', {
    params: { token: apiKey, torrent_id: torrent.id, file_id: fileId, redirect: 'false' }
  });
  const url = resp.data?.data;
  if (!url) {
    return Promise.reject(`Torbox requestdl returned no url: ${JSON.stringify(resp.data)}`);
  }
  console.log(`Unrestricted Torbox ${torrent.hash} [${fileIndex}] to ${url}`);
  return url;
}

export async function getCatalog(apiKey, offset, ip) {
  if (offset > 0) {
    return [];
  }
  const c = client(apiKey, ip);
  const resp = await c.get('/torrents/mylist', { params: { bypass_cache: 'true' } });
  const list = resp.data?.data || [];
  return list
    .filter(t => t.download_finished || t.download_present)
    .slice(0, CATALOG_PAGE_SIZE)
    .map(t => ({
      id: `${KEY}:${t.id}`,
      type: Type.OTHER,
      name: t.name
    }));
}

export async function getItemMeta(itemId, apiKey, ip) {
  const c = client(apiKey, ip);
  const resp = await c.get('/torrents/mylist', {
    params: { id: itemId, bypass_cache: 'true' }
  });
  const torrent = resp.data?.data;
  if (!torrent) {
    return Promise.reject(`Torbox item ${itemId} not found`);
  }
  return {
    id: `${KEY}:${torrent.id}`,
    type: Type.OTHER,
    name: torrent.name,
    infoHash: (torrent.hash || '').toLowerCase(),
    videos: (torrent.files || [])
      .filter(file => isVideo(file.name || file.short_name || ''))
      .map((file, index) => ({
        id: `${KEY}:${torrent.id}:${file.id}`,
        title: file.name || file.short_name,
        released: new Date(new Date(torrent.created_at || Date.now()).getTime() - index).toISOString(),
        streams: [{ url: `${apiKey}/${(torrent.hash || '').toLowerCase()}/null/${index}` }]
      }))
  };
}

export function toCommonError(error) {
  const status = error?.response?.status;
  const detail = error?.response?.data?.detail || error?.response?.data?.error || '';
  if (status === 401 || status === 403 || /unauthor|invalid api/i.test(detail)) {
    return BadTokenError;
  }
  if (status === 402 || /subscription|expired/i.test(detail)) {
    return AccessDeniedError;
  }
  return undefined;
}

function _accessDenied(error) {
  const status = error?.response?.status;
  return status === 401 || status === 403 || status === 402;
}
