/**
 * 会话覆盖时长：按【有素材的实际时间范围】求并集。
 *
 * 双路同时留证时，两路在同一墙钟时间上各自录到一段素材；直接相加会把
 * 重叠拍摄时间算成两段连续延长的会话。这里先按开始时间排序合并重叠/相邻
 * 区间，再累加，得到真实的覆盖时长。
 *
 * 已释放（file=null / released）的素材不再实际持有，交付清单不把它计入覆盖；
 * 仍在录制（endedAt===null）的段没有确定的终点，也不计入。
 */
export function recordingCoverage(segments) {
  const ranges = segments
    .filter(
      (s) =>
        s.endedAt !== null &&
        s.endedAt !== undefined &&
        !s.released &&
        s.endedAt > s.startedAt
    )
    .map((s) => [s.startedAt, s.endedAt])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  let total = 0;
  let cur = null;
  for (const [from, to] of ranges) {
    if (!cur) {
      cur = [from, to];
    } else if (from <= cur[1]) {
      // 重叠或首尾相接：合并（重叠时间只算一次）
      if (to > cur[1]) cur[1] = to;
    } else {
      total += cur[1] - cur[0];
      cur = [from, to];
    }
  }
  if (cur) total += cur[1] - cur[0];
  return total;
}
