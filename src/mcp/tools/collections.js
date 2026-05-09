import { listCollections, getCollectionInfo } from '../../core/qdrant.js';
import { loadConfig, getDenseProvider, getDenseModel, getSparseProvider } from '../../core/config.js';

export const schema = {
  name: 'qdrant_collection_info',
  description: 'List all Qdrant collections with point counts, vector size, and description.',
  inputSchema: { type: 'object', properties: {} },
};

export async function handle() {
  const names  = await listCollections();
  const config = loadConfig();
  const lines  = await Promise.all(names.map(async (name) => {
    const info          = await getCollectionInfo(name);
    const desc          = config.collections?.[name]?.description;
    const denseProvider = getDenseProvider(name);
    const denseModel    = getDenseModel(name);
    const sparse        = getSparseProvider(name);
    return `- **${name}** — ${info.points_count} points, dense: ${denseProvider}/${denseModel}, sparse: ${sparse}${desc ? `, ${desc}` : ''}`;
  }));
  return '## Collections\n\n' + lines.join('\n');
}
