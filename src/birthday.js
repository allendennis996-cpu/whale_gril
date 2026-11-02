'use strict';

// 无年份生日允许闰日；空值表示尚未设定。
function birthday(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !/^\d{2}-\d{2}$/.test(value)) throw Error('生日请使用 MM-DD 格式，例如 06-18；也可以留空');
  const [month, day] = value.split('-').map(Number);
  const days = [31,29,31,30,31,30,31,31,30,31,30,31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) throw Error('生日的月日无效');
  return value;
}
module.exports = birthday;
