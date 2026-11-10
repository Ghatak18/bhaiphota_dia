
/*
 * Bhai Phota - Telegram Notification Backend
 * Node.js 18+ required.
 */

require("dotenv").config();

const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");

// ----------------------------------
// Configuration
// ----------------------------------

const PORT = Number(process.env.PORT || 3000);

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Your sister's name
const SENDER_NAME = "Tuli";

const MAX_BODY_BYTES = 4096;
const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 5;

if (!BOT_TOKEN || !CHAT_ID) {
  console.error(
    "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID."
  );
  process.exit(1);
}

// ----------------------------------
// Rate limiting
// ----------------------------------

const hits = new Map();

function isRateLimited(req) {
  const ip = (
    req.headers["x-forwarded-for"] ||
    req.socket.remoteAddress ||
    "unknown"
  )
    .toString()
    .split(",")[0]
    .trim();

  const now = Date.now();

  let record = hits.get(ip);

  if (!record || now - record.start >= WINDOW_MS) {
    record = {
      count: 0,
      start: now
    };
  }

  record.count++;
  hits.set(ip, record);

  return record.count > MAX_REQUESTS_PER_WINDOW;
}

// ----------------------------------
// JSON response helper
// ----------------------------------

function sendJson(res, status, data) {
  if (res.headersSent) return;

  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });

  res.end(JSON.stringify(data));
}

// ----------------------------------
// Read JSON request body
// ----------------------------------

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let totalBytes = 0;
    let tooLarge = false;

    req.on("data", (chunk) => {
      totalBytes += chunk.length;

      if (totalBytes > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }

      body += chunk.toString("utf8");
    });

    req.on("end", () => {
      if (tooLarge) {
        return reject(new Error("Request body too large"));
      }

      try {
        const payload = JSON.parse(body || "{}");

        if (
          !payload ||
          typeof payload !== "object" ||
          Array.isArray(payload)
        ) {
          return reject(new Error("Invalid JSON"));
        }

        resolve(payload);
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });

    req.on("error", reject);
  });
}

// ----------------------------------
// Send message to Telegram
// ----------------------------------

async function sendTelegramMessage(message) {
  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: message
      }),
      signal: AbortSignal.timeout(15000)
    }
  );

  const result = await response.json();

  if (!response.ok || !result.ok) {
    console.error("Telegram API error:", result);

    throw new Error(
      result.description || "Telegram delivery failed"
    );
  }

  return result;
}

// ----------------------------------
// Main server
// ----------------------------------

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`
  );

  const pathname = requestUrl.pathname;

  // --------------------------------
  // Serve frontend
  // --------------------------------

  if (
    req.method === "GET" &&
    (pathname === "/" || pathname === "/index.html")
  ) {
    try {
      const html = await fs.readFile(
        path.join(__dirname, "index.html")
      );

      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff"
      });

      return res.end(html);
    } catch (error) {
      console.error("Frontend loading error:", error);

      return sendJson(res, 500, {
        ok: false,
        error: "Website could not be loaded."
      });
    }
  }

  // --------------------------------
  // Health check
  // --------------------------------

  if (req.method === "GET" && pathname === "/health") {
    return sendJson(res, 200, {
      ok: true,
      service: "bhai-phota-notifications"
    });
  }

  // --------------------------------
  // Validate API route
  // --------------------------------

  if (
    req.method !== "POST" ||
    !["/api/phota", "/api/message"].includes(pathname)
  ) {
    return sendJson(res, 404, {
      ok: false,
      error: "Not found"
    });
  }

  // --------------------------------
  // Rate limit
  // --------------------------------

  if (isRateLimited(req)) {
    return sendJson(res, 429, {
      ok: false,
      error: "Too many requests. Try again later."
    });
  }

  try {
    const payload = await readJsonBody(req);

    // ==================================
    // 1. BHAI PHOTA NOTIFICATION
    // ==================================

    if (pathname === "/api/phota") {
      if (payload.event !== "bhai_phota") {
        return sendJson(res, 400, {
          ok: false,
          error: "Invalid event"
        });
      }

      const telegramText = [
        "❤️ TULI just gave you Bhai Phota!",
        "",
        "Your website received a new phota.",
        "শুভ ভাইফোঁটা! ❤️❤️❤️"
      ].join("\n");

      await sendTelegramMessage(telegramText);

      console.log("Bhai Phota notification sent successfully.");

      return sendJson(res, 200, {
        ok: true
      });
    }

    // ==================================
    // 2. PERSONAL MESSAGE NOTIFICATION
    // ==================================

    if (pathname === "/api/message") {
      const message =
        typeof payload.message === "string"
          ? payload.message.trim()
          : "";

      if (!message || message.length > 1000) {
        return sendJson(res, 400, {
          ok: false,
          error: "Please enter a message (up to 1000 characters)."
        });
      }

      const telegramText = [
        "💌 New message after Bhai Phota!",
        "",
        `From: ${SENDER_NAME}`,
        "",
        message,
        "",
        "শুভ ভাইফোঁটা! ❤️"
      ].join("\n");

      console.log("Sending personal message from Tuli...");

      await sendTelegramMessage(telegramText);

      console.log("Personal message delivered successfully.");

      return sendJson(res, 200, {
        ok: true,
        message: "Message sent successfully."
      });
    }

  } catch (error) {
    console.error("Request error:", error);

    if (error.message === "Request body too large") {
      return sendJson(res, 413, {
        ok: false,
        error: "Message is too large."
      });
    }

    if (error.message === "Invalid JSON") {
      return sendJson(res, 400, {
        ok: false,
        error: "Invalid JSON request."
      });
    }

    return sendJson(res, 502, {
      ok: false,
      error: "Telegram delivery failed. Please try again."
    });
  }
});

// ----------------------------------
// Start server
// ----------------------------------

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Bhai Phota server running on port ${PORT}`);
});

// ----------------------------------
// Graceful shutdown
// ----------------------------------

process.on("SIGTERM", () => {
  console.log("Shutting down server...");

  server.close(() => {
    process.exit(0);
  });
});
