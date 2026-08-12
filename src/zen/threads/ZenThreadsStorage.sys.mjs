// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Sqlite: "resource://gre/modules/Sqlite.sys.mjs",
  AsyncShutdown: "resource://gre/modules/AsyncShutdown.sys.mjs",
});

const SNAPSHOT_WINDOW_MS = 120 * 24 * 60 * 60 * 1000; // wide, so threads age out whole
const RECEDE_MS = 48 * 60 * 60 * 1000; // inactive 48h -> receded
const ARCHIVE_MS = 14 * 24 * 60 * 60 * 1000; // inactive 14d -> archived
const MAX_THREADS = 50;
// A provenance component only becomes a visible thread once it has enough
// substance — quick lookups must never create structure (idea1 §17).
const THREAD_MIN_NODES = 3;
const THREAD_MIN_SPAN_MS = 5 * 60 * 1000;

// Apps are not pages (idea1 §8): they never belong inside a thread.
const APP_SEED_HOSTS = new Set([
  "mail.google.com",
  "calendar.google.com",
  "gmail.com",
  "outlook.live.com",
  "outlook.office.com",
  "app.slack.com",
  "discord.com",
  "web.whatsapp.com",
  "web.telegram.org",
  "teams.microsoft.com",
  "open.spotify.com",
  "music.youtube.com",
  "netflix.com",
  "chatgpt.com",
  "claude.ai",
  "messenger.com",
]);
const APP_MIN_DAYS = 6; // hosts used on this many distinct days become app-like

/**
 * Process-wide storage and inference for Threads.
 *
 * All browser windows funnel provenance events here; a single WAL-mode
 * SQLite connection owns zen-threads.sqlite in the profile. The events
 * table is an append-only, immutable log (ground truth). Threads are a
 * derived interpretation, recomputed from events, keyed stably by the
 * root node of each provenance component so identities survive restarts.
 */
export const ZenThreadsStorage = new (class {
  #db = null;
  #dbReady = null;
  #writeQueue = Promise.resolve();
  #shutdownBlocker = null;

  // Revisions bumped synchronously on write, so caches invalidate exactly.
  // Split by what each read actually depends on: a checkpoint write must not
  // invalidate the (expensive) derived thread graph.
  #eventSeq = 0;
  #linkRev = 0;
  #metaRev = 0;
  #checkpointRev = 0;
  #shelfRev = 0;
  #snapshotCache = null;
  #shelfCache = null;
  #checkpointCache = null;
  #metaCache = null;

  // Incrementally folded state: the append-only log replayed once, then
  // advanced by cursor. Holds scalars only — the derived projection with
  // its parent/child links is rebuilt separately so folding can never
  // corrupt it.
  #nodes = new Map();
  #hostDays = new Map();
  #maxEventId = 0;
  #foldedSeq = -1;
  #graphCache = null;

  constructor() {
    this.#dbReady = this.#open();
  }

  async #open() {
    try {
      const path = PathUtils.join(PathUtils.profileDir, "zen-threads.sqlite");
      const db = await lazy.Sqlite.openConnection({ path });
      await db.execute("PRAGMA journal_mode = WAL");
      await db.execute(`
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          kind TEXT NOT NULL,
          tab TEXT NOT NULL,
          parent TEXT,
          url TEXT,
          title TEXT,
          search_query TEXT
        )
      `);
      await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts)"
      );
      await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_events_tab ON events(tab)"
      );
      await db.execute(`
        CREATE TABLE IF NOT EXISTS thread_folders (
          thread_id TEXT PRIMARY KEY,
          folder_id TEXT NOT NULL
        )
      `);
      await db.execute(`
        CREATE TABLE IF NOT EXISTS shelf (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          url TEXT NOT NULL,
          title TEXT,
          tab_key TEXT,
          resolved_ts INTEGER,
          restored INTEGER DEFAULT 0
        )
      `);
      await db.execute(`
        CREATE TABLE IF NOT EXISTS checkpoints (
          thread_id TEXT PRIMARY KEY,
          ts INTEGER NOT NULL,
          note TEXT,
          last_url TEXT,
          last_title TEXT
        )
      `);
      await db.execute(`
        CREATE TABLE IF NOT EXISTS thread_meta (
          thread_id TEXT PRIMARY KEY,
          title TEXT
        )
      `);
      await db.execute(`
        CREATE TABLE IF NOT EXISTS thread_links (
          a TEXT NOT NULL,
          b TEXT NOT NULL,
          ts INTEGER NOT NULL,
          PRIMARY KEY (a, b)
        )
      `);
      for (const col of ["status TEXT", "status_ts INTEGER"]) {
        try {
          await db.execute(`ALTER TABLE thread_meta ADD COLUMN ${col}`);
        } catch (e) {
          // Column already exists.
        }
      }
      this.#db = db;
      this.#shutdownBlocker = async () => {
        await this.#writeQueue;
        const conn = this.#db;
        this.#db = null;
        if (conn) {
          await conn.close().catch(() => {});
        }
      };
      lazy.AsyncShutdown.profileBeforeChange.addBlocker(
        "ZenThreadsStorage: closing connection",
        this.#shutdownBlocker
      );
      // Places schedules its own maintenance the same way; the log is only
      // read through a window, so anything older than that is dead weight.
      Services.obs.addObserver(this, "idle-daily");
    } catch (e) {
      console.error("ZenThreadsStorage: open failed", e);
      this.#db = null;
    }
  }

  observe(subject, topic) {
    if (topic === "idle-daily") {
      this.#sweep();
    }
  }

  /**
   * Retention: the read window is finite, so events older than it can never
   * influence anything again. Resolved shelf entries age out the same way.
   */
  #sweep() {
    this.#writeQueue = this.#writeQueue.then(async () => {
      await this.#dbReady;
      if (!this.#db) {
        return;
      }
      const cutoff = Date.now() - SNAPSHOT_WINDOW_MS;
      try {
        await this.#db.execute("DELETE FROM events WHERE ts < :cutoff", {
          cutoff,
        });
        await this.#db.execute(
          `DELETE FROM shelf
           WHERE resolved_ts IS NOT NULL AND resolved_ts < :cutoff`,
          { cutoff }
        );
        // Folded state may now describe deleted rows; rebuild it lazily.
        this.#nodes = new Map();
        this.#hostDays = new Map();
        this.#maxEventId = 0;
        this.#foldedSeq = -1;
        this.#graphCache = null;
        this.#snapshotCache = null;
      } catch (e) {
        console.error("ZenThreadsStorage: retention sweep failed", e);
      }
    });
  }

  recordEvent(kind, tabKey, parentKey, url, title, query) {
    this.#eventSeq++;
    // Stamp when the event happened, not when the queued write drains —
    // a busy queue would otherwise smear session boundaries.
    const ts = Date.now();
    this.#writeQueue = this.#writeQueue.then(async () => {
      await this.#dbReady;
      if (!this.#db) {
        return;
      }
      try {
        await this.#db.executeCached(
          `INSERT INTO events (ts, kind, tab, parent, url, title, search_query)
           VALUES (:ts, :kind, :tab, :parent, :url, :title, :query)`,
          {
            ts,
            kind,
            tab: tabKey,
            parent: parentKey ?? null,
            url: url ?? null,
            title: title ?? null,
            query: query ?? null,
          }
        );
      } catch (e) {
        console.error("ZenThreadsStorage: write failed", e);
      }
    });
  }

  setThreadFolder(threadId, folderId) {
    this.#metaRev++;
    this.#writeQueue = this.#writeQueue.then(async () => {
      await this.#dbReady;
      if (!this.#db) {
        return;
      }
      try {
        await this.#db.execute(
          `INSERT OR REPLACE INTO thread_folders (thread_id, folder_id)
           VALUES (:threadId, :folderId)`,
          { threadId, folderId }
        );
      } catch (e) {
        console.error("ZenThreadsStorage: setThreadFolder failed", e);
      }
    });
  }

  async getThreadFolders() {
    await this.#dbReady;
    await this.#writeQueue;
    const map = new Map();
    if (!this.#db) {
      return map;
    }
    try {
      const rows = await this.#db.execute(
        "SELECT thread_id, folder_id FROM thread_folders"
      );
      for (const row of rows) {
        map.set(
          row.getResultByName("thread_id"),
          row.getResultByName("folder_id")
        );
      }
    } catch (e) {
      console.error("ZenThreadsStorage: getThreadFolders failed", e);
    }
    return map;
  }

  shelvePage(url, title, tabKey) {
    this.#shelfRev++;
    const ts = Date.now();
    this.#writeQueue = this.#writeQueue.then(async () => {
      await this.#dbReady;
      if (!this.#db) {
        return;
      }
      try {
        await this.#db.execute(
          `INSERT INTO shelf (ts, url, title, tab_key)
           VALUES (:ts, :url, :title, :tabKey)`,
          { ts, url, title: title ?? null, tabKey: tabKey ?? null }
        );
      } catch (e) {
        console.error("ZenThreadsStorage: shelvePage failed", e);
      }
    });
  }

  resolveShelfItem(id, restored) {
    this.#shelfRev++;
    this.#writeQueue = this.#writeQueue.then(async () => {
      await this.#dbReady;
      if (!this.#db) {
        return;
      }
      try {
        await this.#db.execute(
          `UPDATE shelf SET resolved_ts = :ts, restored = :restored
           WHERE id = :id`,
          { ts: Date.now(), restored: restored ? 1 : 0, id }
        );
      } catch (e) {
        console.error("ZenThreadsStorage: resolveShelfItem failed", e);
      }
    });
  }

  async getShelf(limit = 30) {
    // Capture the revision before awaiting: a write landing during the await
    // must not let us stamp stale rows as current.
    const cacheKey = `${this.#shelfRev}:${limit}`;
    if (this.#shelfCache?.key === cacheKey) {
      return this.#shelfCache.value;
    }
    await this.#dbReady;
    await this.#writeQueue;
    const items = [];
    if (!this.#db) {
      return items;
    }
    try {
      const rows = await this.#db.executeCached(
        `SELECT id, ts, url, title, tab_key FROM shelf
         WHERE resolved_ts IS NULL ORDER BY ts DESC LIMIT :limit`,
        { limit }
      );
      for (const row of rows) {
        items.push({
          id: row.getResultByName("id"),
          ts: row.getResultByName("ts"),
          url: row.getResultByName("url"),
          title: row.getResultByName("title"),
          tabKey: row.getResultByName("tab_key"),
        });
      }
    } catch (e) {
      console.error("ZenThreadsStorage: getShelf failed", e);
    }
    this.#shelfCache = { key: cacheKey, value: items };
    return items;
  }

  setCheckpoint(threadId, note, lastUrl, lastTitle) {
    this.#checkpointRev++;
    const ts = Date.now();
    this.#writeQueue = this.#writeQueue.then(async () => {
      await this.#dbReady;
      if (!this.#db) {
        return;
      }
      try {
        // Automatic checkpoints (note = null) refresh position but keep any
        // typed note; a typed note always wins.
        await this.#db.execute(
          `INSERT INTO checkpoints (thread_id, ts, note, last_url, last_title)
           VALUES (:threadId, :ts, :note, :lastUrl, :lastTitle)
           ON CONFLICT(thread_id) DO UPDATE SET
             ts = :ts,
             note = COALESCE(:note, checkpoints.note),
             last_url = COALESCE(:lastUrl, checkpoints.last_url),
             last_title = COALESCE(:lastTitle, checkpoints.last_title)`,
          {
            threadId,
            ts,
            note: note ?? null,
            lastUrl: lastUrl ?? null,
            lastTitle: lastTitle ?? null,
          }
        );
      } catch (e) {
        console.error("ZenThreadsStorage: setCheckpoint failed", e);
      }
    });
  }

  async getCheckpoints() {
    const cacheKey = this.#checkpointRev;
    if (this.#checkpointCache?.key === cacheKey) {
      return this.#checkpointCache.value;
    }
    await this.#dbReady;
    await this.#writeQueue;
    const map = new Map();
    if (!this.#db) {
      return map;
    }
    try {
      const rows = await this.#db.executeCached(
        "SELECT thread_id, ts, note, last_url, last_title FROM checkpoints"
      );
      for (const row of rows) {
        map.set(row.getResultByName("thread_id"), {
          ts: row.getResultByName("ts"),
          note: row.getResultByName("note"),
          lastUrl: row.getResultByName("last_url"),
          lastTitle: row.getResultByName("last_title"),
        });
      }
    } catch (e) {
      console.error("ZenThreadsStorage: getCheckpoints failed", e);
    }
    this.#checkpointCache = { key: cacheKey, value: map };
    return map;
  }

  setThreadTitle(threadId, title) {
    this.#metaRev++;
    this.#writeQueue = this.#writeQueue.then(async () => {
      await this.#dbReady;
      if (!this.#db) {
        return;
      }
      try {
        await this.#db.execute(
          `INSERT INTO thread_meta (thread_id, title) VALUES (:threadId, :title)
           ON CONFLICT(thread_id) DO UPDATE SET title = :title`,
          { threadId, title }
        );
      } catch (e) {
        console.error("ZenThreadsStorage: setThreadTitle failed", e);
      }
    });
  }

  linkThreads(a, b) {
    this.#linkRev++;
    const ts = Date.now();
    this.#writeQueue = this.#writeQueue.then(async () => {
      await this.#dbReady;
      if (!this.#db) {
        return;
      }
      try {
        await this.#db.execute(
          `INSERT OR REPLACE INTO thread_links (a, b, ts)
           VALUES (:a, :b, :ts)`,
          { a, b, ts }
        );
      } catch (e) {
        console.error("ZenThreadsStorage: linkThreads failed", e);
      }
    });
  }

  async #getThreadLinks() {
    const links = [];
    if (!this.#db) {
      return links;
    }
    try {
      const rows = await this.#db.executeCached("SELECT a, b FROM thread_links");
      for (const row of rows) {
        links.push([row.getResultByName("a"), row.getResultByName("b")]);
      }
    } catch (e) {
      console.error("ZenThreadsStorage: getThreadLinks failed", e);
    }
    return links;
  }

  setThreadStatus(threadId, status) {
    this.#metaRev++;
    const ts = Date.now();
    this.#writeQueue = this.#writeQueue.then(async () => {
      await this.#dbReady;
      if (!this.#db) {
        return;
      }
      try {
        await this.#db.execute(
          `INSERT INTO thread_meta (thread_id, status, status_ts)
           VALUES (:threadId, :status, :ts)
           ON CONFLICT(thread_id) DO UPDATE SET status = :status, status_ts = :ts`,
          { threadId, status: status ?? null, ts }
        );
      } catch (e) {
        console.error("ZenThreadsStorage: setThreadStatus failed", e);
      }
    });
  }

  async #getThreadMeta() {
    const cacheKey = this.#metaRev;
    if (this.#metaCache?.key === cacheKey) {
      return this.#metaCache.value;
    }
    const map = new Map();
    if (!this.#db) {
      return map;
    }
    try {
      const rows = await this.#db.executeCached(
        "SELECT thread_id, title, status, status_ts FROM thread_meta"
      );
      for (const row of rows) {
        map.set(row.getResultByName("thread_id"), {
          title: row.getResultByName("title"),
          status: row.getResultByName("status"),
          statusTs: row.getResultByName("status_ts"),
        });
      }
    } catch (e) {
      console.error("ZenThreadsStorage: thread meta failed", e);
    }
    this.#metaCache = { key: cacheKey, value: map };
    return map;
  }

  /**
   * Read recent events and derive the thread structure.
   *
   * Returns { threads, loose }. Each thread:
   *   { id, title, isSearch, lastTs, roots: [node] }
   * Each node: { key, parent, url, title, isSearch, query, closed,
   *              lastTs, children: [node] }
   * "loose" holds nodes of components below the thread threshold.
   */
  async getSnapshot() {
    // The whole read is layered so the hot path stays cheap:
    //   1. fold   — replay only events recorded since the last call
    //   2. derive — rebuild the parent/child projection, cached on the log
    //               cursor and manual merge links
    //   3. meta   — apply renames/status and recompute time-based tiers,
    //               cheap enough to run on every call
    const timeBucket = Math.floor(Date.now() / 300000);
    const cacheKey = `${this.#eventSeq}:${this.#linkRev}:${this.#metaRev}:${timeBucket}`;
    if (this.#snapshotCache?.key === cacheKey) {
      return this.#snapshotCache.value;
    }
    await this.#dbReady;
    if (!this.#db) {
      return { threads: [], loose: [], nodeThread: new Map() };
    }
    await this.#advanceFold();

    const graphKey = `${this.#maxEventId}:${this.#linkRev}`;
    let graph;
    if (this.#graphCache?.key === graphKey) {
      graph = this.#graphCache.value;
    } else {
      graph = this.#deriveGraph(await this.#getThreadLinks());
      this.#graphCache = { key: graphKey, value: graph };
    }

    const meta = await this.#getThreadMeta();
    const now = Date.now();
    const threads = graph.shells.map(shell => {
      const m = meta.get(shell.id);
      const renamed = m?.title;
      // Fresh activity always reactivates a thread marked done.
      const done = m?.status === "done" && (m.statusTs ?? 0) >= shell.lastTs;
      const age = now - shell.lastTs;
      return {
        id: shell.id,
        title: renamed || shell.title,
        isSearch: renamed ? false : shell.isSearch,
        lastTs: shell.lastTs,
        roots: shell.roots,
        done,
        tier: done
          ? "archived"
          : age > ARCHIVE_MS
            ? "archived"
            : age > RECEDE_MS
              ? "receded"
              : "recent",
      };
    });

    const value = {
      threads: threads.slice(0, MAX_THREADS),
      loose: graph.loose,
      nodeThread: graph.nodeThread,
    };
    this.#snapshotCache = { key: cacheKey, value };
    return value;
  }

  /**
   * Replay events recorded since the last fold into scalar node state.
   * Safe as an incremental fold because every event touches exactly one
   * node, firstTs is write-once, and everything else is last-write-wins.
   * AUTOINCREMENT guarantees ids are never reused, so the cursor cannot
   * skip rows after a retention sweep.
   */
  async #advanceFold() {
    if (this.#foldedSeq === this.#eventSeq) {
      return; // nothing recorded since the last fold
    }
    // Only wait on pending writes when there is something to wait for.
    await this.#writeQueue;
    const seqAtRead = this.#eventSeq;

    const nodes = this.#nodes;
    const hostDays = this.#hostDays;
    const first = this.#maxEventId === 0;

    let rows;
    try {
      rows = first
        ? await this.#db.execute(
            `SELECT id, ts, kind, tab, parent, url, title, search_query
             FROM events WHERE ts > :cutoff ORDER BY id ASC`,
            { cutoff: Date.now() - SNAPSHOT_WINDOW_MS }
          )
        : await this.#db.executeCached(
            `SELECT id, ts, kind, tab, parent, url, title, search_query
             FROM events WHERE id > :sinceId ORDER BY id ASC`,
            { sinceId: this.#maxEventId }
          );
    } catch (e) {
      console.error("ZenThreadsStorage: fold query failed", e);
      return;
    }

    const nodeFor = key => {
      let node = nodes.get(key);
      if (!node) {
        node = {
          key,
          parent: null,
          url: "",
          title: "",
          isSearch: false,
          query: null,
          closed: true,
          firstTs: 0,
          lastTs: 0,
        };
        nodes.set(key, node);
      }
      return node;
    };

    for (const row of rows) {
      const id = row.getResultByName("id");
      if (id > this.#maxEventId) {
        this.#maxEventId = id;
      }
      const kind = row.getResultByName("kind");
      const key = row.getResultByName("tab");
      const ts = row.getResultByName("ts");
      const node = nodeFor(key);
      if (!node.firstTs) {
        node.firstTs = ts;
      }
      node.lastTs = ts;
      const parent = row.getResultByName("parent");
      if (parent && !node.parent && parent !== key) {
        node.parent = parent;
      }
      const url = row.getResultByName("url");
      const title = row.getResultByName("title");
      switch (kind) {
        case "close":
          node.closed = true;
          if (title) {
            node.title = title;
          }
          if (url && !node.url) {
            node.url = url;
          }
          break;
        case "nav": {
          node.closed = false;
          if (url) {
            node.url = url;
            try {
              const host = new URL(url).hostname.replace(/^www\./, "");
              let days = hostDays.get(host);
              if (!days) {
                days = new Set();
                hostDays.set(host, days);
              }
              days.add(Math.floor(ts / 86400000));
            } catch (e) {
              // Unparseable URL; ignore for app stats.
            }
          }
          if (title) {
            node.title = title;
          }
          const query = row.getResultByName("search_query");
          node.isSearch = !!query;
          node.query = query;
          break;
        }
        default:
          // open / seed / restore
          node.closed = false;
          if (title && !node.title) {
            node.title = title;
          }
          if (url && !node.url) {
            node.url = url;
          }
          break;
      }
    }

    this.#foldedSeq = seqAtRead;
  }

  /**
   * Rebuild the parent/child projection from folded state. Always builds
   * fresh node objects, so it can be re-run any number of times without
   * corrupting the fold. Returns { shells, loose, nodeThread }.
   */
  #deriveGraph(links) {
    const nodes = new Map();
    for (const [key, folded] of this.#nodes) {
      nodes.set(key, { ...folded, children: [] });
    }

    // Mark app nodes: they live outside the thread model entirely.
    const hostDays = this.#hostDays;
    const isAppHost = host =>
      APP_SEED_HOSTS.has(host) ||
      (hostDays.get(host)?.size ?? 0) >= APP_MIN_DAYS;
    for (const node of nodes.values()) {
      if (node.url) {
        try {
          node.isApp = isAppHost(
            new URL(node.url).hostname.replace(/^www\./, "")
          );
        } catch (e) {
          node.isApp = false;
        }
      }
    }

    // Link children; find each node's component root. App nodes neither
    // parent nor join anything.
    for (const node of nodes.values()) {
      if (node.isApp) {
        node.parent = null;
        continue;
      }
      if (
        node.parent &&
        nodes.has(node.parent) &&
        !nodes.get(node.parent).isApp
      ) {
        nodes.get(node.parent).children.push(node);
      } else {
        node.parent = null;
      }
    }
    const rootMemo = new Map();
    const rootOf = node => {
      const cached = rootMemo.get(node.key);
      if (cached) {
        return cached;
      }
      let cur = node;
      const path = [];
      const seen = new Set();
      while (cur.parent && nodes.has(cur.parent) && !seen.has(cur.key)) {
        seen.add(cur.key);
        path.push(cur);
        cur = nodes.get(cur.parent);
        const memo = rootMemo.get(cur.key);
        if (memo) {
          cur = memo;
          break;
        }
      }
      for (const visited of path) {
        rootMemo.set(visited.key, cur);
      }
      rootMemo.set(cur.key, cur);
      return cur;
    };

    // Group into components keyed by root.
    const components = new Map(); // rootKey -> {root, members, lastTs, firstTs}
    for (const node of nodes.values()) {
      if (node.isApp) {
        continue;
      }
      const root = rootOf(node);
      let comp = components.get(root.key);
      if (!comp) {
        comp = { root, members: [], lastTs: 0, firstTs: Infinity };
        components.set(root.key, comp);
      }
      comp.members.push(node);
      comp.lastTs = Math.max(comp.lastTs, node.lastTs);
      comp.firstTs = Math.min(comp.firstTs, node.firstTs);
    }

    // Apply manual merge links: union linked components (two passes to
    // resolve chains).
    for (let pass = 0; pass < 2; pass++) {
      for (const [a, b] of links) {
        const ca = components.get(a);
        const cb = components.get(b);
        if (ca && cb && ca !== cb) {
          ca.members.push(...cb.members);
          ca.lastTs = Math.max(ca.lastTs, cb.lastTs);
          ca.firstTs = Math.min(ca.firstTs, cb.firstTs);
          cb.root.parent = null;
          if (!ca.root.children.includes(cb.root)) {
            ca.root.children.push(cb.root);
          }
          components.delete(b);
          components.set(b, ca);
          components.set(a, ca);
        }
      }
    }
    const seenComps = new Set();

    const shells = [];
    const loose = [];
    for (const comp of components.values()) {
      if (seenComps.has(comp)) {
        continue;
      }
      seenComps.add(comp);
      const span = comp.lastTs - comp.firstTs;
      const hasSearchRoot = comp.root.isSearch;
      // Empty new-tab chains must never become threads.
      const hasContent = comp.members.some(n => /^https?:/.test(n.url));
      const qualifies =
        hasContent &&
        (hasSearchRoot ||
        comp.members.length >= THREAD_MIN_NODES ||
        span >= THREAD_MIN_SPAN_MS);
      if (!qualifies) {
        loose.push(...comp.members.filter(n => !n.parent));
        continue;
      }
      shells.push({
        id: comp.root.key,
        title: this.#titleFor(comp.root),
        isSearch: comp.root.isSearch,
        lastTs: comp.lastTs,
        roots: [comp.root],
      });
    }

    shells.sort((a, b) => b.lastTs - a.lastTs);
    loose.sort((a, b) => b.lastTs - a.lastTs);

    // Reverse index so callers can ask which thread a page belongs to
    // (used to resurface shelf items alongside their thread).
    const nodeThread = new Map();
    const indexNodes = (list, threadId) => {
      for (const node of list) {
        nodeThread.set(node.key, threadId);
        if (node.children.length) {
          indexNodes(node.children, threadId);
        }
      }
    };
    for (const shell of shells) {
      indexNodes(shell.roots, shell.id);
    }

    return { shells, loose, nodeThread };
  }

  /**
   * History as episodic memory: activity grouped into sessions of work on a
   * thread, rather than a flat list of URLs.
   *
   * Returns [{ dayStart, blocks: [{ threadId, title, isSearch, start, end,
   * pages }] }], most recent day first.
   */
  async getJournal(days = 14) {
    await this.#dbReady;
    await this.#writeQueue;
    if (!this.#db) {
      return [];
    }
    const { nodeThread, threads } = await this.getSnapshot();
    const titleById = new Map(
      threads.map(thread => [
        thread.id,
        { title: thread.title, isSearch: thread.isSearch },
      ])
    );

    let rows;
    try {
      rows = await this.#db.execute(
        `SELECT ts, tab, url FROM events
         WHERE kind = 'nav' AND ts > :cutoff ORDER BY ts ASC`,
        { cutoff: Date.now() - days * 86400000 }
      );
    } catch (e) {
      console.error("ZenThreadsStorage: journal query failed", e);
      return [];
    }

    const GAP_MS = 30 * 60 * 1000;
    const blocks = [];
    let current = null;
    for (const row of rows) {
      const tab = row.getResultByName("tab");
      const threadId = nodeThread.get(tab);
      if (!threadId) {
        continue; // app pages and sub-threshold noise stay out of the journal
      }
      const ts = row.getResultByName("ts");
      const url = row.getResultByName("url");
      if (
        current &&
        current.threadId === threadId &&
        ts - current.end <= GAP_MS
      ) {
        current.end = ts;
        current.urls.add(url);
      } else {
        current = { threadId, start: ts, end: ts, urls: new Set([url]) };
        blocks.push(current);
      }
    }

    const byDay = new Map();
    for (const block of blocks) {
      const date = new Date(block.start);
      date.setHours(0, 0, 0, 0);
      const dayStart = date.getTime();
      if (!byDay.has(dayStart)) {
        byDay.set(dayStart, []);
      }
      const meta = titleById.get(block.threadId);
      byDay.get(dayStart).push({
        threadId: block.threadId,
        title: meta?.title ?? "Untitled thread",
        isSearch: !!meta?.isSearch,
        start: block.start,
        end: block.end,
        pages: block.urls.size,
      });
    }

    return [...byDay.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([dayStart, dayBlocks]) => ({
        dayStart,
        blocks: dayBlocks.sort((a, b) => a.start - b.start),
      }));
  }

  #titleFor(root) {
    if (root.isSearch && root.query) {
      return root.query;
    }
    if (root.title) {
      return root.title;
    }
    if (root.url) {
      try {
        return new URL(root.url).hostname;
      } catch (e) {
        return root.url;
      }
    }
    return "Untitled thread";
  }
})();
