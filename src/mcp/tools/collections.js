import { listCollections, getCollectionInfo } from '../../core/qdrant.js';
import { loadConfig, getSparseProvider } from '../../core/config.js';

export const schema = {
  name: 'qdrant_collection_info',
  description: 'List all Qdrant collections with point counts, vector size, and description.',
  inputSchema: { type: 'object', properties: {} },
};

export async function handle() {
  const names = await listCollections();
  const config = loadConfig();
  const lines = await Promise.all(names.map(async (name) => {
    const info = await getCollectionInfo(name);
    const desc = config.collections?.[name]?.description;
    const model    = config.collections?.[name]?.embedModel ?? process.env.EMBED_MODEL ?? 'bge-m3';
    const provider = getSparseProvider(name);
    return `- **${name}** — ${info.points_count} points, model: ${model}, sparse: ${provider}${desc ? `, ${desc}` : ''}`;
  }));
  return '## Collections\n\n' + lines.join('\n');
}
