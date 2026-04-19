"""
API-level tests for the ProPlan FastAPI layer.

Uses FastAPI's TestClient for synchronous, no-server-needed testing.
"""

import unittest
import os
# Force the in-memory backend + mock LLMs before api/db modules import.
# Without popping the Supabase vars, get_database() returns SupabaseDatabase
# and setUp()'s db.leads.clear() raises AttributeError — the entire suite
# becomes non-runnable on any machine with Supabase creds configured.
os.environ.pop("ANTHROPIC_API_KEY", None)
os.environ.pop("SUPABASE_URL", None)
os.environ.pop("SUPABASE_KEY", None)

from fastapi.testclient import TestClient
from api import app, db
from database import LeadModel


class TestHealth(unittest.TestCase):

    def setUp(self):
        self.client = TestClient(app)

    def test_health_returns_200(self):
        """Health endpoint should return 200 with status 'healthy'."""
        res = self.client.get("/health")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["status"], "healthy")
        self.assertIn("timestamp", res.json())


class TestAgentRun(unittest.TestCase):

    def setUp(self):
        self.client = TestClient(app)
        db.leads.clear()
        db.campaigns.clear()
        db.sessions.clear()

    def _run_and_poll(self, payload: dict) -> dict:
        """Dispatch a run and poll until completed or failed. Returns the result dict."""
        dispatch = self.client.post("/agent/run", json=payload)
        self.assertEqual(dispatch.status_code, 200)
        dispatch_data = dispatch.json()
        self.assertEqual(dispatch_data["status"], "running")
        run_id = dispatch_data["run_id"]

        # Background tasks run synchronously in TestClient, so the first poll should resolve.
        for _ in range(10):
            poll = self.client.get(f"/agent/run/status/{run_id}")
            self.assertEqual(poll.status_code, 200)
            data = poll.json()
            if data["status"] in ("completed", "failed"):
                return data
        self.fail("Run did not complete within poll limit")

    def test_agent_run_success(self):
        """POST /agent/run should dispatch and eventually return a completed run with cost info."""
        data = self._run_and_poll({
            "user_id": "user-1",
            "request": "Find leads and generate marketing copy",
        })
        self.assertEqual(data["status"], "completed")
        result = data["result"]
        self.assertEqual(result["status"], "goal_met")
        self.assertEqual(result["user_id"], "user-1")
        self.assertGreater(result["total_cost"], 0)
        self.assertIsInstance(result["memory"], list)
        self.assertGreater(len(result["memory"]), 0)

    def test_agent_run_stores_leads(self):
        """POST /agent/run should auto-store discovered leads after background task completes."""
        self._run_and_poll({
            "user_id": "user-1",
            "request": "Find leads",
        })
        self.assertGreater(len(db.leads), 0)

    def test_agent_run_missing_fields(self):
        """POST /agent/run with missing fields should return 422."""
        res = self.client.post("/agent/run", json={})
        self.assertEqual(res.status_code, 422)

        res2 = self.client.post("/agent/run", json={"user_id": "u1"})
        self.assertEqual(res2.status_code, 422)


def _run_and_wait(client, payload: dict) -> None:
    """Dispatch an agent run and poll until it resolves (helper for all test classes)."""
    dispatch = client.post("/agent/run", json=payload)
    run_id = dispatch.json()["run_id"]
    for _ in range(10):
        data = client.get(f"/agent/run/status/{run_id}").json()
        if data["status"] in ("completed", "failed"):
            return
    raise AssertionError("Run did not complete within poll limit")


class TestLeads(unittest.TestCase):

    def setUp(self):
        self.client = TestClient(app)
        db.leads.clear()
        db.campaigns.clear()
        db.sessions.clear()

    def test_list_leads_empty(self):
        """GET /leads should return empty list when no leads exist."""
        res = self.client.get("/leads")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json(), [])

    def test_list_leads_after_run(self):
        """GET /leads should return leads discovered by agent runs."""
        _run_and_wait(self.client, {"user_id": "user-1", "request": "Find leads"})
        res = self.client.get("/leads")
        self.assertEqual(res.status_code, 200)
        self.assertGreater(len(res.json()), 0)

    def test_leads_min_score_filter(self):
        """GET /leads?min_score=X should filter leads below the threshold."""
        # Seed leads directly to avoid coupling to fallback data shape
        db.create_lead(LeadModel(full_name="High Scorer", icp_score=90.0, source="test"))
        db.create_lead(LeadModel(full_name="Low Scorer", icp_score=30.0, source="test"))

        # Score 90 should be included with min_score=80
        res_high = self.client.get("/leads?min_score=80")
        self.assertEqual(len(res_high.json()), 1)
        self.assertEqual(res_high.json()[0]["full_name"], "High Scorer")

        # Neither should pass min_score=95
        res_too_high = self.client.get("/leads?min_score=95")
        self.assertEqual(len(res_too_high.json()), 0)


class TestCampaigns(unittest.TestCase):

    def setUp(self):
        self.client = TestClient(app)
        db.leads.clear()
        db.campaigns.clear()
        db.sessions.clear()

    def test_create_campaign(self):
        """POST /campaigns should create and return a campaign."""
        res = self.client.post("/campaigns", json={
            "name": "Spring Sale",
            "status": "active"
        })
        self.assertEqual(res.status_code, 201)

        data = res.json()
        self.assertEqual(data["name"], "Spring Sale")
        self.assertEqual(data["status"], "active")
        self.assertIn("id", data)

    def test_create_campaign_default_status(self):
        """POST /campaigns without status should default to 'draft'."""
        res = self.client.post("/campaigns", json={"name": "Summer Push"})
        self.assertEqual(res.status_code, 201)
        self.assertEqual(res.json()["status"], "draft")

    def test_list_campaigns(self):
        """GET /campaigns should return all created campaigns."""
        self.client.post("/campaigns", json={"name": "Campaign A"})
        self.client.post("/campaigns", json={"name": "Campaign B"})

        res = self.client.get("/campaigns")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(len(res.json()), 2)

    def test_list_campaigns_empty(self):
        """GET /campaigns should return empty list when none exist."""
        res = self.client.get("/campaigns")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json(), [])


if __name__ == "__main__":
    unittest.main()
