"""
Tests for the public chat agent endpoints mounted at /agent/chat/*.

These tests run entirely against the in-memory database with mocked
streaming (no ANTHROPIC_API_KEY), so the full suite stays offline.
"""

import os
import unittest

# Force in-memory + mock-LLM mode before api/db modules import.
os.environ.pop("ANTHROPIC_API_KEY", None)
os.environ.pop("SUPABASE_URL", None)
os.environ.pop("SUPABASE_KEY", None)
# Pin chat rate limits low so we can exercise them without writing 30 rows.
os.environ["CHAT_RATE_LIMIT_PER_CONVO"] = "3"
os.environ["CHAT_IP_CONVOS_PER_HOUR"] = "100"

from fastapi.testclient import TestClient  # noqa: E402
from api import app  # noqa: E402
from chat_routes import db as chat_db  # noqa: E402


def _reset_db():
    chat_db.leads.clear()
    chat_db.campaigns.clear()
    chat_db.sessions.clear()
    chat_db.chat_conversations.clear()
    chat_db.chat_messages.clear()


class TestChatStart(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        _reset_db()

    def test_start_returns_conversation_id(self):
        res = self.client.post("/agent/chat/start", json={"origin": "https://example.com"})
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertIn("conversation_id", body)
        self.assertTrue(body["greeting"])
        self.assertEqual(body["rate_limit_per_convo"], 3)
        self.assertIn(body["conversation_id"], chat_db.chat_conversations)

    def test_start_rate_limit_per_ip(self):
        # chat_routes reads the env var at import time, so patch the module
        # constant directly — reloading the module would detach the live app
        # from its currently mounted router and break the other tests.
        import chat_routes
        original = chat_routes.CHAT_IP_CONVOS_PER_HOUR
        chat_routes.CHAT_IP_CONVOS_PER_HOUR = 2
        try:
            for _ in range(2):
                self.assertEqual(self.client.post("/agent/chat/start", json={}).status_code, 200)
            over = self.client.post("/agent/chat/start", json={})
            self.assertEqual(over.status_code, 429)
        finally:
            chat_routes.CHAT_IP_CONVOS_PER_HOUR = original


class TestChatMessage(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        _reset_db()
        self.convo_id = self.client.post("/agent/chat/start", json={}).json()["conversation_id"]

    def _send(self, text: str):
        # TestClient streaming: read full SSE body, assert we got token + done frames.
        with self.client.stream(
            "POST", "/agent/chat/message",
            json={"conversation_id": self.convo_id, "message": text},
        ) as resp:
            self.assertEqual(resp.status_code, 200)
            return "".join(resp.iter_text())

    def test_message_streams_and_persists(self):
        body = self._send("What does ProPlan do?")
        self.assertIn("data:", body)
        self.assertIn("\"done\"", body)
        # Mock reply is persisted — one user + one assistant row.
        msgs = chat_db.get_chat_messages(self.convo_id)
        self.assertEqual(len(msgs), 2)
        self.assertEqual(msgs[0].role, "user")
        self.assertEqual(msgs[1].role, "assistant")

    def test_message_rate_limit_per_convo(self):
        # Limit was pinned to 3 at module load.
        for i in range(3):
            self._send(f"msg {i}")
        res = self.client.post(
            "/agent/chat/message",
            json={"conversation_id": self.convo_id, "message": "overflow"},
        )
        self.assertEqual(res.status_code, 429)

    def test_message_unknown_conversation(self):
        res = self.client.post(
            "/agent/chat/message",
            json={"conversation_id": "00000000-0000-0000-0000-000000000000", "message": "hi"},
        )
        self.assertEqual(res.status_code, 404)


class TestChatCaptureLead(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        _reset_db()
        self.convo_id = self.client.post("/agent/chat/start", json={}).json()["conversation_id"]

    def test_capture_lead_writes_row_with_chat_source(self):
        res = self.client.post("/agent/chat/capture_lead", json={
            "conversation_id": self.convo_id,
            "full_name": "Jane Owner",
            "email": "jane@acme.example.com",
            "company_name": "Acme",
            "notes": "Interested in sales automation.",
        })
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["status"], "captured")
        lead_id = data["lead_id"]

        self.assertIn(lead_id, chat_db.leads)
        lead = chat_db.leads[lead_id]
        self.assertEqual(lead.source, "chat")
        self.assertEqual(lead.source_conversation_id, self.convo_id)

        convo = chat_db.get_chat_conversation(self.convo_id)
        self.assertTrue(convo.lead_captured)

    def test_capture_lead_rejects_bad_email(self):
        res = self.client.post("/agent/chat/capture_lead", json={
            "conversation_id": self.convo_id,
            "full_name": "Bad",
            "email": "not-an-email",
        })
        self.assertEqual(res.status_code, 422)


class TestChatBookCall(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        _reset_db()
        self.convo_id = self.client.post("/agent/chat/start", json={}).json()["conversation_id"]

    def test_book_call_returns_calendly_url(self):
        res = self.client.post("/agent/chat/book_call", json={
            "conversation_id": self.convo_id,
            "full_name": "Pat Buyer",
            "email": "pat@buy.example.com",
        })
        self.assertEqual(res.status_code, 200)
        self.assertIn("calendly.com", res.json()["calendly_url"])
        # Also writes a soft lead so nothing is lost if Calendly flow bails.
        leads = list(chat_db.leads.values())
        self.assertEqual(len(leads), 1)
        self.assertEqual(leads[0].source, "chat")


class TestChatEscalate(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        _reset_db()
        self.convo_id = self.client.post("/agent/chat/start", json={}).json()["conversation_id"]

    def test_escalate_marks_conversation(self):
        res = self.client.post("/agent/chat/escalate", json={
            "conversation_id": self.convo_id,
            "reason": "Needs pricing from a human.",
            "contact": "pat@buy.example.com",
        })
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["status"], "escalated")
        convo = chat_db.get_chat_conversation(self.convo_id)
        self.assertEqual(convo.status, "escalated")


class TestChatHistoryAndEnd(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        _reset_db()
        self.convo_id = self.client.post("/agent/chat/start", json={}).json()["conversation_id"]

    def test_get_conversation_returns_messages(self):
        # Drain at least one message through the mock stream.
        with self.client.stream(
            "POST", "/agent/chat/message",
            json={"conversation_id": self.convo_id, "message": "hi"},
        ) as r:
            list(r.iter_text())

        res = self.client.get(f"/agent/chat/{self.convo_id}")
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertEqual(body["conversation"]["id"], self.convo_id)
        self.assertGreaterEqual(len(body["messages"]), 2)

    def test_end_conversation(self):
        res = self.client.post(f"/agent/chat/{self.convo_id}/end")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["status"], "ended")


if __name__ == "__main__":
    unittest.main()
