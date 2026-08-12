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
    } catch (e) {
      console.error("ZenThreadsStorage: open failed", e);
      this.#db = null;
    }
  }

  recordEvent(kind, tabKey, parentKey, url, title, query) {
    this.#writeQueue = this.#writeQueue.then(async () => {
      await this.#dbReady;
      if (!this.#db) {
        return;
      }
      try {
        await this.#db.execute(
          `INSERT INTO events (ts, kind, tab, parent, url, title, search_query)
           VALUES (:ts, :kind, :tab, :parent, :url, :title, :query)`,
          {
            ts: Date.now(),
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
    this.#writeQueue = this.#writeQueue.then(async () => {
      await this.#dbReady;
      if (!this.#db) {
        return;
      }
      try {
        await this.#db.execute(
          `INSERT INTO shelf (ts, url, title, tab_key)
           VALUES (:ts, :url, :title, :tabKey)`,
          { ts: Date.now(), url, title: title ?? null, tabKey: tabKey ?? null }
        );
      } catch (e) {
        console.error("ZenThreadsStorage: shelvePage failed", e);
      }
    });
  }

  resolveShelfItem(id, restored) {
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
    await this.#dbReady;
    await this.#writeQueue;
    const items = [];
    if (!this.#db) {
      return items;
    }
    try {
      const rows = await this.#db.execute(
        `SELECT id, ts, url, title FROM shelf
         WHERE resolved_ts IS NULL ORDER BY ts DESC LIMIT :limit`,
        { limit }
      );
      for (const row of rows) {
        items.push({
          id: row.getResultByName("id"),
          ts: row.getResultByName("ts"),
          url: row.getResultByName("url"),
          title: row.getResultByName("title"),
        });
      }
    } catch (e) {
      console.error("ZenThreadsStorage: getShelf failed", e);
    }
    return items;
  }

  setCheckpoint(threadId, note, lastUrl, lastTitle) {
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
            ts: Date.now(),
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
    await this.#dbReady;
    await this.#writeQueue;
    const map = new Map();
    if (!this.#db) {
      return map;
    }
    try {
      const rows = await this.#db.execute(
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
    return map;
  }

  setThreadTitle(threadId, title) {
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
    this.#writeQueue = this.#writeQueue.then(async () => {
      await this.#dbReady;
      if (!this.#db) {
        return;
      }
      try {
        await this.#db.execute(
          `INSERT OR REPLACE INTO thread_links (a, b, ts)
           VALUES (:a, :b, :ts)`,
          { a, b, ts: Date.now() }
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
      const rows = await this.#db.execute("SELECT a, b FROM thread_links");
      for (const row of rows) {
        links.push([row.getResultByName("a"), row.getResultByName("b")]);
      }
    } catch (e) {
      console.error("ZenThreadsStorage: getThreadLinks failed", e);
    }
    return links;
  }

  setThreadStatus(threadId, status) {
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
          { threadId, status: status ?? null, ts: Date.now() }
        );
      } catch (e) {
        console.error("ZenThreadsStorage: setThreadStatus failed", e);
      }
    });
  }

  async #getThreadMeta() {
    const map = new Map();
    if (!this.#db) {
      return map;
    }
    try {
      const rows = await this.#db.execute(
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
    await this.#dbReady;
    // Wait for pending writes so the snapshot reflects this session so far.
    await this.#writeQueue;
    if (!this.#db) {
      return { threads: [], loose: [] };
    }

    let rows;
    try {
      rows = await this.#db.execute(
        `SELECT ts, kind, tab, parent, url, title, search_query
         FROM events WHERE ts > :cutoff ORDER BY id ASC`,
        { cutoff: Date.now() - SNAPSHOT_WINDOW_MS }
      );
    } catch (e) {
      console.error("ZenThreadsStorage: snapshot query failed", e);
      return { threads: [], loose: [] };
    }

    // Fold the log into per-tab node state.
    const nodes = new Map(); // key -> node
    const hostDays = new Map(); // host -> Set(day) for app detection
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
          children: [],
        };
        nodes.set(key, node);
      }
      return node;
    };

    for (const row of rows) {
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

    // Mark app nodes: they live outside the thread model entirely.
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
    const rootOf = node => {
      let cur = node;
      const seen = new Set();
      while (cur.parent && nodes.has(cur.parent) && !seen.has(cur.key)) {
        seen.add(cur.key);
        cur = nodes.get(cur.parent);
      }
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
    const links = await this.#getThreadLinks();
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

    const threads = [];
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
      threads.push({
        id: comp.root.key,
        title: this.#titleFor(comp.root),
        isSearch: comp.root.isSearch,
        lastTs: comp.lastTs,
        roots: [comp.root],
      });
    }

    const meta = await this.#getThreadMeta();
    const now = Date.now();
    for (const thread of threads) {
      const m = meta.get(thread.id);
      if (m?.title) {
        thread.title = m.title;
        thread.isSearch = false;
      }
      // Lifecycle tier. Fresh activity always reactivates a done thread.
      const done = m?.status === "done" && (m.statusTs ?? 0) >= thread.lastTs;
      const age = now - thread.lastTs;
      thread.done = done;
      thread.tier = done
        ? "archived"
        : age > ARCHIVE_MS
          ? "archived"
          : age > RECEDE_MS
            ? "receded"
            : "recent";
    }

    threads.sort((a, b) => b.lastTs - a.lastTs);
    loose.sort((a, b) => b.lastTs - a.lastTs);
    return { threads: threads.slice(0, MAX_THREADS), loose };
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
