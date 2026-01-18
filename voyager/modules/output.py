from openai import AsyncOpenAI

class OutputModule:
    def __init__(self, name="agent", model="gpt-4o-mini"):
        self.name = name
        self.history = []
        self.model = model
        self.llm = AsyncOpenAI()

    async def chat(self, message, bot=None, prefix=True):
        full_message = f"[{self.name}] {message}" if prefix else message
        self.history.append(full_message)
        if bot:
            bot.chat(full_message)
        print(full_message)

    async def describe_goal(self, goal, bot=None):
        await self.chat(f"My current goal is: {goal}", bot)

    async def describe_decision(self, decision, bot=None):
        await self.chat(f"My plan is to: {decision}", bot)

    async def report_observation(self, summary, bot=None):
        await self.chat(f"I observed: {summary}", bot)

    async def announce_success(self, task, bot=None):
        await self.chat(f"✅ Successfully completed: {task}", bot)

    async def announce_failure(self, task, bot=None):
        await self.chat(f"❌ Failed to complete: {task}", bot)

    async def why_failed(self, task, last_chatlog, bot=None):
        messages = [
            {
                "role": "system",
                "content": "You are a helpful assistant that explains why a Minecraft agent failed to complete a task.",
            },
            {
                "role": "user",
                "content": f"The task was: {task}\nHere's the final log:\n{last_chatlog}\n\nWhy did I fail?",
            },
        ]
        try:
            result = await self.llm.chat.completions.create(
                model=self.model,
                messages=messages,
                temperature=0.7,
            )
            explanation = result.choices[0].message.content.strip()
        except Exception as e:
            explanation = f"(LLM Error): {e}"

        await self.chat("Analysis of failure: " + explanation, bot)
        return explanation

    def reset(self):
        self.history.clear()
