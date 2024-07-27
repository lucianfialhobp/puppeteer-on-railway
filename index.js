const express = require("express");
const puppeteerExtra = require("puppeteer-extra");
const stealthPlugin = require("puppeteer-extra-plugin-stealth");
const cheerio = require("cheerio");
const dotenv = require("dotenv");
const redis = require("redis");
const cors = require("cors");
const { Cluster } = require("puppeteer-cluster");

dotenv.config();
puppeteerExtra.use(stealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// Configurar Redis
const redisUrl = process.env.REDIS_URL;
const redisClient = redis.createClient({ url: redisUrl });

redisClient.on("error", (err) => {
  console.error("Redis Client Error", err);
});

redisClient.on("connect", () => {
  console.log("Connected to Redis");
});

(async () => {
  try {
    await redisClient.connect();
    console.log("Connected to Redis");
  } catch (err) {
    console.error("Failed to connect to Redis:", err);
  }
})();

app.use(express.json());

const analyzeRisk = (user) => {
  let riskScore = 0;

  if (user.vacBanned) return 99.9;
  if (user.isPrivate) return 99.9;
  if (user.recentGames.length === 0) return 99.9;

  if (user.commentCheck) riskScore += 50;

  const csgo = user.recentGames.find((game) => game.id === "730");
  if (csgo && parseFloat(csgo.hours) > 1000) riskScore += 10;
  if (csgo && parseFloat(csgo.hours) > 500) riskScore += 20;

  if (user.friends < 50) riskScore += 10;
  if (user.level < 10) riskScore += 10;

  const riskPercentage = Math.min(100, riskScore);
  return riskPercentage;
};

const checkCache = async (usernames) => {
  const cachedProfiles = {};
  for (const username of usernames) {
    try {
      const cachedProfile = await redisClient.get(username);
      if (cachedProfile) {
        const parsedProfile = JSON.parse(cachedProfile);
        cachedProfiles[username] = parsedProfile.riskScore;
      }
    } catch (redisErr) {
      console.error(`Error fetching from Redis for ${username}:`, redisErr);
    }
  }
  return cachedProfiles;
};

const fetchUserProfile = async ({ page, data: { username } }) => {
  const user = {};

  await page.goto(`https://steamcommunity.com/profiles/${username}/`, {
    waitUntil: "load",
    timeout: 60000,
  });

  const html = await page.content();
  const $ = cheerio.load(html);

  const isPrivate = $(".profile_private_info").length > 0;
  user.isPrivate = isPrivate;

  if (isPrivate) {
    user.level = null;
    user.friends = null;
    user.recentGames = [];
    user.vacBanned = null;
  } else {
    user.level = parseInt($(".friendPlayerLevelNum").text().trim(), 10) || 0;
    user.friends =
      parseInt(
        $(".profile_friend_links .profile_count_link_total").text().trim(),
        10
      ) || 0;
    user.recentGames = [];
    $(".recent_game").each((i, element) => {
      const game = {
        id: $(element).find("a").attr("href").split("/").pop(),
        title: $(element).find(".game_name a").text().trim(),
        hours: $(element)
          .find(".game_info_details")
          .text()
          .split(" hrs on record")[0]
          .trim(),
      };
      user.recentGames.push(game);
    });

    if (user.recentGames.length === 0) {
      user.isPrivate = true;
    }

    const banStatus = $(".profile_ban_status .profile_ban").text().trim();
    user.vacBanned = banStatus.includes("banimento VAC");

    await page.goto(
      `https://steamcommunity.com/profiles/${username}/allcomments`,
      {
        waitUntil: "load",
        timeout: 60000,
      }
    );
    const commentsHtml = await page.content();
    const $comments = cheerio.load(commentsHtml);

    user.comments = [];
    $comments(".commentthread_comment_text").each((i, element) => {
      const commentText = $comments(element).text().trim();
      user.comments.push(commentText);
    });

    user.commentCheck = user.comments.some((comment) =>
      /cheater|wall|xitado|XITER|xiter|Denúncia/i.test(comment)
    );
  }

  user.riskScore = analyzeRisk(user);

  // Armazenar no cache do Redis
  await redisClient.set(username, JSON.stringify(user), { EX: 604800 });

  return { username, riskScore: user.riskScore };
};

// Função para calcular risco da lobby usando exponential smoothing
const lobbyRiskExponential = (players) => {
  if (players.length === 0) return 100;

  const totalExponentialRisk = players.reduce(
    (sum, player) => sum + Math.exp(player.riskScore / 10),
    0
  );

  return (Math.log(totalExponentialRisk / players.length) * 10).toFixed(2);
};

const initializeCluster = async () => {
  const puppeteerOptions = {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--disable-gpu",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-breakpad",
      "--disable-client-side-phishing-detection",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-domain-reliability",
      "--disable-features=AudioServiceOutOfProcess",
      "--disable-hang-monitor",
      "--disable-ipc-flooding-protection",
      "--disable-notifications",
      "--disable-offer-store-unmasked-wallet-cards",
      "--disable-offer-upload-credit-cards",
      "--disable-print-preview",
      "--disable-prompt-on-repost",
      "--disable-renderer-backgrounding",
      "--disable-sync",
      "--force-color-profile=srgb",
      "--metrics-recording-only",
      "--mute-audio",
      "--no-crash-upload",
      "--no-default-browser-check",
      "--no-pings",
      "--no-sandbox",
      "--password-store=basic",
      "--use-gl=swiftshader",
      "--use-mock-keychain",
    ],
  };

  const cluster = await Cluster.launch({
    concurrency: Cluster.CONCURRENCY_CONTEXT,
    maxConcurrency: 5, // Ajustado para lidar com no máximo 5 jogadores por vez
    puppeteer: puppeteerExtra,
    puppeteerOptions,
  });

  await cluster.task(fetchUserProfile);

  return cluster;
};

let cluster;
initializeCluster().then((initializedCluster) => {
  cluster = initializedCluster;
});

app.post("/getUserProfiles", async (req, res) => {
  const { usernames } = req.body;

  if (!Array.isArray(usernames) || usernames.length === 0) {
    return res
      .status(400)
      .json({ error: "Usernames must be a non-empty array" });
  }

  try {
    const cachedProfiles = await checkCache(usernames);
    const usernamesToFetch = usernames.filter(
      (username) => !cachedProfiles[username]
    );

    let fetchedProfiles = [];
    if (usernamesToFetch.length > 0) {
      const clusterTasks = usernamesToFetch.map((username) =>
        cluster.execute({ username }).catch((err) => {
          console.error(`Error fetching profile for ${username}:`, err);
          return null;
        })
      );

      fetchedProfiles = await Promise.all(clusterTasks);

      fetchedProfiles = fetchedProfiles.filter((result) => result !== null);
    }

    const allProfiles = {
      ...cachedProfiles,
      ...Object.fromEntries(
        fetchedProfiles.map((profile) => [profile.username, profile.riskScore])
      ),
    };

    const lobbyRiskScore = lobbyRiskExponential(
      Object.values(allProfiles).map((riskScore) => ({ riskScore }))
    );
    res.json({ profiles: allProfiles, lobbyRisk: parseFloat(lobbyRiskScore) });
  } catch (error) {
    console.error(`Failed to fetch user profiles:`, error);
    res.status(500).json({ error: "Failed to fetch user profiles" });
  }
});

app.listen(PORT, () => {
  console.log(`Puppeteer service running on port ${PORT}`);
});
