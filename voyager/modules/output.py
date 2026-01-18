from openai import AsyncOpenAI

class OutputModule:
    def __init__(self, name="agent", model="gpt-4o-mini"):
        self.name = name
        self.history = []
        self.model = model
        self.llm = AsyncOpenAI()

    def chat(self, message, bot=None, prefix=True):
        full_message = f"[{self.name}] {message}" if prefix else message
        self.history.append(full_message)
        if bot:
            bot.chat(full_message)
        print(full_message)

    def describe_goal(self, goal):
        self.chat(f"My current goal is: {goal}")

    def describe_decision(self, decision):
        self.chat(f"My plan is to: {decision}")

    def report_observation(self, summary):
        self.chat(f"I observed: {summary}")

    def announce_success(self, task):
        self.chat(f"✅ Successfully completed: {task}")

    def announce_failure(self, task):
        self.chat(f"❌ Failed to complete: {task}")

    async def why_failed(self, task, last_chatlog, bot=None):
        messages = [
            {"role": "system", "content": "You are a helpful assistant that explains why a Minecraft agent failed to complete a task."},
            {"role": "user", "content": f"The task was: {task}
Here's the final log:
{last_chatlog}

Why did I fail?"}
        ]
        try:
            result = await self.llm.chat.completions.create(
                model=self.model,
                messages=messages,
                temperature=0.7
            )
            explanation = result.choices[0].message.content.strip()
        except Exception as e:
            explanation = f"(LLM Error): {e}"

        self.chat("Analysis of failure: " + explanation, bot)
        return explanation

    def reset(self):
        self.history.clear()
