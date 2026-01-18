from openai import AsyncOpenAI


class TalkingModule:
    def __init__(self, model="gpt-4o-mini", name="agent"):
        self.llm = AsyncOpenAI()
        self.model = model
        self.name = name
        self.chat_history = []

    async def speak(self, prompt, bot=None):
        chat_log = self.chat_history[-3:]  # include recent context
        messages = [
            {
                "role": "system",
                "content": "You are a reflective Minecraft agent who explains your current goal and decision clearly.",
            },
            {"role": "user", "content": prompt},
        ]
        try:
            response = await self.llm.chat.completions.create(
                model=self.model, messages=messages, temperature=0.7
            )
            reply = response.choices[0].message.content.strip()
        except Exception as e:
            reply = f"(LLM Error): {e}"

        self.chat_history.append(reply)
        if bot:
            bot.chat(reply)
        print(f"[{self.name}] {reply}")
        return reply

    async def explain_goal(self, goal, bot=None):
        return await self.speak(f"My current goal is: {goal}", bot)

    async def explain_decision(self, decision, bot=None):
        return await self.speak(f"I have decided to: {decision}", bot)

    def reset(self):
        self.chat_history.clear()
