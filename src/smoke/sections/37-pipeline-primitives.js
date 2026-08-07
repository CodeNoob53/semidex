export default async function ({ ok, throwsAsync }) {
  console.log('\n[37] Pipeline primitives (Semaphore + SerialQueue)');

  const { Semaphore } = await import('../../shared/indexer/semaphore.js');
  const { SerialQueue } = await import('../../shared/indexer/serial-queue.js');

  // ── Semaphore ──────────────────────────────────────────────────────────────

  // 37a. Basic: runs a task and returns its value
  {
    const sem = new Semaphore(1);
    const result = await sem.run(() => Promise.resolve(42));
    ok('semaphore: returns task value', result === 42);
  }

  // 37b. Limit=1: tasks run sequentially
  {
    const sem = new Semaphore(1);
    const order = [];
    await Promise.all([
      sem.run(async () => { order.push(1); await tick(); order.push(11); }),
      sem.run(async () => { order.push(2); await tick(); order.push(22); }),
    ]);
    // With limit=1, task 1 must fully complete before task 2 starts
    ok('semaphore limit=1: sequential order', order[0] === 1 && order[1] === 11 && order[2] === 2 && order[3] === 22);
  }

  // 37c. Limit=2: two tasks run concurrently
  {
    const sem = new Semaphore(2);
    const order = [];
    let resolve1, resolve2;
    const p1 = sem.run(() => new Promise(r => { order.push('start1'); resolve1 = r; }));
    const p2 = sem.run(() => new Promise(r => { order.push('start2'); resolve2 = r; }));
    await tick(); // let both tasks start
    ok('semaphore limit=2: both tasks started', order.includes('start1') && order.includes('start2'));
    resolve1(); resolve2();
    await Promise.all([p1, p2]);
  }

  // 37d. Errors propagate and permit is released
  {
    const sem = new Semaphore(1);
    let threw = false;
    try {
      await sem.run(() => Promise.reject(new Error('boom')));
    } catch (e) {
      threw = e.message === 'boom';
    }
    ok('semaphore: error propagates', threw);
    // After error, semaphore should still work
    const result = await sem.run(() => Promise.resolve('ok'));
    ok('semaphore: usable after error (no deadlock)', result === 'ok');
  }

  // ── SerialQueue ────────────────────────────────────────────────────────────

  // 37e. Basic: runs a task and returns its value
  {
    const q = new SerialQueue();
    const result = await q.run(() => Promise.resolve(99));
    ok('serial-queue: returns task value', result === 99);
  }

  // 37f. Tasks run in submission order
  {
    const q = new SerialQueue();
    const order = [];
    await Promise.all([
      q.run(async () => { order.push(1); await tick(); order.push(11); }),
      q.run(async () => { order.push(2); await tick(); order.push(22); }),
      q.run(async () => { order.push(3); }),
    ]);
    ok('serial-queue: strict serial order', order.join(',') === '1,11,2,22,3');
  }

  // 37g. Error propagates and queue continues with next task
  {
    const q = new SerialQueue();
    const results = [];
    const p1 = q.run(() => Promise.reject(new Error('fail'))).catch(e => results.push('err:' + e.message));
    const p2 = q.run(() => Promise.resolve('after')).then(v => results.push(v));
    await Promise.all([p1, p2]);
    ok('serial-queue: error propagates to caller', results.includes('err:fail'));
    ok('serial-queue: queue continues after error', results.includes('after'));
  }

  // 37h. Error does not block subsequent tasks
  {
    const q = new SerialQueue();
    let afterRan = false;
    await q.run(() => Promise.reject(new Error('x'))).catch(() => {});
    await q.run(() => { afterRan = true; });
    ok('serial-queue: no deadlock after rejection', afterRan);
  }
}

function tick() {
  return new Promise(r => setTimeout(r, 0));
}
