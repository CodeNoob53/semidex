import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

export default async function ({ ok }) {
  console.log('\n[17] chunkFileFromPath PDF fixture (no Qdrant)');

  const { chunkFileFromPath } = await import('../../indexer/phases/chunk.js');
  const fixturePath = resolve(dirname(fileURLToPath(import.meta.url)), '../../test-fixtures/three-sections.pdf');

  const chunks = await chunkFileFromPath(fixturePath, 'three-sections.pdf');

  ok('PDF fixture → more than 1 chunk', chunks.length > 1);

  const withSection = chunks.filter(c => c.section && c.section.length > 0);
  ok('PDF fixture → at least 2 chunks have non-empty section', withSection.length >= 2);

  ok('PDF fixture → section "Chapter One" present',
    chunks.some(c => c.section === 'Chapter One'));
  ok('PDF fixture → section "Chapter Two" present',
    chunks.some(c => c.section === 'Chapter Two'));
  ok('PDF fixture → section "Chapter Three" present',
    chunks.some(c => c.section === 'Chapter Three'));

  // source_file must remain the .pdf path — the synthetic .md path must not leak into payload
  ok('PDF fixture → source_file is original .pdf path (no .md leak)',
    chunks.every(c => c.source_file === 'three-sections.pdf'));

  // chunkIndex and totalChunks must be set correctly
  ok('PDF fixture → chunkIndex assigned',
    chunks.every((c, i) => c.chunkIndex === i));
  ok('PDF fixture → totalChunks consistent',
    chunks.every(c => c.totalChunks === chunks.length));
}
