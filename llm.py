"""
Real LLM Integration for ProPlan Agent OS.

Provides Anthropic (Claude) adapters for Planners and Agents that adhere to the
orchestrator's LLMProvider protocol.
"""

import json
import logging
from typing import Dict, Any, Optional

try:
    from anthropic import Anthropic
except ImportError:
    Anthropic = None


class AnthropicPlannerProvider:
    """Anthropic Claude adapter for the ProPlan LLMPlanner."""

    def __init__(self, api_key: str, model: str = "claude-sonnet-4-20250514"):
        if not Anthropic:
            raise ImportError(
                "Please install 'anthropic' to use Anthropic providers.")
        self.client = Anthropic(api_key=api_key)
        self.model = model
        self.system_prompt = (
            "You are the ProPlan Master Planner. Break the user's request into a sequential plan. "
            "You must return a JSON object containing exactly one key: 'plan'. "
            "The value of 'plan' must be a list of task objects. "
            "Each task object must have: \n"
            "  1. 'agent' (must be one of: 'sales', 'marketing', 'support', 'ops')\n"
            "  2. 'action' (always use the string 'execute')\n"
            "  3. 'payload' (a dictionary of input arguments tailored for the chosen agent)\n\n"
            "Example: {\"plan\": [{\"agent\": \"sales\", \"action\": \"execute\", \"payload\": {\"query\": \"NYC restaurants\"}}]}\n\n"
            "You must respond ONLY with valid JSON. No extra text."
        )

    def complete(self, prompt: str, context: Optional[Dict[str, Any]] = None) -> str:
        """Call Anthropic Claude and unpack the nested JSON 'plan' list so the orchestrator can parse it directly."""
        messages = []

        system = self.system_prompt
        if context:
            system += f"\n\nRun Context: {json.dumps(context)}"

        messages.append(
            {"role": "user", "content": f"Generate a plan for this request: {prompt}"})

        logging.info(f"Anthropic Planner | Calling {self.model}...")
        response = self.client.messages.create(
            model=self.model,
            max_tokens=1024,
            system=system,
            messages=messages,
        )

        raw = response.content[0].text
        try:
            data = json.loads(raw)
            # The orchestrator's LLMPlanner expects a JSON array string directly `[{}, {}]`
            plan_list = data.get("plan", [])
            return json.dumps(plan_list)
        except json.JSONDecodeError:
            logging.error("Failed to parse Anthropic Planner JSON response.")
            return "[]"


class AnthropicAgentProvider:
    """Anthropic Claude adapter for ProPlan specialized Agents."""

    def __init__(self, api_key: str, agent_name: str, available_tools: str, model: str = "claude-sonnet-4-20250514"):
        if not Anthropic:
            raise ImportError(
                "Please install 'anthropic' to use Anthropic providers.")
        self.client = Anthropic(api_key=api_key)
        self.model = model
        self.system_prompt = (
            f"You are the {agent_name} agent for ProPlan OS. "
            f"You must accomplish the given task by choosing ONE of the following tools: {available_tools}. "
            "You must respond ONLY with a JSON object. "
            "It must contain exactly two keys: 'tool' (the string name of the tool) and 'payload' (a dictionary of arguments). "
            "Example: {\"tool\": \"search_knowledge_base\", \"payload\": {\"query\": \"refund policy\"}}"
        )

    def complete(self, prompt: str, context: Optional[Dict[str, Any]] = None) -> str:
        """Call Anthropic Claude to get a decision on which tool to use and what arguments to pass."""
        system = self.system_prompt
        if context:
            system += f"\n\nMemory context (past outcomes): {json.dumps(context)}"

        messages = [{"role": "user", "content": prompt}]

        logging.info("Anthropic Agent | Calling %s...", self.model)

        response = self.client.messages.create(
            model=self.model,
            max_tokens=1024,
            system=system,
            messages=messages,
        )

        # Agents directly expect `{"tool": "x", "payload": {}}` encoded as a JSON string
        return response.content[0].text
