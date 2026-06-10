import { listCollections, getCollectionInfo } from '../../core/qdrant.js';
import { loadConfig, resolveEnvProviders } from '../../core/config.js';

export const schema = {
  name: 'qdrant_collection_info',
  description: 'List all Qdrant collections with point counts, vector size, and description.',
  inputSchema: { type: 'object', properties: {} },
};

export async function handle() {
  const names   = await listCollections();
  const config  = loadConfig();
  const envProv = resolveEnvProviders();
  const lines   = await Promise.all(names.map(async (name) => {
    const info  = await getCollectionInfo(name);
    const col   = config.collections?.[name];
    const denseProvider = col?.denseProvider
      ?? (col?.sparseProvider === 'bge-m3-onnx' ? 'bge-m3-onnx' : envProv.denseProvider);
    const denseModel    = col?.denseModel ?? col?.embedModel ?? envProv.denseModel;
    const sparse        = col?.sparseProvider ?? envProv.sparseProvider;
    const desc          = col?.description;
    return `- **${name}** — ${info.points_count} points, dense: ${denseProvider}/${denseModel}, sparse: ${sparse}${desc ? `, ${desc}` : ''}`;
  }));
  return '## Collections\n\n' + lines.join('\n');
}
