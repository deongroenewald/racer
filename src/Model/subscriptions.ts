import { Model } from './Model';
import { CollectionCounter } from './CollectionCounter';
import { mutationEvents } from './events';
import { Query } from './Query';
import * as util from '../util';
const UnloadEvent = mutationEvents.UnloadEvent;
const promisify = util.promisify;

/**
 * A path string, a `Model`, or a `Query`.
 */
export type Subscribable = string | Model<unknown> | Query<unknown>;

declare module './Model' {
  interface Model<T> {
    /**
     * Retrieve data from the server, loading it into the model.
     *
     * @param items
     * @param cb
     *
     * @see https://derbyjs.github.io/derby/models/backends#loading-data-into-a-model
     */
    fetch(items: Subscribable[], cb?: ErrorCallback): Model<T>;
    fetch(item: Subscribable, cb?: ErrorCallback): Model<T>;
    fetch(cb?: ErrorCallback): Model<T>;
    
    fetchPromised(items: Subscribable[]): Promise<void>;
    fetchPromised(item: Subscribable): Promise<void>;
    fetchPromised(): Promise<void>;

    fetchDoc(collecitonName: string, id: string, callback?: ErrorCallback): void;
    fetchDocPromised(collecitonName: string, id: string): Promise<void>;
    fetchOnly: boolean;

    /**
     * Retrieve data from the server, loading it into the model. In addition,
     * subscribe to the items, such that updates from any other client will
     * automatically get reflected in this client's model.
     *
     * Any item that's already subscribed will not result in a network call.
     *
     * @param items
     * @param cb
     *
     * @see https://derbyjs.github.io/derby/models/backends#loading-data-into-a-model
     */
    subscribe(items: Subscribable[], cb?: ErrorCallback): Model<T>;
    subscribe(item: Subscribable, cb?: ErrorCallback): Model<T>;
    subscribe(cb?: ErrorCallback): Model<T>;

    subscribePromised(items: Subscribable[]): Promise<void>;
    subscribePromised(item: Subscribable): Promise<void>;
    subscribePromised(): Promise<void>;

    subscribeDoc(collecitonName: string, id: string, callback?: ErrorCallback): void;
    subscribeDocPromised(collecitonName: string, id: string): Promise<void>;

    /**
     * The reverse of `#fetch`, marking the items as no longer needed in the
     * model.
     *
     * @param items
     * @param cb
     *
     * @see https://derbyjs.github.io/derby/models/backends#loading-data-into-a-model
     */
    unfetch(items: Subscribable[], cb?: ErrorCallback): Model<T>;
    unfetch(item: Subscribable, cb?: ErrorCallback): Model<T>;
    unfetch(cb?: ErrorCallback): Model<T>;

    unfetchPromised(items: Subscribable[]): Promise<void>;
    unfetchPromised(item: Subscribable): Promise<void>;
    unfetchPromised(): Promise<void>;
    
    unfetchDoc(collecitonName: string, id: string, callback?: (err?: Error, count?: number) => void): void;
    unfetchDocPromised(collecitonName: string, id: string): Promise<void>;
    unloadDelay: number;


    /**
     * The reverse of `#subscribe`, marking the items as no longer needed in the
     * model.
     *
     * @param items
     * @param cb
     *
     * @see https://derbyjs.github.io/derby/models/backends#loading-data-into-a-model
     */
    unsubscribe(items: Subscribable[], cb?: ErrorCallback): Model<T>;
    unsubscribe(item: Subscribable, cb?: ErrorCallback): Model<T>;
    unsubscribe(cb?: ErrorCallback): Model<T>;

    unsubscribePromised(): Promise<void>;
    unsubscribeDoc(collecitonName: string, id: string, callback?: (err?: Error, count?: number) => void): void;
    unsubscribeDocPromised(collecitonName: string, id: string): Promise<void>;

    _fetchedDocs: CollectionCounter;
    _forSubscribable(argumentsObject: any, method: any): void;
    _hasDocReferences(collecitonName: string, id: string): boolean;
    _maybeUnloadDoc(collecitonName: string, id: string): void;
    _subscribedDocs: CollectionCounter;
  }
}

Model.INITS.push(function(model, options) {
  model.root.fetchOnly = options.fetchOnly;
  model.root.unloadDelay = options.unloadDelay || (util.isServer) ? 0 : 1000;

  // Track the total number of active fetches per doc
  model.root._fetchedDocs = new CollectionCounter();
  // Track the total number of active susbscribes per doc
  model.root._subscribedDocs = new CollectionCounter();
});

Model.prototype.fetch = function() {
  this._forSubscribable(arguments, 'fetch');
  return this;
};
Model.prototype.fetchPromised = promisify(Model.prototype.fetch);

Model.prototype.unfetch = function() {
  this._forSubscribable(arguments, 'unfetch');
  return this;
};
Model.prototype.unfetchPromised = promisify(Model.prototype.unfetch);

Model.prototype.subscribe = function() {
  this._forSubscribable(arguments, 'subscribe');
  return this;
};
Model.prototype.subscribePromised = promisify(Model.prototype.subscribe);

Model.prototype.unsubscribe = function() {
  this._forSubscribable(arguments, 'unsubscribe');
  return this;
};
Model.prototype.unsubscribePromised = promisify(Model.prototype.unsubscribe);

Model.prototype._forSubscribable = function(argumentsObject, method) {
  var args, cb;
  if (!argumentsObject.length) {
    // Use this model's scope if no arguments
    args = [null];
  } else if (typeof argumentsObject[0] === 'function') {
    // Use this model's scope if the first argument is a callback
    args = [null];
    cb = argumentsObject[0];
  } else if (Array.isArray(argumentsObject[0])) {
    // Items can be passed in as an array
    args = argumentsObject[0];
    cb = argumentsObject[1];
  } else {
    // Or as multiple arguments
    args = Array.prototype.slice.call(argumentsObject);
    var last = args[args.length - 1];
    if (typeof last === 'function') cb = args.pop();
  }

  var group = util.asyncGroup(this.wrapCallback(cb));
  var finished = group();
  var docMethod = method + 'Doc';

  this.root.connection.startBulk();
  for (var i = 0; i < args.length; i++) {
    var item = args[i];
    if (item instanceof Query) {
      item[method](group());
    } else {
      var segments = this._dereference(this._splitPath(item));
      if (segments.length === 2) {
        // Do the appropriate method for a single document.
        this[docMethod](segments[0], segments[1], group());
      } else {
        var message = 'Cannot ' + method + ' to path: ' + segments.join('.');
        group()(new Error(message));
      }
    }
  }
  this.root.connection.endBulk();
  process.nextTick(finished);
};

Model.prototype.fetchDoc = function(collectionName, id, cb) {
  cb = this.wrapCallback(cb);

  // Maintain a count of fetches so that we can unload the document
  // when there are no remaining fetches or subscribes for that document
  this._context.fetchDoc(collectionName, id);
  this.root._fetchedDocs.increment(collectionName, id);

  // Fetch
  var doc = this.getOrCreateDoc(collectionName, id);
  doc.shareDoc.fetch(cb);
};
Model.prototype.fetchDocPromised = promisify(Model.prototype.fetchDoc);

Model.prototype.subscribeDoc = function(collectionName, id, cb) {
  cb = this.wrapCallback(cb);

  // Maintain a count of subscribes so that we can unload the document
  // when there are no remaining fetches or subscribes for that document
  this._context.subscribeDoc(collectionName, id);
  this.root._subscribedDocs.increment(collectionName, id);

  var doc = this.getOrCreateDoc(collectionName, id);
  // Early return if we know we are already subscribed
  if (doc.shareDoc.subscribed) {
    return cb();
  }
  // Subscribe
  if (this.root.fetchOnly) {
    doc.shareDoc.fetch(cb);
  } else {
    doc.shareDoc.subscribe(cb);
  }
};
Model.prototype.subscribeDocPromised = promisify(Model.prototype.subscribeDoc);

Model.prototype.unfetchDoc = function(collectionName, id, cb) {
  cb = this.wrapCallback(cb);
  this._context.unfetchDoc(collectionName, id);

  // No effect if the document is not currently fetched
  if (!this.root._fetchedDocs.get(collectionName, id)) return cb();

  var model = this;
  if (this.root.unloadDelay) {
    setTimeout(finishUnfetchDoc, this.root.unloadDelay);
  } else {
    finishUnfetchDoc();
  }
  function finishUnfetchDoc() {
    var count = model.root._fetchedDocs.decrement(collectionName, id);
    if (count) return cb(null, count);
    model._maybeUnloadDoc(collectionName, id);
    cb(null, 0);
  }
};
Model.prototype.unfetchDocPromised = promisify(Model.prototype.unfetchDoc);

Model.prototype.unsubscribeDoc = function(collectionName, id, cb) {
  cb = this.wrapCallback(cb);
  this._context.unsubscribeDoc(collectionName, id);

  // No effect if the document is not currently subscribed
  if (!this.root._subscribedDocs.get(collectionName, id)) return cb();

  var model = this;
  if (this.root.unloadDelay) {
    setTimeout(finishUnsubscribeDoc, this.root.unloadDelay);
  } else {
    finishUnsubscribeDoc();
  }
  function finishUnsubscribeDoc() {
    var count = model.root._subscribedDocs.decrement(collectionName, id);
    // If there are more remaining subscriptions, only decrement the count
    // and callback with how many subscriptions are remaining
    if (count) return cb(null, count);

    // If there is only one remaining subscription, actually unsubscribe
    if (model.root.fetchOnly) {
      unsubscribeDocCallback();
    } else {
      var doc = model.getDoc(collectionName, id);
      var shareDoc = doc && doc.shareDoc;
      if (!shareDoc) return unsubscribeDocCallback();
      shareDoc.unsubscribe(unsubscribeDocCallback);
    }
  }
  function unsubscribeDocCallback(err?: Error) {
    model._maybeUnloadDoc(collectionName, id);
    if (err) return cb(err);
    cb(null, 0);
  }
};
Model.prototype.unsubscribeDocPromised = promisify(Model.prototype.unsubscribeDoc);

// Removes the document from the local model if the model no longer has any
// remaining fetches or subscribes via a query or direct loading
Model.prototype._maybeUnloadDoc = function(collectionName, id) {
  var model = this;
  var doc = this.getDoc(collectionName, id);
  if (!doc) return;

  // If there is a query or direct fetch or subscribe that is holding reference
  // to this doc, leave it loaded
  if (this._hasDocReferences(collectionName, id)) return;
  // Calling sharedDoc.destroy() will remove it from the connection only when
  // there aren't any operations, fetches, or subscribes pending on the doc.
  // Thus, if we remove the doc from Racer's model but don't remove it from
  // ShareDB, we can end up with an inconsistent state, with the data existing
  // in ShareDB not reflected in the racer model data
  if (doc.shareDoc && doc.shareDoc.hasPending()) {
    // If the Share doc still has pending activity, retry _maybeUnloadDoc once
    // the pending activity is done.
    doc.shareDoc.whenNothingPending(function() {
      model._maybeUnloadDoc(collectionName, id);
    });
  } else {
    // Otherwise, actually do the unload.
    var previous = doc.get();

    // Remove doc from Racer
    if (model.root.collections[collectionName]) model.root.collections[collectionName].remove(id);
    // Remove doc from Share
    if (doc.shareDoc) doc.shareDoc.destroy();

    var event = new UnloadEvent(previous, this._pass);
    this._emitMutation([collectionName, id], event);
  }
};

Model.prototype._hasDocReferences = function(collectionName, id) {
  // Check if any fetched or subscribed queries currently have the
  // id in their results
  var queries = this.root._queries.collectionMap.getCollection(collectionName);
  if (queries) {
    for (var hash in queries) {
      var query = queries[hash];
      if (!query.subscribeCount && !query.fetchCount) continue;
      if (query.idMap[id] > 0) return true;
    }
  }

  // Check if document currently has direct fetch or subscribe
  if (
    this.root._fetchedDocs.get(collectionName, id) ||
    this.root._subscribedDocs.get(collectionName, id)
  ) return true;

  return false;
};
