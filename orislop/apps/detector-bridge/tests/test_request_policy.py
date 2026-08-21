from __future__ import annotations

from pathlib import Path
import sys
import unittest
from unittest import mock


BRIDGE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BRIDGE_ROOT))

from request_policy import LayeredRateLimiter, MinuteRateLimiter


class RequestPolicyTests(unittest.TestCase):
    def test_compatibility_minute_limiter_is_per_identity(self) -> None:
        limiter = MinuteRateLimiter(2)
        self.assertTrue(limiter.allow("extension-a"))
        self.assertTrue(limiter.allow("extension-a"))
        self.assertFalse(limiter.allow("extension-a"))
        self.assertTrue(limiter.allow("extension-b"))

    def test_burst_and_sustained_windows_are_both_enforced(self) -> None:
        clock = iter([0, 0, 0, 11, 11])
        with mock.patch("request_policy.time.monotonic", side_effect=lambda: next(clock)):
            limiter = LayeredRateLimiter(burst_limit=2, burst_seconds=10, sustained_limit=3, sustained_seconds=60)
            self.assertTrue(limiter.check("extension")["allowed"])
            self.assertTrue(limiter.check("extension")["allowed"])
            burst = limiter.check("extension")
            self.assertFalse(burst["allowed"])
            self.assertGreaterEqual(burst["retry_after"], 1)
            self.assertTrue(limiter.check("extension")["allowed"])
            sustained = limiter.check("extension")
            self.assertFalse(sustained["allowed"])

    def test_cost_is_bounded_and_reported(self) -> None:
        limiter = LayeredRateLimiter(burst_limit=5, burst_seconds=10, sustained_limit=10)
        accepted = limiter.check("extension", cost=4)
        rejected = limiter.check("extension", cost=2)
        self.assertTrue(accepted["allowed"])
        self.assertEqual(accepted["remaining"], 1)
        self.assertFalse(rejected["allowed"])


if __name__ == "__main__":
    unittest.main()
