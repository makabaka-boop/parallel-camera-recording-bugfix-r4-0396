export function recordingCoverage(segments) {
  return segments.reduce(
    (n, s) => n + (s.endedAt === null ? 0 : s.endedAt - s.startedAt),
    0,
  );
}
