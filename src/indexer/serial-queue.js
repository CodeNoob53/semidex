// Serial async queue — tasks run one at a time in submission order.
// Errors propagate to the caller; the queue continues with subsequent tasks.
export class SerialQueue {
  constructor() {
    this._tail = Promise.resolve();
  }

  run(fn) {
    const result = this._tail.then(() => fn());
    // Keep tail alive regardless of individual task outcome so the queue
    // never stops processing after a rejection.
    this._tail = result.then(() => {}, () => {});
    return result;
  }
}
