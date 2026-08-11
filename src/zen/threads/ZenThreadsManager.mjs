// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { nsZenDOMOperatedFeature } from "chrome://browser/content/zen-components/ZenCommonUtils.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Sqlite: "resource://gre/modules/Sqlite.sys.mjs",
});

// browser.xhtml is a XUL document: bare createElement() would produce XUL
// elements whose text content does not render. Always create HTML elements.
const XHTML_NS = "http://www.w3.org/1999/xhtml";

// Hosts recognized as search result pages, with their query params.
const SEARCH_ENGINES = [
  { pattern: /(^|\.)google\.[a-z.]+$/i, params: ["q"] },
  { pattern: /(^|\.)bing\.com$/i, params: ["q"] },
  { pattern: /(^|\.)duckduckgo\.com$/i, params: ["q"] },
  { pattern: /(^|\.)search\.brave\.com$/i, params: ["q"] },
  { pattern: /(^|\.)kagi\.com$/i, params: ["q"] },
  { pattern: /(^|\.)startpage\.com$/i, params: ["query", "q"] },
  { pattern: /(^|\.)ecosia\.org$/i, params: ["q"] },
];

/**
 * Threads spike 1: navigation provenance capture.
 *
 * Records which tab spawned which tab (opener chains) and every top-level
 * navigation, into an in-memory model rendered as a live trail panel
 * (Cmd/Ctrl+Shift+Y) and an append-only SQLite log (zen-threads.sqlite in
 * the profile) that later phases — Threads, episodic history, Compare —
 * will build on.
 */
class nsZenThreadsManager extends nsZenDOMOperatedFeature {
  #tabKeys = new WeakMap(); // tab element -> stable key
  #parents = new Map(); // tabKey -> parent tabKey
  #lastInfo = new Map(); // tabKey -> { url, title, isSearch, query, closed }
  #liveTabs = new Map(); // tabKey -> tab element
  #db = null;
  #dbReady = null;
  #writeQueue = Promise.resolve();
  #progressListener = null;

  init() {
    try {
      this.#dbReady = this.#openDb();
      window.addEventListener("unload", this, { once: true });
      // gBrowser does not exist yet at DOMContentLoaded — wait for the
      // window's delayed startup before touching tabs.
      if (
        typeof gBrowserInit !== "undefined" &&
        gBrowserInit.delayedStartupFinished
      ) {
        this.#start();
      } else {
        const topic = "browser-delayed-startup-finished";
        const observer = subject => {
          if (subject === window) {
            Services.obs.removeObserver(observer, topic);
            this.#start();
          }
        };
        Services.obs.addObserver(observer, topic);
      }
    } catch (e) {
      console.error("ZenThreads: init failed", e);
    }
  }

  #start() {
    try {
      for (const tab of gBrowser.tabs) {
        this.#registerTab(tab, tab.openerTab ?? null, "seed");
      }
      window.addEventListener("TabOpen", this);
      window.addEventListener("TabClose", this);
      window.addEventListener("keydown", this, true);
      this.#progressListener = {
        onLocationChange: (browser, webProgress, request, location, flags) => {
          try {
            if (!webProgress?.isTopLevel) {
              return;
            }
            if (
              flags &
              Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT
            ) {
              return;
            }
            const tab = gBrowser.getTabForBrowser(browser);
            if (tab) {
              this.#recordNavigation(tab, location);
            }
          } catch (e) {
            console.error("ZenThreads: failed to record navigation", e);
          }
        },
      };
      gBrowser.addTabsProgressListener(this.#progressListener);
    } catch (e) {
      console.error("ZenThreads: start failed", e);
    }
  }

  handleEvent(event) {
    try {
      switch (event.type) {
        case "TabOpen": {
          const tab = event.target;
          this.#registerTab(tab, tab.openerTab ?? null, "open");
          break;
        }
        case "TabClose": {
          const tab = event.target;
          const key = this.#tabKeys.get(tab);
          if (key) {
            const info = this.#lastInfo.get(key);
            if (info) {
              info.closed = true;
              info.title = tab.label || info.title;
            }
            this.#liveTabs.delete(key);
            this.#write("close", key, null, info?.url, tab.label, null);
          }
          break;
        }
        case "keydown": {
          if (
            event.ctrlKey &&
            !event.metaKey &&
            event.shiftKey &&
            !event.altKey &&
            event.key.toLowerCase() === "y"
          ) {
            event.preventDefault();
            event.stopPropagation();
            this.togglePanel();
            break;
          }
          if (event.key === "Escape") {
            const panel = document.getElementById("zen-threads-panel");
            if (panel && !panel.hidden) {
              panel.hidden = true;
            }
          }
          break;
        }
        case "unload": {
          this.#shutdown();
          break;
        }
      }
    } catch (e) {
      console.error("ZenThreads: event handling failed", e);
    }
  }

  togglePanel() {
    const panel = document.getElementById("zen-threads-panel");
    if (!panel) {
      return;
    }
    if (panel.hidden) {
      this.#render();
      panel.hidden = false;
    } else {
      panel.hidden = true;
    }
  }

  // -- capture ---------------------------------------------------------------

  #keyFor(tab) {
    let key = this.#tabKeys.get(tab);
    if (!key) {
      key = Services.uuid.generateUUID().toString().slice(1, -1);
      this.#tabKeys.set(tab, key);
    }
    return key;
  }

  #registerTab(tab, openerTab, how) {
    const key = this.#keyFor(tab);
    this.#liveTabs.set(key, tab);
    let parentKey = null;
    if (openerTab) {
      parentKey = this.#keyFor(openerTab);
      this.#parents.set(key, parentKey);
    }
    if (!this.#lastInfo.has(key)) {
      this.#lastInfo.set(key, {
        url: "",
        title: tab.label || "",
        isSearch: false,
        query: null,
        closed: false,
      });
    }
    this.#write(how, key, parentKey, null, tab.label, null);
    const uri = tab.linkedBrowser?.currentURI;
    if (uri && uri.spec && uri.spec !== "about:blank") {
      this.#recordNavigation(tab, uri);
    }
  }

  #recordNavigation(tab, uri) {
    const key = this.#keyFor(tab);
    const spec = uri.spec;
    if (!spec || spec === "about:blank") {
      return;
    }
    const search = this.#detectSearch(spec);
    const info = this.#lastInfo.get(key) ?? {};
    info.url = spec;
    info.title = tab.label || spec;
    info.isSearch = !!search;
    info.query = search;
    info.closed = false;
    this.#lastInfo.set(key, info);
    this.#write("nav", key, this.#parents.get(key) ?? null, spec, tab.label, search);
  }

  #detectSearch(spec) {
    try {
      const url = new URL(spec);
      for (const engine of SEARCH_ENGINES) {
        if (engine.pattern.test(url.hostname)) {
          for (const param of engine.params) {
            const q = url.searchParams.get(param);
            if (q) {
              return q;
            }
          }
        }
      }
    } catch (e) {
      // Non-standard URL (about:, view-source:, ...) — not a search.
    }
    return null;
  }

  // -- storage ---------------------------------------------------------------

  async #openDb() {
    try {
      const path = PathUtils.join(PathUtils.profileDir, "zen-threads.sqlite");
      const db = await lazy.Sqlite.openConnection({ path });
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
      this.#db = db;
    } catch (e) {
      console.error("ZenThreads: could not open zen-threads.sqlite", e);
      this.#db = null;
    }
  }

  #write(kind, tabKey, parentKey, url, title, query) {
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
            parent: parentKey,
            url: url ?? null,
            title: title ?? null,
            query: query ?? null,
          }
        );
      } catch (e) {
        console.error("ZenThreads: failed to write event", e);
      }
    });
  }

  #shutdown() {
    try {
      if (this.#progressListener) {
        gBrowser.removeTabsProgressListener(this.#progressListener);
      }
    } catch (e) {
      // Window is going away; nothing useful to do.
    }
    this.#writeQueue = this.#writeQueue.then(async () => {
      if (this.#db) {
        const db = this.#db;
        this.#db = null;
        await db.close().catch(() => {});
      }
    });
  }

  // -- rendering -------------------------------------------------------------

  #render() {
    const content = document.getElementById("zen-threads-content");
    if (!content) {
      return;
    }
    content.replaceChildren();

    // Keys worth showing: all live tabs plus closed ancestors of live tabs.
    const visible = new Set(this.#liveTabs.keys());
    for (const key of this.#liveTabs.keys()) {
      let parent = this.#parents.get(key);
      while (parent && !visible.has(parent)) {
        if (!this.#lastInfo.has(parent)) {
          break;
        }
        visible.add(parent);
        parent = this.#parents.get(parent);
      }
    }

    const children = new Map();
    const roots = [];
    for (const key of visible) {
      const parent = this.#parents.get(key);
      if (parent && visible.has(parent)) {
        if (!children.has(parent)) {
          children.set(parent, []);
        }
        children.get(parent).push(key);
      } else {
        roots.push(key);
      }
    }

    if (!roots.length) {
      const empty = document.createElementNS(XHTML_NS, "div");
      empty.className = "zen-threads-empty";
      empty.textContent = "No trails yet — browse a little.";
      content.appendChild(empty);
      return;
    }

    for (const root of roots) {
      content.appendChild(this.#renderNode(root, children));
    }
  }

  #renderNode(key, children) {
    const info = this.#lastInfo.get(key) ?? { title: "(unknown)", url: "" };
    const tab = this.#liveTabs.get(key);

    const node = document.createElementNS(XHTML_NS, "div");
    node.className = "zen-thread-node";

    const row = document.createElementNS(XHTML_NS, "div");
    row.className = "zen-thread-row";
    if (!tab) {
      row.classList.add("zen-thread-closed");
    }
    if (info.isSearch) {
      row.classList.add("zen-thread-search");
    }

    const title = document.createElementNS(XHTML_NS, "span");
    title.className = "zen-thread-title";
    if (info.isSearch && info.query) {
      title.textContent = `\u{1F50D} ${info.query}`;
    } else {
      title.textContent = (tab ? tab.label : info.title) || info.url || "(empty)";
    }
    row.appendChild(title);

    if (!info.isSearch && info.url) {
      const url = document.createElementNS(XHTML_NS, "span");
      url.className = "zen-thread-url";
      try {
        url.textContent = new URL(info.url).hostname;
      } catch (e) {
        url.textContent = info.url;
      }
      row.appendChild(url);
    }

    if (tab) {
      row.addEventListener("click", () => {
        gBrowser.selectedTab = tab;
      });
    }
    node.appendChild(row);

    const kids = children.get(key);
    if (kids?.length) {
      const container = document.createElementNS(XHTML_NS, "div");
      container.className = "zen-thread-children";
      for (const kid of kids) {
        container.appendChild(this.#renderNode(kid, children));
      }
      node.appendChild(container);
    }
    return node;
  }
}

try {
  window.gZenThreadsManager = new nsZenThreadsManager();
} catch (e) {
  console.error("ZenThreads: bootstrap failed", e);
}
