// Tests for src/shared/admin/ui-src/shared/api/contracts/operations.js —
// hand-written validators for GET /api/operations and
// GET /api/operations/:id, derived field-by-field from
// src/shared/admin/api/operations.js's jobToOperation()/taskToOperation()
// projections (design plan §15 item 3). No DOM dependency, so this is a
// plain ESM import (same convention as ui-view-lifecycle.test.js/
// ui-api-client.test.js).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../../../src/shared/admin/ui-src/shared/api/client.js';
import {
  validateOperationsListResponse, validateOperationDetailResponse,
} from '../../../src/shared/admin/ui-src/shared/api/contracts/operations.js';

// Shaped exactly like jobToOperation() for a running indexing job.
function validIndexOperation(overrides = {}) {
  return {
    id: 'job-1',
    kind: 'index',
    collection: 'my-docs',
    path: '/data/docs',
    state: 'running',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: null,
    cancellable: true,
    progress: {
      percent: 42, phase: 'embedding', currentFile: 'a.md', processedFiles: 3, totalFiles: 10,
    },
    error: null,
    ...overrides,
  };
}

// Shaped exactly like taskToOperation() for a finished repair — path always
// null, progress always null, never cancellable.
function validRepairOperation(overrides = {}) {
  return {
    id: 'task-1',
    kind: 'repair',
    collection: 'my-docs',
    path: null,
    state: 'succeeded',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:01:00.000Z',
    cancellable: false,
    progress: null,
    error: null,
    ...overrides,
  };
}

function assertContractError(fn) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof ApiError, 'must throw an ApiError');
    assert.equal(err.kind, 'contract');
    return true;
  });
}

describe('contracts/operations.js — validateOperationsListResponse()', () => {
  it('accepts a valid list with both job-shaped and task-shaped operations', () => {
    const body = { operations: [validIndexOperation(), validRepairOperation()] };
    const result = validateOperationsListResponse(body);
    assert.equal(result, body, 'a valid response is returned unchanged, same reference');
  });

  it('accepts an empty operations list', () => {
    const body = { operations: [] };
    assert.equal(validateOperationsListResponse(body), body);
  });

  it('rejects a response missing the "operations" field', () => {
    assertContractError(() => validateOperationsListResponse({}));
  });

  it('rejects a non-array "operations" field', () => {
    assertContractError(() => validateOperationsListResponse({ operations: { not: 'an array' } }));
  });

  it('rejects a non-object response body', () => {
    assertContractError(() => validateOperationsListResponse(null));
    assertContractError(() => validateOperationsListResponse('oops'));
    assertContractError(() => validateOperationsListResponse([]));
  });

  describe('per-operation required-field validation', () => {
    it('rejects a missing "id"', () => {
      const op = validIndexOperation(); delete op.id;
      assertContractError(() => validateOperationsListResponse({ operations: [op] }));
    });

    it('rejects an empty-string "id"', () => {
      assertContractError(() => validateOperationsListResponse({ operations: [validIndexOperation({ id: '' })] }));
    });

    it('rejects a wrong-type "cancellable" (string instead of boolean)', () => {
      assertContractError(() => validateOperationsListResponse({ operations: [validIndexOperation({ cancellable: 'yes' })] }));
    });

    it('rejects an unknown "kind"', () => {
      assertContractError(() => validateOperationsListResponse({ operations: [validIndexOperation({ kind: 'delete' })] }));
    });

    it('rejects an unknown "state"', () => {
      assertContractError(() => validateOperationsListResponse({ operations: [validIndexOperation({ state: 'exploded' })] }));
    });

    it('rejects a wrong-type "collection"', () => {
      assertContractError(() => validateOperationsListResponse({ operations: [validIndexOperation({ collection: 42 })] }));
    });

    it('rejects a wrong-type "path" (must be string or null)', () => {
      assertContractError(() => validateOperationsListResponse({ operations: [validIndexOperation({ path: 7 })] }));
    });

    it('rejects a missing "path" key entirely — jobToOperation()/taskToOperation() always emit it (as null for repair), never omit it', () => {
      const op = validRepairOperation(); delete op.path;
      assertContractError(() => validateOperationsListResponse({ operations: [op] }));
    });

    it('rejects a wrong-type "startedAt"/"finishedAt"', () => {
      assertContractError(() => validateOperationsListResponse({ operations: [validIndexOperation({ startedAt: 12345 })] }));
      assertContractError(() => validateOperationsListResponse({ operations: [validIndexOperation({ finishedAt: 12345 })] }));
    });

    it('rejects a missing "startedAt" key entirely', () => {
      const op = validIndexOperation(); delete op.startedAt;
      assertContractError(() => validateOperationsListResponse({ operations: [op] }));
    });

    it('rejects a missing "finishedAt" key entirely — a still-running job legitimately sends null, never omits the key', () => {
      const op = validIndexOperation(); delete op.finishedAt;
      assertContractError(() => validateOperationsListResponse({ operations: [op] }));
    });

    it('rejects a missing "collection" key entirely', () => {
      const op = validIndexOperation(); delete op.collection;
      assertContractError(() => validateOperationsListResponse({ operations: [op] }));
    });

    it('rejects a missing "cancellable" key entirely', () => {
      const op = validIndexOperation(); delete op.cancellable;
      assertContractError(() => validateOperationsListResponse({ operations: [op] }));
    });

    it('rejects a missing "progress" key entirely (distinct from an explicit null)', () => {
      const op = validRepairOperation(); delete op.progress;
      assertContractError(() => validateOperationsListResponse({ operations: [op] }));
    });

    it('accepts progress: null (repair/indeterminate)', () => {
      const body = { operations: [validIndexOperation({ progress: null })] };
      assert.equal(validateOperationsListResponse(body), body);
    });

    it('rejects a non-object, non-null "progress"', () => {
      assertContractError(() => validateOperationsListResponse({ operations: [validIndexOperation({ progress: 'running' })] }));
    });

    it('rejects a wrong-type field inside "progress"', () => {
      assertContractError(() => validateOperationsListResponse({
        operations: [validIndexOperation({ progress: { percent: '42', phase: null, currentFile: null, processedFiles: null, totalFiles: null } })],
      }));
    });

    it('accepts every progress field as null (fully indeterminate but present)', () => {
      const body = {
        operations: [validIndexOperation({ progress: { percent: null, phase: null, currentFile: null, processedFiles: null, totalFiles: null } })],
      };
      assert.equal(validateOperationsListResponse(body), body);
    });

    it('rejects NaN/Infinity in a numeric progress field (typeof "number" is not enough — must be finite)', () => {
      assertContractError(() => validateOperationsListResponse({
        operations: [validIndexOperation({ progress: { percent: NaN, phase: null, currentFile: null, processedFiles: 0, totalFiles: 10 } })],
      }));
      assertContractError(() => validateOperationsListResponse({
        operations: [validIndexOperation({ progress: { percent: 50, phase: null, currentFile: null, processedFiles: Infinity, totalFiles: 10 } })],
      }));
      assertContractError(() => validateOperationsListResponse({
        operations: [validIndexOperation({ progress: { percent: 50, phase: null, currentFile: null, processedFiles: 0, totalFiles: -Infinity } })],
      }));
    });

    it('rejects a wrong-type "error" (must be string or null)', () => {
      assertContractError(() => validateOperationsListResponse({ operations: [validIndexOperation({ error: 123 })] }));
    });

    it('rejects a missing "error" key entirely — a healthy/running operation legitimately sends null, never omits the key', () => {
      const op = validIndexOperation(); delete op.error;
      assertContractError(() => validateOperationsListResponse({ operations: [op] }));
    });

    it('accepts a failed operation with a string error', () => {
      const body = { operations: [validIndexOperation({ state: 'failed', error: 'ENOENT: no such file' })] };
      assert.equal(validateOperationsListResponse(body), body);
    });
  });

  it('preserves an unknown optional field on an operation unchanged (forward compatibility)', () => {
    const op = validIndexOperation({ requestId: 'req-123' });
    const body = { operations: [op] };
    const result = validateOperationsListResponse(body);
    assert.equal(result.operations[0].requestId, 'req-123');
    assert.equal(result.operations[0], op, 'the validated operation is the SAME object, not a stripped copy');
  });

  it('preserves an unknown optional top-level field on the response body itself', () => {
    const body = { operations: [], serverVersion: '1.2.3' };
    const result = validateOperationsListResponse(body);
    assert.equal(result.serverVersion, '1.2.3');
  });
});

describe('contracts/operations.js — validateOperationDetailResponse()', () => {
  function validDetailBody(overrides = {}) {
    return {
      operation: {
        ...validIndexOperation(),
        sourcePath: '/data/docs',
        log: ['[stdout] indexing started', '[stdout] 3/10 files done'],
        ...overrides,
      },
    };
  }

  it('accepts a valid job detail payload', () => {
    const body = validDetailBody();
    assert.equal(validateOperationDetailResponse(body), body);
  });

  it('accepts a valid repair detail payload (null sourcePath, empty log)', () => {
    const body = { operation: { ...validRepairOperation(), sourcePath: null, log: [] } };
    assert.equal(validateOperationDetailResponse(body), body);
  });

  it('rejects a response missing the "operation" field', () => {
    assertContractError(() => validateOperationDetailResponse({}));
  });

  it('rejects a detail body whose "operation" fails the shared shape checks (e.g. bad state)', () => {
    assertContractError(() => validateOperationDetailResponse(validDetailBody({ state: 'bogus' })));
  });

  it('rejects a wrong-type "sourcePath"', () => {
    assertContractError(() => validateOperationDetailResponse(validDetailBody({ sourcePath: 42 })));
  });

  it('rejects a non-array "log"', () => {
    assertContractError(() => validateOperationDetailResponse(validDetailBody({ log: 'not an array' })));
  });

  it('rejects a "log" array containing a non-string entry', () => {
    assertContractError(() => validateOperationDetailResponse(validDetailBody({ log: ['ok', 42] })));
  });

  it('preserves an unknown optional field on the operation detail unchanged', () => {
    const body = validDetailBody({ exitCode: 0 });
    const result = validateOperationDetailResponse(body);
    assert.equal(result.operation.exitCode, 0);
  });
});
