"""
Trigger scheduler — fires cron-driven recurring missions.

Runs as a background thread started during FastAPI startup. Every tick
(60s) the loop loads due triggers and dispatches each via the provided
fire callback. The callback is supplied by api.py so this module stays
decoupled from request/orchestration plumbing.
"""

import logging
import threading
import time
from datetime import datetime, timezone
from typing import Callable, Optional

from croniter import croniter

from database import DatabaseProvider, TriggerModel


def compute_next_run(schedule_cron: str, base: Optional[datetime] = None) -> str:
    """Return the next ISO timestamp that matches the cron expression."""
    base = base or datetime.now(timezone.utc)
    itr = croniter(schedule_cron, base)
    return itr.get_next(datetime).astimezone(timezone.utc).isoformat()


def validate_cron(schedule_cron: str) -> None:
    """Raise ValueError if the cron expression is malformed."""
    if not croniter.is_valid(schedule_cron):
        raise ValueError(f"Invalid cron expression: {schedule_cron!r}")


class TriggerScheduler:
    """Background loop that wakes once per tick and fires due triggers."""

    def __init__(
        self,
        db: DatabaseProvider,
        fire: Callable[[TriggerModel], None],
        tick_seconds: int = 60,
    ):
        self.db = db
        self.fire = fire
        self.tick_seconds = tick_seconds
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="trigger-scheduler", daemon=True)
        self._thread.start()
        logging.info("TriggerScheduler started (tick=%ss)", self.tick_seconds)

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)
        logging.info("TriggerScheduler stopped")

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self._tick()
            except Exception as e:
                logging.error("TriggerScheduler tick failed: %s", e, exc_info=True)
            self._stop.wait(self.tick_seconds)

    def _tick(self) -> None:
        now_iso = datetime.now(timezone.utc).isoformat()
        due = self.db.get_due_triggers(now_iso)
        for trigger in due:
            try:
                self.fire(trigger)
            except Exception as e:
                logging.error("Trigger fire failed (id=%s): %s", trigger.id, e, exc_info=True)
