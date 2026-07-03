/**
 * 将日期格式化为中国标准时间（UTC+8）的字符串。
 * 统一使用 Asia/Shanghai 时区，避免因浏览器/服务器时区不同导致显示偏差。
 *
 * SQLite CURRENT_TIMESTAMP 返回 UTC 时间但不带时区后缀（如 "2026-06-18 08:38:05"），
 * JS 的 new Date() 会将其当作本地时间解析，需要追加 "Z" 明确为 UTC。
 */
export function formatCN(input: string | number | Date): string {
  let date: Date;
  if (input instanceof Date) {
    date = input;
  } else if (typeof input === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(input)) {
    date = new Date(input + 'Z');
  } else {
    date = new Date(input);
  }
  if (isNaN(date.getTime())) return '-';
  return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}
