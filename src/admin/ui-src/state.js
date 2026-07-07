// The one piece of UI state written from more than one module: which
// collection's sidebar tree is currently expanded. sidebar.js,
// collection-view.js, and settings-view.js all read/write this — a plain
// module-level variable would need each of those to import a live mutable
// binding, which ES modules don't make clean; a getter/setter pair does,
// while still being the same kind of singleton (module instances are
// cached) that a bigger state-factory pattern would provide, with none of
// the churn.
let expandedCollection = null; // name of the collection whose tree is open

export function getExpandedCollection() {
  return expandedCollection;
}

export function setExpandedCollection(name) {
  expandedCollection = name;
}
