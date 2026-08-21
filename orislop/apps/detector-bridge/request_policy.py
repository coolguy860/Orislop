from __future__ import annotations

import threading
import time


class LayeredRateLimiter:
    """Bounded per-identity burst and sustained fixed-window limiter."""

    def __init__(self, burst_limit: int, burst_seconds: int, sustained_limit: int, sustained_seconds: int = 60) -> None:
        self.burst_limit = max(1, burst_limit)
        self.burst_seconds = max(1, burst_seconds)
        self.sustained_limit = max(1, sustained_limit)
        self.sustained_seconds = max(self.burst_seconds, sustained_seconds)
        self.buckets: dict[str, dict[str, float | int]] = {}
        self.lock = threading.Lock()

    def check(self, key: str, cost: int = 1) -> dict[str, int | bool]:
        now = time.monotonic()
        cost = max(1, min(100, int(cost)))
        with self.lock:
            bucket = self.buckets.get(key, {
                "burst_started": now, "burst_count": 0,
                "sustained_started": now, "sustained_count": 0,
                "seen_at": now,
            })
            if now - float(bucket["burst_started"]) >= self.burst_seconds:
                bucket["burst_started"], bucket["burst_count"] = now, 0
            if now - float(bucket["sustained_started"]) >= self.sustained_seconds:
                bucket["sustained_started"], bucket["sustained_count"] = now, 0
            burst_remaining = self.burst_limit - int(bucket["burst_count"])
            sustained_remaining = self.sustained_limit - int(bucket["sustained_count"])
            allowed = cost <= burst_remaining and cost <= sustained_remaining
            retry_after = 0
            if not allowed:
                waits = []
                if cost > burst_remaining:
                    waits.append(self.burst_seconds - (now - float(bucket["burst_started"])))
                if cost > sustained_remaining:
                    waits.append(self.sustained_seconds - (now - float(bucket["sustained_started"])))
                retry_after = max(1, int(max(waits, default=1) + 0.999))
            else:
                bucket["burst_count"] = int(bucket["burst_count"]) + cost
                bucket["sustained_count"] = int(bucket["sustained_count"]) + cost
            bucket["seen_at"] = now
            self.buckets[key] = bucket
            if len(self.buckets) > 5000:
                self.buckets = {
                    bucket_key: value
                    for bucket_key, value in self.buckets.items()
                    if now - float(value["seen_at"]) < self.sustained_seconds * 2
                }
            return {
                "allowed": allowed,
                "retry_after": retry_after,
                "remaining": max(0, min(
                    self.burst_limit - int(bucket["burst_count"]),
                    self.sustained_limit - int(bucket["sustained_count"]),
                )),
            }

    def allow(self, key: str, cost: int = 1) -> bool:
        return bool(self.check(key, cost)["allowed"])


class MinuteRateLimiter(LayeredRateLimiter):
    """Compatibility wrapper retained for existing local integrations."""

    def __init__(self, limit: int) -> None:
        super().__init__(limit, 60, limit, 60)
