"""
API-level tests for the ProPlan FastAPI layer.

Uses FastAPI's TestClient for synchronous, no-server-needed testing.
"""

import unittest
import os
os.environ.pop("ANTHROPIC_API_KEY", None)

from fastapi.testclient import TestClient
from api import app, db


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

    def test_agent_run_success(self):
        """POST /agent/run should return a completed run with cost info."""
        res = self.client.post("/agent/run", json={
            "user_id": "user-1",
            "request": "Find leads and generate marketing copy"
        })
        self.assertEqual(res.status_code, 200)

        data = res.json()
        self.assertEqual(data["status"], "goal_met")
        self.assertEqual(data["user_id"], "user-1")
        self.assertGreater(data["total_cost"], 0)
        self.assertIsInstance(data["memory"], list)
        self.assertGreater(len(data["memory"]), 0)

    def test_agent_run_stores_leads(self):
        """POST /agent/run should auto-store discovered leads."""
        self.client.post("/agent/run", json={
            "user_id": "user-1",
            "request": "Find leads"
        })
        self.assertGreater(len(db.leads), 0)

    def test_agent_run_missing_fields(self):
        """POST /agent/run with missing fields should return 422."""
        res = self.client.post("/agent/run", json={})
        self.assertEqual(res.status_code, 422)

        res2 = self.client.post("/agent/run", json={"user_id": "u1"})
        self.assertEqual(res2.status_code, 422)


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
        self.client.post("/agent/run", json={
            "user_id": "user-1",
            "request": "Find leads"
        })
        res = self.client.get("/leads")
        self.assertEqual(res.status_code, 200)
        self.assertGreater(len(res.json()), 0)

    def test_leads_min_score_filter(self):
        """GET /leads?min_score=X should filter leads below the threshold."""
        # Run agent to generate leads (Lead A has score 90)
        self.client.post("/agent/run", json={
            "user_id": "user-1",
            "request": "Find leads"
        })

        # Score 90 should be included with min_score=80
        res_high = self.client.get("/leads?min_score=80")
        self.assertGreater(len(res_high.json()), 0)

        # Score 90 should be excluded with min_score=95
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
