"""
Real LLM Integration for ProPlan Agent OS.

Provides Anthropic (Claude) adapters for Planners and Agents that adhere to the
orchestrator's LLMProvider protocol.
"""

import json
import logging
import re
from typing import Dict, Any, Optional

_CODE_FENCE_RE = re.compile(r"^```(?:json)?\s*\n?(.*?)\n?```\s*$", re.DOTALL)


def _strip_code_fence(text: str) -> str:
    """Remove surrounding markdown code fences if present."""
    m = _CODE_FENCE_RE.match(text.strip())
    return m.group(1).strip() if m else text.strip()

try:
    from anthropic import Anthropic
except ImportError:
    Anthropic = None


class AnthropicPlannerProvider:
    """Anthropic Claude adapter for the ProPlan LLMPlanner."""

    def __init__(self, api_key: str, model: str = "claude-sonnet-4-6"):
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

        logging.info("Anthropic Planner | Calling %s...", self.model)
        response = self.client.messages.create(
            model=self.model,
            max_tokens=4096,
            system=system,
            messages=messages,
        )

        raw = _strip_code_fence(response.content[0].text)
        try:
            data = json.loads(raw)
            # The orchestrator's LLMPlanner expects a JSON array string directly `[{}, {}]`
            plan_list = data.get("plan", [])
            return json.dumps(plan_list)
        except json.JSONDecodeError:
            logging.error("Failed to parse Anthropic Planner JSON response.")
            return "[]"


# Concrete payload examples for every tool the orchestrator registers. The
# agent system prompt only embeds the examples for the tools that agent
# actually owns — Claude was hallucinating field names (e.g. {"copy": "..."}
# for generate_copy_tool) when given only a generic search example.
TOOL_PAYLOAD_EXAMPLES: Dict[str, str] = {
    "find_leads_tool":          '{"query": "B2B SaaS founders in NYC", "count": 5}',
    "generate_copy_tool":       '{"input": "Cold outreach to a VP of Sales at a Series A SaaS company", "type": "email"}',
    "search_knowledge_base":    '{"query": "refund policy"}',
    "schedule_task":            '{"task_name": "Follow up with lead #123", "due_date": "2026-04-25"}',
    "run_workflow":             '{"workflow_name": "weekly_outreach", "steps": ["enrich", "send", "log"]}',
    "create_onboarding_record": '{"customer_name": "Austin HVAC Pros", "industry": "HVAC", "location": "Austin, TX", "primary_contact": "Mike Reynolds", "plan": "founding"}',
}


def _build_tool_examples(available_tools: str) -> str:
    """Render a per-tool example list for the agent prompt."""
    names = [t.strip() for t in available_tools.split(",") if t.strip()]
    lines = []
    for name in names:
        example = TOOL_PAYLOAD_EXAMPLES.get(name)
        if example:
            lines.append(f'  - {name}: {{"tool": "{name}", "payload": {example}}}')
    return "\n".join(lines) if lines else ""


class AnthropicAgentProvider:
    """Anthropic Claude adapter for ProPlan specialized Agents."""

    def __init__(self, api_key: str, agent_name: str, available_tools: str, model: str = "claude-sonnet-4-6"):
        if not Anthropic:
            raise ImportError(
                "Please install 'anthropic' to use Anthropic providers.")
        self.client = Anthropic(api_key=api_key)
        self.model = model
        examples = _build_tool_examples(available_tools)
        self.system_prompt = (
            f"You are the {agent_name} agent for ProPlan OS. "
            f"You must accomplish the given task by choosing ONE of the following tools: {available_tools}. "
            "You must respond ONLY with a JSON object. "
            "It must contain exactly two keys: 'tool' (the string name of the tool) and 'payload' (a dictionary of arguments). "
            "Use ONLY the field names shown in the example below — do not invent or rename keys.\n"
            f"Examples for your tools:\n{examples}"
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
