// AI 结构化上下文：按用户问题选择性注入真实生活数据（财务/经期/病历/购物），
// 绝不把整份文档塞进 Prompt，降低 token 消耗并保护隐私。
// 这些是「只读事实」；AI 若要写入，走 lib/tools.js 的领域工具。
import { financeSummary, fmtCents, todayStr } from './finance.js';
import { withCycleLengths, predict } from './menstrual.js';
import { songInfo } from './netease.js';
import { planProgress, habitStreak } from './domain.js';
import { aiCan } from './permissions.js';

// 领域关键词分两层（Context 与 Tool 分离，绝不强制相同）：
//   1) CONTEXT_PATTERNS：只读上下文注入（轻量，驱动 buildContextSnippet）。
//   2) TOOL_PATTERNS：工具 schema 注入（昂贵，驱动 routes/messages.js 的工具裁剪）。
// 原则：强领域词（任务/账单/病历/计划…）可直接触发；通用时间/日常词（今天/明天/忙/事情/怎么样…）
//       只可能落在只读 context，绝不触发工具注入。

// 只读上下文领域。life/statistics/activity 是聚合/只读/自我领域，本身无业务工具。
const CONTEXT_PATTERNS = [
  ['finance', /花了|花钱|消费|开销|支出|账单|账本|记账|预算|多少钱|花了多少|还剩|剩余|花销|价格|贵|省钱|生活费|日用品|欠|付款|收据|收入|工资|\d+(?:\.\d+)?\s*(?:元|块)/],
  ['menstrual', /经期|月经|例假|大姨妈|生理期|姨妈|经量|痛经|点滴出血|基础体温|period|menstrual|cycle|排卵/],
  ['medical', /病历|过敏|看病|医院|医生|诊断|手术|病史|生病|感冒|发烧|咳嗽|吃药|药|体检|症状|既往|慢病|血压|血糖|就诊|复诊/],
  ['health', /健康|睡眠|睡了|喝水|饮水|体重|身高|热量|卡路里|千卡|摄入|运动|跑步|锻炼|健身|吃了几|吃了什么|饮食|营养|步数|心率/],
  ['music', /这首歌|这首|歌词|评论|热评|正在听|在听|播放|歌曲|音乐|歌手|专辑|一起听|陪我听|陪你听|听什么|下一首|切歌|换一首|再来一首|不喜欢这首|喜欢这首|接歌|听歌/],
  ['memory', /记忆|记住|记得|别忘了|以后都|以后叫|以后你叫|叫我|称呼|偏好|喜好|请保存|保存一下|记一下|记牢|记住这个|下次别忘/],
  ['tasks', /任务|待办|todo|日程|提醒我|要做|该做|要做的事|完成了吗|做完|待办事项/],
  ['plans', /计划|目标|规划|长期|阶段|月计划|周计划|实现|梦想|里程碑|进度|愿景/],
  ['calendar', /日历|日程|几号|周几|星期几|什么时候|哪天|排期|未来几天/],
  ['journal', /日志|日记|写日记|写日志|经历|回忆|那天/],
  ['notes', /笔记|记下来|便签|灵感|想法|备忘录|草稿/],
  ['habits', /习惯|打卡|坚持|规律|自律|早睡|早起/],
  ['shopping', /购物清单|买什么|要买|采购|购物车|清单|囤货|缺什么/],
  ['statistics', /统计|完成率|数据|进度|总结|复盘|这个月|上周|表现/],
  ['life', /最近|生活|怎么样|过得好|状态|压力|焦虑|忙不忙|累|事情多|整体|近况|一切/],
  ['activity', /activity|动态|活动记录|你之前做过|最近做了什么|之前的回应|回想一下/],
];

// 工具领域：只有「有可注入工具」的领域 + 强意图关键词才在这里。
// 排除 life/statistics（只读上下文）与 activity（AI 自我工具常驻 CORE_ALWAYS_TOOLS）。
const TOOL_PATTERNS = [
  ['finance', /花了|花钱|消费|开销|支出|账单|账本|记账|预算|多少钱|花了多少|还剩|剩余|花销|价格|贵|省钱|生活费|欠|付款|收据|收入|工资|\d+(?:\.\d+)?\s*(?:元|块)/],
  ['menstrual', /经期|月经|例假|大姨妈|生理期|姨妈|经量|痛经|点滴出血|基础体温|period|menstrual|cycle|排卵/],
  ['medical', /病历|过敏|看病|医院|医生|诊断|手术|病史|生病|感冒|发烧|咳嗽|吃药|药|体检|症状|既往|慢病|血压|血糖|就诊|复诊/],
  ['health', /健康|睡眠|睡了|喝水|饮水|体重|身高|热量|卡路里|千卡|摄入|运动|跑步|锻炼|健身|吃了几|吃了什么|饮食|营养|步数|心率/],
  ['music', /这首歌|这首|歌词|评论|热评|正在听|在听|播放|歌曲|音乐|歌手|专辑|一起听|陪我听|陪你听|听什么|下一首|切歌|换一首|再来一首|不喜欢这首|喜欢这首|接歌|听歌/],
  ['memory', /记忆|记住|记得|别忘了|以后都|以后叫|以后你叫|叫我|称呼|偏好|喜好|请保存|保存一下|记一下|记牢|记住这个|下次别忘/],
  ['tasks', /任务|待办|todo|日程|提醒我|要做|该做|要做的事|完成了吗|做完|待办事项/],
  ['plans', /计划|目标|规划|长期|阶段|月计划|周计划|实现|梦想|里程碑|进度|愿景/],
  ['calendar', /日历|日程|几号|周几|星期几|什么时候|哪天|排期|未来几天/],
  ['journal', /日志|日记|写日记|写日志|记日记|打开日志|查看日志|我的日志/],
  ['notes', /笔记|记下来|便签|备忘录|草稿/],
  ['habits', /习惯|打卡|坚持|规律|自律|早睡|早起/],
  ['shopping', /购物清单|买什么|要买|采购|购物车|清单|囤货|缺什么/],
];

function matchDomains(patterns, text) {
  const t = String(text || '');
  return patterns.filter(([, re]) => re.test(t)).map(([d]) => d);
}

// 只读上下文领域（buildContextSnippet 用）
export function detectContextDomains(text) {
  return matchDomains(CONTEXT_PATTERNS, text);
}

// 工具领域（routes/messages.js 用它决定注入哪些工具 schema）
export function detectToolDomains(text) {
  return matchDomains(TOOL_PATTERNS, text);
}

// 向后兼容别名：旧调用（buildContextSnippet 内部、既有测试）仍指向「上下文领域」。
export const detectDomains = detectContextDomains;

function centsFmt(c) { return fmtCents(c); }

// 财务上下文（预算 + 本月 + 分类 + 最近消费/购买）
function financeBlock(doc) {
  const s = financeSummary(doc, todayStr());
  const lines = [];
  if (s.hasBudget) {
    lines.push(`- 本月预算：${centsFmt(s.monthlyBudgetCents)}（已设置）`);
    lines.push(`- 本月已花：${centsFmt(s.monthExpenseCents)}（${s.monthExpenseCount} 笔）；剩余：${centsFmt(s.remainingCents)}`);
    lines.push(`- 本月还剩 ${s.remainingDays} 天；建议每日 ≤ ${centsFmt(s.recommendedDailyBudgetCents)}`);
  } else {
    lines.push('- 尚未设置本月预算');
    lines.push(`- 本月已花：${centsFmt(s.monthExpenseCents)}（${s.monthExpenseCount} 笔）`);
  }
  lines.push(`- 今日已花：${centsFmt(s.todayExpenseCents)}；本周已花：${centsFmt(s.weekExpenseCents)}`);
  if (s.monthIncomeCents) lines.push(`- 本月收入：${centsFmt(s.monthIncomeCents)}`);
  const cats = Object.entries(s.categoryBreakdown).sort((a, b) => b[1] - a[1]).map(([c, v]) => `${c} ${centsFmt(v)}`);
  if (cats.length) lines.push(`- 本月分类：${cats.join('、')}`);
  const re = s.recentExpenses.slice(0, 10).map((e) => `${e.title} ${centsFmt(e.amountCents)}（${e.category || '其他'}${e.occurredAt ? '·' + e.occurredAt : ''}）`);
  if (re.length) lines.push(`- 最近消费：${re.join('、')}`);
  const rp = s.recentPurchases.slice(0, 10).map((p) => `${p.itemName} ×${p.quantity} ${centsFmt(p.totalAmountCents)}（${p.category || '其他'}${p.purchasedAt ? '·' + p.purchasedAt : ''}）`);
  if (rp.length) lines.push(`- 最近购买：${rp.join('、')}`);
  return '【财务数据（真实记录，来自用户账本）】\n' + lines.join('\n');
}

// 经期上下文
function menstrualBlock(doc) {
  const pred = predict(doc.menstrualCycles, todayStr());
  const lines = [];
  if (pred.lastStart) {
    lines.push(`- 最近一次开始：${pred.lastStart}${pred.lastEnd ? '，结束：' + pred.lastEnd : '（进行中）'}`);
  }
  if (pred.averageCycleLengthDays) lines.push(`- 平均周期：约 ${pred.averageCycleLengthDays} 天`);
  if (pred.averageDurationDays) lines.push(`- 平均持续：约 ${pred.averageDurationDays} 天`);
  if (pred.status === 'ready') {
    lines.push(`- 预计下次：${pred.predictedStart} 左右（范围 ${pred.rangeStart} ~ ${pred.rangeEnd}，可信度 ${pred.confidence}）`);
  } else {
    lines.push(`- ${pred.note || '历史数据不足，暂无法预测。'}`);
  }
  const rc = withCycleLengths(doc.menstrualCycles).slice(0, 8).map((c) => `${c.startDate}${c.endDate ? '→' + c.endDate : '（进行中）'}${c.cycleLengthDays ? '，周期 ' + c.cycleLengthDays + ' 天' : ''}`);
  if (rc.length) lines.push(`- 最近周期：${rc.join('；')}`);
  lines.push('- 注意：预测仅供参考，不构成医学诊断。涉及异常出血、剧痛、怀孕等请咨询专业医疗人员。');
  return '【经期记录（真实数据，敏感隐私）】\n' + lines.join('\n');
}

// 个人病历上下文
function medicalBlock(doc) {
  const recs = (doc.medicalRecords || []).slice().sort((a, b) => (b.date || '') < (a.date || '') ? -1 : 1);
  if (!recs.length) return '【个人病历】\n- 目前没有找到记录过的病历信息。';
  const lines = recs.slice(0, 10).map((r) => {
    const parts = [];
    if (r.type) parts.push(`[${r.type}]`);
    parts.push(r.title);
    if (r.date) parts.push(r.date);
    if (r.diagnosis) parts.push('诊断：' + r.diagnosis);
    if (r.symptoms) parts.push('症状：' + r.symptoms);
    if (r.medication) parts.push('用药：' + r.medication);
    return '- ' + parts.join(' ');
  });
  if (recs.length > 10) lines.push(`- …共 ${recs.length} 条，仅列最近 10 条`);
  lines.push('- 重要：「没有记录」不等于「没有发生过」；若找不到相关信息，请如实说「没有找到相关记录」，不要断言用户没有该病史。');
  return '【个人病历（真实记录，敏感隐私，仅用于回答用户本人的健康询问）】\n' + lines.join('\n');
}

// 健康上下文（睡眠/饮水/热量/体重，最近 7 天真实记录）
function healthBlock(doc) {
  const recs = (doc.health || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!recs.length) return '【健康记录】\n- 目前没有记录过健康数据（睡眠/饮水/热量/体重）。';
  const hp = doc.healthProfile || {};
  const lines = [];
  if (hp.height) lines.push(`- 身高：${hp.height} cm`);
  const recent = recs.slice(-7);
  for (const r of recent) {
    const parts = [r.date];
    if (r.sleep) parts.push(`睡眠 ${r.sleep}h`);
    if (r.water) parts.push(`饮水 ${r.water}L`);
    if (r.caloriesIn) parts.push(`摄入 ${r.caloriesIn} 千卡`);
    if (r.caloriesOut) parts.push(`运动消耗 ${r.caloriesOut} 千卡`);
    if (r.weight) parts.push(`体重 ${r.weight}kg`);
    lines.push('- ' + parts.join('，'));
  }
  lines.push('- 重要：以上是真实记录；没有记录的日期不代表数据为 0，请如实说明「没有记录」。');
  return '【健康记录（真实数据）】\n' + lines.join('\n');
}

// 音乐上下文：当前播放状态 + 公开歌词/热门评论（需求 18，仅注入真实播放数据 + 公开信息）
async function musicBlock(doc) {
  const p = doc.player || {};
  const track = (p.playlist && p.playlist[p.current]) || null;
  if (!track) return '【音乐】\n- 当前没有在播放歌曲。';
  const mmss = (s) => { s = Math.max(0, Math.round(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const lines = [];
  lines.push(`- 当前${p.playing ? '正在播放' : '暂停中'}：${track.title || '未知'}${track.artist ? '（' + track.artist + '）' : ''}${track.album ? ' · 专辑：' + track.album : ''}`);
  lines.push(`- 进度：${mmss(p.currentTime)} / ${mmss(track.duration)}；来源平台：网易云音乐`);
  const list = (p.playlist || []);
  lines.push(`- 播放列表共 ${list.length} 首，当前第 ${(p.current || 0) + 1} 首${p.togetherListening ? '；已开启「一起听」' : ''}`);
  // 陪听会话 + 当前助手（绑定 assistantId，绝不 assistants[0]）
  const session = doc.listeningSession;
  if (session && session.status === 'active') {
    const asst = (doc.assistants || []).find((a) => a.id === session.assistantId);
    const bits = ['陪听会话已开启'];
    if (asst) bits.push(`由助手「${asst.name || ''}」陪伴`);
    if (session.autoNext) bits.push('已开启自动接歌');
    lines.push(`- ${bits.join('，')}`);
  }
  // 音乐品味画像（仅明确喜欢/不喜欢，绝不把「播放过一次」当偏好）
  const taste = doc.musicTasteProfile;
  if (taste) {
    const fav = (taste.favoriteArtists || []).map((x) => x.name || x).filter(Boolean);
    const dis = (taste.dislikedArtists || []).map((x) => x.name || x).filter(Boolean);
    const favSongs = (taste.favoriteSongs || []).filter(Boolean);
    if (fav.length || dis.length || favSongs.length) {
      lines.push(`- 用户音乐偏好：${fav.length ? '喜欢歌手 ' + fav.join('、') + '；' : ''}${dis.length ? '不喜欢歌手 ' + dis.join('、') + '；' : ''}${favSongs.length ? '喜欢的歌 ' + favSongs.slice(0, 10).join('、') : ''}`);
    }
  }
  if (track.id) {
    try {
      const info = await songInfo(track.id);
      if (info.lyric) {
        const l = info.lyric.length > 1200 ? info.lyric.slice(0, 1200) + '\n…（歌词过长已截断）' : info.lyric;
        lines.push(`- 歌词（公开）：\n${l}`);
      }
      if (info.hotComments && info.hotComments.length) {
        lines.push(`- 热门评论（公开）：${info.hotComments.map((c) => `${c.user}：「${c.content}」（赞 ${c.likedCount}）`).join('；')}`);
      }
    } catch (e) { lines.push('- 歌词/评论获取失败（可能无版权或接口受限）。'); }
  } else {
    lines.push('- 这是本地示例曲目，无歌词/评论数据。');
  }
  lines.push('- 重要：你目前无法真正听到音频，只能依据歌词、歌曲 metadata 与公开评论作答；绝不要声称听到了鼓点/贝斯/具体乐器等细节，也不要把「播放过一次」当成用户喜欢。');
  return '【音乐（真实播放状态；歌词/评论为公开数据）】\n' + lines.join('\n');
}

// ---- 新增：任务 / 计划 / 日历 / 习惯 / 购物 / 笔记 / 日志 / 统计 / 生活快照（只读事实） ----

function tasksBlock(doc) {
  const tasks = doc.tasks || [];
  const today = todayStr();
  const open = tasks.filter((t) => !t.completed);
  const overdue = open.filter((t) => t.date && t.date < today);
  const dueToday = open.filter((t) => t.date === today);
  const lines = [];
  if (!tasks.length) return '【任务】\n- 目前没有任务。';
  lines.push(`- 待办 ${open.length} 项：今日 ${dueToday.length}、已逾期 ${overdue.length}`);
  const upcoming = open.filter((t) => t.date && t.date >= today).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 10);
  for (const t of upcoming) {
    const when = t.date === today ? '今天' : (t.date || '无日期');
    lines.push(`- ${when}${t.time ? ' ' + t.time : ''}：${t.title}${t.priority === 'high' ? '（高优先）' : ''}`);
  }
  if (overdue.length) lines.push(`- 逾期：${overdue.slice(0, 5).map((t) => `${t.title}(${t.date})`).join('、')}`);
  return '【任务（真实数据）】\n' + lines.join('\n');
}

function plansBlock(doc) {
  const plans = (doc.plans || []).filter((p) => !p.archived);
  if (!plans.length) return '【计划】\n- 目前没有进行中的计划。';
  const lines = plans.map((p) => `- [${p.type}] ${p.title}：进度 ${planProgress(p)}%${p.endDate ? '，截止 ' + p.endDate : ''}${(p.stageGoals || []).length ? '，' + p.stageGoals.length + ' 个阶段目标' : ''}`);
  return '【计划（真实数据）】\n' + lines.join('\n');
}

function calendarBlock(doc) {
  const pad2 = (n) => (n < 10 ? '0' + n : '' + n);
  const dstr2 = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const start = todayStr();
  const end = (() => { const d = new Date(); d.setDate(d.getDate() + 7); return dstr2(d); })();
  const tasks = (doc.tasks || []).filter((t) => t.date >= start && t.date <= end).sort((a, b) => a.date.localeCompare(b.date));
  const lines = [];
  if (!tasks.length) return '【日历（未来 7 天）】\n- 未来 7 天没有安排日程。';
  for (const t of tasks) lines.push(`- ${t.date}${t.time ? ' ' + t.time : ''}：${t.title}${t.completed ? '（已完成）' : ''}`);
  return '【日历（未来 7 天）】\n' + lines.join('\n');
}

function journalBlock(doc) {
  const list = (doc.journal || []).slice().sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 5);
  if (!list.length) return '【日志】\n- 目前没有日志记录。';
  const lines = list.map((j) => `- ${j.date || ''}${j.time ? ' ' + j.time : ''}${j.mood ? ' · ' + j.mood : ''}：${String(j.content || '').slice(0, 200)}`);
  lines.push('- 日志是用户亲笔写的，仅供你理解与共情，绝不修改、删除或重写。');
  return '【日志（只读，用户亲笔）】\n' + lines.join('\n');
}

function notesBlock(doc) {
  const list = (doc.notes || []).slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 8);
  if (!list.length) return '【笔记】\n- 目前没有笔记。';
  const lines = list.map((n) => `- ${n.title}${n.content ? '：' + String(n.content).slice(0, 100) : ''}${n.pinned ? '（置顶）' : ''}`);
  return '【笔记（真实数据）】\n' + lines.join('\n');
}

function habitsBlock(doc) {
  const habits = doc.habits || [];
  if (!habits.length) return '【习惯】\n- 目前没有建立习惯。';
  const today = todayStr();
  const lines = habits.map((h) => `- ${h.icon || '✅'} ${h.name}：连续 ${habitStreak(h.completions)} 天，今日${(h.completions || []).includes(today) ? '已打卡' : '未打卡'}${h.goal > 1 ? '（目标 ' + h.goal + ' 次）' : ''}`);
  return '【习惯（真实数据）】\n' + lines.join('\n');
}

function shoppingBlock(doc) {
  const items = (doc.shoppingItems || []).filter((it) => !it.completed);
  if (!items.length) return '【购物清单】\n- 目前没有待购条目。';
  const lines = items.slice(0, 15).map((it) => `- ${it.title}${it.note ? '（' + it.note + '）' : ''}${it.category && it.category !== '其他' ? ' · ' + it.category : ''}`);
  return '【购物清单（未购）】\n' + lines.join('\n');
}

function statisticsBlock(doc) {
  const today = todayStr();
  const tasks = doc.tasks || [];
  const taskTotal = tasks.length;
  const taskDone = tasks.filter((t) => t.completed).length;
  const taskCompletion = taskTotal ? Math.round((taskDone / taskTotal) * 100) : 0;
  const habits = doc.habits || [];
  const habitDoneToday = habits.filter((h) => (h.completions || []).includes(today)).length;
  const active = (doc.plans || []).filter((p) => !p.archived);
  const planCompletion = active.length ? Math.round(active.reduce((a, p) => a + planProgress(p), 0) / active.length) : 0;
  const lines = [
    `- 任务完成率：${taskCompletion}%（${taskDone}/${taskTotal}）`,
    `- 习惯：今日打卡 ${habitDoneToday}/${habits.length}`,
    `- 计划平均进度：${planCompletion}%`,
    `- 未完成任务：${taskTotal - taskDone} 项`,
  ];
  return '【生活统计（真实派生）】\n' + lines.join('\n');
}

function lifeBlock(doc) {
  const today = todayStr();
  const tasks = doc.tasks || [];
  const open = tasks.filter((t) => !t.completed);
  const overdue = open.filter((t) => t.date && t.date < today).length;
  const dueToday = open.filter((t) => t.date === today).length;
  const habits = doc.habits || [];
  const doneToday = habits.filter((h) => (h.completions || []).includes(today)).length;
  const activePlans = (doc.plans || []).filter((p) => !p.archived).length;
  const shopping = (doc.shoppingItems || []).filter((it) => !it.completed).length;
  const notes = (doc.notes || []).length;
  const journal = (doc.journal || []).slice().sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 3).map((j) => `${j.date} ${j.mood || ''} ${String(j.content || '').slice(0, 40)}`);
  const lines = [
    `- 待办：${open.length} 项（今日 ${dueToday}、逾期 ${overdue}）`,
    `- 进行中计划：${activePlans} 个；习惯今日打卡 ${doneToday}/${habits.length}`,
    `- 待购 ${shopping} 项；笔记 ${notes} 篇`,
  ];
  if (journal.length) lines.push(`- 最近日志：${journal.join('；')}`);
  return '【生活快照（真实数据）】\n' + lines.join('\n');
}

function activityBlock(doc) {
  const acts = (doc.ai && Array.isArray(doc.ai.activities)) ? doc.ai.activities : [];
  if (!acts.length) return '【AI 动态】\n- 目前没有动态记录。';
  const lines = acts.slice(0, 10).map((a) => `- ${a.time ? new Date(a.time).toISOString().slice(0, 10) : ''} [${a.type || '其他'}] ${String(a.text || '').slice(0, 80)}`);
  return '【AI 动态（只读回看）】\n' + lines.join('\n');
}

// 根据用户问题返回要注入的结构化上下文片段（无相关性时返回空字符串）
export async function buildContextSnippet(doc, text) {
  const domains = detectDomains(text);
  if (domains.length === 0) return '';
  const blocks = [];
  if (domains.includes('finance') && aiCan('finance', 'read')) blocks.push(financeBlock(doc));
  if (domains.includes('menstrual') && aiCan('menstrual', 'read')) blocks.push(menstrualBlock(doc));
  if (domains.includes('medical') && aiCan('medical', 'read')) blocks.push(medicalBlock(doc));
  if (domains.includes('health') && aiCan('health', 'read')) blocks.push(healthBlock(doc));
  if (domains.includes('music') && aiCan('music', 'read')) blocks.push(await musicBlock(doc));
  if (domains.includes('tasks') && aiCan('tasks', 'read')) blocks.push(tasksBlock(doc));
  if (domains.includes('plans') && aiCan('plans', 'read')) blocks.push(plansBlock(doc));
  if (domains.includes('calendar') && aiCan('calendar', 'read')) blocks.push(calendarBlock(doc));
  if (domains.includes('journal') && aiCan('journal', 'read')) blocks.push(journalBlock(doc));
  if (domains.includes('notes') && aiCan('notes', 'read')) blocks.push(notesBlock(doc));
  if (domains.includes('habits') && aiCan('habit', 'read')) blocks.push(habitsBlock(doc));
  if (domains.includes('shopping') && aiCan('shopping', 'read')) blocks.push(shoppingBlock(doc));
  if (domains.includes('statistics') && aiCan('statistics', 'read')) blocks.push(statisticsBlock(doc));
  if (domains.includes('life') && aiCan('tasks', 'read')) blocks.push(lifeBlock(doc));
  if (domains.includes('activity') && aiCan('activity', 'read')) blocks.push(activityBlock(doc));
  return blocks.join('\n\n');
}

// 会触发「工具注入」的领域（从 TOOL_PATTERNS 派生）。activity 工具常驻 CORE_ALWAYS_TOOLS，不在此列；
// life/statistics/conversation 为只读上下文，也不在此列。
export const TOOL_DOMAIN_SET = new Set(TOOL_PATTERNS.map(([d]) => d));

// 供 AI 工具/前端直接取用的结构化上下文对象（比字符串更适合程序消费）
export function structuredContext(doc) {
  const s = financeSummary(doc, todayStr());
  const pred = predict(doc.menstrualCycles, todayStr());
  const recs = (doc.medicalRecords || []).slice().sort((a, b) => (b.date || '') < (a.date || '') ? -1 : 1);
  return {
    finance: {
      hasBudget: s.hasBudget, monthlyBudgetCents: s.monthlyBudgetCents, monthExpenseCents: s.monthExpenseCents,
      remainingCents: s.remainingCents, remainingDays: s.remainingDays, recommendedDailyBudgetCents: s.recommendedDailyBudgetCents,
      todayExpenseCents: s.todayExpenseCents, weekExpenseCents: s.weekExpenseCents, categoryBreakdown: s.categoryBreakdown,
      recentExpenses: s.recentExpenses.slice(0, 20), recentPurchases: s.recentPurchases.slice(0, 20),
    },
    menstrual: pred,
    medical: { records: recs.slice(0, 20), total: recs.length },
  };
}
