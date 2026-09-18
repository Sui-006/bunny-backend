// 内置领域工具（function calling）：财务 / 经期 / 病历。
// 复用 lib/ai.js 的 tools+callTool 循环 —— 与 MCP 插件同一套机制，不另起炉灶。
// callTool 返回字符串（JSON），由 AI 拼回对话。
import { randomUUID } from 'node:crypto';
import {
  getState, putState, planChain, defaultPlan, PLAN_TYPES,
  habitStreak, habitTotalCompletions, planProgress,
  appendAiActivity, isAiActivity, aiActivities,
} from './domain.js';
import { currentTimeInfo } from './time.js';
import {
  todayStr, yuanToCents, parseExpenseText, parsePurchaseText, guessCategory, financeSummary,
} from './finance.js';
import { startCycle, endCycle, withCycleLengths, predict } from './menstrual.js';
import { songDetail, hotComments, lyric, authState } from './netease.js';
import { config } from './config.js';
import { listMessages } from './db.js';
import { sendNotification } from './notification-engine.js';
import * as companion from '../services/music-companion-service.js';
import * as memory from '../services/memory-service.js';
import { songKey, appendToQueue, indexOfSong } from './music-queue.js';
import { aiCan, TOOL_ACTIONS, ACTION_LABEL } from './permissions.js';
import { recordAudit, clonePath, diffValue } from './audit.js';
import { saveConversationCache, updateConversationCache, getConversationCache } from '../services/conversation-cache.js';

const S = (name, description, properties = {}, required = []) => ({
  name, description,
  parameters: { type: 'object', properties, required },
});

const MONEY = { type: 'integer', description: '金额（分，整数。￥1 = 100）' };
const DATE = { type: 'string', description: '日期 YYYY-MM-DD（缺省今天）' };

// 工具定义（description 用中文，告诉 AI 何时用、参数含义）
const TOOL_DEFS = [
  S('get_recent_purchases', '读取用户最近购买记录（商品名、数量、单价、总价、时间、分类）', { limit: { type: 'integer' } }),
  S('add_purchase', '新增一条最近购买。优先从 text 自然语言解析（如「雨伞 38元」「雨伞 2把 38元」）；也可直接给结构化字段。', {
    text: { type: 'string', description: '自然语言描述，如「雨伞 38元」' },
    itemName: { type: 'string' }, quantity: { type: 'integer' }, unitPriceCents: MONEY,
    category: { type: 'string' }, purchasedAt: DATE, note: { type: 'string' },
    alsoExpense: { type: 'boolean', description: 'true=同时记一笔账（创建关联 Expense）' },
  }),
  S('update_purchase', '修改一条最近购买', { id: { type: 'string' }, itemName: { type: 'string' }, quantity: { type: 'integer' }, unitPriceCents: MONEY, category: { type: 'string' }, purchasedAt: DATE, note: { type: 'string' } }),
  S('delete_purchase', '删除一条最近购买（同时删除关联账目）', { id: { type: 'string' } }),

  S('get_expenses', '读取记账记录（条目、分类、金额、时间、收入/支出 kind）。可按 month=YYYY-MM 过滤。', { month: { type: 'string', description: 'YYYY-MM' } }),
  S('add_expense', '记一笔账（默认支出）。优先从 text 解析（如「麻辣烫 20元」「今天午饭 25块」）；也可给 title+amountCents。分类缺省时按条目自动判断。记收入（如「工资 5000」「发了 8000」）时传 kind="income"。', {
    text: { type: 'string' }, title: { type: 'string' }, category: { type: 'string' }, amountCents: MONEY,
    amount: { type: 'number', description: '金额（元，备选）' }, kind: { type: 'string', description: 'expense=支出(默认)，income=收入' },
    occurredAt: DATE, occurredTime: { type: 'string' }, note: { type: 'string' },
  }),
  S('update_expense', '修改一条记账', { id: { type: 'string' }, title: { type: 'string' }, category: { type: 'string' }, amountCents: MONEY, kind: { type: 'string' }, occurredAt: DATE, note: { type: 'string' } }),
  S('delete_expense', '删除一条记账', { id: { type: 'string' } }),

  S('get_budget', '读取本月预算设置', {}),
  S('set_monthly_budget', '设置本月预算（金额单位：分；或 monthlyBudget 用元）', { monthlyCents: MONEY, monthlyBudget: { type: 'number', description: '预算（元，备选）' } }),
  S('get_budget_summary', '读取预算汇总：本月预算/已花/剩余/剩余天数/每日建议/分类统计/今日本周花费', {}),

  S('get_health_records', '读取健康记录（睡眠小时/饮水升/摄入热量千卡/运动消耗千卡/体重公斤，按日期）', { days: { type: 'integer', description: '最近 N 天' } }),
  S('add_health_record', '记录当天健康数据（睡眠/饮水/体重）。按日期 upsert：该日已有记录则合并，否则新建。字段缺省不覆盖已有值。', {
    date: DATE, sleep: { type: 'number', description: '睡眠小时' }, water: { type: 'number', description: '饮水升' },
    weight: { type: 'number', description: '体重公斤' },
  }),
  S('record_calories_in', '累计摄入热量。根据食物描述估算的千卡数加到当天摄入热量(caloriesIn)。', { date: DATE, amount: { type: 'number', description: '摄入热量千卡' }, description: { type: 'string', description: '吃了什么' } }),
  S('record_calories_out', '累计运动消耗热量。根据运动描述估算的千卡数加到当天运动消耗(caloriesOut)。', { date: DATE, amount: { type: 'number', description: '消耗热量千卡' }, description: { type: 'string', description: '做了什么运动' } }),
  S('get_medical_records', '读取个人病历（过敏史/疾病/就诊/检查/手术/用药等）', { type: { type: 'string' } }),
  S('add_medical_record', '新增一条个人病历。可给 text（如「2026-09-10 感冒 发烧咳嗽」）或结构化字段。', {
    text: { type: 'string' }, title: { type: 'string' }, type: { type: 'string', description: '过敏史/疾病/就诊/检查/手术/用药/其他' },
    date: DATE, hospital: { type: 'string' }, doctor: { type: 'string' }, diagnosis: { type: 'string' },
    symptoms: { type: 'string' }, treatment: { type: 'string' }, medication: { type: 'string' }, notes: { type: 'string' },
  }),
  S('update_medical_record', '修改一条个人病历', { id: { type: 'string' }, title: { type: 'string' }, type: { type: 'string' }, date: DATE, diagnosis: { type: 'string' }, symptoms: { type: 'string' }, medication: { type: 'string' }, notes: { type: 'string' } }),
  S('delete_medical_record', '删除一条个人病历', { id: { type: 'string' } }),

  S('get_menstrual_cycles', '读取经期周期记录（开始/结束/持续天数/周期长度）', {}),
  S('add_period_start', '记录经期开始（幂等：若已有进行中的周期则返回它）', { date: DATE }),
  S('add_period_end', '记录经期结束（关闭进行中周期）', { date: DATE }),
  S('get_period_prediction', '读取经期预测：平均周期/持续/预计下次时间与范围/可信度', {}),

  // 音乐（网易云，公开数据；当前播放状态来自用户真实状态，绝不伪造）
  S('get_current_music', '读取当前正在播放的歌曲（标题/歌手/专辑/时长/进度/播放状态/播放列表位置）', {}),
  S('get_song_detail', '读取指定网易云歌曲的公开详情（标题/歌手/专辑/时长/封面）', { id: { type: 'string', description: '网易云歌曲 id' } }),
  S('get_song_comments', '读取指定网易云歌曲的热门评论（公开数据，仅少量高赞）', { id: { type: 'string' }, limit: { type: 'integer' } }),
  S('get_song_lyrics', '读取指定网易云歌曲的公开歌词（原文+翻译，无版权时可能为空）', { id: { type: 'string' } }),
  S('get_recent_music', '读取最近播放列表（当前列表曲目 + 当前进度）', {}),

  // 「一起听」陪听会话（绑定当前助手 assistantId，绝不 assistants[0]）
  S('get_listening_context', '读取「一起听」陪听会话的完整上下文：当前歌曲(标题/歌手/专辑/时长/进度)、歌词、最近播放、当前播放列表、陪听会话状态、当前 AI 助手、音乐品味画像', {}),
  S('start_listening_session', '开启「一起听」陪听会话（绑定当前 AI 助手，保存 assistantId）', {
    autoNext: { type: 'boolean', description: '是否开启自动接歌（歌曲结束由 AI 选下一首）' },
    companionEnabled: { type: 'boolean', description: '是否启用 AI 陪听（默认 true）' },
  }),
  S('end_listening_session', '结束「一起听」陪听会话', {}),
  S('recommend_next_song', '根据当前歌曲/歌手/歌词/最近播放/音乐偏好/喜欢与跳过历史，推荐下一首（返回 songId 与理由）', {}),
  S('queue_song', '把一首歌加入播放列表末尾（供 AI 选歌后排队）', { id: { type: 'string', description: '网易云歌曲 id' }, title: { type: 'string' }, artist: { type: 'string' } }),
  S('play_song', '播放指定歌曲（按 id 在列表中定位，找不到则标记为需要加入播放）', { id: { type: 'string', description: '网易云歌曲 id' }, title: { type: 'string' } }),
  S('pause_music', '暂停当前音乐', {}),
  S('resume_music', '继续播放当前音乐', {}),
  S('skip_song', '跳到下一首', {}),
  S('like_song', '标记喜欢当前/指定歌曲（仅用户明确表达「我喜欢这首」时调用）', { id: { type: 'string' } }),
  S('dislike_song', '标记不喜欢当前/指定歌曲（仅用户明确表达「不要再放这种」时调用）', { id: { type: 'string' } }),

  // 用户长期记忆（结构化，轻量；只在用户明确要求记住/明确表达稳定偏好时写入，绝不自动记寒暄）
  S('get_memory_context', '读取与当前对话相关的用户长期记忆（分类/查询/数量可选）', { category: { type: 'string', description: 'profile|preference|important_conversation|functional_preference|task_context' }, query: { type: 'string' }, limit: { type: 'integer' } }),
  S('save_memory', '保存一条用户长期记忆。仅在用户明确要求（「记住…」「以后都…」）或明确稳定偏好时调用。category 必须为 profile/preference/important_conversation/functional_preference/task_context 之一。', {
    category: { type: 'string' }, key: { type: 'string', description: '稳定机器键，如 preferred_name' },
    value: { type: 'string', description: '结构化值（字符串或 JSON 字符串）' }, summary: { type: 'string' },
    importance: { type: 'string', description: 'low|normal|high|critical' }, source: { type: 'string' },
    userConfirmed: { type: 'boolean', description: '用户是否已明确确认这条记忆' },
  }),
  S('update_memory', '更新一条已有记忆', { id: { type: 'string' }, summary: { type: 'string' }, key: { type: 'string' }, value: { type: 'string' }, category: { type: 'string' }, importance: { type: 'string' }, isActive: { type: 'boolean' } }),
  S('delete_memory', '删除一条记忆', { id: { type: 'string' } }),
  S('list_memories', '列出用户的长期记忆（可按分类/搜索过滤）', { category: { type: 'string' }, query: { type: 'string' }, limit: { type: 'integer' } }),
  S('remember_user_preference', '保存一条用户明确表达的偏好（如「我喜欢简洁回答」「我不喜欢…」）', { key: { type: 'string' }, value: { type: 'string' }, summary: { type: 'string' } }),
  S('save_important_conversation', '把一段重要对话保存为摘要（绝不保存整段原文）', { title: { type: 'string' }, summary: { type: 'string' }, keyPoints: { type: 'string', description: '要点（数组或逗号分隔）' }, relatedTopic: { type: 'string' } }),
  S('forget_memory', '用户明确要求忘记时，停用或删除对应记忆', { id: { type: 'string' }, key: { type: 'string' } }),

  // ---- 全局读取：任务 / 计划 / 日历 / 习惯 / 购物 / 笔记 / 日志 / 统计 / 会话历史 ----
  S('list_tasks', '列出用户任务（可按日期/完成状态/计划过滤，缺省返回最近的待办）', { date: DATE, completed: { type: 'boolean' }, planId: { type: 'string' }, limit: { type: 'integer' } }),
  S('list_plans', '列出用户计划（长期/阶段/月/周；可按 type/是否归档过滤）', { type: { type: 'string', description: 'long-term|stage|monthly|weekly' }, archived: { type: 'boolean' } }),
  S('get_calendar', '读取日历聚合：指定日期区间内的任务与健康记录（缺省未来 7 天）', { start: DATE, end: DATE }),
  S('list_habits', '列出用户习惯（含今日是否完成、连续天数、累计次数）', {}),
  S('list_shopping', '列出购物清单条目（缺省只列未购）。listId/owner 严格区分两份清单：mine=我的清单（owner=user，用户自己的）、deity=祂的清单（owner=assistant，AI 的）。不确定是哪份清单时必须先问用户，绝不擅自猜。', { listId: { type: 'string', description: 'mine=我的清单 / deity=祂的清单' }, owner: { type: 'string', description: 'user=用户(我的清单) / assistant=AI(祂的清单)，与 listId 二选一' }, includeCompleted: { type: 'boolean' } }),
  S('list_notes', '列出用户笔记（缺省最近 30 条，按更新时间倒序）', { limit: { type: 'integer' } }),
  S('get_journal', '读取用户日志（只读：仅日期/心情/正文，最近 N 条，缺省 5）', { limit: { type: 'integer' } }),
  S('get_statistics', '读取生活统计（任务/习惯/计划完成率，最近 7/30/90 天）', { range: { type: 'string', description: '7d|30d|90d' } }),
  S('get_conversation_history', '读取当前会话最近的对话历史（只读，供回忆上下文）', { limit: { type: 'integer' } }),

  // ---- 编辑：任务 ----
  S('create_task', '新建任务。date 缺省今天；priority=high|med|low；planId 可挂到某个计划。reason=为什么改（记入痕迹）。', {
    title: { type: 'string' }, date: DATE, time: { type: 'string' }, priority: { type: 'string' },
    note: { type: 'string' }, planId: { type: 'string' }, reason: { type: 'string' },
  }, ['title']),
  S('update_task', '修改任务（标题/日期/时间/优先级/备注/完成状态）', { id: { type: 'string' }, title: { type: 'string' }, date: DATE, time: { type: 'string' }, priority: { type: 'string' }, note: { type: 'string' }, completed: { type: 'boolean' }, reason: { type: 'string' } }, ['id']),
  S('complete_task', '标记任务完成/未完成', { id: { type: 'string' }, completed: { type: 'boolean' }, reason: { type: 'string' } }, ['id']),
  S('delete_task', '删除任务', { id: { type: 'string' }, reason: { type: 'string' } }, ['id']),

  // ---- 编辑：计划 ----
  S('create_plan', '新建计划。type=long-term|stage|monthly|weekly', { type: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, startDate: DATE, endDate: DATE, reason: { type: 'string' } }, ['type']),
  S('update_plan', '修改计划（标题/描述/起止日期/主题色/归档）', { id: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, startDate: DATE, endDate: DATE, themeColor: { type: 'string' }, archived: { type: 'boolean' }, reason: { type: 'string' } }, ['id']),
  S('delete_plan', '删除计划', { id: { type: 'string' }, reason: { type: 'string' } }, ['id']),
  S('add_plan_goal', '给计划添加一个阶段目标', { id: { type: 'string', description: '计划 id' }, title: { type: 'string' }, dueDate: { type: 'string' }, progress: { type: 'integer' }, reason: { type: 'string' } }, ['id', 'title']),
  S('update_plan_goal', '更新计划里的一个阶段目标（进度/标题/截止/完成）', { id: { type: 'string', description: '计划 id' }, goalId: { type: 'string' }, title: { type: 'string' }, progress: { type: 'integer' }, dueDate: { type: 'string' }, completed: { type: 'boolean' }, result: { type: 'string' }, reason: { type: 'string' } }, ['id', 'goalId']),

  // ---- 编辑：日历事件（薄封装成 task，日历无独立实体） ----
  S('create_calendar_event', '在日历某天新建一个事件（本质是带日期的任务）', { title: { type: 'string' }, date: DATE, time: { type: 'string' }, reason: { type: 'string' } }, ['title', 'date']),
  S('update_calendar_event', '修改日历事件（标题/日期/时间）', { id: { type: 'string' }, title: { type: 'string' }, date: DATE, time: { type: 'string' }, reason: { type: 'string' } }, ['id']),
  S('delete_calendar_event', '删除日历事件', { id: { type: 'string' }, reason: { type: 'string' } }, ['id']),

  // ---- 编辑：习惯 ----
  S('create_habit', '新建习惯。frequency=daily|weekdays|weekly|custom；goal=每日目标次数', { name: { type: 'string' }, description: { type: 'string' }, icon: { type: 'string' }, color: { type: 'string' }, frequency: { type: 'string' }, goal: { type: 'integer' }, reminderTime: { type: 'string' }, reason: { type: 'string' } }, ['name']),
  S('update_habit', '修改习惯', { id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, icon: { type: 'string' }, color: { type: 'string' }, frequency: { type: 'string' }, goal: { type: 'integer' }, reminderTime: { type: 'string' }, reason: { type: 'string' } }, ['id']),
  S('complete_habit', '给习惯打卡（date 缺省今天，幂等）', { id: { type: 'string' }, date: DATE, reason: { type: 'string' } }, ['id']),
  S('delete_habit', '删除习惯', { id: { type: 'string' }, reason: { type: 'string' } }, ['id']),

  // ---- 编辑：购物 ----
  S('add_shopping_item', '添加购物条目。必须明确加到哪份清单：listId=mine/owner=user=我的清单（用户自己），listId=deity/owner=assistant=祂的清单（AI 自己）。有歧义时先问清用户，绝不擅自加到错误清单。', { title: { type: 'string' }, listId: { type: 'string', description: 'mine=我的清单 / deity=祂的清单' }, owner: { type: 'string', description: 'user=用户 / assistant=AI，与 listId 二选一' }, note: { type: 'string' }, category: { type: 'string' }, priority: { type: 'string' }, reason: { type: 'string' } }, ['title']),
  S('update_shopping_item', '修改购物条目（可改标题/备注/分类/优先级，或把条目移动到另一份清单）', { id: { type: 'string' }, title: { type: 'string' }, note: { type: 'string' }, category: { type: 'string' }, priority: { type: 'string' }, listId: { type: 'string', description: 'mine=我的清单 / deity=祂的清单' }, owner: { type: 'string', description: 'user=用户 / assistant=AI' }, reason: { type: 'string' } }, ['id']),
  S('complete_shopping_item', '勾选/取消购物条目', { id: { type: 'string' }, completed: { type: 'boolean' }, reason: { type: 'string' } }, ['id']),
  S('delete_shopping_item', '删除购物条目', { id: { type: 'string' }, reason: { type: 'string' } }, ['id']),

  // ---- 编辑：笔记 ----
  S('create_note', '新建笔记', { title: { type: 'string' }, content: { type: 'string' }, tags: { type: 'string', description: '逗号分隔' }, pinned: { type: 'boolean' }, reason: { type: 'string' } }, ['title']),
  S('update_note', '修改笔记', { id: { type: 'string' }, title: { type: 'string' }, content: { type: 'string' }, tags: { type: 'string' }, pinned: { type: 'boolean' }, reason: { type: 'string' } }, ['id']),
  S('delete_note', '删除笔记', { id: { type: 'string' }, reason: { type: 'string' } }, ['id']),

  // ---- 编辑：AI 动态 ----
  S('create_ai_activity', '写入一条 AI 动态（记录 AI 自己做过/想到/值得记住/想表达的事）。content=动态正文（第一人称、简洁，一句话即可）；type 缺省 chat。当用户分享了值得记录的事——如完成一件事、有情绪波动、做了决定、有进展或里程碑——你可以自主写一条；也可以写你自己的想法/观察/感受（如「今天突然想和你说句话」）。普通寒暄、闲聊、提问、无实质内容的对话不要写，避免刷屏。写动态不要求同时写记忆，两者独立。', {
    content: { type: 'string', description: '动态正文（第一人称、简洁）' },
    type: { type: 'string', description: 'memory|state|task|habit|plan|shopping|music|weather|chat|journal' },
  }, ['content']),
  S('get_ai_activities', '读取 AI 自己最近写下的动态（AI Activity）。需要回忆自己说过/写过/做过什么时调用。', { limit: { type: 'integer', description: '条数，缺省 10' } }),
  S('update_ai_activity', '修改 AI 自己写过的一条动态（只能改 AI 自己的动态，用户/系统条目不可改）。', {
    id: { type: 'string' }, text: { type: 'string', description: '新的动态正文' }, type: { type: 'string' },
  }, ['id']),
  S('delete_ai_activity', '删除 AI 自己写过的一条动态（真实删除，不可恢复）。', { id: { type: 'string' } }, ['id']),
  // ---- 系统只读：当前时间 ----
  S('get_current_time', '读取当前真实时间（日期、星期、本地时间、是否周末）。不知道「现在几点/今天几号/今天星期几」时必须调用，绝不要猜时间、绝不要用旧时间。', {}),

  // ---- 对话缓存（Conversation Cache，与长期记忆严格区分）：保存「这段对话最近聊了什么/正在做什么」 ----
  S('save_conversation_cache', '把当前对话的进展保存为对话缓存（整体覆盖）。用于长对话：把较旧消息的讨论结果压缩成结构化缓存，避免每次都把完整历史塞进上下文。仅在对话变长或出现需要记住的新信息时调用，不要每句话都调用。字段：summary=摘要文本；keyPoints=要点数组；currentTopic=当前主题；recentDecisions=近期已做决定数组；openItems=待办/未完成数组；coveredMessageId=缓存覆盖到哪条消息。', {
    summary: { type: 'string' }, keyPoints: { type: 'array', items: { type: 'string' } }, currentTopic: { type: 'string' },
    recentDecisions: { type: 'array', items: { type: 'string' } }, openItems: { type: 'array', items: { type: 'string' } },
    coveredMessageId: { type: 'string' },
  }),
  S('update_conversation_cache', '增量更新对话缓存（只覆盖传入的字段，其余保留）。用法同 save_conversation_cache，但不丢失未传入的字段。', {
    summary: { type: 'string' }, keyPoints: { type: 'array', items: { type: 'string' } }, currentTopic: { type: 'string' },
    recentDecisions: { type: 'array', items: { type: 'string' } }, openItems: { type: 'array', items: { type: 'string' } },
    coveredMessageId: { type: 'string' },
  }),
  // ---- 通知：Bark 推送（AI 可调用；经统一 NotificationEngine，绝不暴露 Bark URL/key） ----
  S('send_bark_notification', '给当前用户发送一条 Bark 手机推送通知。只在用户明确要求提醒/通知（如「提醒我喝水」「到点叫我」「发个通知」）时调用；普通聊天、寒暄、闲聊不要每句话都发。AI 不需要也不能传 Bark URL/key，系统自动用当前用户的 Bark 配置发送。', {
    title: { type: 'string', description: '通知标题' },
    body: { type: 'string', description: '通知正文' },
    sound: { type: 'string', description: '可选 Bark 声音名（如 birdsong、minuet、shake）' },
    level: { type: 'string', enum: ['normal', 'time_sensitive'], description: '通知级别：normal=普通（默认），time_sensitive=时效性提醒。不会触发强提醒/来电（critical/call 只能由用户明确设闹钟时由系统触发）。' },
    group: { type: 'string', description: '可选通知分组名' },
  }, ['title', 'body']),
];

function toCents(v) { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : null; }
function todayOr(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : todayStr(); }
// 购物清单 owner 严格区分：mine/我的清单=user（用户），deity/祂的清单=assistant（AI）。
// 接受 listId 或 owner 二选一；两者都缺省时回退 mine（用户清单）。绝不把 AI 条目写进用户清单。
function shopListId(args, fallback = 'mine') {
  const raw = args.listId != null ? args.listId : (args.owner != null ? args.owner : fallback);
  const s = String(raw || '').toLowerCase();
  return (s === 'deity' || s === 'assistant' || s === 'ai') ? 'deity' : 'mine';
}
function shopOwner(listId) { return listId === 'deity' ? 'assistant' : 'user'; }
const pad = (n) => (n < 10 ? '0' + n : '' + n);
const dstr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function addDaysStr(base, n) {
  const p = String(base || '').split('-').map(Number);
  const d = (p.length === 3 && p.every(Number.isFinite)) ? new Date(p[0], p[1] - 1, p[2]) : new Date();
  d.setDate(d.getDate() + n);
  return dstr(d);
}

// 始终可用的「AI 自我」工具（不依赖领域关键词）：AI 随时能读时间、读/写/改/删自己的动态。
// 由 routes/messages.js 的 buildAssistEnv 无条件注入；其余领域工具仍按 TOOL_DOMAIN_SET 门控。
export const AI_SELF_TOOL_NAMES = ['create_ai_activity', 'get_ai_activities', 'update_ai_activity', 'delete_ai_activity', 'get_current_time'];
// 对话缓存工具：不依赖领域关键词，始终注入（与 AI 自我工具同一机制），供 AI 长对话压缩上下文。
export const AI_CACHE_TOOL_NAMES = ['save_conversation_cache', 'update_conversation_cache'];
// 通知工具：AI 独立能力（用户明确要求提醒时发 Bark），不依赖领域关键词，始终注入。
export const AI_NOTIFY_TOOL_NAMES = ['send_bark_notification'];

export function buildDomainTools(userId, model = config.defaultModel, ctx = {}) {
  const tools = TOOL_DEFS;
  const conversationId = ctx?.sessionId || null;

  const callTool = async (name, args = {}) => {
    const doc = await getState(userId);

    // 权限门禁（单一策略）：读全开，写按实体四粒度（READ/CREATE/WRITE/DELETE）。
    const meta = TOOL_ACTIONS[name];
    if (meta && !aiCan(meta.entity, meta.action)) {
      return JSON.stringify({ code: 'DENIED', error: `AI 无权${ACTION_LABEL[meta.action]}「${meta.entity}」` });
    }
    // 修改类工具：before 快照，供 save() 计算 before/after 审计（null 过渡如 listeningSession 也纳入）。
    const track = !!(meta && meta.entityKey && meta.action !== 'read');
    const before = track ? clonePath(doc, meta.entityKey) : null;

    const save = async (result, code = 'OK') => {
      if (track) {
        const after = clonePath(doc, meta.entityKey);
        const d = diffValue(before, after, args.id, result);
        if (d) {
          recordAudit(doc, {
            action: d.action, aiAction: name, entityType: meta.auditEntity || meta.entity,
            entityId: d.entityId, entityLabel: d.entityLabel,
            before: d.before, after: d.after,
            actor: 'assistant', reason: args.reason || '', conversationId,
          });
        }
      }
      await putState(userId, doc);
      return JSON.stringify({ code, ...result });
    };

    switch (name) {
      case 'get_recent_purchases': {
        const limit = Math.max(1, Math.min(50, parseInt(args.limit) || 20));
        return JSON.stringify({ code: 'OK', purchases: doc.purchases.slice().sort((a, b) => (b.purchasedAt || '') < (a.purchasedAt || '') ? -1 : 1).slice(0, limit) });
      }
      case 'add_purchase': {
        let f;
        if (args.text) { f = parsePurchaseText(args.text); if (!f) return JSON.stringify({ code: 'FAILED', error: '无法解析金额，请补充单价（如「雨伞 38元」）' }); }
        else {
          if (!args.itemName) return JSON.stringify({ code: 'FAILED', error: '缺少 itemName' });
          const unitPriceCents = toCents(args.unitPriceCents) ?? (args.unitPrice != null ? yuanToCents(args.unitPrice) : null);
          if (unitPriceCents == null) return JSON.stringify({ code: 'FAILED', error: '缺少单价' });
          const quantity = Math.max(1, parseInt(args.quantity) || 1);
          f = { itemName: String(args.itemName).trim(), quantity, unitPriceCents, totalAmountCents: unitPriceCents * quantity, currency: 'CNY', category: args.category || guessCategory(args.itemName), purchasedAt: todayOr(args.purchasedAt), note: args.note || '' };
        }
        const purchase = { id: randomUUID(), createdAt: Date.now(), updatedAt: Date.now(), ...f };
        if (args.alsoExpense) {
          const expense = { id: randomUUID(), title: purchase.itemName, category: purchase.category || '生活用品', amountCents: purchase.totalAmountCents, currency: 'CNY', occurredAt: purchase.purchasedAt, occurredTime: '', note: purchase.note || '', purchaseId: purchase.id, createdAt: Date.now(), updatedAt: Date.now() };
          doc.expenses.push(expense); purchase.expenseId = expense.id;
        }
        doc.purchases.push(purchase);
        return save({ purchase }, 'CREATED');
      }
      case 'update_purchase': {
        const p = doc.purchases.find((x) => x.id === args.id); if (!p) return JSON.stringify({ code: 'NOT_FOUND', error: '购买记录不存在' });
        if (args.itemName != null) p.itemName = String(args.itemName);
        if (args.quantity != null) p.quantity = Math.max(1, parseInt(args.quantity));
        if (args.unitPriceCents != null) p.unitPriceCents = toCents(args.unitPriceCents);
        if (args.quantity != null || args.unitPriceCents != null) p.totalAmountCents = p.unitPriceCents * p.quantity;
        if (args.category != null) p.category = args.category;
        if (args.purchasedAt != null) p.purchasedAt = todayOr(args.purchasedAt);
        if (args.note != null) p.note = args.note;
        p.updatedAt = Date.now();
        return save({ purchase: p });
      }
      case 'delete_purchase': {
        const before = doc.purchases.length;
        doc.purchases = doc.purchases.filter((x) => x.id !== args.id);
        doc.expenses = doc.expenses.filter((e) => e.purchaseId !== args.id);
        return save({ ok: true, removed: before > doc.purchases.length });
      }

      case 'get_expenses': {
        let list = doc.expenses.slice().sort((a, b) => (b.occurredAt || '') < (a.occurredAt || '') ? -1 : 1);
        if (args.month) list = list.filter((e) => String(e.occurredAt || '').startsWith(String(args.month).slice(0, 7)));
        return JSON.stringify({ code: 'OK', expenses: list.slice(0, 100) });
      }
      case 'add_expense': {
        let f;
        if (args.text) { f = parseExpenseText(args.text); if (!f) return JSON.stringify({ code: 'FAILED', error: '无法解析金额，请补充金额（如「麻辣烫 20元」）' }); }
        else {
          if (!args.title) return JSON.stringify({ code: 'FAILED', error: '缺少 title' });
          const amountCents = toCents(args.amountCents) ?? (args.amount != null ? yuanToCents(args.amount) : null);
          if (amountCents == null) return JSON.stringify({ code: 'FAILED', error: '缺少金额' });
          f = { title: String(args.title).trim(), category: args.category || guessCategory(args.title), amountCents, currency: 'CNY', occurredAt: todayOr(args.occurredAt), occurredTime: args.occurredTime || '', note: args.note || '' };
        }
        f.kind = args.kind === 'income' ? 'income' : 'expense';
        const expense = { id: randomUUID(), createdAt: Date.now(), updatedAt: Date.now(), ...f };
        doc.expenses.push(expense);
        return save({ expense }, 'CREATED');
      }
      case 'update_expense': {
        const e = doc.expenses.find((x) => x.id === args.id); if (!e) return JSON.stringify({ code: 'NOT_FOUND', error: '记账不存在' });
        if (args.title != null) e.title = String(args.title);
        if (args.category != null) e.category = args.category;
        if (args.amountCents != null) e.amountCents = toCents(args.amountCents);
        if (args.kind != null) e.kind = args.kind === 'income' ? 'income' : 'expense';
        if (args.occurredAt != null) e.occurredAt = todayOr(args.occurredAt);
        if (args.note != null) e.note = args.note;
        e.updatedAt = Date.now();
        return save({ expense: e });
      }
      case 'delete_expense': {
        doc.expenses = doc.expenses.filter((x) => x.id !== args.id);
        return save({ ok: true });
      }

      case 'get_budget':
        return JSON.stringify({ code: 'OK', monthlyCents: doc.budget?.monthlyCents ?? null, currency: 'CNY', hasBudget: !!doc.budget?.monthlyCents });
      case 'set_monthly_budget': {
        let monthlyCents = toCents(args.monthlyCents) ?? (args.monthlyBudget != null ? yuanToCents(args.monthlyBudget) : null);
        if (monthlyCents == null || monthlyCents < 0) return JSON.stringify({ code: 'FAILED', error: '预算金额无效' });
        doc.budget = { monthlyCents, currency: 'CNY', updatedAt: Date.now() };
        return save({ budget: doc.budget });
      }
      case 'get_budget_summary':
        return JSON.stringify({ code: 'OK', summary: financeSummary(doc) });

      case 'get_health_records': {
        const days = Math.max(1, Math.min(60, parseInt(args.days) || 7));
        const from = new Date(); from.setDate(from.getDate() - (days - 1));
        const dstr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const cutoff = dstr(from);
        const recs = doc.health.filter((r) => r.date >= cutoff).sort((a, b) => (a.date < b.date ? -1 : 1));
        return JSON.stringify({ code: 'OK', records: recs });
      }
      case 'add_health_record': {
        const date = todayOr(args.date);
        let rec = doc.health.find((r) => r.date === date);
        if (!rec) { rec = { id: randomUUID(), date, sleep: 0, water: 0, caloriesIn: 0, caloriesOut: 0, weight: null }; doc.health.push(rec); }
        for (const k of ['sleep', 'water', 'weight']) {
          const v = Number(args[k]);
          if (Number.isFinite(v)) rec[k] = v;
        }
        rec.updatedAt = Date.now();
        return save({ record: rec });
      }
      case 'record_calories_in':
      case 'record_calories_out': {
        const isIn = name === 'record_calories_in';
        const date = todayOr(args.date);
        let rec = doc.health.find((r) => r.date === date);
        if (!rec) { rec = { id: randomUUID(), date, sleep: 0, water: 0, caloriesIn: 0, caloriesOut: 0, weight: null }; doc.health.push(rec); }
        const amount = Math.max(0, Math.round(Number(args.amount) || 0));
        const key = isIn ? 'caloriesIn' : 'caloriesOut';
        rec[key] = (Number(rec[key]) || 0) + amount;
        if (args.description) rec[(isIn ? 'foodLog' : 'exerciseLog')] = String(args.description);
        rec.updatedAt = Date.now();
        return save({ record: rec });
      }
      case 'get_medical_records': {
        let list = doc.medicalRecords.slice().sort((a, b) => (b.date || '') < (a.date || '') ? -1 : 1);
        if (args.type) list = list.filter((r) => r.type === args.type);
        return JSON.stringify({ code: 'OK', records: list });
      }
      case 'add_medical_record': {
        let f;
        if (args.text && !args.title) {
          const t = String(args.text).trim();
          const dm = t.match(/^(\d{4}-\d{2}-\d{2})\s+/);
          const date = dm ? dm[1] : todayStr();
          const rest = dm ? t.slice(dm[0].length) : t;
          const noteM = rest.match(/备注[:：]\s*(.+)$/);
          const body = noteM ? rest.slice(0, noteM.index).trim() : rest;
          f = { title: args.title || body.split(/[，,。\s]/)[0] || body, type: args.type || '就诊', date, diagnosis: args.diagnosis || body, symptoms: args.symptoms || '', medication: args.medication || '', notes: noteM ? noteM[1] : (args.notes || ''), source: 'user' };
        } else {
          if (!args.title) return JSON.stringify({ code: 'FAILED', error: '缺少 title' });
          f = { title: String(args.title), type: args.type || '其他', date: todayOr(args.date), hospital: args.hospital || '', doctor: args.doctor || '', diagnosis: args.diagnosis || '', symptoms: args.symptoms || '', treatment: args.treatment || '', medication: args.medication || '', notes: args.notes || '', source: args.source || 'user' };
        }
        const rec = { id: randomUUID(), createdAt: Date.now(), updatedAt: Date.now(), ...f };
        doc.medicalRecords.push(rec);
        return save({ record: rec }, 'CREATED');
      }
      case 'update_medical_record': {
        const r = doc.medicalRecords.find((x) => x.id === args.id); if (!r) return JSON.stringify({ code: 'NOT_FOUND', error: '病历不存在' });
        for (const k of ['title', 'type', 'date', 'hospital', 'doctor', 'diagnosis', 'symptoms', 'treatment', 'medication', 'notes']) if (args[k] != null) r[k] = args[k];
        r.updatedAt = Date.now();
        return save({ record: r });
      }
      case 'delete_medical_record': {
        doc.medicalRecords = doc.medicalRecords.filter((x) => x.id !== args.id);
        return save({ ok: true });
      }

      case 'get_menstrual_cycles':
        return JSON.stringify({ code: 'OK', cycles: withCycleLengths(doc.menstrualCycles) });
      case 'add_period_start': {
        const { cycle, created } = startCycle(doc.menstrualCycles, todayOr(args.date));
        if (created) { cycle.id = randomUUID(); doc.menstrualCycles.push(cycle); }
        return save({ cycle, created }, created ? 'CREATED' : 'OK');
      }
      case 'add_period_end': {
        const { cycle, closed } = endCycle(doc.menstrualCycles, todayOr(args.date));
        if (!closed) return JSON.stringify({ code: 'CONFLICT', error: '没有进行中的经期' });
        return save({ cycle, closed: true });
      }
      case 'get_period_prediction':
        return JSON.stringify({ code: 'OK', prediction: predict(doc.menstrualCycles, todayStr()) });

      case 'get_current_music': {
        const p = doc.player || {};
        const track = (p.playlist && p.playlist[p.current]) || null;
        // 当前曲目来自网易云（有 id）时附带真实登录态，避免 AI 在登录失效时假装「正在播放」。
        let neteaseAuth = null;
        if (track && track.id) {
          try { neteaseAuth = (await authState()).status; } catch (e) { neteaseAuth = 'error'; }
        }
        return JSON.stringify({
          code: 'OK',
          playing: !!p.playing,
          currentTime: p.currentTime || 0,
          current: p.current || 0,
          total: (p.playlist && p.playlist.length) || 0,
          neteaseAuth: neteaseAuth || null,
          track: track ? { id: track.id, title: track.title || track.name || '', artist: track.artist || '', album: track.album || '', duration: track.duration || 0 } : null,
        });
      }
      case 'get_song_detail': {
        const id = String(args.id || '').trim();
        if (!id) return JSON.stringify({ code: 'FAILED', error: '缺少歌曲 id' });
        const arr = await songDetail([id]);
        return JSON.stringify({ code: 'OK', song: arr[0] || null });
      }
      case 'get_song_comments': {
        const id = String(args.id || '').trim();
        if (!id) return JSON.stringify({ code: 'FAILED', error: '缺少歌曲 id' });
        const limit = Math.max(1, Math.min(20, parseInt(args.limit) || 10));
        const comments = await hotComments(id, limit);
        return JSON.stringify({ code: 'OK', comments });
      }
      case 'get_song_lyrics': {
        const id = String(args.id || '').trim();
        if (!id) return JSON.stringify({ code: 'FAILED', error: '缺少歌曲 id' });
        const lyr = await lyric(id);
        return JSON.stringify({ code: 'OK', lrc: lyr.lrc || '', tlyric: lyr.tlyric || '' });
      }
      case 'get_recent_music': {
        const p = doc.player || {};
        const list = (p.playlist || []).map((t, i) => ({
          id: t.id, title: t.title || t.name || '', artist: t.artist || '', album: t.album || '', duration: t.duration || 0, isCurrent: i === (p.current || 0),
        }));
        return JSON.stringify({ code: 'OK', current: p.current || 0, playing: !!p.playing, currentTime: p.currentTime || 0, playlist: list });
      }

      // ---- 「一起听」陪听会话 ----
      case 'get_listening_context': {
        const ctx = await companion.getContext(doc);
        return JSON.stringify({ code: 'OK', ...ctx });
      }
      case 'start_listening_session': {
        const session = companion.startSession(doc, {
          assistantId: companion.activeAssistantId(doc),
          autoNext: args.autoNext,
          companionEnabled: args.companionEnabled,
        });
        return save({ session, assistantId: session.assistantId });
      }
      case 'end_listening_session': {
        const session = companion.endSession(doc);
        return save({ session });
      }
      case 'recommend_next_song': {
        const rec = await companion.recommendNextSong(doc, model);
        return JSON.stringify({ code: 'OK', song: rec.song, reason: rec.reason });
      }
      case 'queue_song': {
        if (!doc.player) doc.player = { playlist: [], current: 0, playing: false, currentTime: 0, volume: 0.8 };
        if (!Array.isArray(doc.player.playlist)) doc.player.playlist = [];
        const track = { id: args.id || null, title: args.title || '', artist: args.artist || '', album: '', cover: '', duration: 0, url: null };
        // 按 songId 去重：同一首歌已在队列则不再追加（加入队列 = append + dedup，绝不无意义重复）
        if (songKey(track) != null && indexOfSong(doc.player.playlist, track) >= 0) {
          return save({ queued: null, note: '已在播放列表中' });
        }
        doc.player.playlist = appendToQueue(doc.player.playlist, track);
        return save({ queued: track });
      }
      case 'play_song': {
        const p = doc.player || {};
        const list = p.playlist || [];
        const id = String(args.id || '').trim();
        let idx = id ? list.findIndex((t) => String(t.id) === id) : -1;
        if (idx < 0 && args.title) idx = list.findIndex((t) => (t.title || t.name || '') === args.title);
        if (idx >= 0) {
          p.current = idx; p.currentTime = 0;
          return save({ playing: true, current: idx });
        }
        return JSON.stringify({ code: 'NOT_FOUND', error: '歌曲不在当前播放列表中，可先用 queue_song 加入后再播放' });
      }
      case 'pause_music': {
        doc.player = doc.player || {};
        doc.player.playing = false;
        return save({ playing: false });
      }
      case 'resume_music': {
        doc.player = doc.player || {};
        doc.player.playing = true;
        return save({ playing: true });
      }
      case 'skip_song': {
        const p = doc.player || {};
        const list = p.playlist || [];
        if (!list.length) return JSON.stringify({ code: 'FAILED', error: '播放列表为空' });
        const n = (p.current + 1) % list.length;
        p.current = n; p.currentTime = 0;
        return save({ current: n });
      }
      case 'like_song': {
        const r = companion.recordReaction(doc, 'like', args.id);
        return save({ reaction: r });
      }
      case 'dislike_song': {
        const r = companion.recordReaction(doc, 'dislike', args.id);
        return save({ reaction: r });
      }

      // ---- 用户长期记忆（轻量结构化，尊重 memorySettings.enabled / autoSaveEnabled） ----
      case 'get_memory_context': {
        if (!memory.isEnabled(doc)) return JSON.stringify({ code: 'DISABLED', error: '记忆功能已关闭' });
        const limit = Math.max(1, Math.min(20, parseInt(args.limit) || 10));
        const relevant = memory.getRelevantMemories(doc, { query: args.query || '', limit });
        return JSON.stringify({ code: 'OK', memories: relevant, count: relevant.length });
      }
      case 'list_memories': {
        if (!memory.isEnabled(doc)) return JSON.stringify({ code: 'DISABLED', error: '记忆功能已关闭' });
        const limit = Math.max(1, Math.min(100, parseInt(args.limit) || 20));
        const list = memory.listMemories(doc, { category: args.category || null, query: args.query || '' }).slice(0, limit);
        return JSON.stringify({ code: 'OK', memories: list, count: list.length });
      }
      case 'save_memory': {
        if (!memory.isEnabled(doc)) return JSON.stringify({ code: 'DISABLED', error: '记忆功能已关闭' });
        const explicit = args.userConfirmed === true || args.source === 'user_explicit';
        if (!memory.autoSaveEnabled(doc) && !explicit) {
          return JSON.stringify({ code: 'AUTO_SAVE_DISABLED', error: '自动记忆已关闭，仅用户明确要求时保存' });
        }
        let value = args.value;
        if (typeof value === 'string') { try { value = JSON.parse(value); } catch { /* 保持字符串 */ } }
        try {
          // 按 confirmationMode 路由：明确 → 正式记忆；推断 → 候选（待确认）或忽略
          const res = memory.proposeMemory(doc, {
            category: args.category, key: args.key, summary: args.summary, value,
            importance: args.importance, source: args.source || 'ai_extracted',
            userConfirmed: args.userConfirmed === true,
          });
          if (res.action === 'save') return save({ memory: res.memory }, 'CREATED');
          if (res.action === 'candidate') return save({ candidate: res.candidate }, 'CANDIDATE');
          if (res.reason === 'not_repeated') return save({ pending: true, reason: res.reason }, 'IGNORED'); // 持久化偏好信号计数
          return JSON.stringify({ code: 'IGNORED', reason: res.reason });
        } catch (e) { return JSON.stringify({ code: 'FAILED', error: e.message }); }
      }
      case 'update_memory': {
        if (!memory.isEnabled(doc)) return JSON.stringify({ code: 'DISABLED', error: '记忆功能已关闭' });
        const patch = {};
        for (const k of ['summary', 'key', 'value', 'category', 'importance', 'isActive', 'title', 'userConfirmed']) {
          if (args[k] !== undefined) patch[k] = args[k];
        }
        if (patch.value !== undefined && typeof patch.value === 'string') { try { patch.value = JSON.parse(patch.value); } catch { /* 保持字符串 */ } }
        try {
          const m = memory.updateMemory(doc, args.id, patch);
          return save({ memory: m });
        } catch (e) { return JSON.stringify({ code: 'FAILED', error: e.message }); }
      }
      case 'delete_memory': {
        if (!memory.isEnabled(doc)) return JSON.stringify({ code: 'DISABLED', error: '记忆功能已关闭' });
        const removed = memory.deleteMemory(doc, args.id);
        if (!removed) return JSON.stringify({ code: 'NOT_FOUND', error: '记忆不存在' });
        return save({ ok: true });
      }
      case 'remember_user_preference': {
        if (!memory.isEnabled(doc)) return JSON.stringify({ code: 'DISABLED', error: '记忆功能已关闭' });
        // 用户明确表达偏好 → 视为显式，即使自动记忆关闭也可保存
        const key = args.key || ('pref_' + String(args.summary || args.value || '').slice(0, 16));
        try {
          const m = memory.upsertPreferenceMemory(doc, key, args.value ?? args.summary, { source: 'user_explicit', userConfirmed: true });
          return save({ memory: m }, 'CREATED');
        } catch (e) { return JSON.stringify({ code: 'FAILED', error: e.message }); }
      }
      case 'save_important_conversation': {
        if (!memory.isEnabled(doc)) return JSON.stringify({ code: 'DISABLED', error: '记忆功能已关闭' });
        if (!memory.autoSaveEnabled(doc)) return JSON.stringify({ code: 'AUTO_SAVE_DISABLED', error: '自动记忆已关闭，仅用户明确要求时保存' });
        const keyPoints = Array.isArray(args.keyPoints) ? args.keyPoints : String(args.keyPoints || '').split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
        try {
          // 重要决策需确认：ask_before_save/balanced 下转候选，explicit_only 下忽略
          const value = { title: args.title || '', keyPoints, relatedTopic: args.relatedTopic || '' };
          const res = memory.proposeMemory(doc, {
            category: 'important_conversation', key: 'conv_' + Date.now().toString(36), value,
            summary: args.summary, title: args.title || '', source: 'ai_extracted', importance: 'high',
          });
          if (res.action === 'save') return save({ memory: res.memory }, 'CREATED');
          if (res.action === 'candidate') return save({ candidate: res.candidate }, 'CANDIDATE');
          return JSON.stringify({ code: 'IGNORED', reason: res.reason });
        } catch (e) { return JSON.stringify({ code: 'FAILED', error: e.message }); }
      }
      case 'forget_memory': {
        if (!memory.isEnabled(doc)) return JSON.stringify({ code: 'DISABLED', error: '记忆功能已关闭' });
        let id = args.id;
        if (!id && args.key) {
          const hit = memory.listMemories(doc, { includeInactive: true }).find((m) => m.key === args.key);
          id = hit && hit.id;
        }
        if (!id) return JSON.stringify({ code: 'NOT_FOUND', error: '未找到对应记忆' });
        try {
          const m = memory.deactivateMemory(doc, id);
          return save({ memory: m });
        } catch (e) { return JSON.stringify({ code: 'FAILED', error: e.message }); }
      }

      // ---- 全局读取 ----
      case 'list_tasks': {
        let list = doc.tasks.slice();
        if (args.date) list = list.filter((t) => t.date === args.date);
        if (args.completed !== undefined) list = list.filter((t) => Boolean(t.completed) === Boolean(args.completed));
        if (args.planId) list = list.filter((t) => [t.planId, t.weeklyPlanId, t.monthlyPlanId, t.stagePlanId, t.longTermPlanId].includes(args.planId));
        list.sort((a, b) => (b.order || 0) - (a.order || 0) || (a.date || '').localeCompare(b.date || ''));
        const limit = Math.max(1, Math.min(100, parseInt(args.limit) || 50));
        return JSON.stringify({ code: 'OK', tasks: list.slice(0, limit), count: list.length });
      }
      case 'list_plans': {
        let list = doc.plans.slice();
        if (args.type) list = list.filter((p) => p.type === args.type);
        if (args.archived !== undefined) list = list.filter((p) => Boolean(p.archived) === Boolean(args.archived));
        return JSON.stringify({
          code: 'OK', count: list.length,
          plans: list.map((p) => ({ id: p.id, type: p.type, title: p.title, description: p.description, startDate: p.startDate, endDate: p.endDate, archived: !!p.archived, progress: planProgress(p), stageGoals: p.stageGoals || [] })),
        });
      }
      case 'get_calendar': {
        const start = args.start || todayStr();
        const end = args.end || addDaysStr(start, 7);
        const tasks = doc.tasks.filter((t) => t.date >= start && t.date <= end);
        const health = doc.health.filter((r) => r.date >= start && r.date <= end);
        const plans = doc.plans.filter((p) => (!p.endDate || p.endDate >= start) && (!p.startDate || p.startDate <= end));
        return JSON.stringify({ code: 'OK', start, end, tasks, health, plans: plans.map((p) => ({ id: p.id, type: p.type, title: p.title, startDate: p.startDate, endDate: p.endDate })) });
      }
      case 'list_habits': {
        const today = todayStr();
        const habits = doc.habits.map((h) => ({
          id: h.id, name: h.name, icon: h.icon, color: h.color, frequency: h.frequency, goal: h.goal, reminderTime: h.reminderTime,
          streak: habitStreak(h.completions), totalCompletions: habitTotalCompletions(h.completions, today),
          doneToday: (h.completions || []).includes(today),
        }));
        return JSON.stringify({ code: 'OK', habits, count: habits.length });
      }
      case 'list_shopping': {
        let list = doc.shoppingItems.slice();
        if (args.listId != null || args.owner != null) {
          const want = shopListId(args);
          list = list.filter((it) => it.listId === want || (it.owner != null && it.owner === shopOwner(want)));
        }
        if (!args.includeCompleted) list = list.filter((it) => !it.completed);
        return JSON.stringify({ code: 'OK', items: list, count: list.length });
      }
      case 'list_notes': {
        const limit = Math.max(1, Math.min(100, parseInt(args.limit) || 30));
        const list = doc.notes.slice().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, limit);
        return JSON.stringify({ code: 'OK', notes: list, count: list.length });
      }
      case 'get_journal': {
        const limit = Math.max(1, Math.min(30, parseInt(args.limit) || 5));
        const list = doc.journal.slice().sort((a, b) => (a.date || '').localeCompare(b.date || '') ? -1 : 1).slice(0, limit);
        return JSON.stringify({ code: 'OK', count: list.length, journal: list.map((j) => ({ id: j.id, date: j.date, time: j.time, mood: j.mood, moodSymbol: j.moodSymbol, content: j.content })) });
      }
      case 'get_statistics': {
        const range = ['7d', '30d', '90d'].includes(args.range) ? args.range : '7d';
        const days = parseInt(range);
        const today = todayStr();
        const cutoff = addDaysStr(today, -(days - 1));
        const tasksIn = doc.tasks.filter((t) => t.date >= cutoff && t.date <= today);
        const taskCompletion = tasksIn.length ? Math.round((tasksIn.filter((t) => t.completed).length / tasksIn.length) * 100) : 0;
        const habitTotal = doc.habits.length * days;
        let habitDone = 0;
        for (const h of doc.habits) for (const c of h.completions || []) if (c >= cutoff && c <= today) habitDone++;
        const habitCompletion = habitTotal ? Math.round((habitDone / habitTotal) * 100) : 0;
        const active = doc.plans.filter((p) => !p.archived);
        const planCompletion = active.length ? Math.round(active.reduce((a, p) => a + planProgress(p), 0) / active.length) : 0;
        return JSON.stringify({ code: 'OK', range, taskCompletion, habitCompletion, planCompletion, activeTaskCount: doc.tasks.filter((t) => !t.completed).length });
      }
      case 'get_conversation_history': {
        if (!conversationId) return JSON.stringify({ code: 'FAILED', error: '缺少会话上下文' });
        const limit = Math.max(1, Math.min(50, parseInt(args.limit) || 20));
        const msgs = await listMessages(conversationId, { limit: limit * 2, visibleOnly: true });
        const recent = msgs.slice(-limit).map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 500) }));
        return JSON.stringify({ code: 'OK', messages: recent, count: recent.length });
      }

      // ---- 编辑：任务 ----
      case 'create_task': {
        if (!args.title) return JSON.stringify({ code: 'FAILED', error: '缺少 title' });
        const chain = args.planId ? planChain(doc, args.planId) : {};
        const priority = ['high', 'med', 'low'].includes(args.priority) ? args.priority : 'med';
        const task = {
          id: randomUUID(), planId: null, weeklyPlanId: null, monthlyPlanId: null, stagePlanId: null, longTermPlanId: null,
          order: Date.now(), createdAt: Date.now(), date: todayOr(args.date), time: args.time || '', completed: false,
          priority, note: args.note || '', tags: [], title: String(args.title).trim(), ...chain,
        };
        doc.tasks.push(task);
        return save({ task }, 'CREATED');
      }
      case 'update_task': {
        const t = doc.tasks.find((x) => x.id === args.id); if (!t) return JSON.stringify({ code: 'NOT_FOUND', error: '任务不存在' });
        if (args.title != null) t.title = String(args.title);
        if (args.date != null) t.date = todayOr(args.date);
        if (args.time != null) t.time = String(args.time);
        if (args.priority != null && ['high', 'med', 'low'].includes(args.priority)) t.priority = args.priority;
        if (args.note != null) t.note = String(args.note);
        if (args.completed != null) t.completed = Boolean(args.completed);
        t.updatedAt = Date.now();
        return save({ task: t });
      }
      case 'complete_task': {
        const t = doc.tasks.find((x) => x.id === args.id); if (!t) return JSON.stringify({ code: 'NOT_FOUND', error: '任务不存在' });
        t.completed = args.completed !== undefined ? Boolean(args.completed) : !t.completed;
        t.updatedAt = Date.now();
        return save({ task: t });
      }
      case 'delete_task': {
        const before = doc.tasks.length;
        doc.tasks = doc.tasks.filter((x) => x.id !== args.id);
        return save({ ok: true, removed: before > doc.tasks.length });
      }

      // ---- 编辑：计划 ----
      case 'create_plan': {
        const type = args.type;
        if (!PLAN_TYPES.includes(type)) return JSON.stringify({ code: 'FAILED', error: 'type 必须是 long-term|stage|monthly|weekly' });
        const plan = defaultPlan(type);
        if (args.title != null) plan.title = String(args.title);
        if (args.description != null) plan.description = String(args.description);
        if (args.startDate != null) plan.startDate = todayOr(args.startDate);
        if (args.endDate != null) plan.endDate = todayOr(args.endDate);
        doc.plans.push(plan);
        return save({ plan }, 'CREATED');
      }
      case 'update_plan': {
        const p = doc.plans.find((x) => x.id === args.id); if (!p) return JSON.stringify({ code: 'NOT_FOUND', error: '计划不存在' });
        if (args.title != null) p.title = String(args.title);
        if (args.description != null) p.description = String(args.description);
        if (args.startDate != null) p.startDate = todayOr(args.startDate);
        if (args.endDate != null) p.endDate = todayOr(args.endDate);
        if (args.themeColor != null && /^#[0-9a-fA-F]{6}$/.test(String(args.themeColor))) p.themeColor = String(args.themeColor);
        if (args.archived != null) p.archived = Boolean(args.archived);
        p.updatedAt = Date.now();
        return save({ plan: p });
      }
      case 'delete_plan': {
        const p = doc.plans.find((x) => x.id === args.id); if (!p) return JSON.stringify({ code: 'NOT_FOUND', error: '计划不存在' });
        const type = p.type;
        doc.plans = doc.plans.filter((x) => x.id !== args.id);
        if (!doc.plans.some((x) => x.type === type)) doc.plans.push(defaultPlan(type));
        return save({ ok: true });
      }
      case 'add_plan_goal': {
        const p = doc.plans.find((x) => x.id === args.id); if (!p) return JSON.stringify({ code: 'NOT_FOUND', error: '计划不存在' });
        if (!args.title) return JSON.stringify({ code: 'FAILED', error: '缺少 title' });
        if (!Array.isArray(p.stageGoals)) p.stageGoals = [];
        const goal = { id: randomUUID(), title: String(args.title), progress: Math.max(0, Math.min(100, parseInt(args.progress) || 0)), dueDate: args.dueDate || '', completed: false, result: '' };
        p.stageGoals.push(goal);
        p.updatedAt = Date.now();
        return save({ plan: p, goal }, 'CREATED');
      }
      case 'update_plan_goal': {
        const p = doc.plans.find((x) => x.id === args.id); if (!p) return JSON.stringify({ code: 'NOT_FOUND', error: '计划不存在' });
        const g = (p.stageGoals || []).find((x) => x.id === args.goalId); if (!g) return JSON.stringify({ code: 'NOT_FOUND', error: '目标不存在' });
        if (args.title != null) g.title = String(args.title);
        if (args.progress != null) g.progress = Math.max(0, Math.min(100, parseInt(args.progress)));
        if (args.dueDate != null) g.dueDate = args.dueDate;
        if (args.completed != null) g.completed = Boolean(args.completed);
        if (args.result != null) g.result = String(args.result);
        p.updatedAt = Date.now();
        return save({ plan: p, goal: g });
      }

      // ---- 编辑：日历事件（薄封装成 task） ----
      case 'create_calendar_event': {
        if (!args.title) return JSON.stringify({ code: 'FAILED', error: '缺少 title' });
        const task = {
          id: randomUUID(), planId: null, weeklyPlanId: null, monthlyPlanId: null, stagePlanId: null, longTermPlanId: null,
          order: Date.now(), createdAt: Date.now(), date: todayOr(args.date), time: args.time || '', completed: false,
          priority: 'med', note: '', tags: [], title: String(args.title).trim(),
        };
        doc.tasks.push(task);
        return save({ task }, 'CREATED');
      }
      case 'update_calendar_event': {
        const t = doc.tasks.find((x) => x.id === args.id); if (!t) return JSON.stringify({ code: 'NOT_FOUND', error: '事件不存在' });
        if (args.title != null) t.title = String(args.title);
        if (args.date != null) t.date = todayOr(args.date);
        if (args.time != null) t.time = String(args.time);
        t.updatedAt = Date.now();
        return save({ task: t });
      }
      case 'delete_calendar_event': {
        const before = doc.tasks.length;
        doc.tasks = doc.tasks.filter((x) => x.id !== args.id);
        return save({ ok: true, removed: before > doc.tasks.length });
      }

      // ---- 编辑：习惯 ----
      case 'create_habit': {
        if (!args.name) return JSON.stringify({ code: 'FAILED', error: '缺少 name' });
        const frequency = ['daily', 'weekdays', 'weekly', 'custom'].includes(args.frequency) ? args.frequency : 'daily';
        const habit = {
          id: randomUUID(), name: String(args.name), description: args.description || '', icon: args.icon || '✅', color: args.color || '#6b8cae',
          frequency, goal: Math.max(1, parseInt(args.goal) || 1), reminderTime: args.reminderTime || '', completions: [], streak: 0, createdAt: Date.now(),
        };
        doc.habits.push(habit);
        return save({ habit }, 'CREATED');
      }
      case 'update_habit': {
        const h = doc.habits.find((x) => x.id === args.id); if (!h) return JSON.stringify({ code: 'NOT_FOUND', error: '习惯不存在' });
        for (const k of ['name', 'description', 'icon', 'color', 'reminderTime']) if (args[k] != null) h[k] = String(args[k]);
        if (args.frequency != null && ['daily', 'weekdays', 'weekly', 'custom'].includes(args.frequency)) h.frequency = args.frequency;
        if (args.goal != null) h.goal = Math.max(1, parseInt(args.goal));
        h.updatedAt = Date.now();
        return save({ habit: h });
      }
      case 'complete_habit': {
        const h = doc.habits.find((x) => x.id === args.id); if (!h) return JSON.stringify({ code: 'NOT_FOUND', error: '习惯不存在' });
        const date = todayOr(args.date);
        const completions = Array.isArray(h.completions) ? h.completions : [];
        const alreadyDone = completions.includes(date);
        if (!alreadyDone) { completions.push(date); h.completions = completions; h.streak = habitStreak(completions); h.updatedAt = Date.now(); }
        return save({ habit: h, done: !alreadyDone, alreadyDone });
      }
      case 'delete_habit': {
        const before = doc.habits.length;
        doc.habits = doc.habits.filter((x) => x.id !== args.id);
        return save({ ok: true, removed: before > doc.habits.length });
      }

      // ---- 编辑：购物 ----
      case 'add_shopping_item': {
        if (!args.title) return JSON.stringify({ code: 'FAILED', error: '缺少 title' });
        const listId = shopListId(args);
        const item = {
          id: randomUUID(), listId, owner: shopOwner(listId), title: String(args.title), note: args.note || '', category: args.category || '其他',
          priority: args.priority || 'normal', completed: false, sourceMemoryId: null, sourceConversationId: conversationId || null, createdAt: Date.now(), updatedAt: Date.now(),
        };
        doc.shoppingItems.push(item);
        return save({ item }, 'CREATED');
      }
      case 'update_shopping_item': {
        const it = doc.shoppingItems.find((x) => x.id === args.id); if (!it) return JSON.stringify({ code: 'NOT_FOUND', error: '购物条目不存在' });
        for (const k of ['title', 'note', 'category', 'priority']) if (args[k] != null) it[k] = String(args[k]);
        if (args.listId != null || args.owner != null) { const lid = shopListId(args); it.listId = lid; it.owner = shopOwner(lid); }
        it.updatedAt = Date.now();
        return save({ item: it });
      }
      case 'complete_shopping_item': {
        const it = doc.shoppingItems.find((x) => x.id === args.id); if (!it) return JSON.stringify({ code: 'NOT_FOUND', error: '购物条目不存在' });
        it.completed = args.completed !== undefined ? Boolean(args.completed) : !it.completed;
        it.updatedAt = Date.now();
        return save({ item: it });
      }
      case 'delete_shopping_item': {
        const before = doc.shoppingItems.length;
        doc.shoppingItems = doc.shoppingItems.filter((x) => x.id !== args.id);
        return save({ ok: true, removed: before > doc.shoppingItems.length });
      }

      // ---- 编辑：笔记 ----
      case 'create_note': {
        if (!args.title) return JSON.stringify({ code: 'FAILED', error: '缺少 title' });
        const tags = args.tags ? String(args.tags).split(/[,，、]/).map((s) => s.trim()).filter(Boolean) : [];
        const note = { id: randomUUID(), title: String(args.title), content: args.content || '', tags, pinned: !!args.pinned, createdAt: Date.now(), updatedAt: Date.now() };
        doc.notes.unshift(note);
        return save({ note }, 'CREATED');
      }
      case 'update_note': {
        const n = doc.notes.find((x) => x.id === args.id); if (!n) return JSON.stringify({ code: 'NOT_FOUND', error: '笔记不存在' });
        if (args.title != null) n.title = String(args.title);
        if (args.content != null) n.content = String(args.content);
        if (args.tags != null) n.tags = String(args.tags).split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
        if (args.pinned != null) n.pinned = Boolean(args.pinned);
        n.updatedAt = Date.now();
        return save({ note: n });
      }
      case 'delete_note': {
        const before = doc.notes.length;
        doc.notes = doc.notes.filter((x) => x.id !== args.id);
        return save({ ok: true, removed: before > doc.notes.length });
      }

      // ---- 编辑：AI 动态（Actor=assistant / entityType=activity；与 Memory 完全独立） ----
      case 'create_ai_activity': {
        const text = String(args.content ?? args.text ?? '').trim();
        if (!text) return JSON.stringify({ code: 'FAILED', error: '缺少动态内容' });
        const validTypes = ['memory', 'state', 'task', 'habit', 'plan', 'shopping', 'music', 'weather', 'chat', 'journal'];
        const type = validTypes.includes(args.type) ? args.type : (args.type ? String(args.type) : 'chat');
        const activity = appendAiActivity(doc, { type, text, source: 'chat' });
        return save({ activity }, 'CREATED');
      }
      case 'get_ai_activities': {
        const limit = Math.max(1, Math.min(50, parseInt(args.limit) || 10));
        const list = aiActivities(doc).slice(0, limit);
        return JSON.stringify({ code: 'OK', activities: list, count: list.length });
      }
      case 'update_ai_activity': {
        const arr = (doc.ai && Array.isArray(doc.ai.activities)) ? doc.ai.activities : [];
        const a = arr.find((x) => x.id === args.id);
        if (!a) return JSON.stringify({ code: 'NOT_FOUND', error: '动态不存在' });
        if (!isAiActivity(a)) return JSON.stringify({ code: 'DENIED', error: '只能修改 AI 自己的动态' });
        if (args.text != null) { const t = String(args.text).trim(); if (t) a.text = t; }
        if (args.type != null) a.type = String(args.type);
        a.updatedAt = Date.now();
        return save({ activity: a }, 'UPDATED');
      }
      case 'delete_ai_activity': {
        const arr = (doc.ai && Array.isArray(doc.ai.activities)) ? doc.ai.activities : [];
        const a = arr.find((x) => x.id === args.id);
        if (!a) return JSON.stringify({ code: 'NOT_FOUND', error: '动态不存在' });
        if (!isAiActivity(a)) return JSON.stringify({ code: 'DENIED', error: '只能删除 AI 自己的动态' });
        doc.ai.activities = arr.filter((x) => x.id !== args.id);
        return save({ ok: true }, 'DELETED');
      }
      // ---- 对话缓存（存 sessions 表，不走 doc；失败诚实返回，绝不假装已存） ----
      case 'save_conversation_cache':
      case 'update_conversation_cache': {
        if (!conversationId) return JSON.stringify({ code: 'FAILED', error: '缺少会话上下文' });
        try {
          const cache = name === 'save_conversation_cache'
            ? await saveConversationCache(conversationId, args)
            : await updateConversationCache(conversationId, args);
          if (!cache) return JSON.stringify({ code: 'CONFLICT', error: '缓存版本冲突，请重试' });
          return JSON.stringify({ code: 'OK', cache });
        } catch (e) {
          return JSON.stringify({ code: 'FAILED', error: e.message });
        }
      }
      // ---- 系统只读：当前时间（不修改任何数据、不审计） ----
      case 'get_current_time':
        return JSON.stringify({ code: 'OK', ...currentTimeInfo() });

      // ---- 通知：Bark 推送（经统一 NotificationEngine；真实 HTTP；绝不返回/记录 Bark URL/key） ----
      case 'send_bark_notification': {
        const title = String(args.title || '').trim();
        const body = String(args.body || '').trim();
        if (!title || !body) {
          return JSON.stringify({ code: 'FAILED', provider: 'bark', status: 'FAILED', errorCode: 'MISSING_TITLE_OR_BODY', error: '缺少 title/body' });
        }
        // 级别白名单：AI 工具只能发 normal/time_sensitive，绝不发 critical/call（强提醒走显式闹钟意图）。
        const level = args.level === 'time_sensitive' ? 'time_sensitive' : 'normal';
        const result = await sendNotification({
          userId, title, body, level,
          sound: args.sound, group: args.group,
          source: 'ai_tool', conversationId,
        });
        // 审计：记录 Bark 发送（只记标题，绝不记完整 Bark URL/key）
        recordAudit(doc, {
          action: 'send_bark_notification', aiAction: 'send_bark_notification',
          entityType: 'notification', entityId: null,
          entityLabel: 'Bark 通知：' + title,
          before: null, after: null,
          actor: 'assistant', reason: args.reason || '', conversationId,
        });
        await putState(userId, doc);
        // 标准化 tool_result（真实状态；不返回完整 URL/key）
        return JSON.stringify({
          code: result.status === 'SUCCESS' ? 'OK' : result.status,
          provider: 'bark',
          status: result.status,
          message: result.status === 'SUCCESS' ? 'Notification sent successfully' : undefined,
          ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        });
      }

      default:
        return JSON.stringify({ code: 'UNKNOWN_TOOL', error: '未知工具: ' + name });
    }
  };

  return { tools, callTool, names: TOOL_DEFS.map((t) => t.name) };
}
