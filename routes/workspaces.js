import { makeCrudRouter } from '../lib/rest.js';

// 工作区：name/kind/color/description + items 数组
export default makeCrudRouter('workspace', {
  patchable: ['name', 'kind', 'color', 'description', 'items'],
  createDefaults: () => ({ name: '', kind: 'system', color: '#6b8cae', description: '', items: [] }),
});
