// Simple async semaphore — FIFO, no external dependencies.
// Permits are always released even when the task throws.
export class Semaphore {
  constructor(limit) {
    this._limit = limit;
    this._active = 0;
    this._queue = []; // { resolve }
  }

  run(fn) {
    return new Promise((resolve, reject) => {
      this._queue.push({ fn, resolve, reject });
      this._dispatch();
    });
  }

  _dispatch() {
    while (this._active < this._limit && this._queue.length > 0) {
      const { fn, resolve, reject } = this._queue.shift();
      this._active++;
      Promise.resolve()
        .then(() => fn())
        .then(
          result => { this._release(); resolve(result); },
          err    => { this._release(); reject(err); },
        );
    }
  }

  _release() {
    this._active--;
    this._dispatch();
  }
}
