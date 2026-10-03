/**
 * 会话实际覆盖时长：所有“有素材的实际时间范围”的并集（ms）。
 *
 * 双路同时留证时两段素材可能时间重叠（同一时刻主、备各录了一块），
 * 直接逐段累加会把重叠拍摄时间算成“连续延长的会话”。这里先按开始时间
 * 排序再合并相交/相邻区间，重叠部分只计一次；录制中（endedAt === null）
 * 的段尚无确定终点，不参与统计。
 */
export function recordingCoverage(segments) {
  const ranges = segments
    .filter((s) => Number.isFinite(s?.startedAt) && Number.isFinite(s?.endedAt))
    .map((s) => [s.startedAt, s.endedAt])
    .filter(([from, to]) => to >= from)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  let total = 0;
  let cur = null;
  for (const [from, to] of ranges) {
    if (!cur) {
      cur = [from, to];
    } else if (from <= cur[1]) {
      // 相交或相邻：合并为一个覆盖区间。
      cur[1] = Math.max(cur[1], to);
    } else {
      total += cur[1] - cur[0];
      cur = [from, to];
    }
  }
  if (cur) total += cur[1] - cur[0];
  return total;
}
