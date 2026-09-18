// AI 权限策略（单一来源，READ/CREATE/WRITE/DELETE 四粒度，非 ADMIN 兜底）。
// 日志 / 签名 = USER_ONLY_EDITABLE：AI 只能读，绝不 write/create/delete。
// 健康/财务/病历/经期/音乐等遵循既有业务规则；统计/会话历史为派生只读。

export const AI_PERMISSION_POLICY = {
  // 日志/签名：AI 只能读，绝不 write/create/delete；「comment」= 仅可写评论（与 write 分离）
  journal:      { read: true,  create: false, write: false, delete: false, comment: true },
  signature:    { read: true,  create: false, write: false, delete: false },
  tasks:        { read: true,  create: true,  write: true,  delete: true },
  plans:        { read: true,  create: true,  write: true,  delete: true },
  calendar:     { read: true,  create: true,  write: true,  delete: true },
  habit:        { read: true,  create: true,  write: true,  delete: true },
  shopping:     { read: true,  create: true,  write: true,  delete: true },
  notes:        { read: true,  create: true,  write: true,  delete: true },
  memory:       { read: true,  create: true,  write: true,  delete: true },
  health:       { read: true,  create: true,  write: true,  delete: true, comment: true },
  finance:      { read: true,  create: true,  write: true,  delete: true, comment: true },
  medical:      { read: true,  create: true,  write: true,  delete: true },
  menstrual:    { read: true,  create: true,  write: true,  delete: true },
  music:        { read: true,  create: true,  write: true,  delete: true },
  statistics:   { read: true,  create: false, write: false, delete: false },
  conversation: { read: true,  create: false, write: false, delete: false },
  // 对话缓存（AI 自己的上下文压缩表示，与长期记忆/原始历史分离）：AI 可读/建立/更新，不删除
  conversation_cache: { read: true,  create: true,  write: true,  delete: false },
  // AI 动态（AI 自己的活动流水）：AI 可回看/新增/改写/删除「自己写下的动态」；
  // 用户/系统条目经 isAiActivity 过滤，工具层也只允许改 AI 自己的动态。
  activity:     { read: true,  create: true,  write: true,  delete: true },
  // AI 心情状态（AI 自己的情绪）：AI 可建立/改写自己的心情，不删除（到期自动过期 + 用户回应确认）
  aiState:      { read: true,  create: true,  write: true,  delete: false },
  // 通知（Bark 推送）：AI 只能「发送」（create 语义），绝不读/改/删 Bark 配置
  notification: { read: false, create: true,  write: false, delete: false },
  // 生活记录评论（AI 自己的评论）：AI 可建立/更新自己的评论，不删除（覆盖更新即重写）
  ai_comment:   { read: true,  create: true,  write: true,  delete: false },
};

export const USER_ONLY_EDITABLE = new Set(['journal', 'signature']);

export function aiCan(entity, action) {
  const p = AI_PERMISSION_POLICY[entity];
  if (!p) return false;
  if (action === 'read') return p.read === true;
  // 工具层的「update」对应策略里的「write」（WRITE 权限决定能否修改）。
  const key = action === 'update' ? 'write' : action;
  return p[key] === true;
}

export const ACTION_LABEL = { read: '读取', create: '创建', update: '修改', delete: '删除', comment: '评论' };

// 工具名 → { entity, entityKey, action }：callTool 权限检查 + 审计定位。
// entityKey 为 doc 上的存储键（支持点路径）；只读/无落库工具 entityKey 为 null。
export const TOOL_ACTIONS = {
  // 财务
  get_recent_purchases: { entity: 'finance', entityKey: 'purchases', action: 'read' },
  add_purchase: { entity: 'finance', entityKey: 'purchases', action: 'create' },
  update_purchase: { entity: 'finance', entityKey: 'purchases', action: 'update' },
  delete_purchase: { entity: 'finance', entityKey: 'purchases', action: 'delete' },
  get_expenses: { entity: 'finance', entityKey: 'expenses', action: 'read' },
  add_expense: { entity: 'finance', entityKey: 'expenses', action: 'create' },
  update_expense: { entity: 'finance', entityKey: 'expenses', action: 'update' },
  delete_expense: { entity: 'finance', entityKey: 'expenses', action: 'delete' },
  get_budget: { entity: 'finance', entityKey: 'budget', action: 'read' },
  set_monthly_budget: { entity: 'finance', entityKey: 'budget', action: 'update' },
  get_budget_summary: { entity: 'finance', entityKey: 'budget', action: 'read' },
  // 健康
  get_health_records: { entity: 'health', entityKey: 'health', action: 'read' },
  add_health_record: { entity: 'health', entityKey: 'health', action: 'create' },
  record_calories_in: { entity: 'health', entityKey: 'health', action: 'update' },
  record_calories_out: { entity: 'health', entityKey: 'health', action: 'update' },
  // 病历
  get_medical_records: { entity: 'medical', entityKey: 'medicalRecords', action: 'read' },
  add_medical_record: { entity: 'medical', entityKey: 'medicalRecords', action: 'create' },
  update_medical_record: { entity: 'medical', entityKey: 'medicalRecords', action: 'update' },
  delete_medical_record: { entity: 'medical', entityKey: 'medicalRecords', action: 'delete' },
  // 经期
  get_menstrual_cycles: { entity: 'menstrual', entityKey: 'menstrualCycles', action: 'read' },
  add_period_start: { entity: 'menstrual', entityKey: 'menstrualCycles', action: 'update' },
  add_period_end: { entity: 'menstrual', entityKey: 'menstrualCycles', action: 'update' },
  get_period_prediction: { entity: 'menstrual', entityKey: 'menstrualCycles', action: 'read' },
  // 音乐
  get_current_music: { entity: 'music', entityKey: 'player', action: 'read' },
  get_song_detail: { entity: 'music', entityKey: null, action: 'read' },
  get_song_comments: { entity: 'music', entityKey: null, action: 'read' },
  get_song_lyrics: { entity: 'music', entityKey: null, action: 'read' },
  get_recent_music: { entity: 'music', entityKey: 'player', action: 'read' },
  get_listening_context: { entity: 'music', entityKey: 'listeningSession', action: 'read' },
  start_listening_session: { entity: 'music', entityKey: 'listeningSession', action: 'update' },
  end_listening_session: { entity: 'music', entityKey: 'listeningSession', action: 'update' },
  recommend_next_song: { entity: 'music', entityKey: null, action: 'read' },
  queue_song: { entity: 'music', entityKey: 'player', action: 'update' },
  play_song: { entity: 'music', entityKey: 'player', action: 'update' },
  pause_music: { entity: 'music', entityKey: 'player', action: 'update' },
  resume_music: { entity: 'music', entityKey: 'player', action: 'update' },
  skip_song: { entity: 'music', entityKey: 'player', action: 'update' },
  like_song: { entity: 'music', entityKey: 'musicTasteProfile', action: 'update' },
  dislike_song: { entity: 'music', entityKey: 'musicTasteProfile', action: 'update' },
  // 记忆
  get_memory_context: { entity: 'memory', entityKey: 'ai.memories', action: 'read' },
  save_memory: { entity: 'memory', entityKey: 'ai.memories', action: 'create' },
  update_memory: { entity: 'memory', entityKey: 'ai.memories', action: 'update' },
  delete_memory: { entity: 'memory', entityKey: 'ai.memories', action: 'delete' },
  list_memories: { entity: 'memory', entityKey: 'ai.memories', action: 'read' },
  remember_user_preference: { entity: 'memory', entityKey: 'ai.memories', action: 'create' },
  save_important_conversation: { entity: 'memory', entityKey: 'ai.memories', action: 'create' },
  forget_memory: { entity: 'memory', entityKey: 'ai.memories', action: 'update' },
  // ---- 新增：任务 ----
  list_tasks: { entity: 'tasks', entityKey: 'tasks', action: 'read' },
  create_task: { entity: 'tasks', entityKey: 'tasks', action: 'create' },
  update_task: { entity: 'tasks', entityKey: 'tasks', action: 'update' },
  complete_task: { entity: 'tasks', entityKey: 'tasks', action: 'update' },
  delete_task: { entity: 'tasks', entityKey: 'tasks', action: 'delete' },
  // ---- 新增：计划 ----
  list_plans: { entity: 'plans', entityKey: 'plans', action: 'read' },
  create_plan: { entity: 'plans', entityKey: 'plans', action: 'create' },
  update_plan: { entity: 'plans', entityKey: 'plans', action: 'update' },
  delete_plan: { entity: 'plans', entityKey: 'plans', action: 'delete' },
  add_plan_goal: { entity: 'plans', entityKey: 'plans', action: 'update' },
  update_plan_goal: { entity: 'plans', entityKey: 'plans', action: 'update' },
  // ---- 新增：日历（薄封装 task，因日历无独立实体） ----
  // entity='calendar' 用于权限判断；auditEntity='tasks' 用于审计定位（日历事件真实落在 tasks，前端任务行按 tasks 渲染痕迹）。
  get_calendar: { entity: 'calendar', entityKey: 'tasks', action: 'read' },
  create_calendar_event: { entity: 'calendar', auditEntity: 'tasks', entityKey: 'tasks', action: 'create' },
  update_calendar_event: { entity: 'calendar', auditEntity: 'tasks', entityKey: 'tasks', action: 'update' },
  delete_calendar_event: { entity: 'calendar', auditEntity: 'tasks', entityKey: 'tasks', action: 'delete' },
  // ---- 新增：习惯 ----
  list_habits: { entity: 'habit', entityKey: 'habits', action: 'read' },
  create_habit: { entity: 'habit', entityKey: 'habits', action: 'create' },
  update_habit: { entity: 'habit', entityKey: 'habits', action: 'update' },
  complete_habit: { entity: 'habit', entityKey: 'habits', action: 'update' },
  delete_habit: { entity: 'habit', entityKey: 'habits', action: 'delete' },
  // ---- 新增：购物 ----
  list_shopping: { entity: 'shopping', entityKey: 'shoppingItems', action: 'read' },
  add_shopping_item: { entity: 'shopping', entityKey: 'shoppingItems', action: 'create' },
  update_shopping_item: { entity: 'shopping', entityKey: 'shoppingItems', action: 'update' },
  complete_shopping_item: { entity: 'shopping', entityKey: 'shoppingItems', action: 'update' },
  delete_shopping_item: { entity: 'shopping', entityKey: 'shoppingItems', action: 'delete' },
  // ---- 新增：笔记 ----
  list_notes: { entity: 'notes', entityKey: 'notes', action: 'read' },
  create_note: { entity: 'notes', entityKey: 'notes', action: 'create' },
  update_note: { entity: 'notes', entityKey: 'notes', action: 'update' },
  delete_note: { entity: 'notes', entityKey: 'notes', action: 'delete' },
  // ---- 新增：AI 动态（CRUD；get_current_time 为系统只读，无 entity 权限/无审计） ----
  create_ai_activity: { entity: 'activity', entityKey: 'ai.activities', action: 'create' },
  get_ai_activities: { entity: 'activity', entityKey: 'ai.activities', action: 'read' },
  update_ai_activity: { entity: 'activity', entityKey: 'ai.activities', action: 'update' },
  delete_ai_activity: { entity: 'activity', entityKey: 'ai.activities', action: 'delete' },
  // ---- 新增：AI 心情状态（AI 自己的情绪；create 语义=新设一条状态） ----
  set_ai_state: { entity: 'aiState', entityKey: 'ai.states', action: 'create' },
  // ---- 新增：只读 ----
  get_journal: { entity: 'journal', entityKey: 'journal', action: 'read' },
  get_statistics: { entity: 'statistics', entityKey: null, action: 'read' },
  get_conversation_history: { entity: 'conversation', entityKey: null, action: 'read' },
  // ---- 新增：对话缓存（存 sessions 表，不走 doc，entityKey=null 不审计；由 cache service 直接读写） ----
  save_conversation_cache: { entity: 'conversation_cache', entityKey: null, action: 'create' },
  update_conversation_cache: { entity: 'conversation_cache', entityKey: null, action: 'update' },
  // ---- 通知：Bark 推送（entityKey=null 不自动 diff 审计，工具内手动 recordAudit） ----
  send_bark_notification: { entity: 'notification', entityKey: null, action: 'create' },
  // ---- 生活记录评论（entityKey=null 不自动 diff；工具内按 recordType 二次校验 + 手动 recordAudit） ----
  comment_on_record: { entity: 'ai_comment', entityKey: null, action: 'create' },
};
