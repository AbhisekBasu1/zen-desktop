/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  UrlbarProvider,
  UrlbarUtils,
} from "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs";
import { ProvidersManager } from "moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs";
import { ZenThreadsStorage } from "chrome://browser/content/zen-components/ZenThreadsStorage.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  UrlbarResult: "chrome://browser/content/urlbar/UrlbarResult.mjs",
});

const SNAPSHOT_TTL_MS = 5000;
const MAX_THREAD_RESULTS = 2;
const MAX_SHELF_RESULTS = 2;
const MAX_MEMORY_RESULTS = 4;

/**
 * Intent Bar v1: typing in the urlbar surfaces matching Threads
 * ("Resume: ...") and Shelf items above ordinary suggestions.
 */
class ZenThreadsUrlbarProvider extends UrlbarProvider {
  #cache = null;
  #cacheTs = 0;

  get name() {
    return "ZenThreadsUrlbarProvider";
  }

  get type() {
    return UrlbarUtils.PROVIDER_TYPE.PROFILE;
  }

  async isActive(queryContext) {
    return queryContext.trimmedSearchString.length >= 2;
  }

  getPriority() {
    return 0;
  }

  async #data() {
    const now = Date.now();
    if (!this.#cache || now - this.#cacheTs > SNAPSHOT_TTL_MS) {
      const [snapshot, shelf] = await Promise.all([
        ZenThreadsStorage.getSnapshot(),
        ZenThreadsStorage.getShelf(),
      ]);
      this.#cache = { snapshot, shelf };
      this.#cacheTs = now;
    }
    return this.#cache;
  }

  #bestUrl(thread) {
    // Most recently touched node with a real URL.
    let best = null;
    const walk = nodes => {
      for (const n of nodes) {
        if (/^https?:/.test(n.url) && (!best || n.lastTs > best.lastTs)) {
          best = n;
        }
        if (n.children.length) {
          walk(n.children);
        }
      }
    };
    walk(thread.roots);
    return best?.url ?? null;
  }

  #when(ts) {
    const date = new Date(ts);
    const days = Math.floor((Date.now() - ts) / 86400000);
    if (days === 0) {
      return date.toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
      });
    }
    if (days === 1) {
      return "yesterday";
    }
    if (days < 7) {
      return date.toLocaleDateString(undefined, { weekday: "long" });
    }
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  async startQuery(queryContext, addCallback) {
    try {
      const query = queryContext.trimmedSearchString.toLowerCase();
      const { snapshot, shelf } = await this.#data();
      let added = 0;
      const usedUrls = new Set();

      for (const thread of snapshot.threads) {
        if (added >= MAX_THREAD_RESULTS) {
          break;
        }
        const matches = thread.title.toLowerCase().includes(query);
        const url = this.#bestUrl(thread);
        if (!matches || !url) {
          continue;
        }
        const result = new lazy.UrlbarResult({
          type: UrlbarUtils.RESULT_TYPE.URL,
          source: UrlbarUtils.RESULT_SOURCE.HISTORY,
          payload: { url, title: `Resume thread: ${thread.title}` },
          highlights: {},
          suggestedIndex: 1 + added,
        });
        usedUrls.add(url);
        addCallback(this, result);
        added++;
      }

      let shelfAdded = 0;
      for (const item of shelf) {
        if (shelfAdded >= MAX_SHELF_RESULTS) {
          break;
        }
        const label = item.title || item.url;
        if (!label.toLowerCase().includes(query)) {
          continue;
        }
        const result = new lazy.UrlbarResult({
          type: UrlbarUtils.RESULT_TYPE.URL,
          source: UrlbarUtils.RESULT_SOURCE.HISTORY,
          payload: { url: item.url, title: `Shelf: ${label}` },
          highlights: {},
          suggestedIndex: 1 + added,
        });
        usedUrls.add(item.url);
        addCallback(this, result);
        added++;
        shelfAdded++;
      }

      // Pages inside threads. The context clause — which goal you were
      // pursuing, and when — is the part ordinary history cannot produce.
      const hits = await ZenThreadsStorage.searchMemory(
        queryContext.trimmedSearchString,
        MAX_MEMORY_RESULTS + usedUrls.size
      );
      let memoryAdded = 0;
      for (const hit of hits) {
        if (memoryAdded >= MAX_MEMORY_RESULTS || usedUrls.has(hit.url)) {
          continue;
        }
        const context = hit.threadTitle
          ? `from “${hit.threadTitle}” · ${this.#when(hit.ts)}`
          : this.#when(hit.ts);
        const result = new lazy.UrlbarResult({
          type: UrlbarUtils.RESULT_TYPE.URL,
          source: UrlbarUtils.RESULT_SOURCE.HISTORY,
          payload: {
            url: hit.url,
            title: `${hit.title || hit.url} · ${context}`,
          },
          highlights: {},
          suggestedIndex: 1 + added,
        });
        usedUrls.add(hit.url);
        addCallback(this, result);
        added++;
        memoryAdded++;
      }
    } catch (e) {
      console.error("ZenThreadsUrlbarProvider: query failed", e);
    }
  }
}

try {
  const instance = ProvidersManager.getInstanceForSap("urlbar");
  if (!instance.getProvider("ZenThreadsUrlbarProvider")) {
    instance.registerProvider(new ZenThreadsUrlbarProvider());
  }
} catch (e) {
  console.error("ZenThreadsUrlbarProvider: registration failed", e);
}
