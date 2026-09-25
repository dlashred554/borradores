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
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>DraftFlow</title>
        <link rel="stylesheet" href="/style.css">
      </head>
      <body>
        <main><section class="card">
          <div class="logo">DF</div>
          <h1>Cuenta conectada</h1>
          <p>Selecciona hasta 20 vídeos. DraftFlow los enviará uno por uno.</p>
          <input id="videos" type="file" accept="video/mp4,video/quicktime,video/webm" multiple>
          <p id="count">0 vídeos seleccionados</p>
          <button id="send" type="button">Enviar a TikTok</button>
          <div id="status"></div>
          <footer><a href="/">Inicio</a><a href="/privacy.html">Privacidad</a></footer>

          <script>
            const input = document.getElementById("videos");
            const send = document.getElementById("send");
            const count = document.getElementById("count");
            const status = document.getElementById("status");
            const session = ${JSON.stringify(sessionId)};

            input.addEventListener("change", () => {
              if (input.files.length > 20) {
                status.textContent = "Máximo 20 vídeos por lote.";
                input.value = "";
                count.textContent = "0 vídeos seleccionados";
                return;
              }
              count.textContent = input.files.length + " vídeo" + (input.files.length === 1 ? "" : "s") + " seleccionado" + (input.files.length === 1 ? "" : "s");
              status.textContent = "";
            });

            send.addEventListener("click", async () => {
              const files = Array.from(input.files);
              if (!files.length) {
                status.textContent = "Selecciona al menos un vídeo.";
                return;
              }
              if (files.length > 20) {
                status.textContent = "Máximo 20 vídeos por lote.";
                return;
              }

              send.disabled = true;
              input.disabled = true;

              let completed = 0;

              for (const file of files) {
                status.textContent = "Enviando " + (completed + 1) + "/" + files.length + ": " + file.name;

                const form = new FormData();
                form.append("video", file);

                try {
                  const response = await fetch("/upload?session=" + encodeURIComponent(session), {
                    method: "POST",
                    body: form
                  });

                  const data = await response.json();

                  if (!response.ok || !data.ok) {
                    status.textContent = "Detenido en " + (completed + 1) + "/" + files.length + ". " + (data.message || "TikTok rechazó la subida.");
                    break;
                  }

                  completed++;
                  status.textContent = "Enviados " + completed + "/" + files.length;
                } catch (error) {
                  status.textContent = "Error en " + file.name + ". Se han enviado " + completed + "/" + files.length + ".";
                  break;
                }
              }

              if (completed === files.length) {
                status.textContent = "Listo: " + completed + " de " + files.length + " vídeos enviados a TikTok.";
              }

              send.disabled = false;
              input.disabled = false;
            });
          </script>
        </section></main>
      </body>
      </html>
    `);
  } catch (error) {
    console.error(error);
    res.status(500).send("Error al conectar con TikTok.");
  }
});

app.post("/upload", upload.single("video"), async (req, res) => {
  const session = sessions.get(req.query.session);

  if (!session?.accessToken) {
    return res.status(401).json({ ok: false, message: "Sesión no válida. Vuelve a conectar TikTok." });
  }

  if (!req.file) {
    return res.status(400).json({ ok: false, message: "Selecciona un vídeo." });
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
      console.error("TikTok upload init error:", initData);
      return res.status(400).json({
        ok: false,
        message: "TikTok rechazó la subida. " + (initData.error?.message || initData.error?.code || "Revisa el límite o la configuración de TikTok.")
      });
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
      return res.status(400).json({ ok: false, message: "No se pudo transferir el vídeo a TikTok." });
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, message: "Error durante la subida." });
  }
});

app.listen(PORT, () => {
  console.log(`DraftFlow escuchando en el puerto ${PORT}`);
  console.log("Callback de TikTok:", callbackUrl());
});
