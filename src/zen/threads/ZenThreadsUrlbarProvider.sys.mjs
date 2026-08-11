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
const MAX_RESULTS = 3;

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
    return (
      !queryContext.searchMode &&
      queryContext.trimmedSearchString.length >= 2
    );
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

  async startQuery(queryContext, addCallback) {
    try {
      const query = queryContext.trimmedSearchString.toLowerCase();
      const { snapshot, shelf } = await this.#data();
      let added = 0;

      for (const thread of snapshot.threads) {
        if (added >= MAX_RESULTS) {
          break;
        }
        if (!thread.title.toLowerCase().includes(query)) {
          continue;
        }
        const url = this.#bestUrl(thread);
        if (!url) {
          continue;
        }
        const result = new lazy.UrlbarResult(
          UrlbarUtils.RESULT_TYPE.URL,
          UrlbarUtils.RESULT_SOURCE.HISTORY,
          ...lazy.UrlbarResult.payloadAndSimpleHighlights(
            queryContext.tokens,
            {
              url,
              title: [`Resume thread: ${thread.title}`, UrlbarUtils.HIGHLIGHT.TYPED],
            }
          )
        );
        addCallback(this, result);
        added++;
      }

      for (const item of shelf) {
        if (added >= MAX_RESULTS) {
          break;
        }
        const label = item.title || item.url;
        if (!label.toLowerCase().includes(query)) {
          continue;
        }
        const result = new lazy.UrlbarResult(
          UrlbarUtils.RESULT_TYPE.URL,
          UrlbarUtils.RESULT_SOURCE.HISTORY,
          ...lazy.UrlbarResult.payloadAndSimpleHighlights(
            queryContext.tokens,
            {
              url: item.url,
              title: [`Shelf: ${label}`, UrlbarUtils.HIGHLIGHT.TYPED],
            }
          )
        );
        addCallback(this, result);
        added++;
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
