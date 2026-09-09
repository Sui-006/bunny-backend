import { makeCrudRouter } from '../lib/rest.js';

// 笔记：title/content/tags/pinned
export default makeCrudRouter('notes', {
  patchable: ['title', 'content', 'tags', 'pinned'],
  createDefaults: () => ({ title: '新笔记', content: '', tags: [], pinned: false, updatedAt: Date.now() }),
});
