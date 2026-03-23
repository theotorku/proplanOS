"""
Unit tests for ProPlan Agent Orchestrator v2.0

Covers the 4 critical fixes:
- Fix 1: Evaluator batch-based evaluation
- Fix 2: Iterative retry loop
- Fix 3: LLMProvider injection
- Fix 4: SecurityLayer enforcement
"""

import unittest
import json
from proplanOrchestrator import (
    Logger, CostTracker, Tool, ToolRegistry, Task, TaskResult,
    Goal, Evaluator, ExecutionMemory,
    LLMProvider, MockAgentLLM, MockPlannerLLM,
    SecurityPolicy, SecurityLayer,
    BaseAgent, SalesAgent, MarketingAgent, SupportAgent, OpsAgent,
    AgentRegistry, LLMPlanner, Orchestrator,
    find_leads_tool, generate_copy_tool, search_knowledge_base, schedule_task, run_workflow,
    FindLeadsSchema, GenerateCopySchema, SearchKnowledgeBaseSchema, ScheduleTaskSchema, RunWorkflowSchema
)


# ========================================
# Fix 1: Evaluator Tests
# ========================================

class TestEvaluator(unittest.TestCase):

    def setUp(self):
        self.evaluator = Evaluator()

    def test_all_success_complete(self):
        """Evaluator returns 'complete' when ALL batch results succeed (all_success mode)."""
        goal = Goal(description="test", success_criteria="all_success")
        batch = [
            TaskResult("t1", True, data="ok"),
            TaskResult("t2", True, data="ok"),
        ]
        self.assertEqual(self.evaluator.evaluate(goal, batch), "complete")

    def test_all_success_partial_failure(self):
        """Evaluator returns 'continue' when one result fails (all_success mode)."""
        goal = Goal(description="test", success_criteria="all_success")
        batch = [
            TaskResult("t1", True, data="ok"),
            TaskResult("t2", False, error="fail"),
        ]
        self.assertEqual(self.evaluator.evaluate(goal, batch), "continue")

    def test_any_success_complete(self):
        """Evaluator returns 'complete' when at least one succeeds (any_success mode)."""
        goal = Goal(description="test", success_criteria="any_success")
        batch = [
            TaskResult("t1", False, error="fail"),
            TaskResult("t2", True, data="ok"),
        ]
        self.assertEqual(self.evaluator.evaluate(goal, batch), "complete")

    def test_no_success_continue(self):
        """Evaluator returns 'continue' when nothing succeeds."""
        goal = Goal(description="test", success_criteria="any_success")
        batch = [
            TaskResult("t1", False, error="fail"),
            TaskResult("t2", False, error="fail"),
        ]
        self.assertEqual(self.evaluator.evaluate(goal, batch), "continue")

    def test_empty_batch_continue(self):
        """Evaluator returns 'continue' when the batch is empty."""
        goal = Goal(description="test", success_criteria="all_success")
        self.assertEqual(self.evaluator.evaluate(goal, []), "continue")


# ========================================
# Fix 2: Retry Loop Tests
# ========================================

class TestRetryLoop(unittest.TestCase):

    def test_retry_records_once(self):
        """A failing task with retries should only produce ONE memory entry."""
        orchestrator = Orchestrator()
        orchestrator.register_tool(Tool("find_leads_tool", FindLeadsSchema, find_leads_tool))

        # Create an agent that always fails
        class FailingLLM:
            def complete(self, prompt, context=None):
                return json.dumps({"tool": "nonexistent", "payload": {}})

        orchestrator.register_agent(SalesAgent, llm_provider=FailingLLM())

        task = Task(id="retry-test", agent="sales", action="execute",
                    payload={"query": "test"}, max_retries=2)
        result = orchestrator.execute_task(task)

        # Should have exactly 1 entry in memory despite 3 attempts
        self.assertEqual(len(orchestrator.memory.history), 1)
        self.assertFalse(result.success)

    def test_retry_succeeds_on_second_attempt(self):
        """A task that fails once then succeeds should be recorded as success."""
        orchestrator = Orchestrator()
        orchestrator.register_tool(Tool("find_leads_tool", FindLeadsSchema, find_leads_tool))

        # LLM that fails first, then succeeds
        class FlakeyLLM:
            def __init__(self):
                self.call_count = 0

            def complete(self, prompt, context=None):
                self.call_count += 1
                if self.call_count == 1:
                    return json.dumps({"tool": "nonexistent", "payload": {}})
                return json.dumps({"tool": "find_leads_tool", "payload": {"query": "test"}})

        orchestrator.register_agent(SalesAgent, llm_provider=FlakeyLLM())

        task = Task(id="flakey-test", agent="sales", action="execute",
                    payload={"query": "test"}, max_retries=2)
        result = orchestrator.execute_task(task)

        self.assertEqual(len(orchestrator.memory.history), 1)
        self.assertTrue(result.success)


# ========================================
# Fix 3: LLMProvider Injection Tests
# ========================================

class TestLLMProviderInjection(unittest.TestCase):

    def test_custom_llm_changes_behavior(self):
        """Swapping the LLM provider should change the agent's tool choice."""
        orchestrator = Orchestrator()
        orchestrator.register_tool(Tool("find_leads_tool", FindLeadsSchema, find_leads_tool))
        orchestrator.register_tool(Tool("generate_copy_tool", GenerateCopySchema, generate_copy_tool))

        # Custom LLM that picks generate_copy_tool
        custom_llm = MockAgentLLM("generate_copy_tool", {"input": "custom"})
        orchestrator.register_agent(SalesAgent, llm_provider=custom_llm)

        task = Task(id="llm-test", agent="sales", action="execute", payload={"query": "test"})
        result = orchestrator.execute_task(task)

        self.assertTrue(result.success)
        # generate_copy_tool returns a string (LLM-generated or fallback)
        self.assertIsInstance(result.data, str)
        self.assertGreater(len(result.data), 0)

    def test_marketing_agent_uses_correct_default_tool(self):
        """MarketingAgent should default to generate_copy_tool, not find_leads_tool."""
        orchestrator = Orchestrator()
        orchestrator.register_tool(Tool("find_leads_tool", FindLeadsSchema, find_leads_tool))
        orchestrator.register_tool(Tool("generate_copy_tool", GenerateCopySchema, generate_copy_tool))

        orchestrator.register_agent(MarketingAgent)

        task = Task(id="mkt-test", agent="marketing", action="execute", payload={"input": "test"})
        result = orchestrator.execute_task(task)

        self.assertTrue(result.success)
        # generate_copy_tool returns a string (LLM-generated or fallback)
        self.assertIsInstance(result.data, str)
        self.assertGreater(len(result.data), 0)


# ========================================
# Fix 4: Security Layer Tests
# ========================================

class TestSecurityLayer(unittest.TestCase):

    def test_blocks_unauthorized_tool(self):
        """Security should block an agent from using a non-permitted tool."""
        policy = SecurityPolicy(
            allowed_tools={"sales": ["find_leads_tool"]},  # only find_leads_tool
            rate_limits={},
            budget_limit=10.0
        )
        orchestrator = Orchestrator(security_policy=policy)
        orchestrator.register_tool(Tool("find_leads_tool", FindLeadsSchema, find_leads_tool))
        orchestrator.register_tool(Tool("generate_copy_tool", GenerateCopySchema, generate_copy_tool))

        # Sales agent trying to use generate_copy_tool
        custom_llm = MockAgentLLM("generate_copy_tool", {"input": "test"})
        orchestrator.register_agent(SalesAgent, llm_provider=custom_llm)

        task = Task(id="sec-test", agent="sales", action="execute", payload={})
        result = orchestrator.execute_task(task)

        self.assertFalse(result.success)
        self.assertIn("Security blocked", result.error)

    def test_rate_limit_enforced(self):
        """Execution should be blocked after exceeding the rate limit."""
        policy = SecurityPolicy(
            allowed_tools={},
            rate_limits={"sales": 1},  # only 1 call allowed
            budget_limit=10.0
        )
        orchestrator = Orchestrator(security_policy=policy)
        orchestrator.register_tool(Tool("find_leads_tool", FindLeadsSchema, find_leads_tool))
        orchestrator.register_agent(SalesAgent)

        # First call — should succeed
        task1 = Task(id="rate-1", agent="sales", action="execute", payload={"query": "test"})
        result1 = orchestrator.execute_task(task1)
        self.assertTrue(result1.success)

        # Second call — should be blocked
        task2 = Task(id="rate-2", agent="sales", action="execute", payload={"query": "test"})
        result2 = orchestrator.execute_task(task2)
        self.assertFalse(result2.success)
        self.assertIn("Rate limit", result2.error)

    def test_budget_limit_enforced(self):
        """Execution should be blocked when the budget is exceeded."""
        policy = SecurityPolicy(
            allowed_tools={},
            rate_limits={},
            budget_limit=0.01  # very low budget
        )
        orchestrator = Orchestrator(security_policy=policy)
        orchestrator.register_tool(Tool("find_leads_tool", FindLeadsSchema, find_leads_tool, cost_estimate=0.02))
        orchestrator.register_agent(SalesAgent)

        # First call succeeds (budget checked before execution)
        task1 = Task(id="bud-1", agent="sales", action="execute", payload={"query": "test"})
        result1 = orchestrator.execute_task(task1)
        self.assertTrue(result1.success)

        # Second call — budget exceeded
        task2 = Task(id="bud-2", agent="sales", action="execute", payload={"query": "test"})
        result2 = orchestrator.execute_task(task2)
        self.assertFalse(result2.success)
        self.assertIn("Budget exceeded", result2.error)


# ========================================
# End-to-End Test
# ========================================

class TestFullRun(unittest.TestCase):

    def test_full_run_completes(self):
        """End-to-end run should complete successfully with all fixes in place."""
        orchestrator = Orchestrator()

        orchestrator.register_tool(Tool("find_leads_tool", FindLeadsSchema, find_leads_tool, cost_estimate=0.02))
        orchestrator.register_tool(Tool("generate_copy_tool", GenerateCopySchema, generate_copy_tool, cost_estimate=0.01))
        orchestrator.register_tool(Tool("search_knowledge_base", SearchKnowledgeBaseSchema, search_knowledge_base, cost_estimate=0.005))
        orchestrator.register_tool(Tool("schedule_task", ScheduleTaskSchema, schedule_task, cost_estimate=0.005))
        orchestrator.register_tool(Tool("run_workflow", RunWorkflowSchema, run_workflow, cost_estimate=0.01))

        orchestrator.register_agent(SalesAgent)
        orchestrator.register_agent(MarketingAgent)
        orchestrator.register_agent(SupportAgent)
        orchestrator.register_agent(OpsAgent)

        response = orchestrator.run("Find leads and generate marketing copy")

        self.assertEqual(response["status"], "goal_met")
        self.assertGreater(response["total_cost"], 0)
        self.assertGreater(len(response["memory"]), 0)

        # Verify both agents ran successfully
        memory = response["memory"]
        agents_that_ran = [entry["task"]["agent"] for entry in memory]
        self.assertIn("sales", agents_that_ran)
        self.assertIn("marketing", agents_that_ran)
        self.assertIn("support", agents_that_ran)
        self.assertIn("ops", agents_that_ran)

        # All results should be successful
        for entry in memory:
            self.assertTrue(entry["result"]["success"], f"Task failed: {entry['result']}")


if __name__ == "__main__":
    unittest.main()
