import { makeCrudRouter } from '../lib/rest.js';

// 家人：name/relationship/avatar/status + care 数组
export default makeCrudRouter('family', {
  patchable: ['name', 'relationship', 'avatar', 'status', 'care'],
  createDefaults: () => ({ name: '', relationship: '', avatar: '', status: '', care: [] }),
});
