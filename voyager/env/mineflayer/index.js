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

// ===== MOD START: Reconnect + Chat/Command Rate Limit infrastructure =====

// 最後に /start で渡された設定（自動再接続に使う）
let lastStartOptions = null;

// bot の spawn を待つための Promise
let botReadyResolve = null;
let botReadyReject = null;
let botReadyPromise = null;

function resetBotReadyPromise() {
  botReadyPromise = new Promise((resolve, reject) => {
    botReadyResolve = resolve;
    botReadyReject = reject;
  });
}

// 再接続バックオフ用
let reconnectAttempt = 0;
let reconnectTimer = null;
let isReconnecting = false;

// 送信間隔（スパム対策の要）
const CHAT_INTERVAL_MS = Number(process.env.BOT_CHAT_INTERVAL_MS || 2500); // まずは強め
const MAX_BACKOFF_MS = 60000;

// bot.chat を強制的にキュー送信にする（/give や /tp なども全部ここを通る）
function installChatRateLimiter(botInstance) {
  const rawChat = botInstance.chat.bind(botInstance);

  const queue = [];
  let pumping = false;
  let lastSentAt = 0;

  async function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function pump() {
    if (pumping) return;
    pumping = true;

    while (queue.length > 0 && botInstance) {
      const msg = queue.shift();

      // bot が死んでたら破棄
      if (!botInstance || !botInstance._client) break;

      const now = Date.now();
      const wait = Math.max(0, CHAT_INTERVAL_MS - (now - lastSentAt));
      if (wait > 0) await sleep(wait);

      try {
        rawChat(msg);
      } catch (e) {
        console.error("[chat limiter] rawChat failed:", e?.stack || e);
        // 送信失敗したら一旦中断
        break;
      }
      lastSentAt = Date.now();
    }

    pumping = false;
  }

  // ラップ
  botInstance.chat = (message) => {
    // 空メッセージ抑制
    if (message === null || message === undefined) return;
    const msg = String(message).trim();
    if (!msg) return;

    queue.push(msg);
    pump();
  };

  // 必要なら外から待てるようにする（初期化で便利）
  botInstance._chatQueue = queue;
  botInstance._chatPump = pump;
}

// bot が利用可能になるまで待つ（復帰中でも /step を落とさない）
async function waitForBotReady(timeoutMs = 120000) {
  if (bot && botReadyPromise) {
    // botReadyPromise が resolve 済みの場合でも await は即時完了
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("bot ready timeout")), timeoutMs)
    );
    return Promise.race([botReadyPromise, timeout]);
  }
  throw new Error("bot is not initialized");
}

// bot を破棄（イベント/ビューア/ソケットを綺麗に）
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
  console.error(`[mineflayer] bot cleaned up: ${reason}`);
}

// 自動再接続スケジュール
function scheduleReconnect(reason) {
  if (!lastStartOptions) {
    console.error("[mineflayer] cannot reconnect: lastStartOptions is null");
    return;
  }
  if (isReconnecting) return;
  isReconnecting = true;

  reconnectAttempt += 1;
  const base = 5000; // まず5秒
  const backoff = Math.min(MAX_BACKOFF_MS, base * reconnectAttempt);
  const jitter = Math.floor(Math.random() * 1000);
  const waitMs = backoff + jitter;

  console.error(
    `[mineflayer] scheduling reconnect in ${waitMs}ms (attempt=${reconnectAttempt}) reason=${reason}`
  );

  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    isReconnecting = false;
    // 復帰時は "hard reset" を勝手にしない（サーバー負荷＆コマンド連打の元）
    // ただし位置やkeepInventory等は lastStartOptions に含まれていれば適用される
    startBotInternal(lastStartOptions, { isAutoReconnect: true }).catch((e) => {
      console.error("[mineflayer] reconnect failed:", e?.stack || e);
      // 失敗したら再スケジュール
      scheduleReconnect("reconnect-failed");
    });
  }, waitMs);
}

// bot生成の中核（/start と自動再接続の両方から呼ぶ）
async function startBotInternal(options, { isAutoReconnect = false } = {}) {
  // 以前の bot を落とす
  if (bot) cleanupBot("restart");

  // bot ready promise を作り直す
  resetBotReadyPromise();

  // 設定の保存（自動再接続用）
  lastStartOptions = options;

  const port = options.port;
  const waitTicks = options.waitTicks;

  bot = mineflayer.createBot({
    host: "localhost",
    port: port,
    username: "bot",
    disableChatSigning: true,
    checkTimeoutInterval: 60 * 60 * 1000,
  });

  // 強制スパム対策：bot.chat をキュー制限
  installChatRateLimiter(bot);

  // Event subscriptions / counters
  bot.waitTicks = waitTicks;
  bot.globalTickCounter = 0;
  bot.stuckTickCounter = 0;
  bot.stuckPosList = [];
  bot.iron_pickaxe = false;

  // mounting will cause physicsTick to stop
  bot.on("mount", () => {
    bot.dismount();
  });

  // 接続失敗（初回spawn前）
  const onConnectionFailed = (e) => {
    console.error("[mineflayer] connection failed:", e?.stack || e);
    try {
      if (botReadyReject) botReadyReject(e);
    } catch {}
    cleanupBot("connection-failed");
  };
  bot.once("error", onConnectionFailed);

  // kicked/end/error は復帰トリガ
  bot.on("kicked", (reason) => {
    console.error("[mineflayer] kicked:", reason);
    try {
      if (botReadyReject) botReadyReject(new Error(`kicked:${reason}`));
    } catch {}
    cleanupBot("kicked");
    scheduleReconnect(`kicked:${reason}`);
  });

  bot.on("end", () => {
    console.error("[mineflayer] end");
    try {
      if (botReadyReject) botReadyReject(new Error("end"));
    } catch {}
    cleanupBot("end");
    scheduleReconnect("end");
  });

  bot.on("error", (err) => {
    // spawn後の error も拾って復帰寄りに
    console.error("[mineflayer] error:", err?.stack || err);
    // spawn後に出る error で毎回復帰するのが嫌なら条件分岐してもOK
  });

  bot.once("spawn", async () => {
    // spawn 成功 → 初回バックオフリセット
    reconnectAttempt = 0;

    // spawnしたら接続失敗用エラーハンドラは外す
    bot.removeListener("error", onConnectionFailed);

    // plugin load
    const { pathfinder } = require("mineflayer-pathfinder");
    const { plugin: tool } = require("mineflayer-tool");
    const { plugin: pvp } = require("mineflayer-pvp");
    const hawkEye = require("minecrafthawkeye");
    bot.loadPlugin(pathfinder);
    bot.loadPlugin(tool);
    bot.loadPlugin(pvp);
    bot.loadPlugin(hawkEye.default);
    const collectBlock = require("./mineflayer-collectblock/lib/index.js");
    bot.loadPlugin(collectBlock);

    // observation / skills inject（spawn毎に必要）
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

    // 初期化コマンド群（スパムになりやすいので chat limiter 経由で間隔が空く）
    // ※自動再接続時に "hard reset"（/clear /kill /give連打）を避けるのが重要
    let itemTicks = 1;

    if (!isAutoReconnect && options.reset === "hard") {
      bot.chat("/clear @s");
      bot.chat("/kill @s");

      const inventory = options.inventory ? options.inventory : {};
      const equipment = options.equipment
        ? options.equipment
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

    if (!isAutoReconnect && options.position) {
      bot.chat(
        `/tp @s ${options.position.x} ${options.position.y} ${options.position.z}`
      );
    }

    // iron_pickaxe check
    if (bot.inventory.items().find((item) => item.name === "iron_pickaxe")) {
      bot.iron_pickaxe = true;
    }

    if (!isAutoReconnect && options.spread) {
      bot.chat(`/spreadplayers ~ ~ 0 300 under 80 false @s`);
      await bot.waitForTicks(bot.waitTicks);
    }

    // 初期化コマンドが chat limiter で遅延することを見越して待つ
    await bot.waitForTicks(bot.waitTicks * itemTicks);

    // gamerule（必要最低限）
    bot.chat("/gamerule keepInventory true");
    bot.chat("/gamerule doDaylightCycle false");

    // Ready!
    try {
      if (botReadyResolve) botReadyResolve(true);
    } catch {}

    console.error("[mineflayer] spawned and ready");
  });

  return true;
}

// ===== MOD END =====


// ===== /start =====
// NOTE: /start は「初回起動 or 明示的リスタート」に使う
app.post("/start", async (req, res) => {
  try {
    console.log(req.body);

    // ===== MOD START: use startBotInternal + wait for ready =====
    await startBotInternal(req.body, { isAutoReconnect: false });
    await waitForBotReady(120000);
    // spawn直後の observe を返す（既存仕様）
    res.json(bot.observe());

    // counter init（既存ロジック維持）
    initCounter(bot);
    // ===== MOD END =====

  } catch (e) {
    console.error("[/start] failed:", e?.stack || e);
    try {
      cleanupBot("start-failed");
    } catch {}
    res.status(400).json({ error: String(e?.message || e) });
  }
});


// ===== /step =====
app.post("/step", async (req, res) => {
  // bot が蹴られて復帰中の可能性があるので、まず待つ
  try {
    // ===== MOD START: wait for bot ready (reconnect-safe) =====
    await waitForBotReady(120000);
    // ===== MOD END =====
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
    } else if (f_line && f_line.groups && f_line.groups.file.includes("<anonymous>")) {
      const { file, line, pos } = f_line.groups;
      let source =
        "Your code" + `:${match_line}\n${code.split("\n")[match_line - 1].trim()}\n `;
      let code_source = "";
      if (line < programs_length) {
        source = "In your program code: " + programs.split("\n")[line - 1].trim() + "\n";
        code_source = `at line ${match_line}:${code.split("\n")[match_line - 1].trim()} in your code`;
      }
      return source + err.message + "\n" + code_source;
    }
    return err.message;
  }
});

// ===== /stop =====
app.post("/stop", (req, res) => {
  if (bot) cleanupBot("stop");
  res.json({ message: "Bot stopped" });
});

// ===== /pause =====
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

// ===== /chat =====
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

  bot.emit("chatEvent", sender, message);
  console.log(`Chat from ${sender}: ${message}`);

  res.json({
    status: "success",
    message: `Message '${message}' sent to bot from ${sender}`,
  });
});

// ===== server =====
const DEFAULT_PORT = 3000;
const PORT = process.argv[2] || DEFAULT_PORT;
app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
