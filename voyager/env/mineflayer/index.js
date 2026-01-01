const fs = require("fs");
const express = require("express");
const bodyParser = require("body-parser");
const mineflayer = require("mineflayer");

const skills = require("./lib/skillLoader");
const { initCounter, getNextTime } = require("./lib/utils");
const obs = require("./lib/observation/base");
const OnChat = require("./lib/observation/onChat");
const OnError = require("./lib/observation/onError");
const { Voxels, BlockRecords } = require("./lib/observation/voxels");
const Status = require("./lib/observation/status");
const Inventory = require("./lib/observation/inventory");
const OnSave = require("./lib/observation/onSave");
const Chests = require("./lib/observation/chests");
const { plugin: tool } = require("mineflayer-tool");

let bot = null;

const app = express();

app.use(bodyParser.json({ limit: "50mb" }));
app.use(bodyParser.urlencoded({ limit: "50mb", extended: false }));

// ===== MOD START: Reconnect + safe chat/command rate limiter =====

// last /start body for auto-reconnect
let lastStartBody = null;

// ready promise for /step etc.
let botReadyResolve = null;
let botReadyReject = null;
let botReadyPromise = null;

function resetBotReadyPromise() {
  botReadyPromise = new Promise((resolve, reject) => {
    botReadyResolve = resolve;
    botReadyReject = reject;
  });
}

async function waitForBotReady(timeoutMs = 120000) {
  if (!botReadyPromise) throw new Error("botReadyPromise is not initialized");
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("bot ready timeout")), timeoutMs)
  );
  return Promise.race([botReadyPromise, timeout]);
}

// backoff state
let reconnectAttempt = 0;
let reconnectTimer = null;
let reconnecting = false;

const CHAT_INTERVAL_MS_DEFAULT = Number(process.env.BOT_CHAT_INTERVAL_MS || 2500);
const BASE_RECONNECT_MS = 5000;
const MAX_RECONNECT_MS = 60000;

function cleanupBot(reason = "cleanup") {
  try {
    if (bot && bot.viewer) bot.viewer.close();
  } catch {}
  try {
    if (bot) bot.removeAllListeners();
  } catch {}
  try {
    if (bot && bot._client) bot.end();
  } catch {}
  bot = null;
  console.error(`[mineflayer] cleaned up bot: ${reason}`);
}

// Safe rate limiter. Install ONLY after spawn (bot.chat may be undefined before spawn in some builds)
function installChatRateLimiter(botInstance, intervalMs = CHAT_INTERVAL_MS_DEFAULT) {
  if (!botInstance || typeof botInstance.chat !== "function") {
    console.warn("[chat limiter] bot.chat is not ready; skip limiter install");
    return false;
  }

  const rawChat = botInstance.chat.bind(botInstance);
  const queue = [];
  let pumping = false;
  let lastSentAt = 0;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function pump() {
    if (pumping) return;
    pumping = true;

    while (queue.length > 0) {
      const msg = queue.shift();
      if (!msg) continue;

      const now = Date.now();
      const wait = Math.max(0, intervalMs - (now - lastSentAt));
      if (wait > 0) await sleep(wait);

      try {
        rawChat(msg);
      } catch (e) {
        console.error("[chat limiter] rawChat failed:", e?.stack || e);
        break;
      }
      lastSentAt = Date.now();
    }

    pumping = false;
  }

  botInstance.chat = (message) => {
    if (message === null || message === undefined) return;
    const msg = String(message).trim();
    if (!msg) return;
    queue.push(msg);
    pump();
  };

  return true;
}

function scheduleReconnect(reason) {
  if (!lastStartBody) {
    console.error("[mineflayer] cannot reconnect: lastStartBody is null");
    return;
  }
  if (reconnecting) return;
  reconnecting = true;

  reconnectAttempt += 1;
  const backoff = Math.min(MAX_RECONNECT_MS, BASE_RECONNECT_MS * reconnectAttempt);
  const jitter = Math.floor(Math.random() * 1000);
  const waitMs = backoff + jitter;

  console.error(
    `[mineflayer] scheduling reconnect in ${waitMs}ms (attempt=${reconnectAttempt}) reason=${reason}`
  );

  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnecting = false;

    // Auto reconnect should avoid "hard" reset (massive /give spam). We force reset to "soft".
    const body = { ...lastStartBody, reset: "soft" };

    startBot(body, { isAutoReconnect: true })
      .then(() => {
        console.error("[mineflayer] reconnect started");
      })
      .catch((e) => {
        console.error("[mineflayer] reconnect failed:", e?.stack || e);
        scheduleReconnect("reconnect-failed");
      });
  }, waitMs);
}

async function startBot(startBody, { isAutoReconnect = false } = {}) {
  // store last body for reconnect
  lastStartBody = startBody;

  // reset ready promise
  resetBotReadyPromise();

  // cleanup existing bot if any
  if (bot) cleanupBot("restart");

  bot = mineflayer.createBot({
    host: "localhost", // minecraft server ip
    port: startBody.port, // minecraft server port
    username: "bot",
    disableChatSigning: true,
    checkTimeoutInterval: 60 * 60 * 1000,
  });

  // Connection failed before spawn
  function onConnectionFailed(e) {
    console.error("[mineflayer] connection failed:", e?.stack || e);
    try {
      if (botReadyReject) botReadyReject(e);
    } catch {}
    cleanupBot("connection-failed");
  }
  bot.once("error", onConnectionFailed);

  // Common per-bot state
  bot.waitTicks = startBody.waitTicks;
  bot.globalTickCounter = 0;
  bot.stuckTickCounter = 0;
  bot.stuckPosList = [];
  bot.iron_pickaxe = false;

  // mounting will cause physicsTick to stop
  bot.on("mount", () => {
    try { bot.dismount(); } catch {}
  });

  // kicked/end => cleanup + schedule reconnect
  bot.on("kicked", (message) => {
    console.error("[mineflayer] kicked:", message);
    try {
      if (botReadyReject) botReadyReject(new Error(`kicked:${message}`));
    } catch {}
    cleanupBot("kicked");
    scheduleReconnect(`kicked:${message}`);
  });

  bot.on("end", () => {
    console.error("[mineflayer] end");
    try {
      if (botReadyReject) botReadyReject(new Error("end"));
    } catch {}
    cleanupBot("end");
    scheduleReconnect("end");
  });

  bot.once("spawn", async () => {
    // spawn success => reset reconnectAttempt
    reconnectAttempt = 0;

    // spawn success => remove early connection failed handler
    bot.removeListener("error", onConnectionFailed);

    // IMPORTANT: install rate limiter AFTER spawn (fixes bind undefined)
    installChatRateLimiter(bot, Number(process.env.BOT_CHAT_INTERVAL_MS || CHAT_INTERVAL_MS_DEFAULT));

    let itemTicks = 1;

    // "hard" reset spams commands; we allow only on manual start, never on auto reconnect
    const resetMode = isAutoReconnect ? "soft" : startBody.reset;

    if (resetMode === "hard") {
      bot.chat("/clear @s");
      bot.chat("/kill @s");

      const inventory = startBody.inventory ? startBody.inventory : {};
      const equipment = startBody.equipment
        ? startBody.equipment
        : [null, null, null, null, null, null];

      for (let key in inventory) {
        bot.chat(`/give @s minecraft:${key} ${inventory[key]}`);
        itemTicks += 1;
      }

      const equipmentNames = [
        "armor.head",
        "armor.chest",
        "armor.legs",
        "armor.feet",
        "weapon.mainhand",
        "weapon.offhand",
      ];
      for (let i = 0; i < 6; i++) {
        if (i === 4) continue;
        if (equipment[i]) {
          bot.chat(
            `/item replace entity @s ${equipmentNames[i]} with minecraft:${equipment[i]}`
          );
          itemTicks += 1;
        }
      }
    }

    if (resetMode !== "soft" && startBody.position) {
      bot.chat(`/tp @s ${startBody.position.x} ${startBody.position.y} ${startBody.position.z}`);
    } else if (resetMode === "soft" && startBody.position) {
      // even on soft, tp can be useful; but it's still a chat command so it's rate-limited anyway
      bot.chat(`/tp @s ${startBody.position.x} ${startBody.position.y} ${startBody.position.z}`);
    }

    // if iron_pickaxe is in bot's inventory
    if (bot.inventory.items().find((item) => item.name === "iron_pickaxe")) {
      bot.iron_pickaxe = true;
    }

    const { pathfinder } = require("mineflayer-pathfinder");
    const { plugin: tool } = require("mineflayer-tool");
    const { plugin: pvp } = require("mineflayer-pvp");
    const hawkEye = require("minecrafthawkeye");
    bot.loadPlugin(pathfinder);
    bot.loadPlugin(tool);
    bot.loadPlugin(pvp);
    bot.loadPlugin(hawkEye.default);

    // Use the local mineflayer-collectblock plugin directly
    const collectBlock = require("./mineflayer-collectblock/lib/index.js");
    bot.loadPlugin(collectBlock);

    obs.inject(bot, [
      OnChat,
      OnError,
      Voxels,
      Status,
      Inventory,
      OnSave,
      Chests,
      BlockRecords,
    ]);
    skills.inject(bot);

    if (!isAutoReconnect && startBody.spread) {
      bot.chat(`/spreadplayers ~ ~ 0 300 under 80 false @s`);
      await bot.waitForTicks(bot.waitTicks);
    }

    await bot.waitForTicks(bot.waitTicks * itemTicks);

    // gamerules (rate-limited)
    bot.chat("/gamerule keepInventory true");
    bot.chat("/gamerule doDaylightCycle false");

    try {
      if (botReadyResolve) botReadyResolve(true);
    } catch {}

    console.error("[mineflayer] spawned and ready");
  });

  return true;
}

// ===== MOD END =====


// ===== /start =====
app.post("/start", async (req, res) => {
  try {
    // manual start (may allow hard reset)
    await startBot(req.body, { isAutoReconnect: false });
    await waitForBotReady(120000);

    // initial observation response (existing behavior)
    res.json(bot.observe());

    // init counters
    initCounter(bot);
  } catch (e) {
    console.error("[/start] failed:", e?.stack || e);
    try { cleanupBot("start-failed"); } catch {}
    res.status(400).json({ error: String(e?.message || e) });
  }
});


// ===== /step =====
app.post("/step", async (req, res) => {
  // Ensure bot is ready (handles reconnect)
  try {
    await waitForBotReady(120000);
  } catch (e) {
    return res.status(503).json({ error: `Bot not ready: ${e.message}` });
  }

  let response_sent = false;
  function otherError(err) {
    console.log("Uncaught Error");
    bot.emit("error", handleError(err));
    bot.waitForTicks(bot.waitTicks).then(() => {
      if (!response_sent) {
        response_sent = true;
        res.json(bot.observe());
      }
    });
  }
  process.on("uncaughtException", otherError);

  const mcData = require("minecraft-data")(bot.version);
  mcData.itemsByName["leather_cap"] = mcData.itemsByName["leather_helmet"];
  mcData.itemsByName["leather_tunic"] =
    mcData.itemsByName["leather_chestplate"];
  mcData.itemsByName["leather_pants"] =
    mcData.itemsByName["leather_leggings"];
  mcData.itemsByName["leather_boots"] = mcData.itemsByName["leather_boots"];
  mcData.itemsByName["lapis_lazuli_ore"] = mcData.itemsByName["lapis_ore"];
  mcData.blocksByName["lapis_lazuli_ore"] = mcData.blocksByName["lapis_ore"];

  const {
    Movements,
    goals: {
      Goal,
      GoalBlock,
      GoalNear,
      GoalXZ,
      GoalNearXZ,
      GoalY,
      GoalGetToBlock,
      GoalLookAtBlock,
      GoalBreakBlock,
      GoalCompositeAny,
      GoalCompositeAll,
      GoalInvert,
      GoalFollow,
      GoalPlaceBlock,
    },
    pathfinder,
    Move,
    ComputedPath,
    PartiallyComputedPath,
    XZCoordinates,
    XYZCoordinates,
    SafeBlock,
    GoalPlaceBlockOptions,
  } = require("mineflayer-pathfinder");
  const { Vec3 } = require("vec3");

  const movements = new Movements(bot, mcData);
  bot.pathfinder.setMovements(movements);

  bot.globalTickCounter = 0;
  bot.stuckTickCounter = 0;
  bot.stuckPosList = [];

  function onTick() {
    bot.globalTickCounter++;
    if (bot.pathfinder.isMoving()) {
      bot.stuckTickCounter++;
      if (bot.stuckTickCounter >= 100) {
        onStuck(1.5);
        bot.stuckTickCounter = 0;
      }
    }
  }

  bot.on("physicsTick", onTick);

  // initialize fail count
  let _craftItemFailCount = 0;
  let _killMobFailCount = 0;
  let _mineBlockFailCount = 0;
  let _placeItemFailCount = 0;
  let _smeltItemFailCount = 0;

  const code = req.body.code;
  const programs = req.body.programs;
  bot.cumulativeObs = [];

  await bot.waitForTicks(bot.waitTicks);
  const r = await evaluateCode(code, programs);
  process.off("uncaughtException", otherError);

  if (r !== "success") {
    bot.emit("error", handleError(r));
  }

  await returnItems();
  await bot.waitForTicks(bot.waitTicks);

  if (!response_sent) {
    response_sent = true;
    res.json(bot.observe());
  }

  bot.removeListener("physicsTick", onTick);

  async function evaluateCode(code, programs) {
    try {
      await eval("(async () => {" + programs + "\n" + code + "})()");
      return "success";
    } catch (err) {
      return err;
    }
  }

  function onStuck(posThreshold) {
    const currentPos = bot.entity.position;
    bot.stuckPosList.push(currentPos);

    if (bot.stuckPosList.length === 5) {
      const oldestPos = bot.stuckPosList[0];
      const posDifference = currentPos.distanceTo(oldestPos);

      if (posDifference < posThreshold) {
        teleportBot();
      }

      bot.stuckPosList.shift();
    }
  }

  function teleportBot() {
    const blocks = bot.findBlocks({
      matching: (block) => {
        return block.type === 0;
      },
      maxDistance: 1,
      count: 27,
    });

    if (blocks) {
      const randomIndex = Math.floor(Math.random() * blocks.length);
      const block = blocks[randomIndex];
      bot.chat(`/tp @s ${block.x} ${block.y} ${block.z}`);
    } else {
      bot.chat("/tp @s ~ ~1.25 ~");
    }
  }

  function returnItems() {
    bot.chat("/gamerule doTileDrops false");
    const crafting_table = bot.findBlock({
      matching: mcData.blocksByName.crafting_table.id,
      maxDistance: 128,
    });
    if (crafting_table) {
      bot.chat(
        `/setblock ${crafting_table.position.x} ${crafting_table.position.y} ${crafting_table.position.z} air destroy`
      );
      bot.chat("/give @s crafting_table");
    }
    const furnace = bot.findBlock({
      matching: mcData.blocksByName.furnace.id,
      maxDistance: 128,
    });
    if (furnace) {
      bot.chat(
        `/setblock ${furnace.position.x} ${furnace.position.y} ${furnace.position.z} air destroy`
      );
      bot.chat("/give @s furnace");
    }
    if (bot.inventoryUsed() >= 32) {
      if (!bot.inventory.items().find((item) => item.name === "chest")) {
        bot.chat("/give @s chest");
      }
    }
    if (
      bot.iron_pickaxe &&
      !bot.inventory.items().find((item) => item.name === "iron_pickaxe")
    ) {
      bot.chat("/give @s iron_pickaxe");
    }
    bot.chat("/gamerule doTileDrops true");
  }

  function handleError(err) {
    let stack = err.stack;
    if (!stack) {
      return err;
    }
    console.log(stack);
    const final_line = stack.split("\n")[1];
    const regex = /<anonymous>:(\d+):\d+\)/;

    const programs_length = programs.split("\n").length;
    let match_line = null;
    for (const line of stack.split("\n")) {
      const match = regex.exec(line);
      if (match) {
        const line_num = parseInt(match[1]);
        if (line_num >= programs_length) {
          match_line = line_num - programs_length;
          break;
        }
      }
    }
    if (!match_line) {
      return err.message;
    }
    let f_line = final_line.match(/\((?<file>.*):(?<line>\d+):(?<pos>\d+)\)/);
    if (f_line && f_line.groups && fs.existsSync(f_line.groups.file)) {
      const { file, line, pos } = f_line.groups;
      const f = fs.readFileSync(file, "utf8").split("\n");
      let source = file + `:${line}\n${f[line - 1].trim()}\n `;

      const code_source =
        "at " + code.split("\n")[match_line - 1].trim() + " in your code";
      return source + err.message + "\n" + code_source;
    } else if (
      f_line &&
      f_line.groups &&
      f_line.groups.file.includes("<anonymous>")
    ) {
      const { file, line, pos } = f_line.groups;
      let source =
        "Your code" + `:${match_line}\n${code.split("\n")[match_line - 1].trim()}\n `;
      let code_source = "";
      if (line < programs_length) {
        source =
          "In your program code: " + programs.split("\n")[line - 1].trim() + "\n";
        code_source = `at line ${match_line}:${code
          .split("\n")
          [match_line - 1].trim()} in your code`;
      }
      return source + err.message + "\n" + code_source;
    }
    return err.message;
  }
});

app.post("/stop", (req, res) => {
  if (bot) cleanupBot("stop");
  res.json({
    message: "Bot stopped",
  });
});

app.post("/pause", (req, res) => {
  if (!bot) {
    res.status(400).json({ error: "Bot not spawned" });
    return;
  }
  bot.chat("/pause");
  bot.waitForTicks(bot.waitTicks).then(() => {
    res.json({ message: "Success" });
  });
});

app.post("/", (req, res) => {
  console.log("Voyager sent POST /");
  res.json({ status: "ready" });
});

// Chat endpoint to send messages to the bot
app.post("/chat", (req, res) => {
  if (!bot) {
    res.status(400).json({ error: "Bot not spawned" });
    return;
  }

  const { message, sender = "Human" } = req.body;
  if (!message) {
    res.status(400).json({ error: "Message is required" });
    return;
  }

  // Emit a chat event as if it came from a player
  bot.emit("chatEvent", sender, message);
  console.log(`Chat from ${sender}: ${message}`);

  res.json({
    status: "success",
    message: `Message '${message}' sent to bot from ${sender}`,
  });
});

// Server listening to PORT 3000
const DEFAULT_PORT = 3000;
const PORT = process.argv[2] || DEFAULT_PORT;
app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
