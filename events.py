"""
Internal event bus for trigger fan-out.

`emit_event(name, payload, user_id, depth)` looks up enabled triggers matching
that event name, applies their event_filter, and dispatches each via the
fire callback. The depth counter is propagated through the run's input_data
so cascades terminate (a trigger that runs an orchestration that emits the
same event will not loop forever).
"""

import logging
from typing import Any, Callable, Dict, Optional

from database import DatabaseProvider, TriggerModel


MAX_EVENT_DEPTH = 2


def _filter_matches(event_filter: Optional[Dict[str, Any]], payload: Dict[str, Any]) -> bool:
    """
    Apply a simple JSON filter spec against the event payload.

    Supported filter keys:
      - exact match: {"qualification_status": "qualified"}
      - min_<field>: {"min_icp_score": 70}
      - max_<field>: {"max_cost": 0.50}

    Missing fields fail the filter (conservative). An empty/None filter
    always matches.
    """
    if not event_filter:
        return True
    for key, expected in event_filter.items():
        if key.startswith("min_"):
            field = key[4:]
            actual = payload.get(field)
            if actual is None or actual < expected:
                return False
        elif key.startswith("max_"):
            field = key[4:]
            actual = payload.get(field)
            if actual is None or actual > expected:
                return False
        else:
            if payload.get(key) != expected:
                return False
    return True


def emit_event(
    db: DatabaseProvider,
    fire: Callable[[TriggerModel, Dict[str, Any]], None],
    event_type: str,
    payload: Dict[str, Any],
    user_id: Optional[str] = None,
    depth: int = 0,
) -> int:
    """
    Fan an event out to matching triggers. Returns the number fired.

    `fire(trigger, context)` is the dispatcher; context is shaped as
    {"event_type": ..., "payload": ..., "depth": next_depth}.
    """
    if depth >= MAX_EVENT_DEPTH:
        logging.info("Event %s suppressed at depth=%d (max=%d)", event_type, depth, MAX_EVENT_DEPTH)
        return 0

    try:
        triggers = db.list_triggers_by_event(event_type)
    except Exception as e:
        logging.error("emit_event lookup failed for %s: %s", event_type, e)
        return 0

    fired = 0
    for trigger in triggers:
        if user_id is not None and trigger.user_id != user_id:
            continue
        if not _filter_matches(trigger.event_filter, payload):
            continue
        try:
            fire(trigger, {
                "event_type": event_type,
                "payload": payload,
                "depth": depth + 1,
            })
            fired += 1
        except Exception as e:
            logging.error("Event fire failed (trigger=%s, event=%s): %s",
                          trigger.id, event_type, e, exc_info=True)
    return fired
