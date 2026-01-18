import copy
import json
import os
from typing import Dict, Union

import voyager.utils as U
from .env import VoyagerEnv

from .agents import ActionAgent
from .agents import CriticAgent
from .agents import CurriculumAgent
from .agents import SkillManager

from voyager.modules.memory import MemoryModule
from voyager.modules.goal_generation import GoalGenerationModule
from voyager.modules.controller import CognitiveController
from voyager.modules.state import AgentState
from voyager.modules.navigation import NavigationModule
from voyager.modules.talking import TalkingModule
from voyager.modules.output import OutputModule
import asyncio


class Voyager:
    def __init__(
        self,
        mc_port: int = None,
        azure_login: Dict[str, str] = None,
        server_port: int = 3000,
        openai_api_key: str = None,
        env_wait_ticks: int = 20,
        env_request_timeout: int = 600,
        max_iterations: int = 160,
        reset_placed_if_failed: bool = False,
        action_agent_model_name: str = "gpt-4.1-nano",
        action_agent_base_url: Union[str, None] = None,
        action_agent_temperature: float = 0,
        action_agent_task_max_retries: int = 4,
        action_agent_show_chat_log: bool = True,
        action_agent_show_execution_error: bool = True,
        curriculum_agent_model_name: str = "gpt-4.1-nano",
        curriculum_agent_base_url: Union[str, None] = None,
        curriculum_agent_temperature: float = 0,
        curriculum_agent_qa_model_name: str = "gpt-4.1-nano",
        curriculum_agent_qa_base_url: Union[str, None] = None,
        curriculum_agent_qa_temperature: float = 0,
        curriculum_agent_warm_up: Dict[str, int] = None,
        curriculum_agent_core_inventory_items: str = r".*_log|.*_planks|stick|crafting_table|furnace"
        r"|cobblestone|dirt|coal|.*_pickaxe|.*_sword|.*_axe",
        curriculum_agent_mode: str = "auto",
        critic_agent_model_name: str = "gpt-4.1-nano",
        critic_agent_base_url: Union[str, None] = None,
        critic_agent_temperature: float = 0,
        critic_agent_mode: str = "auto",
        skill_manager_model_name: str = "gpt-4.1-nano",
        skill_manager_base_url: Union[str, None] = None,
        skill_manager_temperature: float = 0,
        skill_manager_retrieval_top_k: int = 5,
        openai_api_request_timeout: int = 240,
        ckpt_dir: str = "ckpt",
        skill_library_dir: str = None,
        resume: bool = False,
    ):
        self.env = VoyagerEnv(
            mc_port=mc_port,
            azure_login=azure_login,
            server_port=server_port,
            request_timeout=env_request_timeout,
        )
        self.env_wait_ticks = env_wait_ticks
        self.reset_placed_if_failed = reset_placed_if_failed
        self.max_iterations = max_iterations

        os.environ["OPENAI_API_KEY"] = openai_api_key

        self.action_agent = ActionAgent(
            model_name=action_agent_model_name,
            temperature=action_agent_temperature,
            request_timout=openai_api_request_timeout,
            ckpt_dir=ckpt_dir,
            resume=resume,
            chat_log=action_agent_show_chat_log,
            execution_error=action_agent_show_execution_error,
            base_url=action_agent_base_url,
        )
        self.action_agent_task_max_retries = action_agent_task_max_retries

        self.curriculum_agent = CurriculumAgent(
            model_name=curriculum_agent_model_name,
            temperature=curriculum_agent_temperature,
            qa_model_name=curriculum_agent_qa_model_name,
            qa_temperature=curriculum_agent_qa_temperature,
            request_timout=openai_api_request_timeout,
            ckpt_dir=ckpt_dir,
            resume=resume,
            mode=curriculum_agent_mode,
            warm_up=curriculum_agent_warm_up,
            core_inventory_items=curriculum_agent_core_inventory_items,
            base_url=curriculum_agent_base_url,
            qa_base_url=curriculum_agent_qa_base_url,
        )
        self.critic_agent = CriticAgent(
            model_name=critic_agent_model_name,
            temperature=critic_agent_temperature,
            request_timout=openai_api_request_timeout,
            mode=critic_agent_mode,
            base_url=critic_agent_base_url,
        )

        goal_model = os.getenv("VOYAGER_GOAL_MODEL", "gpt-4.1-nano")
        controller_model = os.getenv("VOYAGER_CONTROLLER_MODEL", "gpt-4.1-nano")

        self.agent_state = AgentState()
        self.agent_state.memory = MemoryModule()
        self.goal_generator = GoalGenerationModule(model=goal_model)
        self.controller = CognitiveController(model=controller_model)
        self.navigation = NavigationModule()
        self.talking = TalkingModule()
        self.output = OutputModule(name=os.environ.get("BOT_NAME", "bot"))

        self.skill_manager = SkillManager(
            model_name=skill_manager_model_name,
            temperature=skill_manager_temperature,
            retrieval_top_k=skill_manager_retrieval_top_k,
            request_timout=openai_api_request_timeout,
            ckpt_dir=skill_library_dir if skill_library_dir else ckpt_dir,
            resume=True if resume or skill_library_dir else False,
            base_url=skill_manager_base_url,
        )

        self.recorder = U.EventRecorder(ckpt_dir=ckpt_dir, resume=resume)
        self.resume = resume

        self.action_agent_rollout_num_iter = -1
        self.task = None
        self.context = ""
        self.messages = None
        self.conversations = []
        self.last_events = None

    def reset(self, task, context="", reset_env=True):
        self.action_agent_rollout_num_iter = 0
        self.task = task
        self.context = context
        if reset_env:
            self.env.reset(
                options={
                    "mode": "soft",
                    "wait_ticks": self.env_wait_ticks,
                }
            )
        difficulty = (
            "easy" if len(self.curriculum_agent.completed_tasks) > 15 else "peaceful"
        )
        events = self.env.step(
            "bot.chat(`/time set ${getNextTime()}`);\n"
            + f"bot.chat('/difficulty {difficulty}');"
        )
        skills = self.skill_manager.retrieve_skills(query=self.context)
        system_message = self.action_agent.render_system_message(skills=skills)
        human_message = self.action_agent.render_human_message(
            events=events, code="", task=self.task, context=context, critique=""
        )
        self.messages = [system_message, human_message]
        self.conversations = []
        return self.messages

    def close(self):
        self.env.close()

    async def step(self):
        if self.action_agent_rollout_num_iter < 0:
            raise ValueError("Agent must be reset before stepping")

        # === [PIANO] Observation → MemoryModule ===
        try:
            observation_summary = self.env.observe_summary()
        except Exception:
            observation_summary = "No new observation."
        self.agent_state.memory.append(observation_summary)

        # === [PIANO] Memory → Goal Generation ===
        memory_summary = self.agent_state.memory.summarize()
        try:
            self.agent_state.goal = await self.goal_generator.generate_goal(
                memory_summary
            )
            print(f"[PIANO Goal] {self.agent_state.goal}")
        except Exception as e:
            print(f"[Goal Generation Error]: {e}")
            self.agent_state.goal = "Continue previous task."

        # === [PIANO] Navigation + Talking ===
        nav_instruction = self.navigation.get_instruction()
        self.agent_state.goal += f"\n[Navigation]: {nav_instruction}"

        await self.talking.explain_goal(self.agent_state.goal)
        await self.talking.explain_decision(self.agent_state.last_action)

        await self.output.describe_goal(self.agent_state.goal)
        await self.output.describe_decision(self.agent_state.last_action)
        await self.output.report_observation(observation_summary)

        # === [PIANO] Controller Decision ===
        try:
            self.agent_state.last_action = await self.controller.decide_action(
                self.agent_state.goal, memory_summary
            )
            print(f"[PIANO Controller Decision]: {self.agent_state.last_action}")
        except Exception as e:
            print(f"[Controller Error]: {e}")
            self.agent_state.last_action = "Continue with current plan."

        # === ActionAgent 実行 ===
        ai_message = await self.action_agent.llm.ainvoke(self.messages)
        print(f"\033[34m****Action Agent ai message****\n{ai_message.content}\033[0m")

        self.conversations.append(
            (self.messages[0].content, self.messages[1].content, ai_message.content)
        )
        parsed_result = self.action_agent.process_ai_message(message=ai_message)

        success = False
        if isinstance(parsed_result, dict):
            code = parsed_result["program_code"] + "\n" + parsed_result["exec_code"]
            events = self.env.step(code, programs=self.skill_manager.programs)

            self.recorder.record(events, self.task)
            self.action_agent.update_chest_memory(events[-1][1]["nearbyChests"])

            success, critique = self.critic_agent.check_task_success(
                events=events,
                task=self.task,
                context=self.context,
                chest_observation=self.action_agent.render_chest_observation(),
                max_retries=5,
            )

            if self.reset_placed_if_failed and not success:
                blocks, positions = [], []
                for event_type, event in events:
                    if event_type == "onSave" and event["onSave"].endswith("_placed"):
                        blocks.append(event["onSave"].split("_placed")[0])
                        positions.append(event["status"]["position"])
                new_events = self.env.step(
                    f"await givePlacedItemBack(bot, {U.json_dumps(blocks)}, {U.json_dumps(positions)})",
                    programs=self.skill_manager.programs,
                )
                events[-1][1]["inventory"] = new_events[-1][1]["inventory"]
                events[-1][1]["voxels"] = new_events[-1][1]["voxels"]

            new_skills = self.skill_manager.retrieve_skills(
                query=self.context
                + "\n\n"
                + self.action_agent.summarize_chatlog(events)
            )
            system_message = self.action_agent.render_system_message(
                skills=new_skills,
                goal=self.agent_state.goal,
                decision=self.agent_state.last_action,
            )
            human_message = self.action_agent.render_human_message(
                events=events,
                code=parsed_result["program_code"],
                task=self.task,
                context=self.context,
                critique=critique,
            )
            self.last_events = copy.deepcopy(events)
            self.messages = [system_message, human_message]
        else:
            await self.output.announce_failure(self.task)
            await self.output.why_failed(self.task, self.messages[-1].content)
            self.recorder.record([], self.task)
            print(f"\033[34m{parsed_result} Trying again!\033[0m")

        self.action_agent_rollout_num_iter += 1
        done = (
            self.action_agent_rollout_num_iter >= self.action_agent_task_max_retries
            or success
        )
        info = {
            "task": self.task,
            "success": success,
            "conversations": self.conversations,
        }
        if success:
            info["program_code"] = parsed_result["program_code"]
            info["program_name"] = parsed_result["program_name"]
        else:
            await self.output.announce_failure(self.task)
            await self.output.why_failed(self.task, self.messages[-1].content)
            print(
                f"\033[32m****Action Agent human message****\n{self.messages[-1].content}\033[0m"
            )

        return self.messages, 0, done, info

    async def rollout(self, *, task, context, reset_env=True):
        self.reset(task=task, context=context, reset_env=reset_env)
        while True:
            messages, reward, done, info = await self.step()
            if done:
                break
        return messages, reward, done, info

    async def learn(self, reset_env=True):
        print(f"\033[32m===Starting learning process===\033[0m")

        try:
            if self.resume:
                self.env.reset(
                    options={
                        "mode": "soft",
                        "wait_ticks": self.env_wait_ticks,
                    }
                )
            else:
                self.env.reset(
                    options={
                        "mode": "hard",
                        "wait_ticks": self.env_wait_ticks,
                    }
                )
                self.resume = True

            self.last_events = self.env.step("")
        except RuntimeError as e:
            if "Minecraft server reply with code 400" in str(e):
                print(f"\033[31m===Minecraft Connection Error===\033[0m")
                print(f"\033[31mError: {e}\033[0m")
                print(f"\033[31mThis error typically means:\033[0m")
                print(
                    f"\033[31m1. Minecraft server is not running on port {self.env.mc_port}\033[0m"
                )
                print(
                    f"\033[31m2. Minecraft server is not properly configured for Voyager\033[0m"
                )
                print(
                    f"\033[31m3. Mineflayer bot cannot connect to the Minecraft world\033[0m"
                )
                return
            else:
                print(f"\033[31mUnexpected error during environment reset: {e}\033[0m")
                return
        except Exception as e:
            print(
                f"\033[31mUnexpected error during environment initialization: {e}\033[0m"
            )
            return

        while True:
            if self.recorder.iteration > self.max_iterations:
                print("Iteration limit reached")
                break

            task, context = self.curriculum_agent.propose_next_task(
                events=self.last_events,
                chest_observation=self.action_agent.render_chest_observation(),
                max_retries=5,
            )

            print(
                f"\033[35mStarting task {task} for at most {self.action_agent_task_max_retries} times\033[0m"
            )

            try:
                messages, reward, done, info = await self.rollout(
                    task=task,
                    context=context,
                    reset_env=reset_env,
                )
            except Exception as e:
                await asyncio.sleep(3)
                info = {
                    "task": task,
                    "success": False,
                }
                if self.last_events:
                    self.last_events = self.env.reset(
                        options={
                            "mode": "hard",
                            "wait_ticks": self.env_wait_ticks,
                            "inventory": self.last_events[-1][1]["inventory"],
                            "equipment": self.last_events[-1][1]["status"]["equipment"],
                            "position": self.last_events[-1][1]["status"]["position"],
                        }
                    )
                else:
                    print("[WARN] last_events is empty. Resetting environment with mode='hard'.")
                    self.last_events = self.env.reset(
                        options={
                            "mode": "hard",
                            "wait_ticks": self.env_wait_ticks,
                        }
                    )
                print("Your last round rollout terminated due to error:")
                print(f"\033[41m{e}\033[0m")

            if info["success"]:
                await self.output.announce_success(self.task)
                self.skill_manager.add_new_skill(info)

            print(f"[DEBUG] progress before = {self.curriculum_agent.progress}")
            self.curriculum_agent.update_exploration_progress(info)
            print(f"[DEBUG] progress after  = {self.curriculum_agent.progress}")
            print(f"[DEBUG] Expected task: {sub_goals[self.curriculum_agent.progress]}")
            print(f"[DEBUG] Completed task from info: {info['task']}")
            print(
                f"\033[35mCompleted tasks: {', '.join(self.curriculum_agent.completed_tasks)}\033[0m"
            )
            print(
                f"\033[35mFailed tasks: {', '.join(self.curriculum_agent.failed_tasks)}\033[0m"
            )

        return {
            "completed_tasks": self.curriculum_agent.completed_tasks,
            "failed_tasks": self.curriculum_agent.failed_tasks,
            "skills": self.skill_manager.skills,
        }

    async def decompose_task(self, task):
        if not self.last_events:
            self.last_events = self.env.reset(
                options={
                    "mode": "hard",
                    "wait_ticks": self.env_wait_ticks,
                }
            )
        return self.curriculum_agent.decompose_task(task, self.last_events)

    async def inference(
        self, task=None, sub_goals=[], reset_mode="hard", reset_env=True
    ):
        if not task and not sub_goals:
            raise ValueError("Either task or sub_goals must be provided")

        if not sub_goals:
            sub_goals = await self.decompose_task(task)
            print(f"[DEBUG] Sub-goals: {sub_goals}")

        self.env.reset(
            options={
                "mode": reset_mode,
                "wait_ticks": self.env_wait_ticks,
            }
        )
        self.curriculum_agent.completed_tasks = []
        self.curriculum_agent.failed_tasks = []
        self.last_events = self.env.step("")

        while self.curriculum_agent.progress < len(sub_goals):
            next_task = sub_goals[self.curriculum_agent.progress]
            context = self.curriculum_agent.get_task_context(next_task)
            print(
                f"\033[35mStarting task {next_task} for at most {self.action_agent_task_max_retries} times\033[0m"
            )
            messages, reward, done, info = await self.rollout(
                task=next_task,
                context=context,
                reset_env=reset_env,
            )
            print(f"[DEBUG] progress before = {self.curriculum_agent.progress}")
            self.curriculum_agent.update_exploration_progress(info)
            print(f"[DEBUG] progress after  = {self.curriculum_agent.progress}")
            print(f"[DEBUG] Expected task: {sub_goals[self.curriculum_agent.progress]}")
            print(f"[DEBUG] Completed task from info: {info['task']}")
            print(
                f"\033[35mCompleted tasks: {', '.join(self.curriculum_agent.completed_tasks)}\033[0m"
            )
            print(
                f"\033[35mFailed tasks: {', '.join(self.curriculum_agent.failed_tasks)}\033[0m"
            )
