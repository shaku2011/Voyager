
from openai import AsyncOpenAI

class CognitiveController:
    def __init__(self, model="gpt-4o-mini", api_key=None, base_url=None):
        self.model = model
        self.client = AsyncOpenAI(api_key=api_key, base_url=base_url)

    async def decide_action(self, goal: str, memory_summary: str) -> str:
        prompt = (
            f"You are the high-level controller of an AI agent in Minecraft.\n"
            f"Given the current goal and memory summary, choose the next high-level action.\n"
            f"Respond in one sentence only.\n\n"
            f"Current Goal: {goal}\n"
            f"Memory Summary: {memory_summary}\n\n"
            f"Suggested Action:"
        )

        response = await self.client.chat.completions.create(
            model=self.model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.5,
        )
        return response.choices[0].message.content.strip()

