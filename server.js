const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());

// ----------------------
// Connexion PostgreSQL
// ----------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.connect()
  .then(() => console.log("✅ Connecté à PostgreSQL"))
  .catch(err => console.error("Erreur connexion PostgreSQL", err));

// ----------------------
// Initialisation DB
// ----------------------
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      duo TEXT,
      name TEXT,
      lives INTEGER
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS duos (
      name TEXT PRIMARY KEY,
      heal_used BOOLEAN DEFAULT FALSE
    )
  `);

  // ⚡️ uniquement les vraies équipes
  const joueurs = [
    ["violette_p1", "Violette", "Elouan", 3],
    ["violette_p2", "Violette", "Maxence M.", 3],
    ["bleue_p1", "Bleue", "Yannis", 3],
    ["bleue_p2", "Bleue", "Lucka", 3],
    ["rouge_p1", "Rouge", "Jacques", 3],
    ["rouge_p2", "Rouge", "Emile", 3],
    ["orange_p1", "Orange", "Paul", 3],
    ["orange_p2", "Orange", "Gabin", 3],
    ["verte_p1", "Verte", "Arthur", 3],
    ["verte_p2", "Verte", "Maxence B.", 3],
  ];

  const duos = ["Violette", "Bleue", "Rouge", "Orange", "Verte"];

  for (const j of joueurs) {
    await pool.query(
      "INSERT INTO players (id, duo, name, lives) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING",
      j
    );
  }

  for (const d of duos) {
    await pool.query(
      "INSERT INTO duos (name) VALUES ($1) ON CONFLICT (name) DO NOTHING",
      [d]
    );
  }
}
initDB();

// ----------------------
// Routes API
// ----------------------
app.get("/ping", (req, res) => res.send("OK"));

// Login: renvoie les joueurs du duo
app.post("/api/login", async (req, res) => {
  const { duoId } = req.body;
  const result = await pool.query(
    "SELECT * FROM players WHERE LOWER(duo) = LOWER($1)",
    [duoId]
  );
  if (result.rows.length === 0) {
    return res.status(404).json({ error: "Binôme introuvable" });
  }
  return res.json({ duo: duoId, players: result.rows });
});

// Tous les joueurs
app.get("/api/players", async (req, res) => {
  const result = await pool.query("SELECT * FROM players ORDER BY duo, name");
  res.json(result.rows);
});

// Touché (uniquement son binôme)
app.post("/api/touche", async (req, res) => {
  const { playerId, duoId } = req.body;

  const result = await pool.query("SELECT * FROM players WHERE id = $1", [playerId]);
  const player = result.rows[0];
  if (!player) return res.status(404).json({ error: "Joueur introuvable" });

  if (player.duo.toLowerCase() !== duoId.toLowerCase()) {
    return res.status(403).json({ error: "Vous ne pouvez pas modifier une autre équipe" });
  }

  if (player.lives > 0) {
    const newLives = player.lives - 1;
    await pool.query("UPDATE players SET lives = $1 WHERE id = $2", [newLives, playerId]);

    io.emit("notif", {
      type: newLives === 0 ? "eliminated" : "hit",
      duo: player.duo,
      player: player.name,
      lives: newLives
    });

    return res.json({ playerId, lives: newLives });
  } else {
    return res.json({ error: "Joueur déjà éliminé" });
  }
});

// Heal (uniquement son binôme)
app.post("/api/heal", async (req, res) => {
  const { playerId, duoId } = req.body;

  const result = await pool.query("SELECT * FROM players WHERE id = $1", [playerId]);
  const player = result.rows[0];
  if (!player) return res.status(404).json({ error: "Joueur introuvable" });

  if (player.duo.toLowerCase() !== duoId.toLowerCase()) {
    return res.status(403).json({ error: "Vous ne pouvez pas modifier une autre équipe" });
  }

  const duoRes = await pool.query("SELECT * FROM duos WHERE name = $1", [player.duo]);
  const duo = duoRes.rows[0];
  if (!duo) return res.status(404).json({ error: "Duo introuvable" });

  if (duo.heal_used) {
    return res.status(400).json({ error: "Heal déjà utilisé par ce duo" });
  }
  if (player.lives === 0) {
    return res.status(400).json({ error: "Impossible de réanimer un joueur éliminé" });
  }
  if (player.lives === 3) {
    return res.status(400).json({ error: "Impossible de heal un joueur à 3 vies" });
  }

  const newLives = player.lives + 1;
  await pool.query("UPDATE players SET lives = $1 WHERE id = $2", [newLives, playerId]);
  await pool.query("UPDATE duos SET heal_used = TRUE WHERE name = $1", [player.duo]);

  io.emit("notif", {
    type: "heal",
    duo: player.duo,
    player: player.name,
    lives: newLives
  });

  return res.json({ success: true, playerId, lives: newLives });
});

// Reset
app.post("/api/reset", async (req, res) => {
  try {
    await pool.query("UPDATE players SET lives = 3");
    await pool.query("UPDATE duos SET heal_used = FALSE");

    io.emit("notif", {
      type: "reset",
      message: "Toutes les vies ont été réinitialisées à 3 et les heals restaurés"
    });

    res.json({ success: true, message: "Reset complet effectué" });
  } catch (err) {
    console.error("Erreur reset:", err);
    res.status(500).json({ error: "Impossible de réinitialiser" });
  }
});

// ----------------------
// Socket.IO
// ----------------------
io.on("connection", (socket) => {
  console.log("Client connecté :", socket.id);
});

// ----------------------
// Lancement du serveur
// ----------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Serveur lancé sur http://localhost:${PORT}`));
