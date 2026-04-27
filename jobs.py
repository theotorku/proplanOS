"""
Durable job queue worker.

Replaces in-process threading.Thread for orchestrator dispatch. Workers poll
DatabaseProvider.claim_jobs() at a fixed cadence; the SQL claim_jobs RPC uses
FOR UPDATE SKIP LOCKED so multiple processes can run side-by-side without
double-firing. Stale claims (worker crashed mid-run) are recovered after
stale_seconds.

Register handlers by job kind:
    worker.register("orchestrator_run", handler_fn)

The handler receives (payload: dict). Raise to fail the job — the worker
will retry up to job.max_attempts with linear backoff before marking it
"failed".
"""

import logging
import os
import socket
import threading
from typing import Any, Callable, Dict, Optional

from database import DatabaseProvider, JobModel


JobHandler = Callable[[Dict[str, Any]], None]


class JobWorker:
    """Background thread that drains the jobs queue."""

    def __init__(
        self,
        db: DatabaseProvider,
        tick_seconds: float = 2.0,
        batch_size: int = 5,
        stale_seconds: int = 600,
        backoff_seconds: int = 60,
        worker_id: Optional[str] = None,
    ):
        self.db = db
        self.tick_seconds = tick_seconds
        self.batch_size = batch_size
        self.stale_seconds = stale_seconds
        self.backoff_seconds = backoff_seconds
        self.worker_id = worker_id or f"{socket.gethostname()}-{os.getpid()}"
        self._handlers: Dict[str, JobHandler] = {}
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def register(self, kind: str, handler: JobHandler) -> None:
        self._handlers[kind] = handler

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="job-worker", daemon=True)
        self._thread.start()
        logging.info("JobWorker started (id=%s, tick=%ss)", self.worker_id, self.tick_seconds)

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)
            logging.info("JobWorker stopped (id=%s)", self.worker_id)

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self._tick()
            except Exception as e:
                logging.error("JobWorker tick failed: %s", e, exc_info=True)
            self._stop.wait(self.tick_seconds)

    def _tick(self) -> None:
        try:
            jobs = self.db.claim_jobs(
                worker_id=self.worker_id,
                limit=self.batch_size,
                stale_seconds=self.stale_seconds,
            )
        except Exception as e:
            logging.error("claim_jobs failed: %s", e, exc_info=True)
            return

        for job in jobs:
            self._dispatch(job)

    def _dispatch(self, job: JobModel) -> None:
        handler = self._handlers.get(job.kind)
        if not handler:
            logging.error("No handler for job kind=%s (id=%s)", job.kind, job.id)
            self.db.mark_job_failed(job.id, f"no handler for kind={job.kind}", retry=False)
            return
        try:
            handler(job.payload or {})
            self.db.mark_job_done(job.id)
        except Exception as e:
            logging.error("Job %s (kind=%s) failed: %s", job.id, job.kind, e, exc_info=True)
            self.db.mark_job_failed(
                job.id,
                f"{type(e).__name__}: {e}",
                retry=True,
                backoff_seconds=self.backoff_seconds,
            )
