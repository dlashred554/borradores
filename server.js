import express from "express";
import multer from "multer";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }
});

const PORT = process.env.PORT || 3000;
const CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
const BASE_URL = process.env.APP_BASE_URL;

if (!CLIENT_KEY || !CLIENT_SECRET || !BASE_URL) {
  console.warn("Faltan TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET o APP_BASE_URL.");
}

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const sessions = new Map();

function callbackUrl() {
  return `${BASE_URL.replace(/\/$/, "")}/auth/callback`;
}

app.get("/", (req, res) => res.sendFile(process.cwd() + "/index.html"));
app.get("/style.css", (req, res) => res.sendFile(process.cwd() + "/style.css"));
app.get("/terms.html", (req, res) => res.sendFile(process.cwd() + "/terms.html"));
app.get("/privacy.html", (req, res) => res.sendFile(process.cwd() + "/privacy.html"));

app.get("/auth/login", (req, res) => {
  if (!CLIENT_KEY || !CLIENT_SECRET || !BASE_URL) {
    return res.status(500).send("Falta configurar las variables de TikTok en el servidor.");
  }

  const state = crypto.randomBytes(24).toString("hex");
  sessions.set(state, { createdAt: Date.now() });

  const params = new URLSearchParams({
    client_key: CLIENT_KEY,
    response_type: "code",
    scope: "user.info.basic,video.upload",
    redirect_uri: callbackUrl(),
    state
  });

  res.redirect("https://www.tiktok.com/v2/auth/authorize/?" + params.toString());
});

app.get("/auth/callback", async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state || !sessions.has(state)) {
    return res.status(400).send("Autorización no válida.");
  }

  sessions.delete(state);

  try {
    const body = new URLSearchParams({
      client_key: CLIENT_KEY,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: callbackUrl()
    });

    const response = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });

    const data = await response.json();

    if (!response.ok || data.error) {
      return res.status(400).send("TikTok rechazó la autorización: " + JSON.stringify(data));
    }

    const token = data.access_token;
    const openId = data.open_id;

    const sessionId = crypto.randomBytes(24).toString("hex");
    sessions.set(sessionId, {
      createdAt: Date.now(),
      accessToken: token,
      openId
    });

    res.send(`
      <!doctype html>
      <html lang="es">
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DraftFlow</title><link rel="stylesheet" href="/style.css"></head>
      <body><main><section class="card">
      <div class="logo">DF</div>
      <h1>Cuenta conectada</h1>
      <p>Tu cuenta de TikTok ha sido autorizada. Ya puedes enviar un vídeo como borrador.</p>
      <form action="/upload?session=${encodeURIComponent(sessionId)}" method="post" enctype="multipart/form-data">
        <input type="file" name="video" accept="video/mp4,video/quicktime,video/webm" required>
        <button type="submit">Enviar a TikTok</button>
      </form>
      <footer><a href="/">Inicio</a><a href="/privacy.html">Privacidad</a></footer>
      </section></main></body></html>
    `);
  } catch (error) {
    console.error(error);
    res.status(500).send("Error al conectar con TikTok.");
  }
});

app.post("/upload", upload.single("video"), async (req, res) => {
  const session = sessions.get(req.query.session);

  if (!session?.accessToken) {
    return res.status(401).send("Sesión no válida. Vuelve a conectar TikTok.");
  }

  if (!req.file) {
    return res.status(400).send("Selecciona un vídeo.");
  }

  try {
    const initResponse = await fetch(
      "https://open.tiktokapis.com/v2/post/publish/inbox/video/init/",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          "Content-Type": "application/json; charset=UTF-8"
        },
        body: JSON.stringify({
          source_info: {
            source: "FILE_UPLOAD",
            video_size: req.file.size,
            chunk_size: req.file.size,
            total_chunk_count: 1
          }
        })
      }
    );

    const initData = await initResponse.json();

    if (!initResponse.ok || initData.error?.code !== "ok") {
      return res.status(400).send("TikTok no aceptó la subida: " + JSON.stringify(initData));
    }

    const uploadResponse = await fetch(initData.data.upload_url, {
      method: "PUT",
      headers: {
        "Content-Type": req.file.mimetype || "video/mp4",
        "Content-Length": String(req.file.size),
        "Content-Range": `bytes 0-${req.file.size - 1}/${req.file.size}`
      },
      body: req.file.buffer
    });

    if (!uploadResponse.ok) {
      return res.status(400).send("No se pudo transferir el vídeo a TikTok.");
    }

    res.send(`
      <!doctype html>
      <html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DraftFlow</title><link rel="stylesheet" href="/style.css"></head>
      <body><main><section class="card"><div class="logo">DF</div><h1>Vídeo enviado</h1><p>El vídeo se ha enviado a TikTok como borrador. Abre TikTok para continuar editándolo y publicarlo.</p><footer><a href="/">Volver</a></footer></section></main></body></html>
    `);
  } catch (error) {
    console.error(error);
    res.status(500).send("Error durante la subida.");
  }
});

app.listen(PORT, () => {
  console.log(`DraftFlow escuchando en el puerto ${PORT}`);
  console.log("Callback de TikTok:", callbackUrl());
});
