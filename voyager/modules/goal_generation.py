import openai


class GoalGenerationModule:
    def __init__(self, model="gpt-4o-mini"):
        self.model = model

    async def generate_goal(self, memory_summary: str) -> str:
        prompt = (
            f"You are an autonomous Minecraft agent.\n"
            f"Based on the following memory summary, generate one actionable goal in a single sentence.\n\n"
            f"Memory Summary: {memory_summary}\n\n"
            f"Output only the goal."
        )

        response = await openai.ChatCompletion.acreate(
            model=self.model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.7,
        )
        return response.choices[0].message.content.strip()
