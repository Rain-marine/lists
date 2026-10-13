/*
 * Tickoff core: local-first data model, merge, and GitHub gist sync.
 * Works in the browser (global `TickoffCore`) and in Node (module.exports) for tests.
 *
 * Data shape:
 *   { v: 1,
 *     lists: { [id]: { id, name, kind, createdAt, updatedAt, deleted? } },
 *     items: { [id]: { id, listId, text, done, createdAt, updatedAt, doneAt?, deleted? } } }
 *
 * Every record carries updatedAt. Two copies merge record by record, newest wins.
 * Deletes are kept as tombstones (deleted: true) so they sync, then pruned after 60 days.
 */
(function (root) {
  'use strict';

  var API = 'https://api.github.com';
  var FILE = 'tickoff.json';
  var DESCRIPTION = 'Tickoff data (your lists; safe to leave alone)';
  var TOMBSTONE_TTL = 60 * 24 * 3600 * 1000;

  function emptyData() { return { v: 1, lists: {}, items: {} }; }

  function stable(value) {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (value && typeof value === 'object') {
      return '{' + Object.keys(value).sort().filter(function (k) { return value[k] !== undefined; })
        .map(function (k) { return JSON.stringify(k) + ':' + stable(value[k]); }).join(',') + '}';
    }
    return JSON.stringify(value);
  }
  function serialize(d) { return stable(d); }

  function newer(a, b) {
    if (!a) return b;
    if (!b) return a;
    if ((a.updatedAt || 0) !== (b.updatedAt || 0)) return (a.updatedAt || 0) > (b.updatedAt || 0) ? a : b;
    if (!!a.deleted !== !!b.deleted) return a.deleted ? a : b;
    return stable(a) >= stable(b) ? a : b;
  }

  function mergeData(x, y) {
    var out = emptyData();
    ['lists', 'items'].forEach(function (k) {
      var xs = (x && x[k]) || {}, ys = (y && y[k]) || {};
      var seen = {};
      Object.keys(xs).concat(Object.keys(ys)).forEach(function (id) {
        if (seen[id]) return;
        seen[id] = true;
        out[k][id] = newer(xs[id], ys[id]);
      });
    });
    return out;
  }

  function prune(d, nowMs) {
    var cutoff = (nowMs || Date.now()) - TOMBSTONE_TTL;
    var out = emptyData();
    ['lists', 'items'].forEach(function (k) {
      Object.keys(d[k]).forEach(function (id) {
        var r = d[k][id];
        if (r.deleted && (r.updatedAt || 0) < cutoff) return;
        out[k][id] = r;
      });
    });
    return out;
  }

  function validate(parsed) {
    if (!parsed || typeof parsed !== 'object' || typeof parsed.lists !== 'object' || typeof parsed.items !== 'object') return emptyData();
    return { v: 1, lists: parsed.lists || {}, items: parsed.items || {} };
  }

  /* ---------- GitHub gist transport ---------- */

  function SyncError(code, message) {
    var e = new Error(message);
    e.name = 'SyncError';
    e.code = code;      // auth | rate | gone | http
    return e;
  }

  function failFor(res) {
    if (res.status === 401) return SyncError('auth', 'GitHub rejected the token.');
    if (res.status === 403 || res.status === 429) return SyncError('rate', 'GitHub refused the request (rate limit or token permissions).');
    if (res.status === 404) return SyncError('gone', 'Not found.');
    return SyncError('http', 'GitHub answered with status ' + res.status + '.');
  }

  function gh(fetchFn, token, path, opts) {
    opts = opts || {};
    var headers = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' };
    if (opts.body) headers['Content-Type'] = 'application/json';
    if (opts.etag) headers['If-None-Match'] = opts.etag;
    return fetchFn(API + path, {
      method: opts.method || 'GET',
      cache: 'no-store',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
  }

  async function findGist(fetchFn, token) {
    var matches = [];
    for (var page = 1; page <= 5; page++) {
      var res = await gh(fetchFn, token, '/gists?per_page=100&page=' + page);
      if (!res.ok) throw failFor(res);
      var list = await res.json();
      list.forEach(function (g) { if (g.files && g.files[FILE]) matches.push(g); });
      if (list.length < 100) break;
    }
    if (!matches.length) return null;
    matches.sort(function (a, b) { return String(a.created_at).localeCompare(String(b.created_at)); });
    return matches[0].id;
  }

  async function readGist(fetchFn, token, id, etag) {
    var res = await gh(fetchFn, token, '/gists/' + id, { etag: etag });
    if (res.status === 304) return { notModified: true };
    if (!res.ok) throw failFor(res);
    var json = await res.json();
    var file = json.files && json.files[FILE];
    var text = '';
    if (file) {
      text = file.content || '';
      if (file.truncated && file.raw_url) {
        var raw = await fetchFn(file.raw_url, { cache: 'no-store' });
        if (raw.ok) text = await raw.text();
      }
    }
    var parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch (e) { parsed = null; }
    return { data: validate(parsed), etag: res.headers.get('ETag') };
  }

  async function writeGist(fetchFn, token, id, data) {
    var files = {};
    files[FILE] = { content: serialize(data) };
    var res = await gh(fetchFn, token, '/gists/' + id, { method: 'PATCH', body: { files: files } });
    if (!res.ok) throw failFor(res);
    return { etag: res.headers.get('ETag') };
  }

  async function createGist(fetchFn, token, data) {
    var files = {};
    files[FILE] = { content: serialize(data) };
    var res = await gh(fetchFn, token, '/gists', { method: 'POST', body: { description: DESCRIPTION, public: false, files: files } });
    if (!res.ok) throw failFor(res);
    var json = await res.json();
    return { id: json.id, etag: res.headers.get('ETag') };
  }

  /*
   * One sync round. ctx: { fetch, token, gistId, etag, data, dirty }
   * Returns { data, gistId, etag, pushed, changed } and never mutates ctx.data.
   * Throws SyncError for GitHub problems; network failures surface as the fetch error.
   */
  async function syncOnce(ctx) {
    var fetchFn = ctx.fetch, token = ctx.token;
    var gistId = ctx.gistId || null;
    var etag = ctx.etag || null;
    var local = ctx.data;
    var remote = null;

    if (!gistId) gistId = await findGist(fetchFn, token);

    if (gistId) {
      try {
        var r = await readGist(fetchFn, token, gistId, ctx.dirty ? null : etag);
        if (r.notModified) return { data: local, gistId: gistId, etag: etag, pushed: false, changed: false };
        remote = r.data;
        etag = r.etag;
      } catch (e) {
        if (e.code === 'gone') { gistId = null; etag = null; } else throw e;
      }
    }

    if (!gistId) {
      var created = await createGist(fetchFn, token, local);
      return { data: local, gistId: created.id, etag: created.etag, pushed: true, changed: false };
    }

    var merged = prune(mergeData(local, remote || emptyData()));
    var mergedS = serialize(merged);
    var changed = mergedS !== serialize(local);
    var pushed = false;
    if (mergedS !== serialize(remote || emptyData())) {
      var w = await writeGist(fetchFn, token, gistId, merged);
      etag = w.etag;
      pushed = true;
    }
    return { data: merged, gistId: gistId, etag: etag, pushed: pushed, changed: changed };
  }

  var api = {
    FILE: FILE,
    emptyData: emptyData,
    serialize: serialize,
    mergeData: mergeData,
    prune: prune,
    validate: validate,
    syncOnce: syncOnce,
    SyncError: SyncError
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TickoffCore = api;
})(typeof self !== 'undefined' ? self : this);
