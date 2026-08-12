// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { nsZenDOMOperatedFeature } from "chrome://browser/content/zen-components/ZenCommonUtils.mjs";

// Process-wide singleton: all windows share one storage/inference instance.
const { ZenThreadsStorage } = ChromeUtils.importESModule(
  "chrome://browser/content/zen-components/ZenThreadsStorage.sys.mjs"
);

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SessionStore: "resource:///modules/sessionstore/SessionStore.sys.mjs",
});

// browser.xhtml is a XUL document: bare createElement() would produce XUL
// elements whose text content does not render. Always create HTML elements.
const XHTML_NS = "http://www.w3.org/1999/xhtml";

// SessionStore custom value carrying a tab's stable thread key, so trails
// survive session restore.
const TAB_KEY_PROP = "zenThreadKey";

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
 * Per-window Threads feature: captures provenance events into the shared
 * ZenThreadsStorage and renders the trail panel (Ctrl+Shift+Y).
 */
class nsZenThreadsManager extends nsZenDOMOperatedFeature {
  #tabKeys = new WeakMap(); // tab element -> stable key
  #progressListener = null;
  #pendingReopenParent = null; // parent key for a panel-initiated reopen
  #folderMap = new Map(); // threadId -> folderId
  #folderIds = new Set(); // folder ids created from threads (auto-flow)
  #parents = new Map(); // session tabKey -> parent tabKey (root lookup)
  #lastSelected = null; // previously selected tab (checkpoint capture)
  #sidebarEl = null;
  #sidebarRefreshTimer = null;
  #expandedSidebarThreads = new Set();
  #showArchived = false;
  #mergeSource = null; // thread id armed for merging

  init() {
    try {
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
      ZenThreadsStorage.getThreadFolders()
        .then(map => {
          this.#folderMap = map;
          this.#folderIds = new Set(map.values());
        })
        .catch(() => {});
      this.#lastSelected = gBrowser.selectedTab;
      window.addEventListener("TabOpen", this);
      window.addEventListener("TabClose", this);
      window.addEventListener("TabSelect", this);
      window.addEventListener("SSTabRestoring", this);
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
              this.#queueSidebarRefresh();
            }
          } catch (e) {
            console.error("ZenThreads: failed to record navigation", e);
          }
        },
      };
      gBrowser.addTabsProgressListener(this.#progressListener);
      this.#initSidebar();
      // Register the Intent Bar provider (process-wide, idempotent).
      ChromeUtils.importESModule(
        "chrome://browser/content/zen-components/ZenThreadsUrlbarProvider.sys.mjs"
      );
    } catch (e) {
      console.error("ZenThreads: start failed", e);
    }
  }

  handleEvent(event) {
    try {
      switch (event.type) {
        case "TabOpen": {
          const tab = event.target;
          const parentOverride = this.#pendingReopenParent;
          this.#pendingReopenParent = null;
          this.#registerTab(
            tab,
            tab.openerTab ?? null,
            "open",
            parentOverride
          );
          // Auto-flow: a page opened from a grouped thread joins its folder.
          const openerGroup = tab.openerTab?.group;
          if (
            openerGroup?.isZenFolder &&
            this.#folderIds.has(openerGroup.id)
          ) {
            try {
              gBrowser.pinTab(tab);
              openerGroup.addTabs([tab]);
            } catch (e) {
              console.error("ZenThreads: auto-flow failed", e);
            }
          }
          this.#queueSidebarRefresh();
          break;
        }
        case "TabClose": {
          const tab = event.target;
          const key = this.#tabKeys.get(tab);
          if (key) {
            ZenThreadsStorage.recordEvent(
              "close",
              key,
              null,
              tab.linkedBrowser?.currentURI?.spec ?? null,
              tab.label,
              null
            );
          }
          this.#queueSidebarRefresh();
          break;
        }
        case "SSTabRestoring": {
          // A restored tab carries its key from the previous session; adopt
          // it so the trail continues instead of forking.
          const tab = event.target;
          const stored = this.#storedKey(tab);
          if (stored && this.#tabKeys.get(tab) !== stored) {
            this.#tabKeys.set(tab, stored);
            ZenThreadsStorage.recordEvent(
              "restore",
              stored,
              null,
              tab.linkedBrowser?.currentURI?.spec ?? null,
              tab.label,
              null
            );
          }
          break;
        }
        case "TabSelect": {
          const prev = this.#lastSelected;
          const next = event.target;
          this.#lastSelected = next;
          if (prev && prev !== next && !prev.closing) {
            const prevKey = this.#tabKeys.get(prev);
            const nextKey = this.#tabKeys.get(next);
            if (prevKey) {
              const prevRoot = this.#rootKeyOf(prevKey);
              const nextRoot = nextKey ? this.#rootKeyOf(nextKey) : null;
              if (prevRoot !== nextRoot) {
                ZenThreadsStorage.setCheckpoint(
                  prevRoot,
                  null,
                  prev.linkedBrowser?.currentURI?.spec ?? null,
                  prev.label ?? null
                );
              }
            }
          }
          this.#queueSidebarRefresh();
          break;
        }
        case "keydown": {
          if (
            event.metaKey &&
            !event.ctrlKey &&
            !event.shiftKey &&
            !event.altKey &&
            event.key.toLowerCase() === "s"
          ) {
            const ae = document.activeElement;
            if (
              ae &&
              (ae.localName === "input" || ae.localName === "textarea")
            ) {
              break; // typing in chrome UI — leave Cmd+S alone
            }
            if (this.#shelveCurrent()) {
              event.preventDefault();
              event.stopPropagation();
            }
            break;
          }
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
          try {
            if (this.#progressListener) {
              gBrowser.removeTabsProgressListener(this.#progressListener);
            }
          } catch (e) {
            // Window teardown; nothing useful to do.
          }
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
      panel.hidden = false;
      this.#render().catch(e =>
        console.error("ZenThreads: render failed", e)
      );
    } else {
      panel.hidden = true;
    }
  }

  // -- capture ---------------------------------------------------------------

  #storedKey(tab) {
    try {
      return lazy.SessionStore.getCustomTabValue(tab, TAB_KEY_PROP) || null;
    } catch (e) {
      return null;
    }
  }

  #keyFor(tab) {
    let key = this.#tabKeys.get(tab);
    if (key) {
      return key;
    }
    key = this.#storedKey(tab);
    if (!key) {
      key = Services.uuid.generateUUID().toString().slice(1, -1);
      try {
        lazy.SessionStore.setCustomTabValue(tab, TAB_KEY_PROP, key);
      } catch (e) {
        // Tab may not be trackable yet; the key still works for this session.
      }
    }
    this.#tabKeys.set(tab, key);
    return key;
  }

  #registerTab(tab, openerTab, how, parentKeyOverride = null) {
    const key = this.#keyFor(tab);
    let parentKey = parentKeyOverride;
    if (!parentKey && openerTab) {
      parentKey = this.#keyFor(openerTab);
    }
    if (parentKey) {
      this.#parents.set(key, parentKey);
    }
    ZenThreadsStorage.recordEvent(how, key, parentKey, null, tab.label, null);
    const uri = tab.linkedBrowser?.currentURI;
    if (uri && uri.spec && uri.spec !== "about:blank") {
      this.#recordNavigation(tab, uri);
    }
  }

  #recordNavigation(tab, uri) {
    const spec = uri.spec;
    if (!spec || !/^https?:/.test(spec)) {
      return; // only real web navigations belong in trails
    }
    const key = this.#keyFor(tab);
    const query = this.#detectSearch(spec);
    ZenThreadsStorage.recordEvent("nav", key, null, spec, tab.label, query);
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

  // -- rendering -------------------------------------------------------------

  async #render() {
    const content = document.getElementById("zen-threads-content");
    if (!content) {
      return;
    }
    const [{ threads, loose }, shelf, checkpoints] = await Promise.all([
      ZenThreadsStorage.getSnapshot(),
      ZenThreadsStorage.getShelf(),
      ZenThreadsStorage.getCheckpoints(),
    ]);

    const liveTabs = this.#buildLiveMap();

    content.replaceChildren();

    if (shelf.length) {
      content.appendChild(this.#renderShelf(shelf));
    }

    if (!threads.length && !loose.length && !shelf.length) {
      const empty = document.createElementNS(XHTML_NS, "div");
      empty.className = "zen-threads-empty";
      empty.textContent = "No trails yet — browse a little.";
      content.appendChild(empty);
      return;
    }

    const recent = [];
    const receded = [];
    const archived = [];
    for (const thread of threads) {
      if (thread.tier !== "archived" && this.#containsLive(thread.roots, liveTabs)) {
        recent.push(thread);
      } else if (thread.tier === "recent") {
        recent.push(thread);
      } else if (thread.tier === "receded") {
        receded.push(thread);
      } else {
        archived.push(thread);
      }
    }

    for (const thread of recent) {
      content.appendChild(this.#renderThread(thread, liveTabs, checkpoints));
    }

    if (receded.length) {
      const group = document.createElementNS(XHTML_NS, "div");
      group.className = "zen-thread-section zen-threads-earlier collapsed";
      const header = document.createElementNS(XHTML_NS, "div");
      header.className = "zen-thread-header zen-thread-loose-header";
      header.textContent = `Earlier · ${receded.length}`;
      header.addEventListener("click", () =>
        group.classList.toggle("collapsed")
      );
      group.appendChild(header);
      const body = document.createElementNS(XHTML_NS, "div");
      body.className = "zen-thread-body";
      for (const thread of receded) {
        body.appendChild(this.#renderThread(thread, liveTabs, checkpoints));
      }
      group.appendChild(body);
      content.appendChild(group);
    }

    if (archived.length) {
      const toggle = document.createElementNS(XHTML_NS, "div");
      toggle.className = "zen-threads-archived-toggle";
      toggle.textContent = this.#showArchived
        ? "Hide archived"
        : `Show archived · ${archived.length}`;
      toggle.addEventListener("click", () => {
        this.#showArchived = !this.#showArchived;
        this.#render().catch(() => {});
      });
      content.appendChild(toggle);
      if (this.#showArchived) {
        for (const thread of archived) {
          content.appendChild(
            this.#renderThread(thread, liveTabs, checkpoints)
          );
        }
      }
    }

    const liveLoose = loose.filter(n => liveTabs.has(n.key));
    if (liveLoose.length) {
      const section = document.createElementNS(XHTML_NS, "div");
      section.className = "zen-thread-section";
      const header = document.createElementNS(XHTML_NS, "div");
      header.className = "zen-thread-header zen-thread-loose-header";
      header.textContent = "Loose tabs";
      section.appendChild(header);
      const body = document.createElementNS(XHTML_NS, "div");
      body.className = "zen-thread-body";
      for (const node of liveLoose) {
        body.appendChild(this.#renderNode(node, liveTabs));
      }
      section.appendChild(body);
      content.appendChild(section);
    }
  }

  #buildLiveMap() {
    const map = new Map();
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      if (win.closed || !win.gBrowser) {
        continue;
      }
      for (const tab of win.gBrowser.tabs) {
        let key = win === window ? this.#tabKeys.get(tab) : null;
        if (!key) {
          try {
            key =
              lazy.SessionStore.getCustomTabValue(tab, TAB_KEY_PROP) || null;
          } catch (e) {
            key = null;
          }
        }
        if (key && !map.has(key)) {
          map.set(key, { tab, win });
        }
      }
    }
    return map;
  }

  #renderShelf(items) {
    const section = document.createElementNS(XHTML_NS, "div");
    section.className = "zen-thread-section zen-shelf-section";

    const header = document.createElementNS(XHTML_NS, "div");
    header.className = "zen-thread-header";
    const title = document.createElementNS(XHTML_NS, "span");
    title.className = "zen-thread-title";
    title.textContent = "Shelf";
    header.appendChild(title);
    const meta = document.createElementNS(XHTML_NS, "span");
    meta.className = "zen-thread-meta";
    meta.textContent = String(items.length);
    header.appendChild(meta);
    header.addEventListener("click", () => {
      section.classList.toggle("collapsed");
    });
    section.appendChild(header);

    const body = document.createElementNS(XHTML_NS, "div");
    body.className = "zen-thread-body";
    for (const item of items) {
      const row = document.createElementNS(XHTML_NS, "div");
      row.className = "zen-thread-row zen-shelf-row";
      const rowTitle = document.createElementNS(XHTML_NS, "span");
      rowTitle.className = "zen-thread-title";
      rowTitle.textContent = item.title || item.url;
      row.appendChild(rowTitle);
      const host = document.createElementNS(XHTML_NS, "span");
      host.className = "zen-thread-url";
      try {
        host.textContent = new URL(item.url).hostname;
      } catch (e) {
        host.textContent = "";
      }
      row.appendChild(host);
      const dismiss = document.createElementNS(XHTML_NS, "span");
      dismiss.className = "zen-shelf-x";
      dismiss.textContent = "×";
      dismiss.title = "Remove from shelf";
      dismiss.addEventListener("click", e => {
        e.stopPropagation();
        ZenThreadsStorage.resolveShelfItem(item.id, false);
        this.#render().catch(() => {});
      });
      row.appendChild(dismiss);
      row.addEventListener("click", () => {
        try {
          const tab = gBrowser.addTab(item.url, {
            triggeringPrincipal:
              Services.scriptSecurityManager.getSystemPrincipal(),
          });
          gBrowser.selectedTab = tab;
          ZenThreadsStorage.resolveShelfItem(item.id, true);
          this.#render().catch(() => {});
        } catch (e) {
          console.error("ZenThreads: shelf reopen failed", e);
        }
      });
      body.appendChild(row);
    }
    section.appendChild(body);
    return section;
  }

  #renderThread(thread, liveTabs, checkpoints) {
    const hasLive = this.#containsLive(thread.roots, liveTabs);

    const section = document.createElementNS(XHTML_NS, "div");
    section.className = "zen-thread-section";
    if (!hasLive) {
      section.classList.add("collapsed");
    }

    const header = document.createElementNS(XHTML_NS, "div");
    header.className = "zen-thread-header";
    const title = document.createElementNS(XHTML_NS, "span");
    title.className = "zen-thread-title";
    title.textContent = thread.isSearch
      ? `\u{1F50D} ${thread.title}`
      : thread.title;
    title.title = "Double-click to rename";
    title.addEventListener("dblclick", e => {
      e.stopPropagation();
      this.#startRename(thread, header);
    });
    header.appendChild(title);
    const meta = document.createElementNS(XHTML_NS, "span");
    meta.className = "zen-thread-meta";
    meta.textContent = this.#relativeTime(thread.lastTs);
    header.appendChild(meta);

    const liveThreadTabs = [];
    this.#collectLiveTabs(thread.roots, liveTabs, liveThreadTabs);
    const folderId = this.#folderMap.get(thread.id);
    const folder =
      folderId &&
      (gBrowser.tabGroups || []).find(
        g => g.id === folderId && g.isZenFolder
      );
    if (thread.id === this.#mergeSource) {
      section.classList.add("zen-thread-merge-armed");
    }
    const merge = document.createElementNS(XHTML_NS, "span");
    merge.className = "zen-thread-done-btn zen-thread-merge-btn";
    merge.textContent = "⇆";
    merge.title =
      this.#mergeSource && this.#mergeSource !== thread.id
        ? "Merge the armed thread into this one"
        : "Merge: arm this thread, then click ⇆ on the destination";
    merge.addEventListener("click", e => {
      e.stopPropagation();
      if (!this.#mergeSource) {
        this.#mergeSource = thread.id;
      } else if (this.#mergeSource === thread.id) {
        this.#mergeSource = null;
      } else {
        ZenThreadsStorage.linkThreads(thread.id, this.#mergeSource);
        this.#mergeSource = null;
        this.#queueSidebarRefresh();
      }
      this.#render().catch(() => {});
    });
    header.appendChild(merge);

    const done = document.createElementNS(XHTML_NS, "span");
    done.className = "zen-thread-done-btn";
    done.textContent = thread.done ? "↺" : "✓";
    done.title = thread.done
      ? "Restore this thread"
      : "Done — archive thread and close its tabs";
    done.addEventListener("click", e => {
      e.stopPropagation();
      if (thread.done) {
        ZenThreadsStorage.setThreadStatus(thread.id, null);
      } else {
        ZenThreadsStorage.setThreadStatus(thread.id, "done");
        for (const t of liveThreadTabs) {
          try {
            gBrowser.removeTab(t, { animate: true });
          } catch (err) {
            // Tab already gone.
          }
        }
      }
      this.#queueSidebarRefresh();
      setTimeout(() => this.#render().catch(() => {}), 150);
    });
    header.appendChild(done);

    if (folder) {
      const badge = document.createElementNS(XHTML_NS, "span");
      badge.className = "zen-thread-folder-badge";
      badge.textContent = "\u{1F4C1}";
      badge.title = "Grouped in sidebar";
      header.appendChild(badge);
    } else if (
      liveThreadTabs.length >= 2 &&
      typeof gZenFolders !== "undefined"
    ) {
      const btn = document.createElementNS(XHTML_NS, "span");
      btn.className = "zen-thread-group-btn";
      btn.textContent = "Group";
      btn.title = "Group this thread's tabs into a sidebar folder";
      btn.addEventListener("click", e => {
        e.stopPropagation();
        this.#groupThread(thread, liveThreadTabs);
      });
      header.appendChild(btn);
    }

    header.addEventListener("click", () => {
      section.classList.toggle("collapsed");
    });
    section.appendChild(header);

    const body = document.createElementNS(XHTML_NS, "div");
    body.className = "zen-thread-body";

    const cp = checkpoints?.get(thread.id);
    if (cp && (cp.note || cp.lastTitle)) {
      const line = document.createElementNS(XHTML_NS, "div");
      line.className = "zen-thread-checkpoint";
      line.textContent = cp.note
        ? `↩ next: ${cp.note}`
        : `↩ you were at: ${cp.lastTitle}`;
      body.appendChild(line);
    }

    for (const root of thread.roots) {
      body.appendChild(this.#renderNode(root, liveTabs));
    }

    const noteInput = document.createElementNS(XHTML_NS, "input");
    noteInput.className = "zen-thread-note-input";
    noteInput.placeholder = "next: …";
    noteInput.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Enter") {
        const value = noteInput.value.trim();
        if (value) {
          ZenThreadsStorage.setCheckpoint(thread.id, value, null, null);
          this.#render().catch(() => {});
        }
      }
    });
    noteInput.addEventListener("click", e => e.stopPropagation());
    body.appendChild(noteInput);

    section.appendChild(body);
    return section;
  }

  #startRename(thread, headerEl) {
    const input = document.createElementNS(XHTML_NS, "input");
    input.className = "zen-thread-rename-input";
    input.value = thread.title;
    const finish = commit => {
      if (commit) {
        const value = input.value.trim();
        if (value && value !== thread.title) {
          ZenThreadsStorage.setThreadTitle(thread.id, value);
          const folderId = this.#folderMap.get(thread.id);
          const folder =
            folderId &&
            (gBrowser.tabGroups || []).find(
              g => g.id === folderId && g.isZenFolder
            );
          if (folder) {
            folder.label = value;
          }
        }
      }
      this.#render().catch(() => {});
    };
    input.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Enter") {
        finish(true);
      } else if (e.key === "Escape") {
        finish(false);
      }
    });
    input.addEventListener("click", e => e.stopPropagation());
    headerEl.replaceChildren(input);
    input.focus();
    input.select();
  }

  #containsLive(nodes, liveTabs) {
    for (const node of nodes) {
      if (liveTabs.has(node.key)) {
        return true;
      }
      if (node.children.length && this.#containsLive(node.children, liveTabs)) {
        return true;
      }
    }
    return false;
  }

  #renderNode(node, liveTabs) {
    const container = document.createElementNS(XHTML_NS, "div");
    container.className = "zen-thread-node";

    const entry = liveTabs.get(node.key);
    const row = document.createElementNS(XHTML_NS, "div");
    row.className = "zen-thread-row";
    if (!entry) {
      row.classList.add("zen-thread-closed");
    }
    if (node.isSearch) {
      row.classList.add("zen-thread-search");
    }

    const title = document.createElementNS(XHTML_NS, "span");
    title.className = "zen-thread-title";
    if (node.isSearch && node.query) {
      title.textContent = `\u{1F50D} ${node.query}`;
    } else {
      title.textContent =
        (entry ? entry.tab.label : node.title) || node.url || "(empty)";
    }
    row.appendChild(title);

    if (!node.isSearch && node.url) {
      const url = document.createElementNS(XHTML_NS, "span");
      url.className = "zen-thread-url";
      try {
        url.textContent = new URL(node.url).hostname;
      } catch (e) {
        url.textContent = node.url;
      }
      row.appendChild(url);
    }

    row.addEventListener("click", () => {
      if (entry) {
        entry.win.focus();
        entry.win.gBrowser.selectedTab = entry.tab;
      } else if (node.url) {
        this.#reopen(node);
      }
    });
    container.appendChild(row);

    if (node.children.length) {
      const children = document.createElementNS(XHTML_NS, "div");
      children.className = "zen-thread-children";
      for (const child of node.children) {
        children.appendChild(this.#renderNode(child, liveTabs));
      }
      container.appendChild(children);
    }
    return container;
  }

  #reopen(node) {
    try {
      // The TabOpen handler consumes this so the reopened page becomes a
      // child of the ghost node and stays inside its thread.
      this.#pendingReopenParent = node.key;
      const tab = gBrowser.addTab(node.url, {
        triggeringPrincipal:
          Services.scriptSecurityManager.getSystemPrincipal(),
      });
      gBrowser.selectedTab = tab;
      this.#render().catch(() => {});
    } catch (e) {
      this.#pendingReopenParent = null;
      console.error("ZenThreads: reopen failed", e);
    }
  }

  #collectLiveTabs(nodes, liveTabs, out) {
    for (const node of nodes) {
      const entry = liveTabs.get(node.key);
      if (
        entry &&
        entry.win === window &&
        !entry.tab.pinned &&
        !out.includes(entry.tab)
      ) {
        out.push(entry.tab);
      }
      if (node.children.length) {
        this.#collectLiveTabs(node.children, liveTabs, out);
      }
    }
  }

  #rootKeyOf(key) {
    let cur = key;
    const seen = new Set();
    while (this.#parents.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = this.#parents.get(cur);
    }
    return cur;
  }

  #shelveCurrent() {
    try {
      const tab = gBrowser.selectedTab;
      const uri = tab?.linkedBrowser?.currentURI;
      if (!uri || !/^https?$/.test(uri.scheme)) {
        return false; // let the native Save dialog handle non-web pages
      }
      const key = this.#tabKeys.get(tab) ?? null;
      ZenThreadsStorage.shelvePage(uri.spec, tab.label, key);
      if (gBrowser.tabs.length > 1) {
        gBrowser.removeTab(tab, { animate: true });
      } else {
        gBrowser.selectedBrowser.fixupAndLoadURIString("about:newtab", {
          triggeringPrincipal:
            Services.scriptSecurityManager.getSystemPrincipal(),
        });
      }
      return true;
    } catch (e) {
      console.error("ZenThreads: shelve failed", e);
      return false;
    }
  }

  #groupThread(thread, tabs) {
    try {
      const folder = gZenFolders.createFolder(tabs, {
        label: thread.title,
        saveOnWindowClose: true,
      });
      if (folder?.id) {
        this.#folderMap.set(thread.id, folder.id);
        this.#folderIds.add(folder.id);
        ZenThreadsStorage.setThreadFolder(thread.id, folder.id);
      }
      this.#render().catch(() => {});
    } catch (e) {
      console.error("ZenThreads: grouping failed", e);
    }
  }

  #initSidebar() {
    try {
      const foot = document.getElementById("zen-sidebar-foot-buttons");
      if (!foot || !foot.parentNode) {
        return;
      }
      const el = document.createElementNS(XHTML_NS, "div");
      el.id = "zen-threads-sidebar";
      foot.parentNode.insertBefore(el, foot);
      this.#sidebarEl = el;
      this.#queueSidebarRefresh();
    } catch (e) {
      console.error("ZenThreads: sidebar init failed", e);
    }
  }

  #queueSidebarRefresh() {
    if (!this.#sidebarEl) {
      return;
    }
    if (this.#sidebarRefreshTimer) {
      clearTimeout(this.#sidebarRefreshTimer);
    }
    this.#sidebarRefreshTimer = setTimeout(() => {
      this.#sidebarRefreshTimer = null;
      this.#refreshSidebar().catch(e =>
        console.error("ZenThreads: sidebar refresh failed", e)
      );
    }, 400);
  }

  async #refreshSidebar() {
    const el = this.#sidebarEl;
    if (!el || !el.isConnected) {
      return;
    }
    const [{ threads }, shelf, checkpoints] = await Promise.all([
      ZenThreadsStorage.getSnapshot(),
      ZenThreadsStorage.getShelf(),
      ZenThreadsStorage.getCheckpoints(),
    ]);
    const liveTabs = this.#buildLiveMap();
    const selKey = this.#tabKeys.get(gBrowser.selectedTab);
    const selRoot = selKey ? this.#rootKeyOf(selKey) : null;

    el.replaceChildren();
    if (!threads.length && !shelf.length) {
      return;
    }

    const header = document.createElementNS(XHTML_NS, "div");
    header.className = "zen-ts-header";
    header.textContent = "Threads";
    el.appendChild(header);

    const visible = threads
      .filter(t => {
        if (t.tier === "archived") {
          return false;
        }
        return t.tier === "recent" || this.#containsLive(t.roots, liveTabs);
      })
      .slice(0, 6);
    for (const thread of visible) {
      const hasLive = this.#containsLive(thread.roots, liveTabs);
      const isActive = thread.id === selRoot;

      const row = document.createElementNS(XHTML_NS, "div");
      row.className = "zen-ts-row";
      if (hasLive) {
        row.classList.add("live");
      }
      if (isActive) {
        row.classList.add("active");
      }
      const dot = document.createElementNS(XHTML_NS, "span");
      dot.className = "zen-ts-dot";
      row.appendChild(dot);
      const title = document.createElementNS(XHTML_NS, "span");
      title.className = "zen-ts-title";
      title.textContent = thread.isSearch
        ? `\u{1F50D} ${thread.title}`
        : thread.title;
      row.appendChild(title);
      const time = document.createElementNS(XHTML_NS, "span");
      time.className = "zen-ts-time";
      time.textContent = this.#relativeTime(thread.lastTs);
      row.appendChild(time);
      if (thread.id === this.#mergeSource) {
        row.classList.add("zen-thread-merge-armed");
      }
      const merge = document.createElementNS(XHTML_NS, "span");
      merge.className = "zen-thread-done-btn zen-thread-merge-btn";
      merge.textContent = "⇆";
      merge.title =
        this.#mergeSource && this.#mergeSource !== thread.id
          ? "Merge the armed thread into this one"
          : "Merge: arm this thread, then click ⇆ on the destination";
      merge.addEventListener("click", e => {
        e.stopPropagation();
        if (!this.#mergeSource) {
          this.#mergeSource = thread.id;
        } else if (this.#mergeSource === thread.id) {
          this.#mergeSource = null;
        } else {
          ZenThreadsStorage.linkThreads(thread.id, this.#mergeSource);
          this.#mergeSource = null;
        }
        this.#refreshSidebar().catch(() => {});
      });
      row.appendChild(merge);

      const done = document.createElementNS(XHTML_NS, "span");
      done.className = "zen-thread-done-btn";
      done.textContent = "✓";
      done.title = "Done — archive thread and close its tabs";
      done.addEventListener("click", e => {
        e.stopPropagation();
        ZenThreadsStorage.setThreadStatus(thread.id, "done");
        const out = [];
        this.#collectLiveTabs(thread.roots, liveTabs, out);
        for (const t of out) {
          try {
            gBrowser.removeTab(t, { animate: true });
          } catch (err) {
            // Tab already gone.
          }
        }
        this.#queueSidebarRefresh();
      });
      row.appendChild(done);
      row.addEventListener("click", () => {
        if (this.#expandedSidebarThreads.has(thread.id)) {
          this.#expandedSidebarThreads.delete(thread.id);
        } else {
          this.#expandedSidebarThreads.add(thread.id);
        }
        this.#refreshSidebar().catch(() => {});
      });
      el.appendChild(row);

      const cp = checkpoints.get(thread.id);
      if (!isActive && cp && (cp.note || cp.lastTitle)) {
        const line = document.createElementNS(XHTML_NS, "div");
        line.className = "zen-ts-checkpoint";
        line.textContent = cp.note
          ? `↩ next: ${cp.note}`
          : `↩ ${cp.lastTitle}`;
        el.appendChild(line);
      }

      if (this.#expandedSidebarThreads.has(thread.id)) {
        const trail = document.createElementNS(XHTML_NS, "div");
        trail.className = "zen-ts-trail";
        for (const root of thread.roots) {
          trail.appendChild(this.#renderNode(root, liveTabs));
        }
        el.appendChild(trail);
      }
    }

    if (shelf.length) {
      const row = document.createElementNS(XHTML_NS, "div");
      row.className = "zen-ts-row zen-ts-shelf";
      const dot = document.createElementNS(XHTML_NS, "span");
      dot.className = "zen-ts-dot";
      row.appendChild(dot);
      const title = document.createElementNS(XHTML_NS, "span");
      title.className = "zen-ts-title";
      title.textContent = "Shelf";
      row.appendChild(title);
      const count = document.createElementNS(XHTML_NS, "span");
      count.className = "zen-ts-time";
      count.textContent = String(shelf.length);
      row.appendChild(count);
      row.addEventListener("click", () => {
        this.togglePanel();
      });
      el.appendChild(row);
    }
  }

  #relativeTime(ts) {
    if (!ts) {
      return "";
    }
    const delta = Date.now() - ts;
    const minutes = Math.round(delta / 60000);
    if (minutes < 1) {
      return "now";
    }
    if (minutes < 60) {
      return `${minutes}m`;
    }
    const hours = Math.round(minutes / 60);
    if (hours < 24) {
      return `${hours}h`;
    }
    return `${Math.round(hours / 24)}d`;
  }
}

try {
  window.gZenThreadsManager = new nsZenThreadsManager();
} catch (e) {
  console.error("ZenThreads: bootstrap failed", e);
}
