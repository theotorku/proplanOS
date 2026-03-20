"""
Async task queuing via Celery for ProPlan Agent OS.

This module sets up the Celery app and contains the background worker tasks 
that interact with the ProPlan Orchestrator, allowing the API to return 
immediate responses.
"""
import os
import json
import logging
import uuid
import time
from typing import Dict, Any

try:
    from celery import Celery
except ImportError:
    Celery = None

# Configure the Celery application using Redis.
# Default to localhost if no ENV variables are passed.
REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

# If Celery is not installed, provide a mock object to prevent crash
if Celery:
    celery_app = Celery(
        "proplan_tasks",
        broker=REDIS_URL,
        backend=REDIS_URL
    )

    celery_app.conf.update(
        task_serializer='json',
        accept_content=['json'],
        result_serializer='json',
        timezone='UTC',
        enable_utc=True,
    )
    task_decorator = celery_app.task
else:
    logging.warning("Celery is not installed. Background queuing is disabled.")
    celery_app = None

    def task_decorator(*args, **kwargs):
        def wrapper(func):
            return func
        return wrapper


@task_decorator(bind=True, name="run_orchestrator")
def run_orchestrator(self, request: str, user_id: str) -> Dict[str, Any]:
    """
    Run the full ProPlan Agent Orchestrator sequence as a background job.

    Args:
        request: The natural language request that starts the orchestrator.
        user_id: The ID of the user requesting the run.

    Returns:
        A dictionary containing status, cost, and memory.
    """
    # Import locally to avoid circular dependencies during worker boot
    from api import create_orchestrator
    from database import get_database, RunLogModel, extract_leads_from_memory

    # self.request.id is not always present (e.g. during unit tests without a broker)
    task_id = getattr(self.request, "id", None) or str(uuid.uuid4())

    logging.info(
        "Worker %s starting orchestrator payload for user %s", task_id, user_id)
    db = get_database()
    orchestrator = create_orchestrator()

    # The Orchestrator loop
    result = orchestrator.run(request)

    # Persist any leads discovered during execution (shared utility — no duplication)
    for lead in extract_leads_from_memory(result.get("memory", [])):
        db.create_lead(lead)

    # Store the log to either Supabase or the In-Memory store
    db.log_run(RunLogModel(
        run_id=result.get("run_id", task_id),
        action="agent_run",
        metadata={
            "user_id": user_id,
            "status": result.get("status", "completed"),
            "total_cost": result.get("total_cost", 0.0),
            "celery_task_id": task_id
        }
    ))

    logging.info("Worker %s finished orchestrator payload.", task_id)
    return result
