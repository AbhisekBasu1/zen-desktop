# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

## Sidebar section

zen-threads-sidebar-label = Threads
zen-threads-journal-button = Journal
zen-threads-journal-tooltip = Journal — your browsing as sessions of work
zen-threads-empty-hint = Research trails gather here on their own.
zen-threads-shelf-label = Shelf
zen-threads-shelf-with-related =
    Shelf · { $count } from this thread

## Thread actions

zen-threads-action-done = Done — archive this thread and close its tabs
zen-threads-action-restore = Restore this thread
zen-threads-action-merge = Merge: pick this thread, then click again on the destination. Hold Alt to unmerge.
zen-threads-action-merge-into = Merge the selected thread into this one
zen-threads-action-compare =
    Compare { $count } candidates
zen-threads-action-group = Group this thread's tabs into a sidebar folder
zen-threads-action-grouped = Grouped in sidebar
zen-threads-action-forget = Forget this thread and everything in it
zen-threads-rename-tooltip = Double-click to rename

## Panel

zen-threads-panel-title = Threads — live trail
zen-threads-panel-empty = No trails yet — browse a little.
zen-threads-loose-tabs = Loose tabs
zen-threads-earlier =
    Earlier · { $count }
zen-threads-show-archived =
    Show archived · { $count }
zen-threads-hide-archived = Hide archived
zen-threads-note-placeholder = next: …
zen-threads-note-placeholder-own = Notes on this thread…
zen-threads-shelf-filter = Filter shelf…
zen-threads-action-export = Copy this thread as Markdown
zen-threads-shelf-remove = Remove from shelf
zen-threads-shelf-receded =
    Receded · { $count }
zen-threads-shelf-affinity = this thread

## Return card

zen-threads-return-label =
    Where you left off · { $duration } ago
zen-threads-return-next = next: { $note }

## Compare

zen-threads-compare-search =
    Comparing { $count } results for “{ $title }”
zen-threads-compare-pages =
    Comparing { $count } pages from “{ $title }”
zen-threads-compare-close = Close comparison
zen-threads-compare-goto = Go to tab
zen-threads-compare-reopen = Reopen
zen-threads-compare-keep = Keep this one
zen-threads-compare-keep-tooltip = Record this as the decision and shelve the rest
zen-threads-compare-open = open
zen-threads-compare-closed = closed
zen-threads-chose = chose: { $title }

## Journal

zen-threads-journal-title = Journal
zen-threads-journal-close = Close journal
zen-threads-journal-empty = Nothing recorded yet. Once you work on something, it shows up here as sessions rather than a list of links.
zen-threads-journal-today = Today
zen-threads-journal-yesterday = Yesterday
zen-threads-journal-resume = Resume
zen-threads-journal-pages =
    { $pages ->
        [one] { $pages } page
       *[other] { $pages } pages
    } · { $minutes } min

## Undo toasts

zen-threads-toast-shelved = Page shelved
zen-threads-toast-archived =
    Thread archived · { $count } tabs closed
zen-threads-toast-merged = Threads merged
zen-threads-toast-forgotten = Thread forgotten
zen-threads-toast-undo = Undo

## Library

zen-threads-library = Library
zen-threads-reference-badge = reference
zen-threads-archived-kept =
    Thread archived · { $count } references kept
