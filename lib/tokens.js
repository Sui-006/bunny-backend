// 粗略估算文本 token 数（用于触发记忆压缩，无需精确）
// 中文按每字约 1 token，英文/其他按每 4 字符约 1 token
export function estimateTokens(text = '') {
  if (!text) return 0;
  const cjk = (text.match(/[一-鿿　-〿＀-￯]/g) || []).length;
  const other = text.length - cjk;
  return Math.ceil(cjk + other / 4);
}
