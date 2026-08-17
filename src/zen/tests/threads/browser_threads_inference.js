/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Pins the rules that decide what becomes a Thread. These are pure
// interpretation over the append-only event log, so they are exercised by
// writing synthetic events rather than by driving the UI.

const { ZenThreadsStorage } = ChromeUtils.importESModule(
  "chrome://browser/content/zen-components/ZenThreadsStorage.sys.mjs"
);

let keySeed = 0;
function freshKey(label) {
  keySeed++;
  return `test-${label}-${keySeed}-${Services.uuid
    .generateUUID()
    .toString()
    .slice(1, -1)}`;
}

async function threadsFor(keys) {
  const { threads } = await ZenThreadsStorage.getSnapshot();
  const wanted = new Set(keys);
  const collect = (nodes, out) => {
    for (const node of nodes) {
      out.add(node.key);
      collect(node.children, out);
    }
    return out;
  };
  return threads.filter(thread => {
    const members = collect(thread.roots, new Set());
    for (const key of members) {
      if (wanted.has(key)) {
        return true;
      }
    }
    return false;
  });
}

add_task(async function test_search_root_forms_a_thread() {
  const searchKey = freshKey("search");
  const resultKey = freshKey("result");

  ZenThreadsStorage.recordEvent("open", searchKey, null, null, "Search", null);
  ZenThreadsStorage.recordEvent(
    "nav",
    searchKey,
    null,
    "https://www.google.com/search?q=zen+threads+test",
    "zen threads test - Google Search",
    "zen threads test"
  );
  ZenThreadsStorage.recordEvent(
    "open",
    resultKey,
    searchKey,
    null,
    "Result",
    null
  );
  ZenThreadsStorage.recordEvent(
    "nav",
    resultKey,
    null,
    "https://example.com/an-article",
    "An Article",
    null
  );

  const found = await threadsFor([searchKey, resultKey]);
  is(found.length, 1, "Search and its result form exactly one thread");
  is(
    found[0].title,
    "zen threads test",
    "Thread is titled by the originating search query"
  );
  ok(found[0].isSearch, "Thread is marked as search-rooted");

  const root = found[0].roots[0];
  is(root.key, searchKey, "The search is the root of the trail");
  ok(
    root.children.some(child => child.key === resultKey),
    "The opened result is a child of the search"
  );
});

add_task(async function test_single_page_is_not_a_thread() {
  const loneKey = freshKey("lone");

  ZenThreadsStorage.recordEvent("open", loneKey, null, null, "Lone", null);
  ZenThreadsStorage.recordEvent(
    "nav",
    loneKey,
    null,
    "https://example.org/one-off",
    "One Off",
    null
  );

  const found = await threadsFor([loneKey]);
  is(found.length, 0, "A quick one-off lookup never creates structure");
});

add_task(async function test_empty_tab_chain_is_not_a_thread() {
  const a = freshKey("blank-a");
  const b = freshKey("blank-b");
  const c = freshKey("blank-c");

  // Three linked tabs, but none ever reached a real web page.
  ZenThreadsStorage.recordEvent("open", a, null, null, "New Tab", null);
  ZenThreadsStorage.recordEvent("open", b, a, null, "New Tab", null);
  ZenThreadsStorage.recordEvent("open", c, b, null, "New Tab", null);

  const found = await threadsFor([a, b, c]);
  is(found.length, 0, "Chains of empty tabs never qualify as threads");
});

add_task(async function test_app_hosts_are_excluded() {
  const appKey = freshKey("app");
  const childKey = freshKey("app-child");

  ZenThreadsStorage.recordEvent("open", appKey, null, null, "Mail", null);
  ZenThreadsStorage.recordEvent(
    "nav",
    appKey,
    null,
    "https://mail.google.com/mail/u/0/#inbox",
    "Inbox (3)",
    null
  );
  ZenThreadsStorage.recordEvent("open", childKey, appKey, null, "Link", null);
  ZenThreadsStorage.recordEvent(
    "nav",
    childKey,
    null,
    "https://example.net/from-mail",
    "From Mail",
    null
  );

  const { threads } = await ZenThreadsStorage.getSnapshot();
  const withApp = threads.filter(thread => {
    const stack = [...thread.roots];
    while (stack.length) {
      const node = stack.pop();
      if (node.key === appKey) {
        return true;
      }
      stack.push(...node.children);
    }
    return false;
  });
  is(withApp.length, 0, "An app page is never part of a thread");
});

add_task(async function test_manual_merge_unifies_threads() {
  const searchA = freshKey("merge-a");
  const resultA = freshKey("merge-a-result");
  const searchB = freshKey("merge-b");
  const resultB = freshKey("merge-b-result");

  for (const [searchKey, resultKey, query] of [
    [searchA, resultA, "keyboard switches test"],
    [searchB, resultB, "keycap profiles test"],
  ]) {
    ZenThreadsStorage.recordEvent("open", searchKey, null, null, "S", null);
    ZenThreadsStorage.recordEvent(
      "nav",
      searchKey,
      null,
      `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
      `${query} at DuckDuckGo`,
      query
    );
    ZenThreadsStorage.recordEvent("open", resultKey, searchKey, null, "R", null);
    ZenThreadsStorage.recordEvent(
      "nav",
      resultKey,
      null,
      `https://example.com/${encodeURIComponent(query)}`,
      query,
      null
    );
  }

  let found = await threadsFor([searchA, searchB]);
  is(found.length, 2, "Two separate searches start as two threads");

  ZenThreadsStorage.linkThreads(searchA, searchB);

  found = await threadsFor([searchA, searchB]);
  is(found.length, 1, "Linked threads derive as a single thread");
});

add_task(async function test_shelf_roundtrip() {
  const url = `https://example.com/shelf-${Date.now()}`;
  ZenThreadsStorage.shelvePage(url, "Shelved Page", null);

  let shelf = await ZenThreadsStorage.getShelf();
  const item = shelf.find(entry => entry.url === url);
  ok(item, "A shelved page appears on the shelf");
  is(item.title, "Shelved Page", "Shelved page keeps its title");

  ZenThreadsStorage.resolveShelfItem(item.id, true);

  shelf = await ZenThreadsStorage.getShelf();
  ok(
    !shelf.some(entry => entry.url === url),
    "A resolved page leaves the shelf"
  );
});

add_task(async function test_snapshot_cache_is_reused_and_invalidated() {
  const first = await ZenThreadsStorage.getSnapshot();
  const second = await ZenThreadsStorage.getSnapshot();
  is(second, first, "Repeated snapshots reuse the cached derivation");

  ZenThreadsStorage.recordEvent(
    "nav",
    freshKey("cache"),
    null,
    "https://example.com/cache-buster",
    "Cache Buster",
    null
  );

  const third = await ZenThreadsStorage.getSnapshot();
  isnot(third, first, "A recorded event invalidates the snapshot cache");
});

add_task(async function test_checkpoint_write_preserves_typed_note() {
  const threadId = freshKey("checkpoint");

  ZenThreadsStorage.setCheckpoint(threadId, "test the resume flow", null, null);
  ZenThreadsStorage.setCheckpoint(
    threadId,
    null,
    "https://example.com/last",
    "Last Page"
  );

  const checkpoints = await ZenThreadsStorage.getCheckpoints();
  const cp = checkpoints.get(threadId);
  ok(cp, "Checkpoint is stored");
  is(
    cp.note,
    "test the resume flow",
    "An automatic checkpoint does not erase a typed intention"
  );
  is(cp.lastTitle, "Last Page", "Automatic checkpoint updates the position");
});

add_task(async function test_same_tab_search_keeps_its_origin() {
  // The common case: search, then click a result in the SAME tab. The trail
  // must still be rooted in — and named after — the search.
  const key = freshKey("same-tab");

  ZenThreadsStorage.recordEvent("open", key, null, null, "New Tab", null);
  ZenThreadsStorage.recordEvent(
    "nav",
    key,
    null,
    "https://www.google.com/search?q=same+tab+origin+test",
    "same tab origin test - Google Search",
    "same tab origin test"
  );
  // Same tab navigates onward to a result.
  ZenThreadsStorage.recordEvent(
    "nav",
    key,
    null,
    "https://example.com/the-result",
    "The Result",
    null
  );

  const found = await threadsFor([key]);
  is(found.length, 1, "A same-tab search still forms a thread on its own");
  is(
    found[0].title,
    "same tab origin test",
    "Navigating in place does not erase the search that started the trail"
  );
  ok(found[0].isSearch, "Thread is still recognised as search-rooted");
});

add_task(async function test_done_survives_closing_its_tabs() {
  const searchKey = freshKey("done-search");
  const resultKey = freshKey("done-result");

  ZenThreadsStorage.recordEvent("open", searchKey, null, null, "S", null);
  ZenThreadsStorage.recordEvent(
    "nav",
    searchKey,
    null,
    "https://duckduckgo.com/?q=done+lifecycle+test",
    "done lifecycle test",
    "done lifecycle test"
  );
  ZenThreadsStorage.recordEvent("open", resultKey, searchKey, null, "R", null);
  ZenThreadsStorage.recordEvent(
    "nav",
    resultKey,
    null,
    "https://example.com/done-lifecycle",
    "Done Lifecycle",
    null
  );

  let found = await threadsFor([searchKey]);
  is(found.length, 1, "Thread exists before being marked done");
  const threadId = found[0].id;

  // Marking done happens first, then the tabs close — the close events must
  // not make the thread look active again.
  ZenThreadsStorage.setThreadStatus(threadId, "done");
  ZenThreadsStorage.recordEvent(
    "close",
    resultKey,
    null,
    "https://example.com/done-lifecycle",
    "Done Lifecycle",
    null
  );
  ZenThreadsStorage.recordEvent("close", searchKey, null, null, "S", null);

  found = await threadsFor([searchKey]);
  is(found.length, 1, "Thread is still derivable after being archived");
  ok(found[0].done, "Closing its tabs does not resurrect a done thread");
  is(found[0].tier, "archived", "A done thread is archived");
});

add_task(async function test_merge_can_be_undone() {
  const a = freshKey("unmerge-a");
  const b = freshKey("unmerge-b");

  for (const [key, query] of [
    [a, "unmerge alpha test"],
    [b, "unmerge beta test"],
  ]) {
    ZenThreadsStorage.recordEvent("open", key, null, null, "S", null);
    ZenThreadsStorage.recordEvent(
      "nav",
      key,
      null,
      `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
      query,
      query
    );
    const child = freshKey("unmerge-child");
    ZenThreadsStorage.recordEvent("open", child, key, null, "R", null);
    ZenThreadsStorage.recordEvent(
      "nav",
      child,
      null,
      `https://example.com/${encodeURIComponent(query)}`,
      query,
      null
    );
  }

  is((await threadsFor([a, b])).length, 2, "Two threads to begin with");

  ZenThreadsStorage.linkThreads(a, b);
  is((await threadsFor([a, b])).length, 1, "Merging fuses them");

  ZenThreadsStorage.unlinkThread(a);
  is((await threadsFor([a, b])).length, 2, "Unmerging separates them again");
});
