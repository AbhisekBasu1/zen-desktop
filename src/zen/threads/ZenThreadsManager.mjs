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
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  Downloads: "resource://gre/modules/Downloads.sys.mjs",
});

// browser.xhtml is a XUL document: bare createElement() would produce XUL
// elements whose text content does not render. Always create HTML elements.
const XHTML_NS = "http://www.w3.org/1999/xhtml";

// Strings come from browser/zen-threads.ftl. The English text stays inline as
// a fallback so a missing or not-yet-translated id degrades to readable text
// rather than an empty label.
let gStrings = null;
function ftl(id, fallback, args = null) {
  try {
    if (!gStrings) {
      gStrings = new Localization(["browser/zen-threads.ftl"], true);
    }
    return gStrings.formatValueSync(id, args) || fallback;
  } catch (e) {
    return fallback;
  }
}

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
  #shelfFilter = "";
  #toastTimer = null;
  #dwellStart = 0;
  #downloadView = null;
  #downloadList = null;
  #mergeSource = null; // thread id armed for merging
  #pendingGlance = new WeakMap(); // peeked tab -> its provenance, held back
  #returnCardTimer = null;
  #returnCardSettleTimer = null;
  #returnCardGen = 0;
  #returnCardShown = new Map(); // threadId -> ts, so a return is announced once
  #nodeThread = new Map(); // tabKey -> threadId, from the latest snapshot
  #startupObserver = null;
  #startupTopic = null;

  init() {
    try {
      // Private browsing must leave no trace: the whole feature writes to a
      // permanent on-disk log, so it does not run in private windows at all.
      if (lazy.PrivateBrowsingUtils.isWindowPrivate(window)) {
        return;
      }
      if (!Services.prefs.getBoolPref("zen.threads.enabled", true)) {
        return;
      }
      window.addEventListener("unload", this, { once: true });
      // gBrowser does not exist yet at DOMContentLoaded — wait for the
      // window's delayed startup before touching tabs.
      if (
        typeof gBrowserInit !== "undefined" &&
        gBrowserInit.delayedStartupFinished
      ) {
        this.#start();
      } else {
        // Held on the instance so unload can unregister it — a window that
        // closes before delayed startup would otherwise leak itself.
        this.#startupTopic = "browser-delayed-startup-finished";
        this.#startupObserver = subject => {
          if (subject === window) {
            this.#removeStartupObserver();
            this.#start();
          }
        };
        Services.obs.addObserver(this.#startupObserver, this.#startupTopic);
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
      this.#dwellStart = Date.now();
      window.addEventListener("TabOpen", this);
      window.addEventListener("TabClose", this);
      window.addEventListener("TabSelect", this);
      window.addEventListener("SSTabRestoring", this);
      window.addEventListener("GlanceClose", this, true);
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
      this.#watchDownloads();
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
        case "GlanceClose": {
          // Dismissed without being promoted: it leaves no trace.
          this.#pendingGlance.delete(event.target);
          break;
        }
        case "TabClose": {
          const tab = event.target;
          this.#pendingGlance.delete(tab);
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
          const now = Date.now();
          if (prev && this.#dwellStart) {
            const prevKey = this.#tabKeys.get(prev);
            if (prevKey) {
              ZenThreadsStorage.recordDwell(prevKey, now - this.#dwellStart);
            }
          }
          this.#dwellStart = now;
          if (prev && prev !== next && !prev.closing) {
            const prevKey = this.#tabKeys.get(prev);
            const nextKey = this.#tabKeys.get(next);
            if (prevKey) {
              // Use the storage-derived thread id: the session-local parent
              // walk is empty for restored tabs, which would key checkpoints
              // under an id nothing ever reads back.
              const prevRoot = this.#threadIdFor(prevKey);
              const nextRoot = nextKey ? this.#threadIdFor(nextKey) : null;
              if (prevRoot !== nextRoot) {
                ZenThreadsStorage.setCheckpoint(
                  prevRoot,
                  null,
                  prev.linkedBrowser?.currentURI?.spec ?? null,
                  prev.label ?? null
                );
                if (nextRoot) {
                  // Let rapid tab flicking settle before announcing.
                  if (this.#returnCardSettleTimer) {
                    clearTimeout(this.#returnCardSettleTimer);
                  }
                  this.#returnCardSettleTimer = setTimeout(() => {
                    this.#returnCardSettleTimer = null;
                    this.#maybeShowReturnCard(nextRoot).catch(() => {});
                  }, 250);
                }
              }
            }
          }
          this.#queueSidebarRefresh();
          break;
        }
        case "keydown": {
          // Shelve on accel+Shift+S. Plain accel+S is deliberately NOT used:
          // it is Save in every web app (intercepting it closed the tab and
          // lost work, because focus in web content reads as <browser> here,
          // not input/textarea) and Zen already binds it to compact mode.
          if (
            (event.metaKey || event.ctrlKey) &&
            event.shiftKey &&
            !event.altKey &&
            event.key.toLowerCase() === "s"
          ) {
            const ae = document.activeElement;
            if (
              ae &&
              (ae.localName === "input" || ae.localName === "textarea")
            ) {
              break; // typing in chrome UI
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
            // Dismiss only the topmost surface, so closing Compare does not
            // also close the panel it was opened from.
            const backdrop = document.getElementById(
              "zen-threads-compare-backdrop"
            );
            const card = document.getElementById("zen-threads-return-card");
            const panel = document.getElementById("zen-threads-panel");
            if (backdrop && !backdrop.hidden) {
              event.preventDefault();
              event.stopPropagation();
              this.#closeCompare();
            } else if (card && !card.hidden) {
              event.preventDefault();
              event.stopPropagation();
              this.#hideReturnCard();
            } else if (panel && !panel.hidden) {
              event.preventDefault();
              event.stopPropagation();
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
          if (this.#lastSelected && this.#dwellStart) {
            const key = this.#tabKeys.get(this.#lastSelected);
            if (key) {
              ZenThreadsStorage.recordDwell(key, Date.now() - this.#dwellStart);
            }
          }
          if (this.#downloadList && this.#downloadView) {
            try {
              this.#downloadList.removeView(this.#downloadView);
            } catch (e) {
              // List already gone.
            }
            this.#downloadList = null;
            this.#downloadView = null;
          }
          this.#removeStartupObserver();
          for (const timer of [
            this.#sidebarRefreshTimer,
            this.#returnCardTimer,
            this.#returnCardSettleTimer,
          ]) {
            if (timer) {
              clearTimeout(timer);
            }
          }
          this.#sidebarRefreshTimer = null;
          this.#returnCardTimer = null;
          this.#returnCardSettleTimer = null;
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
    // A Glance is a peek, not a commitment (idea1 §9: attention causes
    // persistence). Hold its provenance back until it is promoted into a
    // real tab; if it is dismissed, nothing was ever recorded.
    if (tab.hasAttribute?.("zen-glance-tab")) {
      this.#pendingGlance.set(tab, { openerTab, parentKeyOverride, how });
      return;
    }
    const key = this.#keyFor(tab);
    let parentKey = parentKeyOverride;
    if (!parentKey && openerTab) {
      parentKey = this.#keyFor(openerTab);
    }
    if (parentKey) {
      // Bounded: this only needs to answer root lookups for live work.
      if (this.#parents.size > 4000) {
        const oldest = this.#parents.keys().next().value;
        this.#parents.delete(oldest);
      }
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
    if (tab.hasAttribute?.("zen-glance-tab")) {
      return; // still a peek
    }
    this.#promoteGlance(tab);
    const key = this.#keyFor(tab);
    const query = this.#detectSearch(spec);
    ZenThreadsStorage.recordEvent("nav", key, null, spec, tab.label, query);
  }

  #promoteGlance(tab) {
    const pending = this.#pendingGlance.get(tab);
    if (!pending) {
      return;
    }
    this.#pendingGlance.delete(tab);
    this.#registerTab(
      tab,
      pending.openerTab,
      pending.how,
      pending.parentKeyOverride
    );
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
    const [{ threads, loose, nodeThread }, shelf, checkpoints] =
      await Promise.all([
        ZenThreadsStorage.getSnapshot(),
        ZenThreadsStorage.getShelf(),
        ZenThreadsStorage.getCheckpoints(),
      ]);

    const liveTabs = this.#buildLiveMap();

    content.replaceChildren();

    this.#nodeThread = nodeThread;
    const selKey = this.#tabKeys.get(gBrowser.selectedTab);
    const activeThreadId = selKey ? this.#threadIdFor(selKey) : null;
    const rankedShelf = this.#rankShelf(shelf, nodeThread, activeThreadId);
    if (rankedShelf.length) {
      content.appendChild(this.#renderShelf(rankedShelf));
    }

    if (!threads.length && !loose.length && !shelf.length) {
      const empty = document.createElementNS(XHTML_NS, "div");
      empty.className = "zen-threads-empty";
      empty.textContent = ftl(
        "zen-threads-panel-empty",
        "No trails yet — browse a little."
      );
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
      header.textContent = ftl("zen-threads-loose-tabs", "Loose tabs");
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

  /**
   * Focus a tab wherever it lives: another window, or another Zen space —
   * a thread's tabs are not confined to the space you happen to be in.
   */
  #activateTab(entry) {
    try {
      entry.win.focus();
      const workspaceId = entry.tab
        .closest?.("[zen-workspace-id]")
        ?.getAttribute("zen-workspace-id");
      const spaces = entry.win.gZenWorkspaces;
      if (
        workspaceId &&
        spaces?.activeWorkspace &&
        spaces.activeWorkspace !== workspaceId &&
        typeof spaces.changeWorkspaceWithID === "function"
      ) {
        spaces.changeWorkspaceWithID(workspaceId);
      }
      entry.win.gBrowser.selectedTab = entry.tab;
    } catch (e) {
      try {
        entry.win.gBrowser.selectedTab = entry.tab;
      } catch (err) {
        console.error("ZenThreads: could not focus tab", err);
      }
    }
  }

  /** Per-page corrections: take this page out of the thread it joined. */
  #openNodeMenu(event, node) {
    const menu = document.getElementById("zen-threads-node-menu");
    if (!menu) {
      return;
    }
    const detach = document.getElementById("zen-threads-node-detach");
    const reattach = document.getElementById("zen-threads-node-reattach");
    if (detach) {
      detach.hidden = !!node.isDetached;
      detach.oncommand = () => {
        ZenThreadsStorage.detachNode(node.key);
        this.#toast("Moved out of this thread", () => {
          ZenThreadsStorage.reattachNode(node.key);
          this.#queueSidebarRefresh();
          this.#render().catch(() => {});
        });
        this.#queueSidebarRefresh();
        setTimeout(() => this.#render().catch(() => {}), 120);
      };
    }
    if (reattach) {
      reattach.hidden = !node.isDetached;
      reattach.oncommand = () => {
        ZenThreadsStorage.reattachNode(node.key);
        this.#queueSidebarRefresh();
        setTimeout(() => this.#render().catch(() => {}), 120);
      };
    }
    menu.openPopupAtScreen(event.screenX, event.screenY, true);
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

  /**
   * The Shelf behaves like memory rather than a folder: recent things stay
   * near the top, anything belonging to the thread you are in right now
   * surfaces, and old things quietly recede without being destroyed.
   */
  #rankShelf(items, nodeThread, activeThreadId) {
    const DAY = 86400000;
    const now = Date.now();
    return items
      .map(item => {
        const ageDays = (now - item.ts) / DAY;
        const threadId = item.tabKey ? nodeThread.get(item.tabKey) : null;
        const belongsHere = !!threadId && threadId === activeThreadId;
        return {
          ...item,
          ageDays,
          belongsHere,
          // Affinity dominates; recency decays with a two-week half-life.
          score: (belongsHere ? 1000 : 0) + Math.pow(0.5, ageDays / 14),
        };
      })
      .sort((a, b) => b.score - a.score);
  }

  #renderShelf(itemsIn) {
    let items = itemsIn;
    const section = document.createElementNS(XHTML_NS, "div");
    section.className = "zen-thread-section zen-shelf-section";

    const header = document.createElementNS(XHTML_NS, "div");
    header.className = "zen-thread-header";
    const title = document.createElementNS(XHTML_NS, "span");
    title.className = "zen-thread-title";
    title.textContent = ftl("zen-threads-shelf-label", "Shelf");
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

    if (items.length > 6 || this.#shelfFilter) {
      const filter = document.createElementNS(XHTML_NS, "input");
      filter.className = "zen-thread-note-input zen-shelf-filter";
      filter.placeholder = "Filter shelf…";
      filter.value = this.#shelfFilter;
      filter.addEventListener("keydown", e => e.stopPropagation());
      filter.addEventListener("click", e => e.stopPropagation());
      filter.addEventListener("input", () => {
        this.#shelfFilter = filter.value;
        const caret = filter.selectionStart;
        this.#render()
          .then(() => {
            const next = document.querySelector(".zen-shelf-filter");
            if (next) {
              next.focus();
              next.setSelectionRange(caret, caret);
            }
          })
          .catch(() => {});
      });
      body.appendChild(filter);
    }

    const needle = this.#shelfFilter.trim().toLowerCase();
    if (needle) {
      items = items.filter(item =>
        `${item.title ?? ""} ${item.url}`.toLowerCase().includes(needle)
      );
    }

    const RECEDE_DAYS = 90;
    const current = items.filter(item => item.ageDays <= RECEDE_DAYS);
    const receded = items.filter(item => item.ageDays > RECEDE_DAYS);

    const renderItem = (item, container) => {
      const row = document.createElementNS(XHTML_NS, "div");
      row.className = "zen-thread-row zen-shelf-row";
      if (item.belongsHere) {
        row.classList.add("is-related");
      }
      if (item.ageDays > 30) {
        row.classList.add("is-aged");
      }

      const icon = document.createElementNS(XHTML_NS, "img");
      icon.className = "zen-thread-favicon";
      icon.setAttribute("src", `page-icon:${item.url}`);
      icon.setAttribute("alt", "");
      row.appendChild(icon);

      const rowTitle = document.createElementNS(XHTML_NS, "span");
      rowTitle.className = "zen-thread-title";
      rowTitle.textContent = item.title || item.url;
      row.appendChild(rowTitle);

      if (item.belongsHere) {
        const badge = document.createElementNS(XHTML_NS, "span");
        badge.className = "zen-shelf-affinity";
        badge.textContent = ftl("zen-threads-shelf-affinity", "this thread");
        row.appendChild(badge);
      }
      const dismiss = document.createElementNS(XHTML_NS, "button");
      dismiss.className = "zen-shelf-x";
      dismiss.setAttribute("aria-label", "Remove from shelf");
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
      container.appendChild(row);
    };

    for (const item of current) {
      renderItem(item, body);
    }

    if (receded.length) {
      const older = document.createElementNS(XHTML_NS, "div");
      older.className = "zen-thread-section zen-shelf-receded collapsed";
      const olderHeader = document.createElementNS(XHTML_NS, "div");
      olderHeader.className = "zen-thread-header zen-thread-loose-header";
      olderHeader.textContent = `Receded · ${receded.length}`;
      olderHeader.addEventListener("click", e => {
        e.stopPropagation();
        older.classList.toggle("collapsed");
      });
      older.appendChild(olderHeader);
      const olderBody = document.createElementNS(XHTML_NS, "div");
      olderBody.className = "zen-thread-body";
      for (const item of receded) {
        renderItem(item, olderBody);
      }
      older.appendChild(olderBody);
      body.appendChild(older);
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
    const compareSet = this.#comparisonSet(thread);
    if (compareSet) {
      const cmp = document.createElementNS(XHTML_NS, "button");
      cmp.className = "zen-thread-done-btn zen-thread-compare-btn";
      cmp.textContent = `⊞${compareSet.candidates.length}`;
      cmp.title = `Compare ${compareSet.candidates.length} candidates`;
      cmp.addEventListener("click", e => {
        e.stopPropagation();
        this.#openCompare(thread, compareSet, liveTabs);
      });
      header.appendChild(cmp);
    }
    const merge = document.createElementNS(XHTML_NS, "button");
    merge.className = "zen-thread-done-btn zen-thread-merge-btn";
    merge.textContent = "⇆";
    merge.title =
      this.#mergeSource && this.#mergeSource !== thread.id
        ? "Merge the armed thread into this one"
        : "Merge: arm this thread, then click ⇆ on the destination";
    merge.addEventListener("click", e => {
      e.stopPropagation();
      if (e.altKey) {
        ZenThreadsStorage.unlinkThread(thread.id);
        this.#mergeSource = null;
        this.#queueSidebarRefresh();
      } else if (!this.#mergeSource) {
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

    const done = document.createElementNS(XHTML_NS, "button");
    done.className = "zen-thread-done-btn";
    done.textContent = thread.done ? "↺" : "✓";
    done.title = thread.done
      ? ftl("zen-threads-action-restore", "Restore this thread")
      : ftl(
          "zen-threads-action-done",
          "Done — archive this thread and close its tabs"
        );
    done.addEventListener("click", e => {
      e.stopPropagation();
      if (thread.done) {
        ZenThreadsStorage.setThreadStatus(thread.id, null);
      } else {
        ZenThreadsStorage.setThreadStatus(thread.id, "done");
        const closable = [];
        this.#collectLiveTabs(thread.roots, liveTabs, closable, {
          includePinned: true,
          skipReferences: true,
        });
        for (const t of closable) {
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

    if (!node.isSearch && node.url) {
      const icon = document.createElementNS(XHTML_NS, "img");
      icon.className = "zen-thread-favicon";
      const iconUrl = this.#faviconFor(node, entry);
      if (iconUrl) {
        icon.setAttribute("src", iconUrl);
      }
      icon.setAttribute("alt", "");
      row.appendChild(icon);
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

    if (node.isReference) {
      const badge = document.createElementNS(XHTML_NS, "span");
      badge.className = "zen-thread-reference-badge";
      badge.textContent = ftl("zen-threads-reference-badge", "reference");
      badge.title = "You return to this across different work — kept when a thread is done";
      row.appendChild(badge);
    }

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
        this.#activateTab(entry);
      } else if (node.url) {
        this.#reopen(node);
      }
    });
    row.addEventListener("contextmenu", e => {
      e.preventDefault();
      e.stopPropagation();
      this.#openNodeMenu(e, node);
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

  /**
   * Restore rather than re-fetch where possible: a session-restored tab comes
   * back with its scroll position, form state and back-history intact, which
   * is the difference between returning to your work and merely revisiting
   * a URL.
   */
  #restoreClosedTab(node) {
    try {
      const closed = lazy.SessionStore.getClosedTabDataForWindow(window);
      for (let i = 0; i < closed.length; i++) {
        const entry = closed[i];
        const key = entry?.state?.extData?.[TAB_KEY_PROP];
        const matchesKey = key && key.replace(/^"|"$/g, "") === node.key;
        const matchesUrl =
          !key &&
          entry?.state?.entries?.length &&
          entry.state.entries[entry.state.entries.length - 1]?.url === node.url;
        if (matchesKey || matchesUrl) {
          const tab = lazy.SessionStore.undoCloseTab(window, i);
          if (tab) {
            return tab;
          }
        }
      }
    } catch (e) {
      // Fall through to a plain load.
    }
    return null;
  }

  #reopen(node) {
    try {
      // The TabOpen handler consumes this so the reopened page becomes a
      // child of the ghost node and stays inside its thread.
      this.#pendingReopenParent = node.key;
      const restored = this.#restoreClosedTab(node);
      const tab =
        restored ||
        gBrowser.addTab(node.url, {
          triggeringPrincipal:
            Services.scriptSecurityManager.getSystemPrincipal(),
        });
      this.#pendingReopenParent = null;
      gBrowser.selectedTab = tab;
      this.#render().catch(() => {});
      return tab;
    } catch (e) {
      this.#pendingReopenParent = null;
      console.error("ZenThreads: reopen failed", e);
      return null;
    }
  }

  /**
   * Tabs of this thread living in this window. Grouping pins tabs, so the
   * Done path must include pinned ones or it would find nothing to close
   * once a thread has been grouped into a folder.
   */
  async #exportThread(thread) {
    const lines = [`# ${thread.title}`, ""];
    const checkpoints = await ZenThreadsStorage.getCheckpoints();
    const cp = checkpoints.get(thread.id);
    if (cp?.note) {
      lines.push(`> next: ${cp.note}`, "");
    }
    if (thread.outcomeTitle) {
      lines.push(`**Chose:** ${thread.outcomeTitle}`, "");
    }
    const walk = (nodes, depth) => {
      for (const node of nodes) {
        if (/^https?:/.test(node.url)) {
          const indent = "  ".repeat(depth);
          const label = node.isSearch && node.query
            ? `search: ${node.query}`
            : node.title || node.url;
          lines.push(`${indent}- [${label}](${node.url})`);
        }
        if (node.children.length) {
          walk(node.children, depth + 1);
        }
      }
    };
    walk(thread.roots, 0);
    lines.push("", `_Exported from Threads · ${new Date().toLocaleString()}_`);

    const markdown = lines.join("\n");
    try {
      const transferable = Cc[
        "@mozilla.org/widget/transferable;1"
      ].createInstance(Ci.nsITransferable);
      transferable.init(null);
      const supportsString = Cc[
        "@mozilla.org/supports-string;1"
      ].createInstance(Ci.nsISupportsString);
      supportsString.data = markdown;
      transferable.addDataFlavor("text/plain");
      transferable.setTransferData("text/plain", supportsString);
      Services.clipboard.setData(
        transferable,
        null,
        Ci.nsIClipboard.kGlobalClipboard
      );
      this.#toast("Thread copied as Markdown");
    } catch (e) {
      console.error("ZenThreads: export failed", e);
    }
  }

  #collectKeys(nodes, out = []) {
    for (const node of nodes) {
      out.push(node.key);
      if (node.children.length) {
        this.#collectKeys(node.children, out);
      }
    }
    return out;
  }

  #countReferences(nodes, liveTabs) {
    let count = 0;
    for (const node of nodes) {
      if (node.isReference && liveTabs.has(node.key)) {
        count++;
      }
      if (node.children.length) {
        count += this.#countReferences(node.children, liveTabs);
      }
    }
    return count;
  }

  #forgetThread(thread, liveTabs) {
    // The only action here with no inverse, so it is the only one that asks.
    const ok = Services.prompt.confirm(
      window,
      "Forget this thread?",
      `“${thread.title}” and everything recorded in it will be permanently ` +
        `deleted. This cannot be undone.`
    );
    if (!ok) {
      return;
    }
    const keys = this.#collectKeys(thread.roots);
    const tabs = [];
    this.#collectLiveTabs(thread.roots, liveTabs, tabs, {
      includePinned: true,
    });
    for (const tab of tabs) {
      try {
        gBrowser.removeTab(tab, { animate: true });
      } catch (e) {
        // Tab already gone.
      }
    }
    ZenThreadsStorage.forgetThread(thread.id, keys);
    this.#toast("Thread forgotten");
    this.#queueSidebarRefresh();
    setTimeout(() => this.#render().catch(() => {}), 150);
  }

  #collectLiveTabs(
    nodes,
    liveTabs,
    out,
    { includePinned = false, skipReferences = false } = {}
  ) {
    for (const node of nodes) {
      const entry = liveTabs.get(node.key);
      if (
        entry &&
        entry.win === window &&
        (includePinned || !entry.tab.pinned) &&
        !(skipReferences && node.isReference) &&
        !out.includes(entry.tab)
      ) {
        out.push(entry.tab);
      }
      if (node.children.length) {
        this.#collectLiveTabs(node.children, liveTabs, out, {
          includePinned,
          skipReferences,
        });
      }
    }
  }

  #threadIdFor(key) {
    return this.#nodeThread.get(key) ?? this.#rootKeyOf(key);
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
      const url = uri.spec;
      ZenThreadsStorage.shelvePage(url, tab.label, key);
      if (gBrowser.tabs.length > 1) {
        gBrowser.removeTab(tab, { animate: true });
        this.#toast(`Shelved “${tab.label || url}”`, () => {
          ZenThreadsStorage.unshelveUrl(url);
          try {
            lazy.SessionStore.undoCloseTab(window, 0);
          } catch (e) {
            gBrowser.selectedTab = gBrowser.addTab(url, {
              triggeringPrincipal:
                Services.scriptSecurityManager.getSystemPrincipal(),
            });
          }
          this.#queueSidebarRefresh();
        });
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

  // -- journal ---------------------------------------------------------------

  async #openJournal() {
    const backdrop = document.getElementById("zen-threads-compare-backdrop");
    const host = document.getElementById("zen-threads-compare");
    if (!backdrop || !host) {
      return;
    }
    const [days, { threads }] = await Promise.all([
      ZenThreadsStorage.getJournal(),
      ZenThreadsStorage.getSnapshot(),
    ]);
    const threadById = new Map(threads.map(t => [t.id, t]));

    const header = document.createElementNS(XHTML_NS, "div");
    header.className = "ztc-header";
    const heading = document.createElementNS(XHTML_NS, "div");
    heading.className = "ztc-heading";
    heading.textContent = ftl("zen-threads-journal-title", "Journal");
    header.appendChild(heading);
    const close = document.createElementNS(XHTML_NS, "button");
    close.className = "ztc-close";
    close.textContent = "✕";
    close.setAttribute("aria-label", "Close journal");
    close.addEventListener("click", () => this.#closeCompare());
    header.appendChild(close);

    const body = document.createElementNS(XHTML_NS, "div");
    body.className = "ztj-body";

    if (!days.length) {
      const empty = document.createElementNS(XHTML_NS, "div");
      empty.className = "ztj-empty";
      empty.textContent =
        "Nothing recorded yet. Once you work on something, it shows up here as sessions rather than a list of links.";
      body.appendChild(empty);
    }

    for (const day of days) {
      const daySection = document.createElementNS(XHTML_NS, "div");
      daySection.className = "ztj-day";

      const dayLabel = document.createElementNS(XHTML_NS, "div");
      dayLabel.className = "ztj-day-label";
      dayLabel.textContent = this.#dayLabel(day.dayStart);
      daySection.appendChild(dayLabel);

      for (const block of day.blocks) {
        const row = document.createElementNS(XHTML_NS, "div");
        row.className = "ztj-block";

        const time = document.createElementNS(XHTML_NS, "div");
        time.className = "ztj-time";
        time.textContent = `${this.#clock(block.start)} – ${this.#clock(
          block.end
        )}`;
        row.appendChild(time);

        const main = document.createElementNS(XHTML_NS, "div");
        main.className = "ztj-main";
        const title = document.createElementNS(XHTML_NS, "div");
        title.className = "ztj-title";
        title.textContent = block.isSearch
          ? `\u{1F50D} ${block.title}`
          : block.title;
        main.appendChild(title);
        const meta = document.createElementNS(XHTML_NS, "div");
        meta.className = "ztj-meta";
        const minutes = Math.max(
          1,
          Math.round((block.end - block.start) / 60000)
        );
        meta.textContent = `${block.pages} page${
          block.pages === 1 ? "" : "s"
        } · ${minutes} min`;
        if (block.readPages) {
          meta.textContent += ` · ${block.readPages} read`;
        }
        main.appendChild(meta);
        row.appendChild(main);

        const resume = document.createElementNS(XHTML_NS, "button");
        resume.className = "ztc-open";
        resume.textContent = ftl("zen-threads-journal-resume", "Resume");
        resume.addEventListener("click", () => {
          const thread = threadById.get(block.threadId);
          this.#closeCompare();
          if (thread) {
            this.#resumeThread(thread);
          }
        });
        row.appendChild(resume);

        daySection.appendChild(row);
      }
      body.appendChild(daySection);
    }

    host.replaceChildren(header, body);
    backdrop.hidden = false;
    backdrop.onclick = e => {
      if (e.target === backdrop) {
        this.#closeCompare();
      }
    };

    const motion = this.#prefersReducedMotion()
      ? null
      : window.gZenUIManager?.motion;
    if (motion) {
      motion.animate(backdrop, { opacity: [0, 1] }, { duration: 0.18 });
      motion.animate(
        host,
        { opacity: [0, 1], transform: ["scale(0.97)", "scale(1)"] },
        { duration: 0.24, bounce: 0 }
      );
    }
  }

  #resumeThread(thread) {
    const liveTabs = this.#buildLiveMap();
    let target = null;
    const walk = nodes => {
      for (const node of nodes) {
        const entry = liveTabs.get(node.key);
        if (entry) {
          if (!target || node.lastTs > target.lastTs) {
            target = { entry, lastTs: node.lastTs };
          }
        } else if (
          /^https?:/.test(node.url) &&
          (!target || node.lastTs > target.lastTs)
        ) {
          target = { node, lastTs: node.lastTs };
        }
        if (node.children.length) {
          walk(node.children);
        }
      }
    };
    walk(thread.roots);
    if (!target) {
      return;
    }

    // Bring the rest of the thread's recent pages back with it, capped so a
    // long trail cannot flood the window.
    const MAX_RESTORE = 8;
    const closedNodes = [];
    const gather = nodes => {
      for (const node of nodes) {
        if (
          !liveTabs.has(node.key) &&
          /^https?:/.test(node.url) &&
          node !== target.node
        ) {
          closedNodes.push(node);
        }
        if (node.children.length) {
          gather(node.children);
        }
      }
    };
    gather(thread.roots);
    closedNodes.sort((a, b) => b.lastTs - a.lastTs);
    for (const node of closedNodes.slice(0, MAX_RESTORE - 1)) {
      const restored = this.#restoreClosedTab(node);
      if (!restored) {
        try {
          gBrowser.addTab(node.url, {
            triggeringPrincipal:
              Services.scriptSecurityManager.getSystemPrincipal(),
          });
        } catch (e) {
          // Skip anything that will not load.
        }
      }
    }

    if (target.entry) {
      this.#activateTab(target.entry);
    } else {
      this.#reopen(target.node);
    }
    this.#queueSidebarRefresh();
  }

  #dayLabel(dayStart) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffDays = Math.round((today.getTime() - dayStart) / 86400000);
    if (diffDays === 0) {
      return ftl("zen-threads-journal-today", "Today");
    }
    if (diffDays === 1) {
      return ftl("zen-threads-journal-yesterday", "Yesterday");
    }
    const date = new Date(dayStart);
    if (diffDays < 7) {
      return date.toLocaleDateString(undefined, { weekday: "long" });
    }
    return date.toLocaleDateString(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric",
    });
  }

  #clock(ts) {
    return new Date(ts).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }

  // -- compare mode ----------------------------------------------------------

  /**
   * A decision usually looks like one search with several candidates hanging
   * off it. Find the widest such fan-out in a thread.
   */
  #comparisonSet(thread) {
    const MIN_SIBLINGS = 3;
    let best = null;
    const walk = nodes => {
      for (const node of nodes) {
        const candidates = node.children.filter(
          c => /^https?:/.test(c.url) && !c.isReference
        );
        if (
          candidates.length >= MIN_SIBLINGS &&
          (!best || candidates.length > best.candidates.length)
        ) {
          best = { parent: node, candidates };
        }
        if (node.children.length) {
          walk(node.children);
        }
      }
    };
    walk(thread.roots);
    return best;
  }

  #faviconFor(node, entry) {
    if (entry?.tab?.image) {
      return entry.tab.image;
    }
    // The full page URL keeps page-specific icons; Places already falls
    // back origin-ward on its own, and the protocol streams a default
    // icon rather than failing, so no error handling is needed.
    return node.url ? `page-icon:${node.url}` : null;
  }

  #openCompare(thread, set, liveTabs) {
    const backdrop = document.getElementById("zen-threads-compare-backdrop");
    const host = document.getElementById("zen-threads-compare");
    if (!backdrop || !host) {
      return;
    }

    const header = document.createElementNS(XHTML_NS, "div");
    header.className = "ztc-header";
    const heading = document.createElementNS(XHTML_NS, "div");
    heading.className = "ztc-heading";
    heading.textContent = thread.isSearch
      ? `Comparing ${set.candidates.length} results for “${thread.title}”`
      : `Comparing ${set.candidates.length} pages from “${thread.title}”`;
    header.appendChild(heading);
    const close = document.createElementNS(XHTML_NS, "button");
    close.className = "ztc-close";
    close.textContent = "✕";
    close.addEventListener("click", () => this.#closeCompare());
    header.appendChild(close);

    const grid = document.createElementNS(XHTML_NS, "div");
    grid.className = "ztc-grid";
    grid.style.setProperty(
      "--ztc-columns",
      String(Math.min(set.candidates.length, 4))
    );

    for (const node of set.candidates) {
      const entry = liveTabs.get(node.key);
      const card = document.createElementNS(XHTML_NS, "div");
      card.className = "ztc-card";
      if (!entry) {
        card.classList.add("is-closed");
      }

      const top = document.createElementNS(XHTML_NS, "div");
      top.className = "ztc-card-top";
      const icon = document.createElementNS(XHTML_NS, "img");
      icon.className = "ztc-favicon";
      const iconUrl = this.#faviconFor(node, entry);
      if (iconUrl) {
        icon.setAttribute("src", iconUrl);
      }
      icon.setAttribute("alt", "");
      top.appendChild(icon);
      const host_ = document.createElementNS(XHTML_NS, "span");
      host_.className = "ztc-host";
      try {
        host_.textContent = new URL(node.url).hostname.replace(/^www\./, "");
      } catch (e) {
        host_.textContent = "";
      }
      top.appendChild(host_);
      card.appendChild(top);

      const title = document.createElementNS(XHTML_NS, "div");
      title.className = "ztc-title";
      title.textContent = (entry ? entry.tab.label : node.title) || node.url;
      card.appendChild(title);

      const state = document.createElementNS(XHTML_NS, "div");
      state.className = "ztc-state";
      state.textContent = entry
        ? ftl("zen-threads-compare-open", "open")
        : ftl("zen-threads-compare-closed", "closed");
      card.appendChild(state);

      const open = document.createElementNS(XHTML_NS, "button");
      open.className = "ztc-open";
      open.textContent = entry
        ? ftl("zen-threads-compare-goto", "Go to tab")
        : ftl("zen-threads-compare-reopen", "Reopen");
      open.addEventListener("click", e => {
        e.stopPropagation();
        this.#closeCompare();
        // Re-resolve: the grid may have been open long enough for the tab
        // to have been closed or moved to another window.
        const current = this.#buildLiveMap().get(node.key);
        if (current && !current.win.closed) {
          this.#activateTab(current);
        } else {
          this.#reopen(node);
        }
      });
      card.appendChild(open);

      const keep = document.createElementNS(XHTML_NS, "button");
      keep.className = "ztc-keep";
      keep.textContent = ftl("zen-threads-compare-keep", "Keep this one");
      keep.title = ftl(
        "zen-threads-compare-keep-tooltip",
        "Record this as the decision and shelve the rest"
      );
      keep.addEventListener("click", e => {
        e.stopPropagation();
        this.#keepCandidate(thread, set, node, liveTabs);
      });
      card.appendChild(keep);

      grid.appendChild(card);
    }

    host.replaceChildren(header, grid);
    backdrop.hidden = false;
    backdrop.onclick = e => {
      if (e.target === backdrop) {
        this.#closeCompare();
      }
    };

    const motion = this.#prefersReducedMotion()
      ? null
      : window.gZenUIManager?.motion;
    if (motion) {
      motion.animate(backdrop, { opacity: [0, 1] }, { duration: 0.18 });
      motion.animate(
        host,
        { opacity: [0, 1], transform: ["scale(0.97)", "scale(1)"] },
        { duration: 0.24, bounce: 0 }
      );
    }
  }

  /**
   * Comparing ends in a choice. Record it, keep the winner, and shelve the
   * rest rather than destroying them — the trail stops offering to compare
   * a decision that has already been made.
   */
  #keepCandidate(thread, set, chosen, liveTabs) {
    try {
      ZenThreadsStorage.setThreadOutcome(
        thread.id,
        chosen.url,
        chosen.title || chosen.url
      );
      let shelved = 0;
      for (const node of set.candidates) {
        if (node.key === chosen.key) {
          continue;
        }
        ZenThreadsStorage.shelvePage(node.url, node.title, node.key);
        shelved++;
        const entry = liveTabs.get(node.key);
        if (entry && entry.win === window) {
          try {
            gBrowser.removeTab(entry.tab, { animate: true });
          } catch (e) {
            // Already gone.
          }
        }
      }
      this.#closeCompare();
      const entry = liveTabs.get(chosen.key);
      if (entry) {
        this.#activateTab(entry);
      } else {
        this.#reopen(chosen);
      }
      this.#toast(
        `Kept “${chosen.title || chosen.url}” · ${shelved} shelved`
      );
      this.#queueSidebarRefresh();
    } catch (e) {
      console.error("ZenThreads: keep failed", e);
    }
  }

  /**
   * Small, self-dismissing confirmation. Zen's own toast API needs Fluent
   * ids for dynamic values, so destructive actions get their own.
   */
  #toast(message, undo = null) {
    let host = document.getElementById("zen-threads-toast");
    if (!host) {
      host = document.createElementNS(XHTML_NS, "div");
      host.id = "zen-threads-toast";
      document.getElementById("zen-threads-panel")?.parentNode?.appendChild(host);
    }
    host.replaceChildren();
    const text = document.createElementNS(XHTML_NS, "span");
    text.textContent = message;
    host.appendChild(text);
    if (undo) {
      const button = document.createElementNS(XHTML_NS, "button");
      button.className = "zen-threads-toast-undo";
      button.textContent = ftl("zen-threads-toast-undo", "Undo");
      button.addEventListener("click", () => {
        undo();
        host.hidden = true;
      });
      host.appendChild(button);
    }
    host.hidden = false;
    if (this.#toastTimer) {
      clearTimeout(this.#toastTimer);
    }
    this.#toastTimer = setTimeout(() => {
      host.hidden = true;
    }, undo ? 7000 : 3500);
  }

  #closeCompare() {
    const backdrop = document.getElementById("zen-threads-compare-backdrop");
    const host = document.getElementById("zen-threads-compare");
    if (!backdrop || backdrop.hidden) {
      return;
    }
    const finish = () => {
      backdrop.hidden = true;
      host?.replaceChildren();
    };
    const motion = this.#prefersReducedMotion()
      ? null
      : window.gZenUIManager?.motion;
    if (motion) {
      motion
        .animate(backdrop, { opacity: [1, 0] }, { duration: 0.16 })
        .then(finish, finish);
    } else {
      finish();
    }
  }

  // -- return card -----------------------------------------------------------

  async #maybeShowReturnCard(rootKey) {
    // Overridable so the card can be exercised without waiting hours.
    const MIN_AWAY_MS = Services.prefs.getIntPref(
      "zen.threads.return-card.min-away-seconds",
      2 * 60 * 60
    ) * 1000;
    const REANNOUNCE_MS = 30 * 60 * 1000;

    const shownAt = this.#returnCardShown.get(rootKey);
    if (shownAt && Date.now() - shownAt < REANNOUNCE_MS) {
      return;
    }
    // Don't interrupt typing in the address bar, and don't announce into a
    // window the user isn't looking at.
    if (!document.hasFocus() || gURLBar?.focused || gURLBar?.view?.isOpen) {
      return;
    }

    const gen = ++this.#returnCardGen;
    const stillCurrent = () =>
      gen === this.#returnCardGen &&
      this.#threadIdFor(this.#tabKeys.get(gBrowser.selectedTab)) === rootKey;

    const checkpoints = await ZenThreadsStorage.getCheckpoints();
    if (!stillCurrent()) {
      return;
    }
    const cp = checkpoints.get(rootKey);
    if (!cp || !cp.ts) {
      return;
    }
    const away = Date.now() - cp.ts;
    if (away < MIN_AWAY_MS) {
      return;
    }
    if (!cp.note && !cp.lastTitle) {
      return;
    }
    const { threads } = await ZenThreadsStorage.getSnapshot();
    if (!stillCurrent()) {
      return;
    }
    const thread = threads.find(t => t.id === rootKey);
    if (this.#returnCardShown.size > 200) {
      this.#returnCardShown.clear();
    }
    this.#returnCardShown.set(rootKey, Date.now());
    this.#showReturnCard({
      title: thread
        ? thread.isSearch
          ? `\u{1F50D} ${thread.title}`
          : thread.title
        : "Earlier thread",
      note: cp.note,
      lastTitle: cp.lastTitle,
      away,
    });
  }

  #showReturnCard({ title, note, lastTitle, away }) {
    const card = document.getElementById("zen-threads-return-card");
    if (!card) {
      return;
    }
    if (this.#returnCardTimer) {
      clearTimeout(this.#returnCardTimer);
      this.#returnCardTimer = null;
    }

    const label = document.createElementNS(XHTML_NS, "div");
    label.className = "ztrc-label";
    label.textContent = `Where you left off · ${this.#humanDuration(away)} ago`;

    const heading = document.createElementNS(XHTML_NS, "div");
    heading.className = "ztrc-title";
    heading.textContent = title;

    const body = document.createElementNS(XHTML_NS, "div");
    body.className = "ztrc-note";
    body.textContent = note ? `next: ${note}` : lastTitle;
    if (note) {
      body.classList.add("is-intention");
    }

    card.replaceChildren(label, heading, body);
    card.hidden = false;

    // Motion drives WAAPI, which does not consult prefers-reduced-motion,
    // so honour it here.
    const motion = this.#prefersReducedMotion()
      ? null
      : window.gZenUIManager?.motion;
    if (motion) {
      motion.animate(
        card,
        { opacity: [0, 1], transform: ["translateY(-8px)", "translateY(0)"] },
        { duration: 0.28, bounce: 0 }
      );
    }

    const dismiss = () => this.#hideReturnCard();
    card.onclick = dismiss;
    card.onmouseenter = () => {
      if (this.#returnCardTimer) {
        clearTimeout(this.#returnCardTimer);
        this.#returnCardTimer = null;
      }
    };
    card.onmouseleave = () => {
      if (!card.hidden) {
        this.#returnCardTimer = setTimeout(dismiss, 2000);
      }
    };
    this.#returnCardTimer = setTimeout(dismiss, 6500);
  }

  #hideReturnCard() {
    // Disarm first: an already-hidden card must not leave a timer running
    // that would fire into the next card's lifetime.
    if (this.#returnCardTimer) {
      clearTimeout(this.#returnCardTimer);
      this.#returnCardTimer = null;
    }
    const card = document.getElementById("zen-threads-return-card");
    if (!card || card.hidden) {
      return;
    }
    const motion = this.#prefersReducedMotion()
      ? null
      : window.gZenUIManager?.motion;
    const finish = () => {
      card.hidden = true;
      card.replaceChildren();
      card.onclick = null;
      card.onmouseenter = null;
      card.onmouseleave = null;
    };
    if (motion) {
      motion
        .animate(
          card,
          { opacity: [1, 0], transform: ["translateY(0)", "translateY(-6px)"] },
          { duration: 0.2, bounce: 0 }
        )
        .then(finish, finish);
    } else {
      finish();
    }
  }

  /**
   * Research ends in artefacts. A file saved while working on a goal belongs
   * to that goal, not to a flat list in the Downloads panel.
   */
  #watchDownloads() {
    lazy.Downloads.getList(lazy.Downloads.ALL)
      .then(list => {
        this.#downloadView = {
          onDownloadAdded: download => {
            try {
              const tab = gBrowser.selectedTab;
              const key = tab ? this.#tabKeys.get(tab) : null;
              if (!key) {
                return;
              }
              const url = download?.source?.url;
              if (!url) {
                return;
              }
              const name = download?.target?.path?.split("/").pop() || url;
              const childKey = Services.uuid
                .generateUUID()
                .toString()
                .slice(1, -1);
              ZenThreadsStorage.recordEvent(
                "download",
                childKey,
                key,
                url,
                name,
                null
              );
            } catch (e) {
              console.error("ZenThreads: download capture failed", e);
            }
          },
        };
        list.addView(this.#downloadView);
        this.#downloadList = list;
      })
      .catch(() => {});
  }

  #removeStartupObserver() {
    if (!this.#startupObserver) {
      return;
    }
    try {
      Services.obs.removeObserver(this.#startupObserver, this.#startupTopic);
    } catch (e) {
      // Already removed.
    }
    this.#startupObserver = null;
  }

  #prefersReducedMotion() {
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (e) {
      return false;
    }
  }

  #humanDuration(ms) {
    const minutes = Math.round(ms / 60000);
    if (minutes < 60) {
      return `${minutes}m`;
    }
    const hours = Math.round(minutes / 60);
    if (hours < 24) {
      return `${hours}h`;
    }
    const days = Math.round(hours / 24);
    return days === 1 ? "a day" : `${days} days`;
  }

  #initSidebar() {
    try {
      const foot = document.getElementById("zen-sidebar-foot-buttons");
      if (!foot || !foot.parentNode) {
        return;
      }
      const el = document.createElementNS(XHTML_NS, "div");
      el.id = "zen-threads-sidebar";
      el.setAttribute("role", "tree");
      el.setAttribute("aria-label", "Threads");
      el.addEventListener("keydown", e => this.#onSidebarKeydown(e));
      foot.parentNode.insertBefore(el, foot);
      this.#sidebarEl = el;
      this.#queueSidebarRefresh();
    } catch (e) {
      console.error("ZenThreads: sidebar init failed", e);
    }
  }

  /**
   * Salience should track attention (idea1 §15): while you are working
   * inside a thread, tabs that belong to other work recede slightly. Kept
   * deliberately subtle, skipped for pinned/app tabs, and only when the
   * current thread actually has company.
   */
  #applyTabSalience(threadKeys) {
    if (
      !Services.prefs.getBoolPref("zen.threads.dim-unrelated-tabs", true)
    ) {
      return;
    }
    const active = threadKeys && threadKeys.size >= 2;
    for (const tab of gBrowser.tabs) {
      let dim = false;
      if (active && !tab.pinned && !tab.selected) {
        const key = this.#tabKeys.get(tab);
        dim = !key || !threadKeys.has(key);
      }
      if (dim) {
        tab.setAttribute("zen-thread-dimmed", "true");
      } else {
        tab.removeAttribute("zen-thread-dimmed");
      }
    }
  }

  #sidebarRows() {
    return [...(this.#sidebarEl?.querySelectorAll('[role="treeitem"]') ?? [])];
  }

  /** Keep exactly one row in the tab order, as tree widgets should. */
  #updateRovingTabstop(preferred) {
    const rows = this.#sidebarRows();
    if (!rows.length) {
      return;
    }
    const target =
      (preferred && rows.find(r => r.dataset.threadId === preferred)) ||
      rows[0];
    for (const row of rows) {
      row.setAttribute("tabindex", row === target ? "0" : "-1");
    }
  }

  /**
   * Every thread action, reachable without hovering and without knowing a
   * keyboard shortcut.
   */
  #openContextMenu(event, thread, compareSet, liveTabs) {
    const menu = document.getElementById("zen-threads-context-menu");
    if (!menu) {
      return;
    }
    const bind = (id, enabled, handler) => {
      const item = document.getElementById(id);
      if (!item) {
        return;
      }
      item.hidden = !enabled;
      item.oncommand = enabled ? handler : null;
    };

    const hasFolder = this.#folderMap.has(thread.id);
    const liveThreadTabs = [];
    this.#collectLiveTabs(thread.roots, liveTabs, liveThreadTabs);

    bind("zen-threads-ctx-open", true, () => {
      this.#expandedSidebarThreads.add(thread.id);
      this.#refreshSidebar(thread.id).catch(() => {});
    });
    bind("zen-threads-ctx-rename", true, () => {
      this.togglePanel();
      setTimeout(() => this.#render().catch(() => {}), 60);
    });
    bind(
      "zen-threads-ctx-group",
      !hasFolder && liveThreadTabs.length >= 2 && typeof gZenFolders !== "undefined",
      () => this.#groupThread(thread, liveThreadTabs)
    );
    bind("zen-threads-ctx-compare", !!compareSet, () =>
      this.#openCompare(thread, compareSet, liveTabs)
    );
    bind("zen-threads-ctx-merge", true, () => {
      this.#mergeSource = thread.id;
      this.#toast("Pick another thread to merge into");
      this.#refreshSidebar().catch(() => {});
    });
    bind("zen-threads-ctx-unmerge", true, () => {
      ZenThreadsStorage.unlinkThread(thread.id);
      this.#queueSidebarRefresh();
    });
    bind("zen-threads-ctx-export", true, () =>
      this.#exportThread(thread).catch(e =>
        console.error("ZenThreads: export failed", e)
      )
    );
    bind("zen-threads-ctx-done", true, () => {
      const out = [];
      this.#collectLiveTabs(thread.roots, liveTabs, out, {
        includePinned: true,
        skipReferences: true,
      });
      ZenThreadsStorage.setThreadStatus(thread.id, "done");
      let closed = 0;
      for (const tab of out) {
        try {
          gBrowser.removeTab(tab, { animate: true });
          closed++;
        } catch (e) {
          // Already gone.
        }
      }
      this.#toast(`Thread archived · ${closed} tabs closed`, () => {
        ZenThreadsStorage.setThreadStatus(thread.id, null);
        for (let i = 0; i < closed; i++) {
          try {
            lazy.SessionStore.undoCloseTab(window, 0);
          } catch (e) {
            break;
          }
        }
        this.#queueSidebarRefresh();
      });
      this.#queueSidebarRefresh();
    });
    bind("zen-threads-ctx-forget", true, () =>
      this.#forgetThread(thread, liveTabs)
    );

    menu.openPopupAtScreen(event.screenX, event.screenY, true);
  }

  #onSidebarKeydown(event) {
    const rows = this.#sidebarRows();
    if (!rows.length) {
      return;
    }
    const active = document.activeElement;
    const current = rows.indexOf(active);

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const next =
        event.key === "ArrowDown"
          ? Math.min(current + 1, rows.length - 1)
          : Math.max(current - 1, 0);
      if (next !== current && rows[next]) {
        event.preventDefault();
        this.#focusRow(rows[next]);
      }
      return;
    }

    if (current < 0) {
      return;
    }
    const threadId = active.dataset.threadId;
    if (!threadId) {
      return;
    }
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      const expanded = this.#expandedSidebarThreads.has(threadId);
      const wantExpanded = event.key === "ArrowRight";
      if (expanded === wantExpanded) {
        return;
      }
      event.preventDefault();
      if (wantExpanded) {
        this.#expandedSidebarThreads.add(threadId);
      } else {
        this.#expandedSidebarThreads.delete(threadId);
      }
      this.#refreshSidebar(threadId).catch(() => {});
    }
  }

  #focusRow(row) {
    for (const other of this.#sidebarRows()) {
      other.setAttribute("tabindex", other === row ? "0" : "-1");
    }
    row.focus();
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

  async #refreshSidebar(focusThreadId = null) {
    const el = this.#sidebarEl;
    if (!el || !el.isConnected) {
      return;
    }
    // Rebuilding the list would otherwise throw away keyboard focus.
    const hadFocus = el.contains(document.activeElement);
    const focusTarget =
      focusThreadId ??
      (hadFocus ? document.activeElement?.dataset?.threadId : null);
    const [{ threads, nodeThread }, shelf, checkpoints] = await Promise.all([
      ZenThreadsStorage.getSnapshot(),
      ZenThreadsStorage.getShelf(),
      ZenThreadsStorage.getCheckpoints(),
    ]);
    this.#nodeThread = nodeThread;
    const liveTabs = this.#buildLiveMap();
    const selKey = this.#tabKeys.get(gBrowser.selectedTab);
    const selRoot = selKey ? this.#threadIdFor(selKey) : null;

    // Tabs belonging to the thread currently in focus.
    const activeThread = threads.find(t => t.id === selRoot);
    let threadKeys = null;
    if (activeThread) {
      threadKeys = new Set();
      const collect = nodes => {
        for (const node of nodes) {
          threadKeys.add(node.key);
          if (node.children.length) {
            collect(node.children);
          }
        }
      };
      collect(activeThread.roots);
    }
    this.#applyTabSalience(threadKeys);

    el.replaceChildren();

    const header = document.createElementNS(XHTML_NS, "div");
    header.className = "zen-ts-header";
    const headerLabel = document.createElementNS(XHTML_NS, "span");
    headerLabel.textContent = ftl("zen-threads-sidebar-label", "Threads");
    header.appendChild(headerLabel);
    const journalBtn = document.createElementNS(XHTML_NS, "button");
    journalBtn.className = "zen-ts-journal-btn";
    journalBtn.textContent = ftl("zen-threads-journal-button", "Journal");
    journalBtn.title = ftl(
        "zen-threads-journal-tooltip",
        "Journal — your browsing as sessions of work"
      );
    journalBtn.addEventListener("click", () =>
      this.#openJournal().catch(e =>
        console.error("ZenThreads: journal failed", e)
      )
    );
    header.appendChild(journalBtn);
    el.appendChild(header);

    if (!threads.length && !shelf.length) {
      const hint = document.createElementNS(XHTML_NS, "div");
      hint.className = "zen-ts-hint";
      hint.textContent =
        "Research trails gather here on their own. ⇧⌘S shelves a page.";
      el.appendChild(hint);
      return;
    }

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
      row.setAttribute("role", "treeitem");
      // Roving tabindex: the list is one tab stop, arrows move within it.
      row.setAttribute("tabindex", "-1");
      row.dataset.threadId = thread.id;
      row.setAttribute(
        "aria-expanded",
        this.#expandedSidebarThreads.has(thread.id) ? "true" : "false"
      );
      row.setAttribute("aria-level", "1");
      row.setAttribute(
        "aria-label",
        `${thread.title}${hasLive ? ", active" : ", paused"}`
      );
      if (hasLive) {
        row.classList.add("live");
      }
      if (isActive) {
        row.classList.add("active");
      }
      row.addEventListener("keydown", e => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          row.click();
        }
      });
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
      const compareSet = this.#comparisonSet(thread);
      if (compareSet) {
        const cmp = document.createElementNS(XHTML_NS, "button");
        cmp.className = "zen-thread-done-btn zen-thread-compare-btn";
        cmp.textContent = `⊞${compareSet.candidates.length}`;
        cmp.title = `Compare ${compareSet.candidates.length} candidates`;
        cmp.addEventListener("click", e => {
          e.stopPropagation();
          this.#openCompare(thread, compareSet, liveTabs);
        });
        row.appendChild(cmp);
      }
      const merge = document.createElementNS(XHTML_NS, "button");
      merge.className = "zen-thread-done-btn zen-thread-merge-btn";
      merge.textContent = "⇆";
      merge.title =
        this.#mergeSource && this.#mergeSource !== thread.id
          ? "Merge the armed thread into this one"
          : "Merge: arm this thread, then click ⇆ on the destination (alt-click to unmerge)";
      merge.addEventListener("click", e => {
        e.stopPropagation();
        if (e.altKey) {
          ZenThreadsStorage.unlinkThread(thread.id);
          this.#mergeSource = null;
        } else if (!this.#mergeSource) {
          this.#mergeSource = thread.id;
        } else if (this.#mergeSource === thread.id) {
          this.#mergeSource = null;
        } else {
          const merged = this.#mergeSource;
          ZenThreadsStorage.linkThreads(thread.id, merged);
          this.#mergeSource = null;
          this.#toast("Threads merged", () => {
            ZenThreadsStorage.unlinkThread(merged);
            this.#queueSidebarRefresh();
          });
        }
        this.#refreshSidebar().catch(() => {});
      });
      row.appendChild(merge);

      const share = document.createElementNS(XHTML_NS, "button");
      share.className = "zen-thread-done-btn";
      share.textContent = "↗";
      share.title = "Copy this thread as Markdown";
      share.addEventListener("click", e => {
        e.stopPropagation();
        this.#exportThread(thread).catch(err =>
          console.error("ZenThreads: export failed", err)
        );
      });
      row.appendChild(share);

      const forget = document.createElementNS(XHTML_NS, "button");
      forget.className = "zen-thread-done-btn zen-thread-forget-btn";
      forget.textContent = "⌫";
      forget.title = "Forget this thread and everything recorded in it";
      forget.addEventListener("click", e => {
        e.stopPropagation();
        this.#forgetThread(thread, liveTabs);
      });
      row.appendChild(forget);

      const done = document.createElementNS(XHTML_NS, "button");
      done.className = "zen-thread-done-btn";
      done.textContent = "✓";
      done.title = "Done — archive thread and close its tabs";
      done.addEventListener("click", e => {
        e.stopPropagation();
        ZenThreadsStorage.setThreadStatus(thread.id, "done");
        const out = [];
        this.#collectLiveTabs(thread.roots, liveTabs, out, {
          includePinned: true,
          skipReferences: true,
        });
        let closed = 0;
        for (const t of out) {
          try {
            gBrowser.removeTab(t, { animate: true });
            closed++;
          } catch (err) {
            // Tab already gone.
          }
        }
        const keptRefs = this.#countReferences(thread.roots, liveTabs);
        this.#toast(
          keptRefs
            ? `Thread archived · ${closed} closed, ${keptRefs} references kept`
            : `Thread archived · ${closed} tabs closed`,
          () => {
            ZenThreadsStorage.setThreadStatus(thread.id, null);
            for (let i = 0; i < closed; i++) {
              try {
                lazy.SessionStore.undoCloseTab(window, 0);
              } catch (err) {
                break;
              }
            }
            this.#queueSidebarRefresh();
          }
        );
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

      if (thread.outcomeTitle) {
        const chose = document.createElementNS(XHTML_NS, "div");
        chose.className = "zen-ts-checkpoint zen-ts-outcome";
        chose.textContent = `✓ chose: ${thread.outcomeTitle}`;
        el.appendChild(chose);
      }

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
      const related = this.#rankShelf(shelf, nodeThread, selRoot).filter(
        item => item.belongsHere
      ).length;
      const row = document.createElementNS(XHTML_NS, "div");
      row.className = "zen-ts-row zen-ts-shelf";
      row.setAttribute("role", "treeitem");
      row.setAttribute("tabindex", "-1");
      row.setAttribute("aria-level", "1");
      row.addEventListener("keydown", e => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          row.click();
        }
      });
      if (related) {
        row.classList.add("live");
      }
      const dot = document.createElementNS(XHTML_NS, "span");
      dot.className = "zen-ts-dot";
      row.appendChild(dot);
      const title = document.createElementNS(XHTML_NS, "span");
      title.className = "zen-ts-title";
      title.textContent = related ? `Shelf · ${related} from this thread` : "Shelf";
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

    this.#updateRovingTabstop(focusTarget);
    if (focusTarget && (hadFocus || focusThreadId)) {
      const restored = this.#sidebarRows().find(
        r => r.dataset.threadId === focusTarget
      );
      restored?.focus();
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
